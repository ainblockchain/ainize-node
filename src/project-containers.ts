/**
 * Long-running project containers — `kind: service` (the repo's Dockerfile) and `kind: nextjs` (a Dockerfile the
 * node writes, project-manifest.ts) — built and run with the boundary hosted code agents get (hosted-agent-docker.ts):
 * the `--internal` network whose only exit is the node's gateway, no capabilities, no new privileges, a read-only
 * root with a tmpfs `/tmp`, memory/cpu/pid limits, gVisor when configured. The node reaches the container on its
 * internal address and proxies `/svc/<projectId>/…` to it (project-routes.ts); nothing else does.
 *
 * ZERO-DOWNTIME SWAP. A redeploy builds and starts the new container beside the old one, polls `healthcheck`
 * until it answers 200, and only then points the project at it and removes the old one. A build or health failure
 * removes the new container and leaves the old one serving — a broken push never takes a running service down.
 *
 * Containers belong to this process: their gateway tokens die with it, so a node start removes the ones a
 * previous process left and redeploys what was `ready` (projects.ts `ProjectWorker.recover`).
 */
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { hostedAgentDockerExec, type HostedAgentDockerResult } from './hosted-agent-docker.js';
import type { RunGrant } from './hosted-agent-gateway.js';
import { nextjsDockerfile, type ProjectManifest } from './project-manifest.js';

export const PROJECT_CONTAINER_LABEL = 'ainize.project';
export const PROJECT_HEALTH_TIMEOUT_MS = 120_000;
const PROJECT_IMAGE_PREFIX = 'ainize-proj-';

export interface ProjectContainersOptions {
  /** The hosted-agent internal network. */
  network: string;
  /** Issues/revokes a run grant for egress through the gateway, and the gateway's bridge URL once listening. */
  gateway: { issueRun: (grant: RunGrant) => string; revokeRun: (token: string) => void };
  gatewayUrl: () => string | null;
  /** This node's own listener (loopback) — where a container's `/api/decide`, `/api/chat`, `/v1` are answered. */
  selfUrl: () => string;
  publicUrl: () => string | undefined;
  /** Where env files live for the instant between being written and `docker run` reading them. */
  workDir: string;
  runtime?: string;
  memory: string;
  cpus: number;
  pidsLimit: number;
  buildTimeoutMs: number;
  healthTimeoutMs?: number;
  log: (level: 'info' | 'warn' | 'error', message: string) => void;
  exec?: (args: string[], timeoutMs?: number) => Promise<HostedAgentDockerResult>;
}

export interface ProjectContainer { projectId: string; deploymentId: string; name: string; sha: string; upstream: string; token: string; port: number }

export const PROJECT_CONTAINER_DEFAULTS = { memory: '512m', cpus: 1, pidsLimit: 256, buildTimeoutMs: 600_000 } as const;

export const projectImageTag = (projectId: string, sha: string) => `${PROJECT_IMAGE_PREFIX}${projectId.toLowerCase()}:${sha.slice(0, 12)}`;
export const projectContainerName = (projectId: string, sha: string) => `${PROJECT_IMAGE_PREFIX}${projectId.toLowerCase()}-${sha.slice(0, 12)}`;

export class ProjectContainers {
  private readonly live = new Map<string, ProjectContainer>();
  private readonly exec: (args: string[], timeoutMs?: number) => Promise<HostedAgentDockerResult>;

  constructor(private readonly o: ProjectContainersOptions) {
    this.exec = o.exec ?? hostedAgentDockerExec;
  }

  /** The running container of a project, if this process started one. */
  current(projectId: string): ProjectContainer | null { return this.live.get(projectId) ?? null; }
  list(): ProjectContainer[] { return [...this.live.values()]; }

  /** Containers a previous node process left: their tokens died with it, so they go. */
  async removeOrphans(): Promise<void> {
    const r = await this.exec(['ps', '-aq', '--filter', `label=${PROJECT_CONTAINER_LABEL}`]);
    const ids = r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    if (ids.length) await this.exec(['rm', '-f', ...ids], 60_000);
  }

  async stopAll(): Promise<void> {
    for (const c of this.live.values()) await this.remove(c).catch(() => undefined);
    this.live.clear();
  }

  async stop(projectId: string): Promise<void> {
    const c = this.live.get(projectId);
    if (!c) return;
    this.live.delete(projectId);
    await this.remove(c);
    await this.exec(['image', 'rm', '-f', projectImageTag(projectId, c.sha)], 60_000).catch(() => undefined);
  }

