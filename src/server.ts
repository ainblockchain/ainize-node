import { NODE_VERSION as VERSION } from './version.js';
/**
 * Assemble and run a marketplace node: ledger + store + blobs + runtime + market + p2p + verifier + HTTP.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import express from 'express';
import { buildAgents } from './agents.js';
import { HostedAgentStore, HOSTED_AGENT_DEFAULT_LIMITS } from './hosted-agent-store.js';
import { HostedAgentSecretStore } from './hosted-agent-secrets.js';
import { HostedAgentGateway } from './hosted-agent-gateway.js';
import { HostedAgentHost } from './hosted-agent-host.js';
import { HostedAgentDocker, HOSTED_AGENT_DOCKER_DEFAULTS } from './hosted-agent-docker.js';
import { hostedAgentRoutes } from './hosted-agent-routes.js';
import { siteSession } from './site-session.js';
import { buildSam, makeMeshRelay } from './sam.js';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import { AinLedger, DEFAULT_EVENTS_RETENTION_DAYS, LocalLedger, loadConfig, mergeConfigChanges, saveConfig, validateConfig, type DepositLedger, type Ledger, type NodeConfig } from '@ainize/core';
import { buildApi, setupTokenPath } from './api.js';
import { diskReport, humanBytes, sweepTemp } from './disk.js';
import { BlobStore } from './blobs.js';
import { Market } from './market.js';
import { InferenceRecords, type InferenceLedger } from './inference-records.js';
import { P2P } from './p2p.js';
import { Runtime } from './runtime.js';
import { Store } from './store.js';
import { Verifier } from './verifier.js';
import { Drive } from './drive.js';
import { TeachWorker, type TeachHooks } from './teach.js';
import { InferenceBackendRegistry } from './inference-backends.js';
import { OpenaiApiKeyStore } from './openai-api-keys.js';
import { openaiSurfaceRouter } from './openai-surface.js';
import { publicModelsRouter, probeBackend } from './public-models-route.js';
import { freeTierRouter } from './free-tier-routes.js';
import { openaiApiKeysRoutes } from './openai-api-keys-routes.js';
import { readSiteAssertionSecret } from './site-assertion.js';
import { ModalityGate } from './modality-gate.js';
import { DepositWatcher } from './deposit-watcher.js';
import { DepositLedgerStore } from './deposit-ledger-store.js';
import { assertDepositsConfigured, depositChainClients, DEFAULT_CONFIRMATIONS } from './deposit-chain-reader.js';
import { StakeFairQueue } from './stake-fair-queue.js';
import { stakeWeightFrom, STAKE_WEIGHT_FLOOR, STAKE_IDLE_FORGET_MS } from './stake-weight-source.js';

export interface RunningNode {
  cfg: NodeConfig;
  market: Market;
  ledger: Ledger;
  store: Store;
  verifier: Verifier | null;
  drive: Drive;
  /** Teach-mode worker (null when disabled with `teachWorker: false`). */
  teach: TeachWorker | null;
  /** Credited deposits, when this node sells throughput (null when it does not). */
  deposits: DepositLedger | null;
  server: Server;
  url: string;
  stop(): Promise<void>;
}

export interface StartOptions {
  home?: string;              // where config.json lives (for saveConfig)
  serveWeb?: boolean;
  webDist?: string;
  listen?: boolean;
  quiet?: boolean;
  /** Start the teach worker (default true). */
  teachWorker?: boolean;
  /** Process hooks for the teach worker (tests fake `spawn`/`exec`). */
  teachHooks?: TeachHooks;
}

/** `config.json` `agentHost` — optional; defaults run prompt agents only. */
export interface HostedAgentHostConfig {
  perOwner?: number;
  total?: number;
  docker?: {
    enabled?: boolean;
    runtime?: string;
    memory?: string;
    cpus?: number;
    pidsLimit?: number;
    network?: string;
    buildTimeoutMs?: number;
    idleStopMs?: number;
    maxRunning?: number;
  };
}

/** How long raw event rows are kept (lineage design §5.6) when `events.retentionDays` is not set (item 128). */
export const EVENTS_RETENTION_MS = DEFAULT_EVENTS_RETENTION_DAYS * 86_400_000;

/**
 * How long an upload temp file may sit in `<dataDir>/uploads` or `<dataDir>/teach/incoming` before the sweep takes
 * it (item 129). The routes unlink their own file; this only ever catches what a crash or a SIGKILL left behind,
 * and `mtime` is the test, so an upload that is still streaming in is never touched.
 */
export const UPLOAD_TEMP_TTL_MS = 3600_000;

