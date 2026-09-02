/**
 * Assemble and run a marketplace node: ledger + store + blobs + runtime + market + p2p + verifier + HTTP.
 */
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import { AinLedger, LocalLedger, saveConfig, validateConfig, type Ledger, type NodeConfig } from '@ngram/core';
import { buildApi } from './api.js';
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
  const p2p = new P2P({ identity: cfg.identity, ledger, store, selfInfo: () => market.selfInfo(), log: (l, k, m, d) => market.log(l, k, m, null, d) }, cfg.peers, cfg.gossipIntervalMs, selfUrl);
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
  app.use(buildApi({ market, verifier, drive, teach: teach ?? undefined, saveConfig: () => { if (opts.home) saveConfig(cfg, opts.home); } }));

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
  const url = opts.listen === false ? selfUrl : `http://${cfg.host === '0.0.0.0' ? 'localhost' : cfg.host}:${(server.address() as { port: number }).port}`;

  if (!opts.quiet) {
    console.log(`ainize node "${cfg.name}" listening on ${url}`);
    console.log(`  identity : ${cfg.identity.address}`);
    console.log(`  ledger   : ${ledger.kind}${cfg.ledger.kind === 'ain' ? ` (${cfg.ledger.ain!.providerUrl})` : ''}   roles: ${cfg.roles.join(',')}   peers: ${cfg.peers.length}`);
  }
  market.log('info', 'node', `node started (${ledger.kind} ledger, roles ${cfg.roles.join('/')})`);
  for (const p of problems) market.log('warn', 'config', `${p.key}: ${p.message}`);
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
  const watchdog = setInterval(() => { market.watchdog().catch(() => undefined); market.reconcileSupersedes().catch(() => undefined); }, 20_000);
  watchdog.unref?.();
  const driveSync = setInterval(() => { drive.sync().catch(() => undefined); }, 15_000);
  driveSync.unref?.();
  setTimeout(() => { drive.sync().catch(() => undefined); }, 2000).unref?.();

  return {
    cfg, market, ledger, store, verifier, drive, teach, server, url,
    async stop() {
      clearInterval(watchdog);
      clearInterval(driveSync);
      market.payouts.stop();
      await Promise.all([verifier?.stop(), p2p.stop(), teach?.stop()]);
      await new Promise<void>((res) => server.close(() => res()));
      await ledger.close();
      store.close();
    },
  };
}