  /**
   * Build from `dir` and start it; resolves with the new container once healthy (the previous one is gone by
   * then). Rejects — with the old container still serving — on a build, start or health failure. `say` receives
   * every line of build and run output for the deployment log.
   */
  async deploy(p: { projectId: string; deploymentId: string; sha: string }, dir: string, manifest: ProjectManifest, env: Record<string, string>, say: (line: string) => void): Promise<ProjectContainer> {
    const kind = manifest.kind;
    if (kind !== 'service' && kind !== 'nextjs') throw new Error(`kind "${kind}" does not run as a container`);
    const gatewayUrl = this.o.gatewayUrl();
    if (!gatewayUrl) throw new Error('this node runs no project containers (Docker is not enabled)');
    const context = resolve(dir, manifest.build.context);
    if (!context.startsWith(resolve(dir))) throw new Error('build.context escapes the repository');
    let dockerfile = resolve(dir, manifest.build.dockerfile);
    if (!dockerfile.startsWith(resolve(dir))) throw new Error('build.dockerfile escapes the repository');
    if (kind === 'nextjs') {
      // The repo's own Dockerfile wins when it has one; otherwise the node's.
      if (!existsSync(dockerfile)) {
        dockerfile = join(dir, '.ainize.nextjs.Dockerfile');
        writeFileSync(dockerfile, nextjsDockerfile(manifest.port));
        say('[ainize] no Dockerfile — building Next.js with the node\'s (node:20-alpine, npm ci && npm run build, npm start)');
      }
    } else if (!existsSync(dockerfile)) {
      throw new Error(`${manifest.build.dockerfile} is not in the repository`);
    }
    const tag = projectImageTag(p.projectId, p.sha);
    say(`[ainize] docker build -t ${tag} -f ${manifest.build.dockerfile} ${manifest.build.context}`);
    const build = await this.stream(['build', '-t', tag, '--label', `${PROJECT_CONTAINER_LABEL}=${p.projectId}`, '-f', dockerfile, context], this.o.buildTimeoutMs, say);
    if (build !== 0) throw new Error(`docker build exited ${build}`);

    const name = projectContainerName(p.projectId, p.sha);
    await this.exec(['rm', '-f', name], 30_000);
    const runId = `project-${p.projectId}-${randomBytes(4).toString('hex')}`;
    const token = this.o.gateway.issueRun({ id: runId, allowedHosts: this.allowedHosts(), selfUrl: this.o.selfUrl() });
    const base = `${gatewayUrl}/t/${token}`;
    const full = this.environment(env, manifest, base, gatewayUrl, token);
    mkdirSync(this.o.workDir, { recursive: true });
    const envFile = join(this.o.workDir, `project-env-${runId}`);
    writeFileSync(envFile, Object.entries(full).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o600 });
    let r: HostedAgentDockerResult;
    try {
      say(`[ainize] docker run ${name} (port ${manifest.port})`);
      r = await this.exec([
        'run', '-d', '--name', name,
        '--label', `${PROJECT_CONTAINER_LABEL}=${p.projectId}`,
        '--label', `${PROJECT_CONTAINER_LABEL}.deployment=${p.deploymentId}`,
        '--network', this.o.network,
        '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges',
        '--read-only',
        '--tmpfs', '/tmp:rw,nosuid,size=64m',
        '--memory', this.o.memory,
        '--memory-swap', this.o.memory,
        '--cpus', String(this.o.cpus),
        '--pids-limit', String(this.o.pidsLimit),
        ...(this.o.runtime ? ['--runtime', this.o.runtime] : []),
        '--env-file', envFile,
        tag,
      ], 60_000);
    } finally {
      rmSync(envFile, { force: true });
    }
    const next: ProjectContainer = { projectId: p.projectId, deploymentId: p.deploymentId, name, sha: p.sha, upstream: '', token, port: manifest.port };
    if (r.code !== 0) {
      this.o.gateway.revokeRun(token);
      throw new Error(`docker run failed: ${r.stderr.trim().slice(0, 500)}`);
    }
    try {
      const ip = (await this.exec(['inspect', name, '--format', `{{(index .NetworkSettings.Networks "${this.o.network}").IPAddress}}`])).stdout.trim();
      if (!ip) throw new Error(`container ${name} has no address on ${this.o.network}`);
      next.upstream = `http://${ip}:${manifest.port}`;
      say(`[ainize] waiting for ${manifest.healthcheck} to answer 200`);
      await this.waitHealthy(next.upstream, manifest.healthcheck, name, say);
    } catch (e) {
      const logs = await this.exec(['logs', '--tail', '50', name], 15_000).catch(() => null);
      if (logs) for (const line of `${logs.stdout}${logs.stderr}`.split('\n').filter(Boolean)) say(`[run] ${line}`);
      await this.remove(next).catch(() => undefined);
      throw e;
    }
    const prior = this.live.get(p.projectId);
    this.live.set(p.projectId, next);
    if (prior && prior.name !== next.name) {
      say(`[ainize] healthy — replacing ${prior.name}`);
      await this.remove(prior).catch((err: Error) => this.o.log('warn', `project ${p.projectId}: could not remove ${prior.name}: ${err.message}`));
      if (prior.sha !== next.sha) await this.exec(['image', 'rm', '-f', projectImageTag(p.projectId, prior.sha)], 60_000).catch(() => undefined);
    } else {
      say('[ainize] healthy');
    }
    return next;
  }

  private async remove(c: ProjectContainer): Promise<void> {
    this.o.gateway.revokeRun(c.token);
    await this.exec(['rm', '-f', c.name], 30_000);
  }

  private async waitHealthy(upstream: string, path: string, name: string, say: (line: string) => void): Promise<void> {
    const deadline = Date.now() + (this.o.healthTimeoutMs ?? PROJECT_HEALTH_TIMEOUT_MS);
    let last = '';
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`${upstream}${path}`, { signal: AbortSignal.timeout(3000), redirect: 'manual' });
        if (r.status === 200) return;
        last = `HTTP ${r.status}`;
      } catch (e) { last = (e as Error).message; }
      const state = (await this.exec(['inspect', name, '--format', '{{.State.Status}}'], 10_000)).stdout.trim();
      if (state && state !== 'running' && state !== 'created') throw new Error(`container ${state} before ${path} answered 200 (${last})`);
      await new Promise((r) => setTimeout(r, 1000));
    }
    say(`[ainize] ${path} did not answer 200 within ${this.o.healthTimeoutMs ?? PROJECT_HEALTH_TIMEOUT_MS}ms (${last})`);
    throw new Error(`healthcheck ${path} failed: ${last}`);
  }

  private allowedHosts(): string[] {
    const hosts = ['ainize.ai'];
    const pub = this.publicHost();
    if (pub && !hosts.includes(pub)) hosts.push(pub);
    return hosts;
  }

  private publicHost(): string | null {
    try { const u = this.o.publicUrl(); return u ? new URL(u).hostname.toLowerCase() : null; } catch { return null; }
  }

  /** The manifest's env under the project's, then what the sandbox contract promises a script (run-sandbox.ts). */
  private environment(env: Record<string, string>, manifest: ProjectManifest, base: string, gatewayUrl: string, token: string): Record<string, string> {
    const reserved = new Set(['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy', 'AINIZE_API_URL', 'PATH', 'PORT', 'HOSTNAME']);
    const out: Record<string, string> = {};
    const pub = this.publicHost();
    for (const [k, v] of Object.entries({ ...manifest.env, ...env })) {
      if (reserved.has(k) || /[\r\n\0]/.test(v)) continue;
      out[k] = v;
      if (!pub) continue;
      try {
        const u = new URL(v);
        if ((u.protocol === 'https:' || u.protocol === 'http:') && u.hostname.toLowerCase() === pub && /^\/(?:api\/decide|api\/chat|v1(?:\/|$))/.test(u.pathname)) out[k] = `${base}${u.pathname}${u.search}`;
      } catch { /* not a URL */ }
    }
    out.AINIZE_DECIDE_URL ??= `${base}/api/decide`;
    out.AINIZE_CHAT_URL ??= `${base}/api/chat`;
    out.AINIZE_API_URL = base;
    out.PORT = String(manifest.port);
    out.HOSTNAME = '0.0.0.0';
    const proxy = new URL(gatewayUrl);
    proxy.username = 'run';
    proxy.password = token;
    out.HTTPS_PROXY = proxy.href;
    out.https_proxy = proxy.href;
    return out;
  }

  /** docker with its output streamed line by line into the deployment log. */
  private stream(args: string[], timeoutMs: number, say: (line: string) => void): Promise<number> {
    return new Promise((resolveExit) => {
      const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let buf = '';
      const feed = (c: Buffer) => {
        buf += c.toString('utf8');
        let at: number;
        while ((at = buf.indexOf('\n')) !== -1) { const line = buf.slice(0, at).trimEnd(); if (line) say(`[build] ${line}`); buf = buf.slice(at + 1); }
      };
      child.stdout.on('data', feed);
      child.stderr.on('data', feed);
      const timer = setTimeout(() => { say(`[ainize] build timed out after ${timeoutMs}ms`); child.kill('SIGKILL'); }, timeoutMs);
      child.on('error', (e) => { say(`[ainize] docker could not start: ${e.message}`); });
      child.on('close', (code) => { clearTimeout(timer); if (buf.trim()) say(`[build] ${buf.trim()}`); resolveExit(code ?? 1); });
    });
  }
}
