/**
 * Docker for hosted agents that bring code — through the `docker` CLI, so the node needs no daemon SDK and an
 * operator can reproduce any step by hand.
 *
 * Two images:
 *   • the RUNTIME image (`ainize/hosted-agent-runtime:<context hash>`) — node 24, the A2A SDK, express and the
 *     compiled hosted-agent-runtime/ directory. Built on first need, and again whenever those files change.
 *   • one AGENT image per spec version — the runtime plus the owner's files, with `npm install --ignore-scripts`
 *     when a package.json is present.
 *
 * Containers run on an `--internal` network: no route out, except to the node's gateway on the bridge address.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface HostedAgentDockerOptions {
  /** The OCI runtime (`runsc` for gVisor). Empty uses Docker's default (runc) — a weaker boundary. */
  runtime?: string;
  memory: string;
  cpus: number;
  pidsLimit: number;
  network: string;
  buildTimeoutMs: number;
  /** Where build contexts are written. */
  workDir: string;
  /**
   * Repository of the runtime image. The tag is a hash of the build context, so a changed runtime — a new node
   * version, or a patched one that kept its version — builds a new image instead of reusing a stale one.
   */
  runtimeImage: string;
}

export const HOSTED_AGENT_DOCKER_DEFAULTS = {
  memory: '512m', cpus: 1, pidsLimit: 256, network: 'ainize-hosted-agents', buildTimeoutMs: 300_000,
};

const HOSTED_AGENT_CONTAINER_PREFIX = 'ainize-hosted-';
const HOSTED_AGENT_CONTAINER_PORT = 8080;

export const hostedAgentContainerName = (agentId: string) => `${HOSTED_AGENT_CONTAINER_PREFIX}${agentId}`;
export const hostedAgentImageTag = (agentId: string, version: number) => `ainize-hosted-agent/${agentId}:v${version}`;

export interface HostedAgentDockerResult { code: number; stdout: string; stderr: string }

export function hostedAgentDockerExec(args: string[], timeoutMs = 60_000): Promise<HostedAgentDockerResult> {
  return new Promise((resolve) => {
    execFile('docker', args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) || (err && code === 1 && !stderr ? err.message : '') });
    });
  });
}

/** Is there a Docker daemon this node may use? */
export async function hostedAgentDockerAvailable(): Promise<boolean> {
  return (await hostedAgentDockerExec(['version', '--format', '{{.Server.Version}}'], 10_000)).code === 0;
}

/** The directory holding the runtime sources this process was loaded from (`.js` in dist, `.ts` under tsx). */
const hostedAgentRuntimeSourceDir = () => join(dirname(fileURLToPath(import.meta.url)), 'hosted-agent-runtime');

/**
 * Write the runtime image's build context: compiled runtime files, a package.json pinning the SDK and express
 * to the versions this node was built with, and the Dockerfile.
 *
 * Under tsx (development, tests) the sources are TypeScript; they are transpiled here with the compiler from
 * devDependencies. A published node ships `.js` and never reaches that branch.
 */
