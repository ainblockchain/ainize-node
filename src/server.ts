/**
 * Assemble and run a marketplace node: ledger + store + blobs + runtime + market + p2p + verifier + HTTP.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import { AinLedger, DEFAULT_EVENTS_RETENTION_DAYS, LocalLedger, VERSION, loadConfig, mergeConfigChanges, saveConfig, validateConfig, type Ledger, type NodeConfig } from '@ngram/core';
import { buildApi, setupTokenPath } from './api.js';
import { diskReport, humanBytes, sweepTemp } from './disk.js';
import { BlobStore } from './blobs.js';
import { Market } from './market.js';
import { P2P } from './p2p.js';
import { Runtime } from './runtime.js';
import { Store } from './store.js';
import { Verifier } from './verifier.js';
import { Drive } from './drive.js';
import { TeachWorker, type TeachHooks } from './teach.js';

export interface RunningNode {
  cfg: NodeConfig;
  market: Market;
  ledger: Ledger;
  store: Store;
  verifier: Verifier | null;
  drive: Drive;
  /** Teach-mode worker (null when disabled with `teachWorker: false`). */
  teach: TeachWorker | null;
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

function defaultWebDist(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', '..', 'web', 'dist');
}

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

  const store = new Store(join(cfg.dataDir, 'node.sqlite'));
  // item 131: what the LAST run did, read before this one overwrites it.
  const lastStart = Number(store.get('node.started_at') ?? 0);
  const lastStop = Number(store.get('node.stopped_at') ?? 0);
  store.set('node.started_at', String(Date.now()));
  const runtime = new Runtime(cfg.runtime ?? {});
  const blobs = new BlobStore(store, cfg.dataDir);

  let market: Market;
  const events = { onRecord: () => market?.invalidate() };
  const ledger: Ledger = cfg.ledger.kind === 'ain'
    ? new AinLedger({ providerUrl: cfg.ledger.ain!.providerUrl, eventHandlerUrl: cfg.ledger.ain!.eventHandlerUrl, chainId: cfg.ledger.ain!.chainId }, cfg.identity, events)
    : new LocalLedger(join(cfg.dataDir, 'ledger.sqlite'), cfg.identity, events, 'local');
  await ledger.init();

  market = new Market(cfg, ledger, store, blobs, runtime);
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
  // NGRAM_TRUST_PROXY). Default false: `req.ip` is the TCP peer, so per-IP quotas / bans / rate limits cannot be spoofed.
  app.set('trust proxy', cfg.server?.trustProxy ?? false);
  app.use(compression());
  app.use(cookieParser());
  // keep the raw bytes: the request-bound visitor signature (teach-auth.ts v2) hashes the body exactly as sent
  app.use(express.json({ limit: '5mb', verify: (req, _res, buf) => { (req as typeof req & { rawBody?: Buffer }).rawBody = buf; } }));
  app.use((req, res, next) => {
    res.setHeader('access-control-allow-origin', req.headers.origin ?? '*');
    res.setHeader('access-control-allow-credentials', 'true');
    res.setHeader('access-control-allow-headers', 'content-type, authorization, x-payment, x-ngram-auth, x-ngram-buyer');
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

  const webDist = opts.webDist ?? defaultWebDist();
  if (opts.serveWeb !== false && existsSync(join(webDist, 'index.html'))) {
    app.use(express.static(webDist, { maxAge: '1h', index: false }));
    app.get(/^\/(?!api\/|x402\/|p2p\/).*/, (_req, res) => { res.sendFile(join(webDist, 'index.html')); });
  } else {
    app.get('/', (_req, res) => { res.type('text').send(`ainize node ${cfg.name} (${cfg.identity.address})\nAPI: /api/info  catalog: /api/catalog\nweb UI not built — run \`npm run build -w packages/web\``); });
  }

  const server = createServer(app);
  if (opts.listen !== false) {
    await new Promise<void>((res, rej) => { server.once('error', rej); server.listen(cfg.port, cfg.host, () => res()); });
  }
  const bound = opts.listen === false ? null : (server.address() as { port: number }).port;
  const everyInterface = cfg.host === '0.0.0.0' || cfg.host === '::';
  const url = bound === null ? selfUrl : `http://${everyInterface ? 'localhost' : cfg.host}:${bound}`;

  /**
   * A node with no operator password is claimed by the first caller that reaches `POST /api/auth/setup` (item 121).
   * Claiming is loopback-only, so an operator who administers the node over the network needs a second proof that
   * they are the owner: this one-time token, written where only the user the node runs as can read it. It is deleted
   * the moment the node is claimed, and re-minted on any start that finds the node still unclaimed.
   */
  if (opts.home) {
    const tokenFile = setupTokenPath(opts.home);
    if (cfg.operatorPasswordHash) { try { if (existsSync(tokenFile)) writeFileSync(tokenFile, '', { mode: 0o600 }); } catch { /* nothing to clean up */ } }
    else {
      try {
        mkdirSync(opts.home, { recursive: true });
        const existing = existsSync(tokenFile) ? readFileSync(tokenFile, 'utf8').trim() : '';
        if (!existing) writeFileSync(tokenFile, randomBytes(24).toString('hex') + '\n', { mode: 0o600 });
      } catch { /* the loopback path still works */ }
    }
  }

  if (!opts.quiet) {
    console.log(`ainize node "${cfg.name}" listening on ${url}${bound !== null && everyInterface ? `  (bound to ${cfg.host}:${bound} — reachable from every interface)` : ''}`);
    console.log(`  identity : ${cfg.identity.address}`);
    console.log(`  ledger   : ${ledger.kind}${cfg.ledger.kind === 'ain' ? ` (${cfg.ledger.ain!.providerUrl})` : ''}   roles: ${cfg.roles.join(',')}   peers: ${cfg.peers.length}`);
    if (!cfg.operatorPasswordHash) {
      console.log(`  ${everyInterface ? '! ' : ''}this node has no operator password yet — set one with \`ainize login\`${everyInterface ? ' NOW: it is reachable from every interface' : ''}`);
      if (opts.home) console.log(`    claiming it from another machine needs the one-time token in ${setupTokenPath(opts.home)}`);
    }
  }
  // The same two facts in the event log, where `ainize logs` and the console can see them.
  if (!cfg.operatorPasswordHash) {
    market.log(everyInterface ? 'warn' : 'info', 'auth', `this node has no operator password: it is unclaimed${everyInterface ? ` and bound to ${cfg.host} (every interface)` : ' (loopback only)'} — run \`ainize login\` to claim it`);
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
  // A config written before 2026-09 still carries `verifier.stake`. Nothing was ever escrowed or slashed for it, so
  // the node ignores it and says so once — an operator must not go on believing money is at risk (item 127).
  if (cfg.verifier?.stake !== undefined) {
    market.log('warn', 'config', `verifier.stake ("${cfg.verifier.stake}") is ignored: no deposit is escrowed, transferred or slashed anywhere in this product. An attestation is backed by this node's signature on a permanent public record, and any node can challenge it. Remove the key from ${join(dirname(cfg.dataDir), 'config.json')}.`);
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

  return {
    cfg, market, ledger, store, verifier, drive, teach, server, url,
    async stop() {
      // The record of a clean shutdown (item 131): without this line a SIGKILL and a `ainize stop` left byte-identical
      // histories, and the next start could not tell an operator which of the two had happened.
      market.log('info', 'node', 'node stopping (clean shutdown)');
      try { store.set('node.stopped_at', String(Date.now())); } catch { /* the database may already be gone */ }
      clearInterval(watchdog);
      clearInterval(retention);
      clearInterval(diskWatch);
      clearInterval(uploadSweep);
      clearInterval(driveSync);
      market.payouts.stop();
      await Promise.all([verifier?.stop(), p2p.stop(), teach?.stop()]);
      await new Promise<void>((res) => server.close(() => res()));
      await ledger.close();
      store.close();
    },
  };
}
