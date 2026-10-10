/**
 * `POST /api/run` — one script, run once, in the hosted-agent sandbox (deploy/run-runtime/README.md).
 *
 * aindrive's ▶ button sends the file tree and the entry; this runs it and hands back what it printed. The boundary
 * is the one a hosted code agent has (hosted-agent-docker.ts): the same `--internal` network, whose only exit is
 * the gateway; a read-only rootfs with a 64 MiB tmpfs at `/work` for the files; `--cap-drop ALL`,
 * `no-new-privileges`, uid 1000, memory/cpu/pid limits, gVisor when the operator set it. Nothing of the host is
 * mounted: the files go in as a tar on the container's stdin, unpacked by the image's own `tar` before the
 * interpreter starts (so the script sees stdin at EOF).
 *
 * What the script can reach is decided by the gateway (hosted-agent-gateway.ts, `RunGrant`): this node's own
 * `/api/decide`, `/api/chat` and `/v1/*`, and a CONNECT tunnel to `ainize.ai` and this node's public host. The
 * sandbox tells the script where through its environment — `AINIZE_DECIDE_URL` and friends point at the gateway,
 * `HTTPS_PROXY` carries the run's token — and rewrites a caller-supplied URL that names this node's own public
 * host to the gateway path, so a run on ainize.ai calling `https://ainize.ai/api/decide` is answered here, in
 * the free class, attributed to the caller, rather than leaving for the internet and coming back as the node.
 *
 * Admission is a count, not a queue: more than `perCaller` runs for one caller or `maxRunning` on the node is a
 * 429 the button can show at once, rather than a spinner that may never end.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { HostedAgentDocker } from './hosted-agent-docker.js';
import { hostedAgentDockerExec } from './hosted-agent-docker.js';
import type { HostedAgentGateway } from './hosted-agent-gateway.js';

export const RUN_LANGUAGES = ['python', 'node'] as const;
export type RunLanguage = (typeof RUN_LANGUAGES)[number];

export const RUN_LIMITS = {
  maxFiles: 32,
  maxTotalBytes: 2 * 1024 * 1024,
  maxFileNameLength: 255,
  maxEnvEntries: 32,
  maxEnvValueBytes: 4096,
  minTimeoutMs: 1000,
  maxTimeoutMs: 300_000,
  defaultTimeoutMs: 120_000,
  /** The most of each stream that is forwarded and kept; the rest is dropped with a note on stderr. */
  maxOutputBytes: 1024 * 1024,
  workTmpfs: '64m',
  tmpTmpfs: '16m',
} as const;

/** The exit code of a run that was killed at `timeoutMs` — coreutils `timeout` uses the same one. */
export const RUN_TIMEOUT_EXIT_CODE = 124;

/** Hosts a run may open a CONNECT tunnel to, besides this node's own public host. */
export const RUN_ALLOWED_HOSTS = ['ainize.ai'];

/** What a run may be pointed at on this node (the gateway enforces the same set). */
const RUN_SURFACE_PATH = /^\/(?:api\/decide|api\/chat|v1(?:\/|$))/;

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Names the sandbox sets itself; a caller's value for one is ignored rather than refused. */
const ENV_RESERVED = new Set(['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy', 'AINIZE_API_URL', 'AINIZE_RUN_ID', 'HOME', 'PATH']);

/** One path inside `/work`: relative, forward slashes, no empty, `.`, `..` or `.git` segment, nothing unprintable. */
export function runFileNameOk(name: string): boolean {
  if (!name || name.length > RUN_LIMITS.maxFileNameLength) return false;
  if (/[\\\u0000-\u001f\u007f]/.test(name)) return false;
  if (name.startsWith('/')) return false;
  return name.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..' && seg.toLowerCase() !== '.git');
}

/**
 * The files, in either shape a client sends: a map `{ "<path>": "<content>" }` or, as aindrive's run client does,
 * a list `[{ "path", "content" }]`. Both become the map; a path given twice in the list is refused.
 */
const runFilesSchema = z.union([
  z.record(z.string(), z.string()),
  z.array(z.object({ path: z.string(), content: z.string() })).max(RUN_LIMITS.maxFiles),
]);

export const runRequestSchema = z.object({
  language: z.enum(RUN_LANGUAGES),
  entry: z.string().min(1),
  files: runFilesSchema,
  env: z.record(z.string(), z.string()).optional(),
  timeoutMs: z.number().int().min(RUN_LIMITS.minTimeoutMs).max(RUN_LIMITS.maxTimeoutMs).optional(),
});