export async function prepareHostedAgentRuntimeContext(dir: string): Promise<string> {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const src = hostedAgentRuntimeSourceDir();
  const files = readdirSync(src).filter((f) => /\.(js|ts)$/.test(f) && !f.endsWith('.d.ts'));
  const needsTranspile = files.some((f) => f.endsWith('.ts'));
  const ts = needsTranspile ? (await import('typescript')).default : null;
  for (const f of files) {
    if (f.endsWith('.js')) { copyFileSync(join(src, f), join(dir, f)); continue; }
    const out = ts!.transpileModule(readFileSync(join(src, f), 'utf8'), {
      compilerOptions: { module: ts!.ModuleKind.ESNext, target: ts!.ScriptTarget.ES2022, esModuleInterop: true },
    });
    writeFileSync(join(dir, f.replace(/\.ts$/, '.js')), out.outputText);
  }
  const own = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')) as { dependencies?: Record<string, string> };
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'ainize-hosted-agent-runtime',
    private: true,
    type: 'module',
    dependencies: {
      '@a2a-js/sdk': own.dependencies?.['@a2a-js/sdk'] ?? '^1.2.1',
      express: own.dependencies?.express ?? '^5.2.1',
      // PDFs an agent opens (hostedAgentPdf.ts): text extraction, and page rendering for scans.
      unpdf: own.dependencies?.unpdf ?? '^1.8.1',
      '@napi-rs/canvas': own.dependencies?.['@napi-rs/canvas'] ?? '^1.0.9',
    },
  }, null, 2));
  writeFileSync(join(dir, 'Dockerfile'), [
    'FROM node:24-slim',
    'WORKDIR /runtime',
    'COPY package.json ./',
    'RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force',
    'COPY *.js ./',
    'ENV NODE_ENV=production',
    'USER node',
    `EXPOSE ${HOSTED_AGENT_CONTAINER_PORT}`,
    'CMD ["node", "/runtime/hostedAgentRuntimeMain.js"]',
    '',
  ].join('\n'));
  const hash = createHash('sha256');
  for (const f of readdirSync(dir).sort()) hash.update(f).update('\0').update(readFileSync(join(dir, f))).update('\0');
  return hash.digest('hex').slice(0, 16);
}

export class HostedAgentDocker {
  constructor(private readonly o: HostedAgentDockerOptions) {}

  /** The internal network, created if missing. Returns its gateway address — where the node's gateway listens. */
  async ensureNetwork(): Promise<string> {
    const inspect = async () => hostedAgentDockerExec(['network', 'inspect', this.o.network, '--format', '{{(index .IPAM.Config 0).Gateway}}']);
    let r = await inspect();
    if (r.code !== 0) {
      const created = await hostedAgentDockerExec(['network', 'create', '--internal', '--label', 'ainize.hosted-agents=1', this.o.network]);
      if (created.code !== 0 && !/already exists/.test(created.stderr)) throw new Error(`docker network create failed: ${created.stderr.trim()}`);
      r = await inspect();
    }
    const gw = r.stdout.trim();
    if (r.code !== 0 || !gw) throw new Error(`cannot read the gateway of network ${this.o.network}: ${r.stderr.trim()}`);
    return gw;
  }

  private runtimeTag: Promise<string> | null = null;

  /** The runtime image's tag, building it when this runtime's hash has no image yet. Once per process. */
  ensureRuntimeImage(): Promise<string> {
    if (!this.runtimeTag) {
      this.runtimeTag = this.buildRuntimeImage();
      this.runtimeTag.catch(() => { this.runtimeTag = null; });
    }
    return this.runtimeTag;
  }

  private async buildRuntimeImage(): Promise<string> {
    const dir = join(this.o.workDir, 'runtime');
    const tag = `${this.o.runtimeImage}:${await prepareHostedAgentRuntimeContext(dir)}`;
    if ((await hostedAgentDockerExec(['image', 'inspect', tag], 20_000)).code === 0) return tag;
    const r = await hostedAgentDockerExec(['build', '-t', tag, '--label', 'ainize.hosted-agent-runtime=1', dir], this.o.buildTimeoutMs);
    if (r.code !== 0) throw new Error(`building ${tag} failed:\n${(r.stderr || r.stdout).slice(-4000)}`);
    return tag;
  }

