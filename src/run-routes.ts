/**
 * `POST /api/run` (deploy/run-runtime/README.md): the HTTP face of run-sandbox.ts.
 *
 * Starting a run needs no key. Who the run is FOR decides what the script holds (run-actor.ts): a caller with an
 * API key runs as its owner and the script gets that key; aindrive, proving itself with an AIN SSO machine token
 * and naming the person in `X-AIN-Actor`, runs it as that person and the script gets THEIR `aindrive run` key;
 * anyone else runs anonymously and the script gets no key — a decision model then answers 401, as it would to a
 * keyless curl. The caller's name is the admission bucket and the log line; a key buys a wider bucket.
 *
 * The answer is a stream unless the caller asked for JSON: a script that prints as it goes should be seen as it
 * goes, and a timeout a minute in should not look like a hung request. Every event's `data` is JSON, the exit
 * event last; a client that cannot stream gets the same four things in one object.
 */
import { Router, type Request, type Response } from 'express';
import type { OpenaiApiKeyStore } from './openai-api-keys.js';
import { RUN_LIMITS, RunRefused, parseRunRequest, type RunCaller, type RunSandbox } from './run-sandbox.js';
import { RUN_ACTOR_HEADER, RunActorError, bearerOf, isServiceToken, type RunKeyIssuer } from './run-actor.js';
import { SsoError, type ServicePrincipal } from './sso.js';

export interface RunRoutesDeps {
  /** Null when this node cannot run scripts: every request then answers 503 `runner_unavailable`. */
  sandbox: RunSandbox | null;
  /** To name a caller by the key it holds. Absent → every caller is named by address. */
  keys?: Pick<OpenaiApiKeyStore, 'addressForKey'>;
  /**
   * A trusted application running a script for a person (run-actor.ts). Absent → a machine token is just an
   * unknown bearer and the run is anonymous.
   */
  actor?: {
    /** sso.ts `verifyServiceToken` bound to this node: the application, or an SsoError. */
    verify: (authorization: string) => Promise<ServicePrincipal>;
    keys: Pick<RunKeyIssuer, 'keyFor'>;
  };
}

const SSE_HEARTBEAT_MS = 15_000;

/** Who is calling, by the key it carries (its owner) or by address. A machine token is decided by `runActorOf`. */
export function runCallerOf(req: Request, keys?: Pick<OpenaiApiKeyStore, 'addressForKey'>): RunCaller {
  const key = bearerOf(req.header('authorization')) ?? '';
  const owner = key && keys ? keys.addressForKey(key) : null;
  if (owner) return { id: `key:${owner.toLowerCase()}`, keyed: true, key };
  return { id: `ip:${req.ip ?? 'unknown'}`, keyed: false };
}

/**
 * The caller when the bearer is an AIN SSO machine token: the person named in `X-AIN-Actor`, with their own key;
 * or the application itself, anonymous, when it names nobody. A token that does not verify is a 401 — never a
 * fall-through to an anonymous run, so a misconfigured aindrive is seen rather than silently downgraded.
 */
export async function runActorOf(req: Request, actor: NonNullable<RunRoutesDeps['actor']>): Promise<RunCaller> {
  let app: ServicePrincipal;
  try { app = await actor.verify(req.header('authorization')!); }
  catch (e) { throw new RunRefused(401, 'invalid_service_token', `the machine token was refused (${e instanceof SsoError ? e.code : (e as Error).message})`); }
  const subject = (req.header(RUN_ACTOR_HEADER) ?? '').trim();
  if (!subject) return { id: `app:${app.clientId}`, keyed: false };
  try {
    const { key, principal } = actor.keys.keyFor(subject);
    return { id: `key:${principal}`, keyed: true, key };
  } catch (e) {
    if (e instanceof RunActorError) throw new RunRefused(e.status, e.code, e.message);
    if (e instanceof SsoError) throw new RunRefused(e.status, e.code, e.message);
    throw e;
  }
}

const wantsJson = (req: Request) => {
  const accept = req.header('accept') ?? '';
  return /application\/json/i.test(accept) && !/text\/event-stream/i.test(accept);
};

export function runRouter(deps: RunRoutesDeps): Router {
  const router = Router();

  router.post('/api/run', async (req: Request, res: Response) => {
    const refuse = (status: number, code: string, message: string) => { res.status(status).json({ error: code, message }); };
    let request;
    try {
      request = parseRunRequest(req.body);
    } catch (e) {
      if (e instanceof RunRefused) return refuse(e.status, e.code, e.message);
      throw e;
    }
    const sandbox = deps.sandbox;
    if (!sandbox?.available) return refuse(503, 'runner_unavailable', 'this node cannot run scripts: Docker is not available to it');
    let caller: RunCaller;
    try {
      caller = deps.actor && isServiceToken(bearerOf(req.header('authorization'))) ? await runActorOf(req, deps.actor) : runCallerOf(req, deps.keys);
    } catch (e) {
      if (e instanceof RunRefused) return refuse(e.status, e.code, e.message);
      throw e;
    }
    const abort = new AbortController();
    res.on('close', () => abort.abort());

    if (wantsJson(req)) {
      let stdout = '';
      let stderr = '';
      // The sandbox already caps each stream at RUN_LIMITS.maxOutputBytes; the strings here cannot outgrow it.
      try {
        const outcome = await sandbox.run(request, caller, { stdout: (c) => { stdout += c; }, stderr: (c) => { stderr += c; } }, abort.signal);
        if (res.writableEnded || abort.signal.aborted) return;
        res.json({ stdout, stderr, code: outcome.code, ms: outcome.ms, ...(outcome.error ? { error: outcome.error } : {}) });
      } catch (e) {
        if (e instanceof RunRefused) return refuse(e.status, e.code, e.message);
        throw e;
      }
      return;
    }

    // Admission is decided inside run() before anything is streamed; a 429 must still be a 429, so the stream
    // headers go out once the run is admitted and not before.
    let streaming = false;
    const open = () => {
      if (streaming || res.headersSent) return;
      streaming = true;
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        'x-accel-buffering': 'no',
        connection: 'keep-alive',
      });
      res.flushHeaders();
    };
    const send = (event: string, data: unknown) => {
      open();
      if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const heartbeat = setInterval(() => { if (streaming && !res.writableEnded) res.write(': ping\n\n'); }, SSE_HEARTBEAT_MS);
    heartbeat.unref();
    try {
      const outcome = await sandbox.run(request, caller, { admitted: open, stdout: (c) => send('stdout', c), stderr: (c) => send('stderr', c) }, abort.signal);
      if (outcome.error) send('error', outcome.error);
      send('exit', { code: outcome.code, ms: outcome.ms });
    } catch (e) {
      if (e instanceof RunRefused && !streaming) return refuse(e.status, e.code, e.message);
      send('error', e instanceof Error ? e.message : String(e));
      send('exit', { code: 1, ms: 0 });
    } finally {
      clearInterval(heartbeat);
      if (!res.writableEnded) res.end();
    }
  });

  return router;
}

export { RUN_LIMITS };
