/**
 * Runs hosted agents and hands agents.ts an upstream URL for each — the one thing the proxy needs.
 *
 *   • prompt agents run IN this process: one loopback HTTP server holds a runtime router per agent at `/a/<id>`.
 *     A loopback hop costs nothing next to a model call, and it lets agents.ts treat every agent the same way
 *     (card rewrite, rate limit, body cap, attribution, call counting, streaming pipe) with no second code path.
 *   • code agents (tools, handler) run in Docker (hosted-agent-docker.ts). The image is built when the spec is
 *     saved; the container starts on the first call, stops after `idleStopMs`, and at most `maxRunning` run at
 *     once (the least recently used is stopped to make room).
 *
 * A failed build leaves the previous version serving: an update is not live until its image exists.
 */
import express from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Router } from 'express';
import { createHostedAgentRuntimeRouter } from './hosted-agent-runtime/hostedAgentRuntimeApp.js';
import type { HostedAgentGateway } from './hosted-agent-gateway.js';
import type { HostedAgentDocker } from './hosted-agent-docker.js';
import { hostedAgentPopPrivateKeyOf } from './hosted-agent-pop.js';
import type { HostedAgentSecretStore } from './hosted-agent-secrets.js';
import type { HostedAgentTaskFile } from './hosted-agent-task-store.js';
import { hostedAgentRuntimeSpecOf, hostedAgentUsesCode, type HostedAgentSpec, type HostedAgentStatus } from './hosted-agent-types.js';

export interface HostedAgentHostOptions {
  gateway: HostedAgentGateway;
  secrets: HostedAgentSecretStore;
  /** Null when this node does not run code agents. */
  docker: HostedAgentDocker | null;
  /** Fixed bridge gateway port for hosts with an explicit firewall rule. Defaults to an ephemeral port. */
  dockerGatewayPort?: number;
  gatewaySocketPath?: string;
  idleStopMs: number;
  maxRunning: number;
  /** Operator allowlist. Agent code or incoming messages cannot enable their own schedule. */
  scheduledAgentIds?: string[];
  scheduleIntervalMs?: number;
  /** Where prompt agents keep their A2A tasks across restarts (hosted-agent-task-store.ts). Absent: in memory. */
  tasks?: HostedAgentTaskFile;
  log: (level: 'info' | 'warn' | 'error', message: string) => void;
}

interface HostedAgentState {
  status: HostedAgentStatus;
  error: string | null;
  /** The version whose image exists (code) or whose router is mounted (prompt). */
  liveVersion: number | null;
  buildLog: string[];
  upstream: string | null;
  token: string | null;
  lastUsed: number;
  starting: Promise<string> | null;
}

const HOSTED_AGENT_START_TIMEOUT_MS = 30_000;
const HOSTED_AGENT_BUILD_LOG_LINES = 200;

export function hostedAgentScheduleIds(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  const ids = [...new Set(value.split(',').map(id => id.trim()))];
  if (ids.length > 32 || ids.some(id => !/^[a-z0-9][a-z0-9-]{0,39}$/.test(id))) throw new Error('invalid hosted agent schedule allowlist');
  return ids;
}