export interface RunRequest {
  language: RunLanguage;
  entry: string;
  files: Record<string, string>;
  env: Record<string, string>;
  timeoutMs: number;
  /** UTF-8 bytes across `files`, for the log line. */
  bytes: number;
}

export class RunRefused extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

/** Validate a request body into a `RunRequest`, or throw a `RunRefused` with the status to answer. */
export function parseRunRequest(body: unknown): RunRequest {
  const parsed = runRequestSchema.safeParse(body ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new RunRefused(400, 'invalid_request', `${issue?.path.join('.') || 'body'}: ${issue?.message ?? 'invalid request'}`);
  }
  const { language, entry, files: given, env = {}, timeoutMs = RUN_LIMITS.defaultTimeoutMs } = parsed.data;
  let files: Record<string, string>;
  if (Array.isArray(given)) {
    files = {};
    for (const { path, content } of given) {
      if (path in files) throw new RunRefused(400, 'invalid_request', `files: "${path}" is listed twice`);
      files[path] = content;
    }
  } else {
    files = given;
  }
  const names = Object.keys(files);
  if (names.length === 0) throw new RunRefused(400, 'invalid_request', 'files: at least the entry file is required');
  if (names.length > RUN_LIMITS.maxFiles) throw new RunRefused(400, 'invalid_request', `files: at most ${RUN_LIMITS.maxFiles} files`);
  for (const name of names) {
    if (!runFileNameOk(name)) throw new RunRefused(400, 'invalid_request', `files: "${name}" is not a relative path inside the work directory (no "..", ".git", empty or absolute segments)`);
  }
  if (!(entry in files)) throw new RunRefused(400, 'invalid_request', `entry: "${entry}" is not one of files`);
  let bytes = 0;
  for (const content of Object.values(files)) bytes += Buffer.byteLength(content, 'utf8');
  if (bytes > RUN_LIMITS.maxTotalBytes) throw new RunRefused(413, 'files_too_large', `files: ${bytes} bytes; at most ${RUN_LIMITS.maxTotalBytes} in total`);
  const entries = Object.entries(env);
  if (entries.length > RUN_LIMITS.maxEnvEntries) throw new RunRefused(400, 'invalid_request', `env: at most ${RUN_LIMITS.maxEnvEntries} entries`);
  for (const [k, v] of entries) {
    if (!ENV_NAME.test(k)) throw new RunRefused(400, 'invalid_request', `env: "${k}" is not an environment variable name`);
    if (/[\r\n\u0000]/.test(v)) throw new RunRefused(400, 'invalid_request', `env: ${k} must not contain line breaks`);
    if (Buffer.byteLength(v, 'utf8') > RUN_LIMITS.maxEnvValueBytes) throw new RunRefused(400, 'invalid_request', `env: ${k} is longer than ${RUN_LIMITS.maxEnvValueBytes} bytes`);
  }
  return { language, entry, files, env, timeoutMs, bytes };
}

/**
 * A ustar archive of the files, owned by uid 1000, mode 0644 — what the container's `tar -x` unpacks into `/work`.
 * Written here rather than through a dependency: the format is forty lines, and this is the only place it is read.
 */