/** Warn about the volume below this share of free space, or below this many bytes, whichever bites first (item 128). */
export const DISK_WARN_FRACTION = 0.05;
export const DISK_WARN_BYTES = 2 * 1000 ** 3;

export async function startNode(cfg: NodeConfig, opts: StartOptions = {}): Promise<RunningNode> {
  // A config nothing ever checked used to boot: `port notanumber` bound an ephemeral port, `roles admin` silently
  // disabled every role, `host 999.999.999.999` listened nowhere findable. Refuse, and name every offending key
  // with what it should hold (item 123). Keys this build does not know are only reported, so a config written by a
  // newer build still starts here.
  const problems = validateConfig(cfg);
  const invalid = problems.filter((p) => p.kind === 'invalid');
  if (invalid.length) {
    throw new Error(`this node's config is not usable:\n${invalid.map((p) => `  ${p.key} ${p.message}`).join('\n')}\n` +
      `fix it with \`ainize config set <key> <value>\` (or \`ainize config unset <key>\` for the default) in ${join(dirname(cfg.dataDir), 'config.json')}`);
  }

  const recordInference = process.env.AINIZE_INFERENCE_RECORDS === 'true';
  if (recordInference && (cfg.ledger.kind !== 'ain'
    || typeof (AinLedger.prototype as InferenceLedger).noteInferenceBatch !== 'function')) {
    throw new Error('AINIZE_INFERENCE_RECORDS requires an AIN ledger and a core build with noteInferenceBatch');
  }
  const store = new Store(join(cfg.dataDir, 'node.sqlite'));
  // item 131: what the LAST run did, read before this one overwrites it.
  const lastStart = Number(store.get('node.started_at') ?? 0);
  const lastStop = Number(store.get('node.stopped_at') ?? 0);
  store.set('node.started_at', String(Date.now()));
  /**
   * The queue that divides the shared model by what callers deposited.
   *
   * Built only when this node accepts deposits. Without it `Runtime` orders its queue by priority then arrival,
   * exactly as it always has — a node that sells no throughput must not change behaviour because this feature
   * exists. The ledger is filled in below, once the deposits config has been checked; the weight function closes
   * over the holder rather than the ledger so the two can be built in either order.
   */
  const stakeHolder: { ledger: DepositLedger | null } = { ledger: null };
  const stakeQueue = cfg.deposits && cfg.backends?.length
    ? new StakeFairQueue({
      weightOf: (address) => (stakeHolder.ledger ? stakeWeightFrom(stakeHolder.ledger)(address) : 0),
      weightFloor: STAKE_WEIGHT_FLOOR,
      now: () => Date.now(),
    })
    : undefined;
  const runtime = new Runtime(cfg.runtime ?? {}, undefined, stakeQueue);
  const blobs = new BlobStore(store, cfg.dataDir);

  let market: Market;
  const events = { onRecord: () => market?.invalidate() };
  const ledger: Ledger = cfg.ledger.kind === 'ain'
    ? new AinLedger({ providerUrl: cfg.ledger.ain!.providerUrl, eventHandlerUrl: cfg.ledger.ain!.eventHandlerUrl, chainId: cfg.ledger.ain!.chainId, pollMs: cfg.ledger.ain!.pollMs }, cfg.identity, events)
    : new LocalLedger(join(cfg.dataDir, 'ledger.sqlite'), cfg.identity, events, 'local');
  await ledger.init();

  market = new Market(cfg, ledger, store, blobs, runtime);
  if (recordInference) market.inferenceRecords = new InferenceRecords(store, ledger as InferenceLedger,
    message => market.log('info', 'inference', message));
  const selfUrl = cfg.publicUrl ?? `http://localhost:${cfg.port}`;
  const p2p = new P2P({ identity: cfg.identity, ledger, store, selfInfo: () => market.selfInfo(), log: (l, k, m, d) => market.log(l, k, m, null, d) }, cfg.peers, cfg.gossipIntervalMs, selfUrl, cfg.p2p ?? {});
  market.p2p = p2p;
  const drive = new Drive(market);
  market.drive = drive;
  const verifier = cfg.roles.includes('verifier') ? new Verifier(market, cfg.verifier?.intervalMs ?? 5000) : null;
  const teach = opts.teachWorker === false ? null : new TeachWorker(market, opts.teachHooks);

  const app = express();
  app.disable('x-powered-by');
  // Only trust X-Forwarded-For when the operator says the node is behind a proxy (config `server.trustProxy`, env
  // AINIZE_TRUST_PROXY). Default false: `req.ip` is the TCP peer, so per-IP quotas / bans / rate limits cannot be spoofed.
  app.set('trust proxy', cfg.server?.trustProxy ?? false);
  /**
   * Security headers, because of what this origin holds (item 377).
   *
   * A teaching key is a private key, it lives in this origin's `localStorage`, and it is not a session — it owns
   * the lessons it signed and the money they earn. The same origin renders what visitors upload: dataset rows,
   * display names, knowledge descriptions. React escapes all of it, `dangerouslySetInnerHTML` appears nowhere,
   * and `NAME_BLOCKLIST` strips links, markup and invisible characters — so there was no known way in. A CSP is
   * for the one nobody knows about, and the asset behind this door is somebody's income.
   *
   * `'unsafe-inline'` for styles is what styled-components needs; scripts get no such allowance. `connect-src`
   * stays open because a node legitimately talks to peers, a chain and a runtime the operator chooses.
   */
  app.use((_req, res, next) => {
    res.setHeader('Content-Security-Policy', [
      "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:", "font-src 'self' data:", "connect-src *",
      "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'",
    ].join('; '));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    // A node is reachable over plain HTTP on a LAN by design, so HSTS is not set here: it would strand an operator
    // who reaches their own node by IP. Put it on the reverse proxy that terminates TLS.
    next();
  });
  app.use(compression());
  app.use(cookieParser());
  // keep the raw bytes: the request-bound visitor signature (teach-auth.ts v2) hashes the body exactly as sent
  app.use(express.json({ limit: '5mb', verify: (req, _res, buf) => { (req as typeof req & { rawBody?: Buffer }).rawBody = buf; } }));
  app.use((req, res, next) => {
    res.setHeader('access-control-allow-origin', req.headers.origin ?? '*');
    res.setHeader('access-control-allow-credentials', 'true');
    res.setHeader('access-control-allow-headers', 'content-type, authorization, x-payment, x-ainize-auth, x-ainize-buyer, a2a-version, x-sam-required-labels, x-sam-authentication, x-sam-agent');
    res.setHeader('access-control-expose-headers', 'x-payment-required, x-payment-tx-hash, x-payment-currency, x-payment-response, x-content-sha256');
    res.setHeader('access-control-allow-methods', 'GET,POST,PATCH,DELETE,OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  // The node holds its own copy of the config. Writing that whole snapshot back — which is what every console
  // save used to do — reverted every `ainize config set` made since start-up. Save only what THIS node changed,
  // on top of whatever config.json says now (item 124).
  // The baseline is what this node LAST WROTE, not its boot snapshot: a peer added and then removed must reach the
  // file as removed — diffed against boot it looked like "no change" and the earlier save (with the peer) stood.
  let baseline = structuredClone(cfg);
  const persistConfig = () => {
    if (!opts.home) return;
    const onDisk = loadConfig(opts.home);
    saveConfig(onDisk ? mergeConfigChanges(onDisk, baseline, cfg) : cfg, opts.home);
    baseline = structuredClone(cfg);
  };
  app.use(buildApi({ market, verifier, drive, teach: teach ?? undefined, saveConfig: persistConfig, home: opts.home }));

  // The OpenAI-compatible surface, mounted only when an operator has declared what it serves. A node with no
  // `backends` block has no `/v1` at all rather than a `/v1` that advertises nothing — the two look the same to a
  // reader of the config but mean different things to a client, which needs "not offered here" and not "offered,
  // empty". It is a separate router because `api.ts` is long enough already.
  /**
   * One registry, read by both surfaces.
   *
   * `/v1` routes by it and `/api/models` lists from it. Two registries built from one config would be two
   * things to keep in step, and the one that drifted would be the one nobody was looking at.
   */
  const inferenceRegistry = cfg.backends?.length
    ? new InferenceBackendRegistry(cfg.backends.map((b) => ({ ...b, concurrency: b.concurrency ?? 1 })))
    : null;

  /**
   * Mounted whether or not this node serves anything: an unconfigured node answers an empty list, which a page
   * can render, rather than a 404 that is indistinguishable from a node too old to have the route.
   */
  /**
   * Agents this node RUNS (docs/superpowers/specs/2026-09-26-hosted-agents-design.md). Built before the models
   * router so a model's page can count the agents built on it, and before the agent surface so `/agents/<id>`
   * resolves them. Code agents need `agentHost.docker.enabled`; prompt agents need nothing but a chat backend.
   */
  const agentHostCfg = (cfg as NodeConfig & { agentHost?: HostedAgentHostConfig }).agentHost ?? {};
  const hostedHome = cfg.dataDir;
  const hostedStore = new HostedAgentStore(join(hostedHome, 'hosted-agents.json'), {
    perOwner: agentHostCfg.perOwner ?? HOSTED_AGENT_DEFAULT_LIMITS.perOwner,
    total: agentHostCfg.total ?? HOSTED_AGENT_DEFAULT_LIMITS.total,
  });
  const hostedSecrets = new HostedAgentSecretStore(join(hostedHome, 'hosted-agent-secrets.json'), join(hostedHome, 'hosted-agent-secrets.key'));
  const hostedGateway = new HostedAgentGateway({
    registry: () => inferenceRegistry,
    spec: (id) => hostedStore.get(id),
    log: (message) => market.log('info', 'agents', message),
  });
  const dockerCfg = agentHostCfg.docker;
  if (dockerCfg?.enabled && !dockerCfg.runtime) {
    market.log('warn', 'agents', 'agentHost.docker.runtime is not set: agent code runs under runc, which shares the host kernel — set "runsc" (gVisor) for code from strangers');
  }
  const hostedHost = new HostedAgentHost({
    gateway: hostedGateway,
    secrets: hostedSecrets,
    docker: dockerCfg?.enabled ? new HostedAgentDocker({
      runtime: dockerCfg.runtime,
      memory: dockerCfg.memory ?? HOSTED_AGENT_DOCKER_DEFAULTS.memory,
      cpus: dockerCfg.cpus ?? HOSTED_AGENT_DOCKER_DEFAULTS.cpus,
      pidsLimit: dockerCfg.pidsLimit ?? HOSTED_AGENT_DOCKER_DEFAULTS.pidsLimit,
      network: dockerCfg.network ?? HOSTED_AGENT_DOCKER_DEFAULTS.network,
      buildTimeoutMs: dockerCfg.buildTimeoutMs ?? HOSTED_AGENT_DOCKER_DEFAULTS.buildTimeoutMs,
      workDir: join(cfg.dataDir, 'hosted-agents'),
      runtimeImage: 'ainize/hosted-agent-runtime',
    }) : null,
    idleStopMs: dockerCfg?.idleStopMs ?? 600_000,
    maxRunning: dockerCfg?.maxRunning ?? 20,
    log: (level, message) => market.log(level, 'agents', message),
  });
  await hostedHost.start(hostedStore.list());
  const hostedAgents = { host: hostedHost, store: hostedStore };
  market.hostedAgents = hostedAgents;

  app.use(publicModelsRouter({
    registry: inferenceRegistry,
    probe: probeBackend,
    // Agents here and on peers, counted the way `/api/agents?model=` lists them.
    agentCount: async (model) => {
      const own = hostedStore.list().filter((s) => s.model === model).length;
      const peers = (await market.knownNodes().catch(() => []))
        .filter((n) => (n.address ?? '').toLowerCase() !== cfg.identity.address.toLowerCase())
        .flatMap((n) => (n.agents ?? []) as { model?: string }[])
        .filter((a) => a.model === model).length;
      return own + peers;
    },
  }));
  app.use(hostedAgentRoutes({
    store: hostedStore,
    secrets: hostedSecrets,
    host: hostedHost,
    registry: () => inferenceRegistry,
    sessionAddress: (req) => siteSession(req, store, cfg.identity.address)?.address.toLowerCase() ?? null,
    reserved: (id) => (cfg.agents ?? []).some((a) => a?.id === id),
    publicBase: (req) => market.publicUrl ?? `${req.protocol}://${req.get('host') ?? ''}`,
  }));

  /**
   * One gate per non-LLM backend, shared by the paid surface and the free tier.
   *
   * A gate is the queue in front of a GPU. Built twice, each copy would admit up to the card's concurrency on its
   * own and the card would see double — so it is built here, once, and handed to both routers.
   */
  const modalityGates = new Map<string, ModalityGate>();

  /**
   * API keys for the `/v1` surface.
   *
   * Built outside the backends block because the routes that manage them are about the person, not about what
   * this node happens to serve: somebody signed in should be able to see and revoke their keys on a node whose
   * model server is down.
   */
  const openaiKeys = new OpenaiApiKeyStore(join(opts.home ?? tmpdir(), 'openai-keys.json'));
  app.use(openaiApiKeysRoutes({ keys: openaiKeys, store, nodeAddress: cfg.identity.address, siteAssertionSecret: readSiteAssertionSecret(opts.home) }));

  let deposits: DepositLedger | null = null;
  let depositWatcher: DepositWatcher | null = null;
  if (cfg.backends?.length) {
    const surfaceHome = opts.home ?? tmpdir();
    for (const modality of ['transcription', 'image'] as const) {
      for (const backend of inferenceRegistry!.backendsFor(modality)) {
        modalityGates.set(backend.id, new ModalityGate(modality, backend.concurrency, stakeQueue));
      }
    }
    if (cfg.deposits) {
      // Refused here, before anything is served, because neither mistake is visible later: a node watching the
      // wrong address simply never sees a transfer, which looks exactly like nobody having deposited yet.
      assertDepositsConfigured(cfg.deposits);
      const chains = cfg.deposits.chains.map((c) => ({
        chain: c.chain, rpcUrl: c.rpcUrl, token: c.token,
        confirmations: c.confirmations ?? DEFAULT_CONFIRMATIONS[c.chain] ?? 12,
        isVaultShare: c.isVaultShare ?? false,
      }));
      const store = new DepositLedgerStore(join(surfaceHome, 'deposits.json'));
      deposits = store.load();
      stakeHolder.ledger = deposits;
      depositWatcher = new DepositWatcher({
        chains,
        receivingAddress: cfg.deposits.receivingAddress,
        ledger: deposits,
        journalFile: join(surfaceHome, 'deposit-journal.json'),
        log: (message) => market.log('info', 'deposits', message),
        ...depositChainClients(chains, cfg.deposits.vault),
      });
      // Persist after every pass: a credit the node forgets is a caller who paid for a share they do not have.
      depositWatcher.onCredited = () => store.save(deposits!);
      depositWatcher.start(cfg.deposits.pollMs ?? 30_000);
    }
    app.use(openaiSurfaceRouter({
      registry: inferenceRegistry!,
      keys: openaiKeys,
      market,
      gates: modalityGates,
      scheduler: stakeQueue,
      node: cfg.identity.address,
      nodeName: cfg.name,
      deposits: deposits && cfg.deposits
        ? {
          ledger: deposits,
          receivingAddress: cfg.deposits.receivingAddress,
          chains: cfg.deposits.chains.map((c) => ({ chain: c.chain, token: c.token })),
        }
        : undefined,
    }));

    // The visitor's door, beside the program's. Same gates, same hourly allowance as /api/chat — see
    // free-tier-quota.ts for why the allowance is defined in one place rather than per route.
    app.use(freeTierRouter({ registry: inferenceRegistry, market, gates: modalityGates }));
  }

  const samDeps = {
    cfg,
    identity: cfg.identity,
    peers: () => store.listPeers().map((p) => ({ address: p.address, endpoint: p.endpoint })),
    selfUrl: () => market.publicUrl,
    log: (level: 'debug' | 'info' | 'warn' | 'error', kind: string, message: string, data?: unknown) =>
      market.log(level, kind, message, null, data),
  };

  // A2A agents this node operates (NEWS-AGENT-REQUIREMENTS §5). Mounted before the SPA catch-all so that
  // `/agents/<id>/.well-known/agent-card.json` is a card and not an HTML page — an A2A client that receives
  // index.html reports "no name in card" and the real cause is invisible.
  // The mesh hop is shared: `/sam/<peer>/a2a/<id>` names the peer, `/agents/<id>` is the address this node
  // hands out for an agent it has registered from the peer table. One implementation, so the labels gate, the
  // signature and the rate limit cannot drift apart between the two doors.
  const mesh = makeMeshRelay(samDeps);
  app.use(buildAgents(cfg, {
    hosted: hostedAgents,
    knownNodes: () => market.knownNodes(),
    selfAddress: cfg.identity.address,
    relay: mesh,
    publicUrl: () => market.publicUrl,
  }));

  // Agent-to-agent across nodes, on SAM's wire contract (sam.ts): the mesh path, card regeneration and the
  // fail-closed labels gate. Mounted beside the agent surface because the two are halves of one thing — this is
  // the caller's side of what `/agents/<id>` serves.
  app.use(buildSam(samDeps, mesh));

  // ---------------------------------------------------------------- health probes (item 134)
  // Everything that is not an API route used to be answered 200 with the web app, so `/healthz` — the path every
  // uptime check tries first — reported a perfectly healthy node while its model server was gone. These two answer
  // for real, and the other probe paths answer 404 instead of an HTML page a monitor will read as success.
  const startedAt = Date.now();
  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, node: cfg.name, address: cfg.identity.address, version: VERSION, uptime_s: Math.round((Date.now() - startedAt) / 1000) });
  });
  app.get('/readyz', async (_req, res) => {
    const info = await ledger.info().catch(() => null);
    // an AIN node with no block height cannot read or write the public record; a local ledger is its own file
    const ledgerOk = !!info && (info.kind !== 'ain' || info.height !== undefined);
    const needsRuntime = cfg.roles.includes('serving') || cfg.roles.includes('verifier');
    const rt = await runtime.status().catch(() => null);
    const peers = store.listPeers();
    const checks = {
      ledger: { ok: ledgerOk, kind: cfg.ledger.kind, height: info?.height ?? null, records: info?.records ?? null, ...(ledgerOk ? {} : { error: `ledger unreachable${cfg.ledger.ain ? ` (${cfg.ledger.ain.providerUrl})` : ''}` }) },
      runtime: { ok: !needsRuntime || !!rt?.available, required: needsRuntime, available: !!rt?.available, model: rt?.model ?? null, ...(rt?.error ? { error: rt.error } : {}) },
      peers: { ok: true, configured: peers.length, unreachable: peers.filter((p) => p.failures > 0).length },
    };
    const ok = checks.ledger.ok && checks.runtime.ok;
    res.status(ok ? 200 : 503).json({ ok, node: cfg.name, address: cfg.identity.address, version: VERSION, checks });
  });
  // the usual probe paths must never be answered with the SPA: a 200 HTML page is a green light to every monitor
  app.get(/^\/(health|healthcheck|_health|ready|live|livez|ping|status|metrics|version|up)\/?$/, (_req, res) => {
    res.status(404).json({ error: 'not found', hint: 'health checks: /healthz (the process is alive) and /readyz (ledger + runtime); /api/info for detail' });
  });

  const webDist = opts.webDist ? resolve(opts.webDist) : undefined;
  if (opts.serveWeb !== false && webDist && existsSync(join(webDist, 'index.html'))) {
    app.use(express.static(webDist, { maxAge: '1h', index: false }));
    app.get(/^\/(?!api\/|x402\/|p2p\/|agents\/|sam\/).*/, (_req, res) => { res.sendFile(join(webDist, 'index.html')); });
  } else {
    app.get('/', (_req, res) => { res.type('text').send(`ainize node ${cfg.name} (${cfg.identity.address})\nAPI: /api/info  catalog: /api/catalog\nno web UI here — it is its own build: github.com/ainblockchain/ainize-web\n(point webDist at its dist/, or serve it anywhere and hand it this node's URL)`); });
  }

  const server = createServer(app);
  if (opts.listen !== false) {
    await new Promise<void>((res, rej) => { server.once('error', rej); server.listen(cfg.port, cfg.host, () => res()); });
  }
  const bound = opts.listen === false ? null : (server.address() as { port: number }).port;
  const everyInterface = cfg.host === '0.0.0.0' || cfg.host === '::';
  const url = bound === null ? selfUrl : `http://${everyInterface ? 'localhost' : cfg.host}:${bound}`;

  /**
   * The one-time enrolment token, written where only the user the node runs as can read it.
   *
   * Adding an address to this node's operators is loopback-only, because it is exactly as privileged as being one.
   * An operator who administers the node over the network needs a second proof that they are the owner, and this is
   * it. Re-minted on every start that finds it missing, and deleted the moment it is used.
   *
   * It is no longer a CLAIM token: the node's own key is always an operator, so there is no state in which the node
   * is unowned and waiting for whoever asks first. What the token buys is enrolling a SECOND address.
   */
  if (opts.home) {
    const tokenFile = setupTokenPath(opts.home);
    try {
      mkdirSync(opts.home, { recursive: true });
      const existing = existsSync(tokenFile) ? readFileSync(tokenFile, 'utf8').trim() : '';
      if (!existing) writeFileSync(tokenFile, randomBytes(24).toString('hex') + '\n', { mode: 0o600 });
    } catch { /* the loopback path still works */ }
  }

  if (!opts.quiet) {
    console.log(`ainize node "${cfg.name}" listening on ${url}${bound !== null && everyInterface ? `  (bound to ${cfg.host}:${bound} — reachable from every interface)` : ''}`);
    console.log(`  identity : ${cfg.identity.address}`);
    console.log(`  ledger   : ${ledger.kind}${cfg.ledger.kind === 'ain' ? ` (${cfg.ledger.ain!.providerUrl})` : ''}   roles: ${cfg.roles.join(',')}   peers: ${cfg.peers.length}`);
    console.log(`  operator : this node's own key — \`ainize login --node-key\` signs in with it, no password`);
    const others = cfg.operatorAddresses ?? [];
    if (others.length) console.log(`             also ${others.join(', ')}`);
    else if (opts.home) console.log(`             to add another address, from that machine: \`ainize operators add <address>\` with the token in ${setupTokenPath(opts.home)}`);
  }
  if (everyInterface && cfg.server?.trustProxy === false) {
    market.log('info', 'config', `host is ${cfg.host}: this node accepts connections from every interface. Bind it to 127.0.0.1 (\`ainize config set host 127.0.0.1\`) unless it is meant to be public.`);
  }
  market.log('info', 'node', `node started (${ledger.kind} ledger, roles ${cfg.roles.join('/')})`);
  // Was the last run stopped, or killed? Two consecutive `node started` lines used to be the whole history, so
  // nobody could tell a deliberate restart from a crash — the first question in any incident (item 131). `stop()`
  // writes `node.stopped_at`; a start that finds it older than the last start says so, once, in the log.
  if (lastStart > 0 && lastStop < lastStart) {
    market.log('warn', 'node', `the previous run started ${new Date(lastStart).toISOString()} and never recorded a shutdown — it was killed or it crashed (a clean stop logs "node stopping"). The events just before that time are what it last saw.`, null, { previous_start: lastStart, last_clean_stop: lastStop || null });
  }
  for (const p of problems) market.log('warn', 'config', `${p.key}: ${p.message}`);
  // `version` in config.json is the string the config was WRITTEN with; the running build is VERSION in the code.
  // Say so once when they differ — the natural hook for a future config migration (item 141).
  if (cfg.version !== VERSION) {
    market.log('info', 'config', `config.json was written by version ${cfg.version}; this node is running ${VERSION}`);
  }
  // Item 145: the trainer must not be pointed at the GPUs that serve the model — deploy/README's own rule, which
  // nothing checked. Said at start-up, where an operator who has just switched teach.backend to 'gradient' will see
  // it, as well as on every lesson that then refuses to start.
  const gpuClash = teach?.gpuConflict();
  if (gpuClash && market.teach().enabled) {
    market.log('error', 'teach', `gradient training cannot start: ${gpuClash}. Lessons will stay queued until this is fixed (\`ainize config set teach.trainer.gpus …\`, \`ainize config set runtime.gpus …\`, or teach.backend "stub").`);
  }
  // A config written before 2026-09 still carries `verifier.stake`: a number the node declared about itself, which
  // escrowed nothing (item 127). Bonds are a different thing in the same place, so the warning has to say which —
  // an operator reading "stake is ignored" must not conclude that nothing is at risk any more (`bond.ts`).
  if (cfg.verifier?.stake !== undefined) {
    market.log('warn', 'config', `verifier.stake ("${cfg.verifier.stake}") is ignored: it was a number this node declared about itself and nothing was ever escrowed for it. A bond is not that — it is AIN this node stakes on the knowledge app, read from the chain by whoever counts the attestation, and an attestation from an unbonded address now counts toward no quorum. Remove the key from ${join(dirname(cfg.dataDir), 'config.json')} and see \`ainize bond\`; \`verifier.requireBond\` sets what this node demands of OTHERS.`);
  }

  // background loops
  await market.registerSelf().catch((e) => market.log('warn', 'node', `self-registration failed: ${(e as Error).message}`));
  p2p.start();
  if (cfg.verifier?.auto !== false) verifier?.start();   // verifier.auto=false: manual verification only
  teach?.start();
  market.payouts.start();   // 60-s royalty payout retry timer (spec §9.3)
  // Item 313: the payout rows are rebuilt from the settlements this node itself wrote, at boot and on the watchdog
  // tick. A crash between `ledger.append` and `enqueue`, or a wiped data dir, used to leave a public debt that no
  // row anywhere knew about — and therefore no retry, no "failed" and no button that could pay it.
  setTimeout(() => { market.reconcilePayouts().catch((e) => market.log('warn', 'payout', `payout reconcile failed: ${(e as Error).message}`)); }, 5_000).unref?.();
  // The same 20-second tick brings subscribed tracks up to date (item 255): "subscribe" was a one-time snapshot and
  // nothing ever reacted to a later `branch` or `supersede` record, so a subscriber served yesterday's retired bake
  // indefinitely while every screen said it was current.
  const watchdog = setInterval(() => {
    market.watchdog().catch(() => undefined);
    market.reconcileSupersedes().catch(() => undefined);
    market.reconcileSubscriptions().catch(() => undefined);
    market.reconcilePayouts().catch(() => undefined);
  }, 20_000);
  watchdog.unref?.();
  // events retention (lineage design §5.6): the demand counters are materialised in `patch_signals_daily` at write
  // time, so the raw event rows — the only place a visitor id ever lands — are kept for 90 days and no longer.
  const retentionMs = (cfg.events?.retentionDays ?? DEFAULT_EVENTS_RETENTION_DAYS) * 86_400_000;
  const purgeEvents = () => { try { const n = store.purgeEvents(Date.now() - retentionMs); if (n) market.log('info', 'node', `removed ${n} event(s) older than ${Math.round(retentionMs / 86_400_000)} days (events.retentionDays)`); } catch { /* next hour */ } };
  const retention = setInterval(purgeEvents, 3600_000);
  retention.unref?.();
  setTimeout(purgeEvents, 5000).unref?.();
  // Disk was the one resource nothing in the product reported: a verifier accumulates a gigabyte of bodies per
  // handful of catalogue items and the first symptom was ENOSPC, which takes the store and the ledger with it.
  // Say it hourly in the event log while the volume is tight; `/api/info.disk` and `ainize status` carry the detail.
  let warnedDisk = 0;
  const checkDisk = () => {
    try {
      const d = diskReport(cfg.dataDir, { home: opts.home, ledgerFile: join(cfg.dataDir, 'ledger.jsonl') });
      if (d.free === null || d.size === null) return;
      const tight = d.free < DISK_WARN_BYTES || d.free / d.size < DISK_WARN_FRACTION;
      if (tight && Date.now() - warnedDisk > 3600_000) {
        warnedDisk = Date.now();
        market.log('warn', 'node', `only ${humanBytes(d.free)} free on the volume holding ${cfg.dataDir} — this node is using ${humanBytes(d.total)} (bodies ${humanBytes(d.blobs)}, training sets ${humanBytes(d.datasets)}, uploads ${humanBytes(d.uploads)}, database ${humanBytes(d.db)}). \`ainize gc\` removes bodies this node neither published nor bought.`);
      }
    } catch { /* next hour */ }
  };
  const diskWatch = setInterval(checkDisk, 3600_000);
  diskWatch.unref?.();
  setTimeout(checkDisk, 8000).unref?.();
  // Orphaned upload bodies (item 129). Every upload route now unlinks its own temp file, but a node killed mid-request
  // leaves one behind, and a node upgrading from an older build starts with a directory full of them — 115 MB on the
  // demo node, twenty-three times its blob store. Swept at start-up and hourly, and said out loud when it takes anything.
  const sweepUploads = () => {
    for (const dir of [join(cfg.dataDir, 'uploads'), join(cfg.dataDir, 'teach', 'incoming')]) {
      const r = sweepTemp(dir, UPLOAD_TEMP_TTL_MS);
      if (r.files) market.log('info', 'node', `removed ${r.files} abandoned upload file(s) (${humanBytes(r.bytes)}) from ${dir} — nothing had written to them for over an hour`);
    }
  };
  const uploadSweep = setInterval(sweepUploads, 3600_000);
  uploadSweep.unref?.();
  setTimeout(sweepUploads, 3000).unref?.();
  const driveSync = setInterval(() => { drive.sync().catch(() => undefined); }, 15_000);
  driveSync.unref?.();
  setTimeout(() => { drive.sync().catch(() => undefined); }, 2000).unref?.();

  const inferenceTimer = recordInference ? setInterval(() => {
    void market.inferenceRecords!.flush().catch(() => market.log('warn', 'inference', 'Inference batch persistence failed; inspect the journal'));
  }, 60_000) : null;
  inferenceTimer?.unref();

  return {
    cfg, market, ledger, store, verifier, drive, teach, deposits, server, url,
    async stop() {
      // The record of a clean shutdown (item 131): without this line a SIGKILL and a `ainize stop` left byte-identical
      // histories, and the next start could not tell an operator which of the two had happened.
      market.log('info', 'node', 'node stopping (clean shutdown)');
      if (inferenceTimer) clearInterval(inferenceTimer);
      depositWatcher?.stop();
      try { store.set('node.stopped_at', String(Date.now())); } catch { /* the database may already be gone */ }
      clearInterval(watchdog);
      clearInterval(retention);
      clearInterval(diskWatch);
      clearInterval(uploadSweep);
      clearInterval(driveSync);
      market.payouts.stop();
      await hostedHost.stop().catch(() => {});
      await Promise.all([verifier?.stop(), p2p.stop(), teach?.stop()]);
      await new Promise<void>((res) => server.close(() => res()));
      await market.inferenceRecords?.flush().catch(() => market.log('warn', 'inference', 'Inference batch flush failed during shutdown'));
      await market.inferenceRecords?.flush().catch(() => market.log('warn', 'inference', 'Remaining inference receipts could not be flushed'));
      await ledger.close();
      store.close();
    },
  };
}