export class HostedAgentHost {
  private readonly state = new Map<string, HostedAgentState>();
  private readonly specs = new Map<string, HostedAgentSpec>();
  private readonly routers = new Map<string, Router>();
  private server: Server | null = null;
  private loopbackBase = '';
  private loopbackGateway = '';
  private dockerGateway = '';
  private sweeper: NodeJS.Timeout | null = null;
  private scheduler: NodeJS.Timeout | null = null;
  private scheduling = false;
  private stopping = false;
  private readonly scheduledBusy = new Set<string>();
  private readonly scheduleErrors = new Set<string>();
  private startQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly o: HostedAgentHostOptions) {}

  get dockerEnabled(): boolean {
    return this.o.docker !== null;
  }

  async start(specs: HostedAgentSpec[]): Promise<void> {
    this.stopping = false;
    const app = express();
    app.disable('x-powered-by');
    app.use('/a/:id', (req, res, next) => {
      const router = this.routers.get(String(req.params.id));
      if (!router) return res.status(404).json({ error: 'no such agent' });
      router(req, res, next);
    });
    this.server = createServer(app);
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', () => resolve()));
    this.loopbackBase = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    this.loopbackGateway = await this.o.gateway.listen('127.0.0.1');
    if (this.o.docker) {
      try {
        const bridge = await this.o.docker.ensureNetwork();
        this.dockerGateway = this.o.gatewaySocketPath
          ? await this.o.gateway.listenUnix(this.o.gatewaySocketPath)
          : await this.o.gateway.listen(bridge, this.o.dockerGatewayPort);
        await this.o.docker.removeOrphans();
      } catch (e) {
        this.o.log('error', `hosted agents: docker unusable, code agents disabled — ${(e as Error).message}`);
        this.o.docker = null;
      }
    }
    for (const spec of specs) this.apply(spec, { boot: true });
    this.sweeper = setInterval(() => { void this.sweep(); }, 30_000);
    this.sweeper.unref();
    if (this.o.scheduledAgentIds?.length) {
      this.scheduler = setInterval(() => { void this.runScheduled(); }, this.o.scheduleIntervalMs ?? 30_000);
      this.scheduler.unref();
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.scheduler) clearInterval(this.scheduler);
    if (this.sweeper) clearInterval(this.sweeper);
    await this.startQueue;
    if (this.o.docker) await Promise.all([...this.state.entries()].filter(([, s]) => s.upstream && !s.upstream.startsWith(this.loopbackBase)).map(([id]) => this.o.docker!.stop(id)));
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
    await this.o.gateway.close();
    this.o.tasks?.close();
  }

  /** Create or update. Prompt agents are live on return; code agents build in the background. */
  apply(spec: HostedAgentSpec, opts: { boot?: boolean } = {}): void {
    this.specs.set(spec.id, spec);
    const prior = this.state.get(spec.id);
    const st: HostedAgentState = prior ?? { status: 'building', error: null, liveVersion: null, buildLog: [], upstream: null, token: null, lastUsed: 0, starting: null };
    this.state.set(spec.id, st);

    if (!hostedAgentUsesCode(spec.mode)) {
      // A prompt agent that used to be a code agent: its container goes.
      if (st.upstream && !st.upstream.startsWith(this.loopbackBase)) void this.stopContainer(spec.id);
      if (st.token) this.o.gateway.revoke(st.token);
      st.token = this.o.gateway.issue(spec.id);
      this.routers.set(spec.id, createHostedAgentRuntimeRouter({
        spec: hostedAgentRuntimeSpecOf(spec),
        gateway: { url: this.loopbackGateway, token: st.token },
        secrets: {},
        // The PoP private key signs delegated reads (hostedAgentDelegatedReads.ts); it is not one of `secrets`.
        popKey: hostedAgentPopPrivateKeyOf(this.o.secrets, spec.id),
        module: null,
        cardUrl: `${this.loopbackBase}/a/${spec.id}`,
        // The same store for every router this agent gets in this process: an update keeps its tasks.
        taskStore: this.o.tasks?.forAgent(spec.id),
        log: (...args) => this.o.log('info', `agent ${spec.id}: ${args.map(String).join(' ')}`),
      }));
      Object.assign(st, { status: 'ready', error: null, liveVersion: spec.version, upstream: `${this.loopbackBase}/a/${spec.id}` });
      return;
    }

    this.routers.delete(spec.id);
    if (st.upstream?.startsWith(this.loopbackBase)) st.upstream = null;
    if (!this.o.docker) {
      Object.assign(st, { status: 'failed', error: 'this node does not run code agents (Docker is not enabled)' });
      return;
    }
    st.status = st.liveVersion === null ? 'building' : st.status;
    st.error = null;
    void this.build(spec, opts.boot === true);
  }

  private async build(spec: HostedAgentSpec, boot: boolean): Promise<void> {
    const st = this.state.get(spec.id)!;
    try {
      const log = await this.o.docker!.buildAgent(spec.id, spec.version, spec.files);
      if (this.specs.get(spec.id)?.version !== spec.version) return; // superseded while building
      st.buildLog = log.split('\n').slice(-HOSTED_AGENT_BUILD_LOG_LINES);
      const wasRunning = !!st.upstream;
      Object.assign(st, { status: 'ready', error: null, liveVersion: spec.version });
      // The new image is live from the next start; a running container of the old one is replaced now.
      if (wasRunning) await this.stopContainer(spec.id);
      if (!boot) this.o.log('info', `hosted agent ${spec.id} v${spec.version} built`);
    } catch (e) {
      if (this.specs.get(spec.id)?.version !== spec.version) return;
      const err = e as Error & { buildLog?: string };
      st.buildLog = (err.buildLog ?? err.message).split('\n').slice(-HOSTED_AGENT_BUILD_LOG_LINES);
      // An older version that built keeps serving; the error says why the new one is not live.
      st.status = st.liveVersion === null ? 'failed' : 'ready';
      st.error = `v${spec.version} did not build: ${err.message.split('\n')[0]}`;
      this.o.log('warn', `hosted agent ${spec.id}: ${st.error}`);
    }
  }

  /** Called only by the authenticated management API; the scoped token never reaches its response. */
  async manage(id: string, action: string, params: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
    const upstream = await this.resolve(id);
    const token = this.state.get(id)?.token;
    if (!upstream || !token) return { status: 503, body: { error: 'agent_unavailable' } };
    const response = await fetch(upstream.replace(/\/+$/, '') + '/_ainize/manage', {
      method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify({ action, params }), signal: AbortSignal.timeout(120_000), redirect: 'error',
    });
    return { status: response.status, body: await response.json() };
  }

  async remove(id: string): Promise<void> {
    this.scheduledBusy.delete(id);
    this.scheduleErrors.delete(id);
    const st = this.state.get(id);
    this.routers.delete(id);
    this.specs.delete(id);
    this.state.delete(id);
    this.o.tasks?.removeAgent(id);
    this.o.gateway.revokeAgent(id);
    if (st && this.o.docker) {
      await this.o.docker.stop(id);
      await this.o.docker.removeImages(id);
    }
  }

  /** Pick up new secret values: a running container is stopped and the next call starts it with them. */
  async restart(id: string): Promise<void> {
    const st = this.state.get(id);
    if (st?.upstream && !st.upstream.startsWith(this.loopbackBase)) await this.stopContainer(id);
  }

  has(id: string): boolean {
    return this.specs.has(id);
  }

  status(id: string): { status: HostedAgentStatus; error: string | null; liveVersion: number | null } | null {
    const st = this.state.get(id);
    return st ? { status: st.status, error: st.error, liveVersion: st.liveVersion } : null;
  }

  async logs(id: string): Promise<string[]> {
    const st = this.state.get(id);
    const spec = this.specs.get(id);
    if (!st || !spec) return [];
    const out = [...st.buildLog.map((l) => `[build] ${l}`)];
    if (st.error) out.push(`[status] ${st.error}`);
    if (this.o.docker && hostedAgentUsesCode(spec.mode) && st.upstream) out.push(...(await this.o.docker.logs(id)).map((l) => `[run] ${l}`));
    return out.slice(-HOSTED_AGENT_BUILD_LOG_LINES);
  }

  /**
   * The upstream to forward a call to, starting the container when it is not running. Null when the agent cannot
   * answer (unknown, failed build); throws when a start was attempted and failed.
   */
  async resolve(id: string): Promise<string | null> {
    const st = this.state.get(id);
    const spec = this.specs.get(id);
    if (!st || !spec || st.liveVersion === null) return null;
    st.lastUsed = Date.now();
    if (st.upstream) return st.upstream;
    if (!hostedAgentUsesCode(spec.mode) || !this.o.docker) return null;
    if (!st.starting) {
      const start = this.startQueue.then(() => {
        if (this.stopping || !this.specs.has(id)) throw new Error('hosted agent is stopping');
        return this.startContainer(spec, st);
      });
      this.startQueue = start.then(() => {}, () => {});
      st.starting = start.finally(() => { st.starting = null; });
    }
    return st.starting;
  }

  private async startContainer(spec: HostedAgentSpec, st: HostedAgentState): Promise<string> {
    await this.makeRoom(spec.id);
    const token = this.o.gateway.issue(spec.id);
    const version = st.liveVersion!;
    const runtimeSpec = { ...hostedAgentRuntimeSpecOf(spec), version };
    const env: Record<string, string> = {
      AINIZE_AGENT_SPEC: JSON.stringify(runtimeSpec),
      AINIZE_GATEWAY_URL: this.dockerGateway,
      AINIZE_AGENT_TOKEN: token,
    };
    for (const [name, value] of Object.entries(this.o.secrets.reveal(spec.id, spec.secretNames))) env[`AINIZE_SECRET_${name}`] = value;
    // The PoP private key travels like a secret (env file, scrubbed by the entry point) and never in the spec JSON.
    const popKey = hostedAgentPopPrivateKeyOf(this.o.secrets, spec.id);
    if (popKey) env.AINIZE_POP_JWK = popKey;
    try {
      const { upstream } = await this.o.docker!.run(spec.id, version, env);
      await waitForHostedAgentHealth(upstream, HOSTED_AGENT_START_TIMEOUT_MS);
      if (st.token) this.o.gateway.revoke(st.token);
      Object.assign(st, { upstream, token });
      this.o.log('info', `hosted agent ${spec.id} v${version} started`);
      return upstream;
    } catch (e) {
      this.o.gateway.revoke(token);
      await this.o.docker!.stop(spec.id);
      throw e;
    }
  }

  private async stopContainer(id: string): Promise<void> {
    this.scheduledBusy.delete(id);
    const st = this.state.get(id);
    if (st?.token) { this.o.gateway.revoke(st.token); st.token = null; }
    if (st) st.upstream = null;
    await this.o.docker?.stop(id);
  }

  private running(): [string, HostedAgentState][] {
    return [...this.state.entries()].filter(([, s]) => s.upstream && !s.upstream.startsWith(this.loopbackBase));
  }

  private async makeRoom(forId: string): Promise<void> {
    const running = this.running().filter(([id]) => id !== forId).sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    while (running.length >= this.o.maxRunning) {
      const candidate = running.findIndex(([id]) => !this.scheduledBusy.has(id));
      if (candidate < 0) throw new Error('hosted agent capacity is busy');
      const [id] = running.splice(candidate, 1)[0]!;
      this.o.log('info', `hosted agent ${id} stopped to make room`);
      await this.stopContainer(id);
    }
  }

  /** Stop containers nobody has called for `idleStopMs`. */
  async sweep(now = Date.now()): Promise<void> {
    for (const [id, st] of this.running()) {
      if (!this.scheduledBusy.has(id) && now - st.lastUsed > this.o.idleStopMs) await this.stopContainer(id);
    }
  }

  /** Short polls only. The runtime holds single-flight state; durable job leases cover node restarts. */
  async runScheduled(): Promise<void> {
    if (this.scheduling || this.stopping) return;
    this.scheduling = true;
    try {
      for (const id of this.o.scheduledAgentIds ?? []) {
        if (this.stopping) break;
        const spec = this.specs.get(id), st = this.state.get(id);
        if (spec?.mode !== 'handler' || st?.status !== 'ready') continue;
        this.scheduledBusy.add(id); // Includes start and observation, so eviction cannot race the poll.
        try {
          const upstream = await this.resolve(id), token = this.state.get(id)?.token;
          if (!upstream || !token || this.stopping) throw new Error('scheduled agent unavailable');
          const response = await fetch(`${upstream}/_ainize/tick`, { method: 'POST',
            headers: { authorization: 'Bearer ' + token }, redirect: 'error', signal: AbortSignal.timeout(5000) });
          if (response.status === 404) this.scheduledBusy.delete(id); // Runtime confirms there is no tick hook.
          if (!response.ok) throw new Error('tick refused');
          const status = await response.json() as { running?: unknown; failed?: unknown };
          if (typeof status.running !== 'boolean') throw new Error('invalid tick status');
          if (!status.running) this.scheduledBusy.delete(id);
          if (status.failed === true) throw new Error('tick failed');
          this.scheduleErrors.delete(id);
        } catch {
          // A timeout alone is not evidence that execution ended. Keep the eviction pin until a
          // later tick response or Docker itself confirms the runtime is no longer running.
          try {
            if (!st.upstream || (this.o.docker && !(await this.o.docker.isRunning(id)))) await this.stopContainer(id);
          } catch { /* Unknown Docker status must not restart an active step. */ }
          if (!this.scheduleErrors.has(id)) this.o.log('warn', `scheduled agent ${id} needs another status check`);
          this.scheduleErrors.add(id);
        }
      }
    } finally { this.scheduling = false; }
  }
}

export async function waitForHostedAgentHealth(upstream: string, timeoutMs: number): Promise<void> {
  const until = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < until) {
    try {
      const r = await fetch(`${upstream}/health`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return;
      last = `health answered ${r.status}`;
    } catch (e) {
      last = (e as Error).message;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`agent did not come up within ${timeoutMs / 1000}s (${last})`);
}
