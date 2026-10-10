/**
 * Who a run is FOR, and the key it runs with.
 *
 * aindrive's ▶ button runs a script on this node for the person who pressed it. That person is signed in to
 * aindrive through AIN SSO and, as far as this node is concerned, is the same account that signs in here — so the
 * key the script gets must be THEIRS, not an anonymous grant and not aindrive's. aindrive proves two things on
 * `POST /api/run`: that it is aindrive (`Authorization: Bearer <client_credentials at+jwt>` for this node as the
 * resource — verified by sso.ts `verifyServiceToken`, the same check `POST /api/projects/auto` makes) and who pressed the button (`X-AIN-Actor: <SSO subject>`).
 * The node resolves the subject to its principal the way a sign-in does (creating the identity just in time, as a
 * first sign-in would), and issues — once — that account's key labelled `aindrive run`, which the sandbox hands
 * to the script as `AINIZE_API_KEY`. Usage is then the person's, in the gate and on the ledger, as if they had
 * pasted the key themselves. A push-deploy of a project does the same with the hook's `pusher.subject`.
 *
 * The key is deterministic — HMAC of the principal under a per-node secret file — so "get or create" needs no
 * plaintext store: the key store keeps only its hash like every other key, and the same derivation returns the
 * same key next time. It is a real key: revocable from the keys page, disabled with the organization's others on
 * suspension (sso.ts), and refused by the derivation while a disabled record for it exists.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { decodeProtectedHeader } from 'jose';
import { OPENAI_API_KEY_PREFIX, type OpenaiApiKeyStore } from './openai-api-keys.js';
import { SERVICE_TOKEN_TYPE, SSO_ALGORITHMS } from './sso.js';

export const RUN_KEY_LABEL = 'aindrive run';
/** The header aindrive names the person in. The value is their AIN SSO subject (`acc_…`). */
export const RUN_ACTOR_HEADER = 'x-ain-actor';
const SUBJECT = /^[A-Za-z0-9._~-]{1,255}$/;

/** `Authorization: Bearer <token>`, or null. */
export function bearerOf(authorization: string | undefined): string | null {
  const m = /^Bearer\s+([A-Za-z0-9._~+/=-]+)$/i.exec((authorization ?? '').trim());
  return m ? m[1]! : null;
}

/**
 * Shaped like an AIN SSO machine token: a JWT whose header says `typ: at+jwt` with an asymmetric algorithm. An
 * `ainize-sk-…` key is not, so it keeps its own path. Shape only — verification is sso.ts `verifyServiceToken`.
 */
export function isServiceToken(token: string | null): boolean {
  if (!token || token.split('.').length !== 3) return false;
  try {
    const h = decodeProtectedHeader(token);
    return h.typ === SERVICE_TOKEN_TYPE && typeof h.alg === 'string' && SSO_ALGORITHMS.includes(h.alg);
  } catch { return false; }
}

/** A refusal with the status the route answers and a stable code. */
export class RunActorError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); this.name = 'RunActorError'; }
}

export interface RunKeyIssuerDeps {
  keys: Pick<OpenaiApiKeyStore, 'ensure'>;
  /** The subject's principal here, created just in time like a first sign-in; throws SsoError when it may not act. */
  resolveActor: (subject: string) => { principal: string; created: boolean };
  issuer: string;
  /** Where the derivation secret lives (`<home>/run-keys.secret`, 0600, made on first use). */
  secretFile: string;
  log?: (level: 'info' | 'warn', message: string) => void;
}

export class RunKeyIssuer {
  private secret: Buffer | null = null;

  constructor(private readonly deps: RunKeyIssuerDeps) {}

  /**
   * The `aindrive run` key of the account behind `subject`: issued the first time, the same key after. Null when a
   * disabled record for it exists (an organization suspension switched it off — the derivation must not revive it).
   */
  keyFor(subject: string): { key: string; principal: string; issued: boolean } {
    if (!SUBJECT.test(subject)) throw new RunActorError(400, 'invalid_actor', `${RUN_ACTOR_HEADER} is not an AIN SSO subject`);
    const { principal, created } = this.deps.resolveActor(subject);
    const key = `${OPENAI_API_KEY_PREFIX}${createHmac('sha256', this.loadSecret()).update(`aindrive-run\0${principal}`).digest('base64url').slice(0, 32)}`;
    const state = this.deps.keys.ensure(key, principal, RUN_KEY_LABEL, { iss: this.deps.issuer, sub: subject });
    if (state === 'disabled') throw new RunActorError(403, 'account_suspended', 'This account\'s run key is switched off.');
    if (state === 'issued' || created) this.deps.log?.('info', `run key ${state} for ${principal}${created ? ' (account created just in time)' : ''}`);
    return { key, principal, issued: state === 'issued' };
  }

  private loadSecret(): Buffer {
    if (this.secret) return this.secret;
    const file = this.deps.secretFile;
    if (!existsSync(file)) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, randomBytes(32).toString('hex') + '\n', { mode: 0o600, flag: 'wx' });
    }
    this.secret = Buffer.from(readFileSync(file, 'utf8').trim(), 'hex');
    if (this.secret.length < 32) throw new Error(`${file} does not hold a 32-byte hex secret`);
    return this.secret;
  }
}