  /** Build one agent version. Returns the build log; throws with the log's tail when the build fails. */
  async buildAgent(agentId: string, version: number, files: Record<string, string>): Promise<string> {
    const runtimeTag = await this.ensureRuntimeImage();
    const dir = join(this.o.workDir, 'build', `${agentId}-v${version}`);
    rmSync(dir, { recursive: true, force: true });
    for (const [name, content] of Object.entries(files)) {
      const target = join(dir, 'agent', name);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
    writeFileSync(join(dir, 'Dockerfile'), [
      `FROM ${runtimeTag}`,
      'USER root',
      'COPY agent/ /agent/',
      // --ignore-scripts: an install step is code too, and it runs with network access the container never gets.
      'RUN if [ -f /agent/package.json ]; then cd /agent && npm install --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force; fi \\',
      '  && chmod -R a+rX,go-w /agent',
      'USER node',
      '',
    ].join('\n'));
    const tag = hostedAgentImageTag(agentId, version);
    const r = await hostedAgentDockerExec(['build', '-t', tag, '--label', `ainize.hosted-agent=${agentId}`, dir], this.o.buildTimeoutMs);
    rmSync(dir, { recursive: true, force: true });
    const log = `${r.stdout}\n${r.stderr}`.trim();
    if (r.code !== 0) throw Object.assign(new Error(`build failed:\n${log.slice(-4000)}`), { buildLog: log });
    return log;
  }

  /**
   * Start one agent. Env goes through a 0600 file removed right after `docker run`, not through argv: argv is
   * readable by every user on the machine in the process table. Values are base64 so a newline cannot end one.
   */
  async run(agentId: string, version: number, env: Record<string, string>): Promise<{ upstream: string }> {
    const name = hostedAgentContainerName(agentId);
    await hostedAgentDockerExec(['rm', '-f', name], 30_000);
    const envFile = join(this.o.workDir, `env-${agentId}-${process.pid}`);
    mkdirSync(this.o.workDir, { recursive: true });
    writeFileSync(envFile, Object.entries(env).map(([k, v]) => `${k}=b64:${Buffer.from(v).toString('base64')}`).join('\n') + '\n', { mode: 0o600 });
    let r: HostedAgentDockerResult;
    try {
      r = await hostedAgentDockerExec([
        'run', '-d', '--name', name,
        '--label', `ainize.hosted-agent=${agentId}`,
        '--network', this.o.network,
        '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges',
        '--read-only',
        '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m',
        '--memory', this.o.memory,
        '--memory-swap', this.o.memory,
        '--cpus', String(this.o.cpus),
        '--pids-limit', String(this.o.pidsLimit),
        '--user', 'node',
        ...(this.o.runtime ? ['--runtime', this.o.runtime] : []),
        '--env-file', envFile,
        hostedAgentImageTag(agentId, version),
      ], 60_000);
    } finally {
      rmSync(envFile, { force: true });
    }
    if (r.code !== 0) throw new Error(`docker run failed: ${r.stderr.trim()}`);
    const ip = (await hostedAgentDockerExec(['inspect', name, '--format', `{{(index .NetworkSettings.Networks "${this.o.network}").IPAddress}}`])).stdout.trim();
    if (!ip) throw new Error(`container ${name} has no address on ${this.o.network}`);
    return { upstream: `http://${ip}:${HOSTED_AGENT_CONTAINER_PORT}` };
  }

  async stop(agentId: string): Promise<void> {
    await hostedAgentDockerExec(['rm', '-f', hostedAgentContainerName(agentId)], 30_000);
  }

  async logs(agentId: string, tail = 200): Promise<string[]> {
    const r = await hostedAgentDockerExec(['logs', '--tail', String(tail), hostedAgentContainerName(agentId)], 15_000);
    return `${r.stdout}${r.stderr}`.split('\n').filter(Boolean).slice(-tail);
  }

  async removeImages(agentId: string): Promise<void> {
    const r = await hostedAgentDockerExec(['image', 'ls', '-q', '--filter', `label=ainize.hosted-agent=${agentId}`]);
    const ids = [...new Set(r.stdout.split('\n').map((s) => s.trim()).filter(Boolean))];
    if (ids.length) await hostedAgentDockerExec(['image', 'rm', '-f', ...ids], 60_000);
  }

  /** Containers left by a previous node process — removed at start, since their tokens died with it. */
  async removeOrphans(): Promise<void> {
    const r = await hostedAgentDockerExec(['ps', '-aq', '--filter', 'label=ainize.hosted-agent']);
    const ids = r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    if (ids.length) await hostedAgentDockerExec(['rm', '-f', ...ids], 60_000);
  }
}