export function packRunFiles(files: Record<string, string>): Buffer {
  const blocks: Buffer[] = [];
  const header = (name: string, size: number, type: '0' | '5'): Buffer => {
    const h = Buffer.alloc(512);
    let prefix = '';
    let base = name;
    if (Buffer.byteLength(base) > 100) {
      const cut = name.lastIndexOf('/', 100);
      if (cut <= 0 || Buffer.byteLength(name.slice(cut + 1)) > 100 || Buffer.byteLength(name.slice(0, cut)) > 155) throw new RunRefused(400, 'invalid_request', `files: "${name}" is too long for the archive`);
      prefix = name.slice(0, cut);
      base = name.slice(cut + 1);
    }
    h.write(base, 0, 100, 'utf8');
    h.write((type === '5' ? 0o755 : 0o644).toString(8).padStart(7, '0') + '\0', 100, 8);
    h.write('0001750\0', 108, 8); // uid 1000
    h.write('0001750\0', 116, 8); // gid 1000
    h.write(size.toString(8).padStart(11, '0') + '\0', 124, 12);
    h.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0', 136, 12);
    h.write('        ', 148, 8); // checksum placeholder: spaces while summing
    h.write(type, 156, 1);
    h.write('ustar\0', 257, 6);
    h.write('00', 263, 2);
    h.write('runner', 265, 32);
    h.write('runner', 297, 32);
    if (prefix) h.write(prefix, 345, 155, 'utf8');
    let sum = 0;
    for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
    return h;
  };
  const dirs = new Set<string>();
  for (const name of Object.keys(files).sort()) {
    const parts = name.split('/');
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/') + '/';
      if (dirs.has(dir)) continue;
      dirs.add(dir);
      blocks.push(header(dir, 0, '5'));
    }
    const body = Buffer.from(files[name]!, 'utf8');
    blocks.push(header(name, body.length, '0'), body);
    const pad = (512 - (body.length % 512)) % 512;
    if (pad) blocks.push(Buffer.alloc(pad));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

export interface RunSandboxOptions {
  /** The hosted-agent Docker: its internal network is the one a run joins. */
  docker: HostedAgentDocker;
  gateway: HostedAgentGateway;
  /** Fixed bridge gateway port for hosts with an explicit firewall rule. Defaults to an ephemeral port. */
  gatewayPort?: number;
  /** This node's own listener (loopback), where a run's `/api/decide`, `/api/chat` and `/v1/*` are answered. */
  selfUrl: () => string;
  /** This node's public URL, if it has one: its host is a CONNECT target, and a caller's URL naming it is served here. */
  publicUrl: () => string | undefined;
  /** The OCI runtime (`runsc` for gVisor). Empty uses Docker's default. */
  runtime?: string;
  memory: string;
  cpus: number;
  pidsLimit: number;
  maxRunning: number;
  perCaller: number;
  /** For a caller holding an API key: a program, not a visitor. */
  perKeyedCaller: number;
  buildTimeoutMs: number;
  /** Where env files live for the instant between being written and `docker run` reading them. */
  workDir: string;
  /** Directory holding `<language>/Dockerfile`; defaults to the package's `deploy/run-runtime`. */
  runtimeDir?: string;
  imageRepository?: string;
  log: (level: 'info' | 'warn' | 'error', message: string) => void;
}

export const RUN_SANDBOX_DEFAULTS = {
  memory: '512m', cpus: 1, pidsLimit: 128, maxRunning: 8, perCaller: 2, perKeyedCaller: 4, buildTimeoutMs: 600_000,
} as const;

export interface RunSink {
  stdout(chunk: string): void;
  stderr(chunk: string): void;
  /** The run has its slot: whatever follows is the run itself, not a refusal. */
  admitted?(): void;
}

export interface RunOutcome {
  code: number;
  ms: number;
  /** Set when the run ended for a reason other than the script exiting: the timeout, or docker itself. */
  error?: string;
}

export interface RunCaller {
  /** `ip:<address>` or `key:<owner address>` — the admission bucket and the log line's name. */
  id: string;
  keyed: boolean;
}

const RUN_CONTAINER_PREFIX = 'ainize-run-';
const RUN_LABEL = 'ainize.run=1';

const packageRoot = () => join(dirname(fileURLToPath(import.meta.url)), '..');

export class RunSandbox {
  private gatewayUrl = '';
  private readonly images = new Map<RunLanguage, Promise<string>>();
  private readonly perCaller = new Map<string, number>();
  private running = 0;
  private ready = false;

  constructor(private readonly o: RunSandboxOptions) {}

  get available(): boolean {
    return this.ready;
  }

  /** How many runs are in flight — for a status page, and for tests. */
  get inFlight(): number {
    return this.running;
  }

  /**
   * Join the internal network and put the gateway on its bridge address. Failure here leaves `available` false
   * and `/api/run` answering 503; nothing else on the node is affected.
   */
  async start(): Promise<void> {
    try {
      const bridge = await this.o.docker.ensureNetwork();
      this.gatewayUrl = await this.o.gateway.listen(bridge, this.o.gatewayPort);
      await this.removeOrphans();
      this.ready = true;
    } catch (e) {
      this.o.log('error', `run sandbox: docker unusable, /api/run disabled — ${(e as Error).message}`);
      this.ready = false;
    }
  }

  /** Build the runner images now rather than on the first press. Failures are logged; the first run retries. */
  warm(): void {
    for (const language of RUN_LANGUAGES) {
      this.ensureImage(language).catch((e: Error) => this.o.log('warn', `run sandbox: ${language} image not built yet — ${e.message.split('\n')[0]}`));
    }
  }

  async stop(): Promise<void> {
    this.ready = false;
    await this.removeOrphans();
  }

  /** Containers a previous node process left running: their tokens died with it, so they go. */
  private async removeOrphans(): Promise<void> {
    const r = await hostedAgentDockerExec(['ps', '-aq', '--filter', `label=${RUN_LABEL}`]);
    const ids = r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    if (ids.length) await hostedAgentDockerExec(['rm', '-f', ...ids], 60_000);
  }

  /** The runner image for a language: `<repo>-<language>:<hash of its build context>`, built when missing. */
  ensureImage(language: RunLanguage): Promise<string> {
    let p = this.images.get(language);
    if (!p) {
      p = this.buildImage(language);
      p.catch(() => this.images.delete(language));
      this.images.set(language, p);
    }
    return p;
  }

  private async buildImage(language: RunLanguage): Promise<string> {
    const dir = join(this.o.runtimeDir ?? join(packageRoot(), 'deploy', 'run-runtime'), language);
    const hash = createHash('sha256');
    for (const f of readdirSync(dir).sort()) hash.update(f).update('\0').update(readFileSync(join(dir, f))).update('\0');
    const tag = `${this.o.imageRepository ?? 'ainize/run-runtime'}-${language}:${hash.digest('hex').slice(0, 16)}`;
    if ((await hostedAgentDockerExec(['image', 'inspect', tag], 20_000)).code === 0) return tag;
    this.o.log('info', `run sandbox: building ${tag}`);
    const r = await hostedAgentDockerExec(['build', '-t', tag, '--label', 'ainize.run-runtime=1', dir], this.o.buildTimeoutMs);
    if (r.code !== 0) throw new Error(`building ${tag} failed:\n${(r.stderr || r.stdout).slice(-4000)}`);
    return tag;
  }

  /** Take a slot for this caller, or refuse. Synchronous, so two presses cannot both see the room for one. */
  private admit(caller: RunCaller): () => void {
    const limit = caller.keyed ? this.o.perKeyedCaller : this.o.perCaller;
    const mine = this.perCaller.get(caller.id) ?? 0;
    if (mine >= limit) throw new RunRefused(429, 'too_many_runs', `you already have ${mine} run${mine === 1 ? '' : 's'} going; at most ${limit} at once`);
    if (this.running >= this.o.maxRunning) throw new RunRefused(429, 'too_many_runs', `this node is running ${this.running} scripts already; try again in a moment`);
    this.perCaller.set(caller.id, mine + 1);
    this.running++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.running--;
      const n = (this.perCaller.get(caller.id) ?? 1) - 1;
      if (n <= 0) this.perCaller.delete(caller.id); else this.perCaller.set(caller.id, n);
    };
  }

  /** The hosts a run may tunnel to: ainize.ai, and this node's own public host when it has one. */
  private allowedHosts(): string[] {
    const hosts = [...RUN_ALLOWED_HOSTS];
    const pub = this.publicHost();
    if (pub && !hosts.includes(pub)) hosts.push(pub);
    return hosts;
  }

  private publicHost(): string | null {
    try {
      const u = this.o.publicUrl();
      return u ? new URL(u).hostname.toLowerCase() : null;
    } catch {
      return null;
    }
  }

  /**
   * The script's environment: the caller's, with URLs naming this node's public host rewritten to the gateway
   * (the run is answered here either way; this way it is attributed to the caller), then the sandbox's own.
   */
  private environment(req: RunRequest, runId: string, base: string): Record<string, string> {
    const pub = this.publicHost();
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.env)) {
      if (ENV_RESERVED.has(k)) continue;
      env[k] = v;
      if (!pub) continue;
      try {
        const u = new URL(v);
        if ((u.protocol === 'https:' || u.protocol === 'http:') && u.hostname.toLowerCase() === pub && RUN_SURFACE_PATH.test(u.pathname)) env[k] = `${base}${u.pathname}${u.search}`;
      } catch { /* not a URL */ }
    }
    env.AINIZE_DECIDE_URL ??= `${base}/api/decide`;
    env.AINIZE_CHAT_URL ??= `${base}/api/chat`;
    env.AINIZE_API_URL = base;
    env.AINIZE_RUN_ID = runId;
    const proxy = new URL(this.gatewayUrl);
    proxy.username = 'run';
    proxy.password = base.slice(base.lastIndexOf('/') + 1);
    env.HTTPS_PROXY = proxy.href;
    env.https_proxy = proxy.href;
    env.HOME = '/work';
    return env;
  }

  /**
   * Run one script. Output chunks reach `sink` as they are produced; the promise settles with the outcome once the
   * container is gone. `signal` aborting (the caller went away) kills the container.
   */
  async run(req: RunRequest, caller: RunCaller, sink: RunSink, signal?: AbortSignal): Promise<RunOutcome> {
    if (!this.ready) throw new RunRefused(503, 'runner_unavailable', 'this node cannot run scripts right now');
    const release = this.admit(caller);
    sink.admitted?.();
    const started = Date.now();
    const runId = randomBytes(8).toString('hex');
    const name = `${RUN_CONTAINER_PREFIX}${runId}`;
    let token: string | null = null;
    let envFile: string | null = null;
    try {
      const image = await this.ensureImage(req.language);
      if (signal?.aborted) return { code: RUN_TIMEOUT_EXIT_CODE, ms: Date.now() - started, error: 'cancelled' };
      token = this.o.gateway.issueRun({ id: runId, allowedHosts: this.allowedHosts(), selfUrl: this.o.selfUrl() });
      const base = `${this.gatewayUrl}/t/${token}`;
      const env = this.environment(req, runId, base);
      mkdirSync(this.o.workDir, { recursive: true });
      envFile = join(this.o.workDir, `run-env-${runId}`);
      writeFileSync(envFile, Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o600 });
      const interpreter = req.language === 'python' ? ['python3', `/work/${req.entry}`] : ['node', `/work/${req.entry}`];
      const outcome = await this.spawnRun(name, [
        'run', '--rm', '-i', '--name', name,
        '--label', RUN_LABEL,
        '--network', this.o.docker.network,
        '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges',
        '--read-only',
        '--tmpfs', `/work:rw,nosuid,size=${RUN_LIMITS.workTmpfs},uid=1000,gid=1000,mode=0700`,
        '--tmpfs', `/tmp:rw,noexec,nosuid,size=${RUN_LIMITS.tmpTmpfs}`,
        '--memory', this.o.memory,
        '--memory-swap', this.o.memory,
        '--cpus', String(this.o.cpus),
        '--pids-limit', String(this.o.pidsLimit),
        '--user', '1000:1000',
        '--workdir', '/work',
        ...(this.o.runtime ? ['--runtime', this.o.runtime] : []),
        '--env-file', envFile,
        image,
        // The files arrive on stdin as a tar; the interpreter then takes over the process (and an EOF stdin).
        'sh', '-c', 'tar -xf - -C /work && exec "$0" "$@"', ...interpreter,
      ], packRunFiles(req.files), req.timeoutMs, sink, signal);
      this.o.log('info', `run ${runId}: caller=${caller.id} language=${req.language} entry=${req.entry} bytes=${req.bytes} ms=${outcome.ms} exit=${outcome.code}${outcome.error ? ` error=${JSON.stringify(outcome.error)}` : ''}`);
      return outcome;
    } finally {
      if (envFile) rmSync(envFile, { force: true });
      if (token) this.o.gateway.revokeRun(token);
      release();
    }
  }

  private spawnRun(name: string, args: string[], input: Buffer, timeoutMs: number, sink: RunSink, signal?: AbortSignal): Promise<RunOutcome> {
    return new Promise((resolve) => {
      const started = Date.now();
      const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
      let error: string | undefined;
      let killed = false;
      const kill = (why: string) => {
        if (killed) return;
        killed = true;
        error ??= why;
        void hostedAgentDockerExec(['kill', name], 15_000).then(() => hostedAgentDockerExec(['rm', '-f', name], 15_000));
        setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 5000).unref();
      };
      const timer = setTimeout(() => kill(`timeout after ${timeoutMs}ms`), timeoutMs);
      const onAbort = () => kill('cancelled');
      signal?.addEventListener('abort', onAbort, { once: true });

      const forward = (stream: NodeJS.ReadableStream, emit: (s: string) => void) => {
        const decoder = new StringDecoder('utf8');
        let sent = 0;
        let truncated = false;
        stream.on('data', (c: Buffer) => {
          if (truncated) return;
          if (sent + c.length > RUN_LIMITS.maxOutputBytes) {
            truncated = true;
            const room = RUN_LIMITS.maxOutputBytes - sent;
            if (room > 0) emit(decoder.write(c.subarray(0, room)));
            sink.stderr(`\n[ainize] output truncated at ${RUN_LIMITS.maxOutputBytes} bytes\n`);
            return;
          }
          sent += c.length;
          emit(decoder.write(c));
        });
        stream.on('end', () => { const rest = decoder.end(); if (rest && !truncated) emit(rest); });
      };
      forward(child.stdout, (s) => sink.stdout(s));
      forward(child.stderr, (s) => sink.stderr(s));

      child.stdin.on('error', () => { /* the container may exit before reading everything */ });
      child.stdin.end(input);
      child.on('error', (e) => { error ??= `docker could not start: ${e.message}`; });
      child.on('close', (code) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        const ms = Date.now() - started;
        const exit = killed ? RUN_TIMEOUT_EXIT_CODE : code ?? 1;
        // 125 is docker's own failure (the daemon refused, the image is gone): the script never ran.
        if (!killed && code === 125) error ??= 'docker could not start the container';
        resolve(error ? { code: exit, ms, error } : { code: exit, ms });
      });
    });
  }
}
