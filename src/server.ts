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
import { AinLedger, LocalLedger, saveConfig, type Ledger, type NodeConfig } from '@ngram/core';
import { buildApi } from './api.js';
import { BlobStore } from './blobs.js';
import { Market } from './market.js';
import { P2P } from './p2p.js';
import { Runtime } from './runtime.js';
import { Store } from './store.js';
import { Verifier } from './verifier.js';

export interface RunningNode {
  cfg: NodeConfig;
  market: Market;
  ledger: Ledger;
  store: Store;
  verifier: Verifier | null;
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
}

function defaultWebDist(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', '..', 'web', 'dist');
}

export async function startNode(cfg: NodeConfig, opts: StartOptions = {}): Promise<RunningNode> {
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
  const verifier = cfg.roles.includes('verifier') ? new Verifier(market, cfg.verifier?.intervalMs ?? 5000) : null;

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);
  app.use(compression());
  app.use(cookieParser());
  app.use(express.json({ limit: '5mb' }));
  app.use((req, res, next) => {
    res.setHeader('access-control-allow-origin', req.headers.origin ?? '*');
    res.setHeader('access-control-allow-credentials', 'true');
    res.setHeader('access-control-allow-headers', 'content-type, authorization, x-payment, x-ngram-auth, x-ngram-buyer');
    res.setHeader('access-control-expose-headers', 'x-payment-required, x-payment-tx-hash, x-payment-currency, x-payment-response, x-content-sha256');
    res.setHeader('access-control-allow-methods', 'GET,POST,PATCH,DELETE,OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  app.use(buildApi({ market, verifier, saveConfig: () => { if (opts.home) saveConfig(cfg, opts.home); } }));

  const webDist = opts.webDist ?? defaultWebDist();
  if (opts.serveWeb !== false && existsSync(join(webDist, 'index.html'))) {
    app.use(express.static(webDist, { maxAge: '1h', index: false }));
    app.get(/^\/(?!api\/|x402\/|p2p\/).*/, (_req, res) => { res.sendFile(join(webDist, 'index.html')); });
  } else {
    app.get('/', (_req, res) => { res.type('text').send(`ngram node ${cfg.name} (${cfg.identity.address})\nAPI: /api/info  catalog: /api/catalog\nweb UI not built — run \`npm run build -w packages/web\``); });
  }

  const server = createServer(app);
  if (opts.listen !== false) {
    await new Promise<void>((res, rej) => { server.once('error', rej); server.listen(cfg.port, cfg.host, () => res()); });
  }
  const url = opts.listen === false ? selfUrl : `http://${cfg.host === '0.0.0.0' ? 'localhost' : cfg.host}:${(server.address() as { port: number }).port}`;

  if (!opts.quiet) {
    console.log(`ngram node "${cfg.name}" listening on ${url}`);
    console.log(`  identity : ${cfg.identity.address}`);
    console.log(`  ledger   : ${ledger.kind}${cfg.ledger.kind === 'ain' ? ` (${cfg.ledger.ain!.providerUrl})` : ''}   roles: ${cfg.roles.join(',')}   peers: ${cfg.peers.length}`);
  }
  market.log('info', 'node', `node started (${ledger.kind} ledger, roles ${cfg.roles.join('/')})`);

  // background loops
  await market.registerSelf().catch((e) => market.log('warn', 'node', `self-registration failed: ${(e as Error).message}`));
  p2p.start();
  verifier?.start();
  const watchdog = setInterval(() => { market.watchdog().catch(() => undefined); market.reconcileSupersedes().catch(() => undefined); }, 20_000);
  watchdog.unref?.();

  return {
    cfg, market, ledger, store, verifier, server, url,
    async stop() {
      clearInterval(watchdog);
      await Promise.all([verifier?.stop(), p2p.stop()]);
      await new Promise<void>((res) => server.close(() => res()));
      await ledger.close();
      store.close();
    },
  };
}
