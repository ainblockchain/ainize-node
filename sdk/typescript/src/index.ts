/**
 * Point OpenAI at an Ainize node.
 *
 * The same contract as the Python package, deliberately: one call proves which address is asking and returns the
 * genuine `OpenAI` client. It does not wrap or re-export a narrowed version of it — what comes back IS `OpenAI`
 * (a subclass adding nothing but `decide()`, for the one endpoint OpenAI has no name for) — the whole promise is
 * that the code after that line is unchanged, and a wrapper would have to grow a method every time OpenAI's
 * client does while being a second place for bugs to live; a subclass inherits every one of them.
 *
 * It never signs a transfer. `depositAddress()` says where to send AIN and `awaitDeposit()` waits for the node to
 * credit it; moving funds stays with the wallet the caller already trusts. Signing a transfer is a much larger
 * thing to hand a private key to than signing a login, and nothing at the import line shows the difference.
 */
import OpenAI from 'openai';
import { privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';

export interface ConnectOptions {
  /** Sign in with this key and be issued one. */
  privateKey?: Hex;
  /** Or reuse a key already issued. */
  apiKey?: string;
  /** Label recorded against the issued key, so an operator can tell two of them apart. */
  label?: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DECIDE_TIMEOUT_MS = 120_000;

/** One question to a decision model: `noul` → P(true); `score` → an index into `criteria`; `choice` → a key of `criteria`. */
export type DecideQuestion =
  | { type: 'noul'; instructions?: string }
  | { type: 'score'; instructions?: string; criteria: string[] }
  | { type: 'choice'; instructions?: string; criteria: Record<string, string> };

export interface DecideRequest {
  /** `clef-flash` (fast) or `clef` (27B). */
  model: string;
  /** Any JSON describing the situation. */
  state: unknown;
  questions: Record<string, DecideQuestion | Record<string, unknown>>;
  /** `{ prompt: true }` returns the exact prompt the model received in `debug.prompt`. */
  debug?: { prompt?: boolean } & Record<string, unknown>;
  timeoutMs?: number;
  /** Anything else (`images`, `videos`) travels to the node unchanged. */
  [extra: string]: unknown;
}

export interface DecideResult {
  model?: string;
  answers: Record<string, { type?: string; noul?: number; score?: number; choice?: string; distribution?: unknown } & Record<string, unknown>>;
  usage?: Record<string, unknown>;
  debug?: { prompt?: string; input_tokens?: number; questions?: number } & Record<string, unknown>;
}

/** The node refused or failed a decision: its HTTP `status`, error `code` and the body it sent. */
export class DecideError extends Error {
  constructor(readonly status: number, readonly code: string | undefined, readonly body: unknown) {
    super((body as { error?: { message?: string } } | undefined)?.error?.message ?? `the node answered ${status}`);
    this.name = 'DecideError';
  }
}

/**
 * `OpenAI`, plus `decide()`. Nothing of OpenAI's is changed or hidden; `client instanceof OpenAI` holds. The
 * decision goes to `/v1/systemone` with this client's own `baseURL` and `apiKey`.
 */
export class AinizeClient extends OpenAI {
  async decide(req: DecideRequest): Promise<DecideResult> {
    const { timeoutMs, debug, ...body } = req;
    if (!body.questions || typeof body.questions !== 'object' || Object.keys(body.questions).length === 0) {
      throw new Error('decide() needs a non-empty questions object');
    }
    const url = `${String(this.baseURL).replace(/\/+$/, '')}/systemone`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify(debug ? { ...body, debug } : body),
      signal: AbortSignal.timeout(timeoutMs ?? DECIDE_TIMEOUT_MS),
    });
    const text = await response.text();
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { parsed = { error: { message: text.slice(0, 200) } }; }
    if (!response.ok) throw new DecideError(response.status, (parsed as { error?: { code?: string } })?.error?.code, parsed);
    return parsed as DecideResult;
  }
}

/**
 * Return an `OpenAI` pointed at `nodeUrl`, signing in if it has to.
 *
 * Every call, parameter and exception on the returned client is OpenAI's — plus `decide()` for decision models.
 */
export async function connectAinize(nodeUrl: string, opts: ConnectOptions = {}): Promise<AinizeClient> {
  const base = nodeUrl.replace(/\/+$/, '');
  const apiKey = opts.apiKey ?? await signIn(base, opts);
  return new AinizeClient({ baseURL: `${base}/v1`, apiKey });
}

async function signIn(base: string, opts: ConnectOptions): Promise<string> {
  if (!opts.privateKey) {
    throw new Error('connectAinize() needs either privateKey (to sign in and be issued one) or apiKey (one you already hold)');
  }
  const account = privateKeyToAccount(opts.privateKey);
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const challenge = await postJson<{ nonce: string; message: string }>(
    `${base}/v1/auth/nonce`, { address: account.address, scheme: 'eip191' }, timeout);

  // The message signed is the one the node issued, verbatim. Rebuilding it here would be signing a message this
  // client had a hand in, and the node verifies against the bytes it handed out.
  const signature = await account.signMessage({ message: challenge.message });

  const issued = await postJson<{ api_key: string }>(
    `${base}/v1/auth/token`, { nonce: challenge.nonce, signature, label: opts.label }, timeout);
  return issued.api_key;
}

/** Where to send AIN or sAIN to buy a share of this node's throughput, and which chains it watches. */
export async function depositAddress(nodeUrl: string, apiKey: string): Promise<{ address: string; chains: { chain: string; token: string }[] }> {
  return getJson(`${nodeUrl.replace(/\/+$/, '')}/v1/account/deposit-address`, apiKey, DEFAULT_TIMEOUT_MS);
}

/** This address's deposit and the share it currently buys. */
export async function account(nodeUrl: string, apiKey: string): Promise<{
  address: string; deposited_shares: string; total_deposited_shares: string; share_of_active: number;
}> {
  return getJson(`${nodeUrl.replace(/\/+$/, '')}/v1/account`, apiKey, DEFAULT_TIMEOUT_MS);
}

/**
 * Wait until the node has credited a transfer.
 *
 * The node is the authority on when a transfer counts: it waits for its own confirmation depth before crediting,
 * so a transaction a block explorer already shows is not yet a share here. Polling is honest about that; reading
 * the chain directly would not be.
 */
export async function awaitDeposit(
  nodeUrl: string, txHash: string, apiKey: string,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<{ credited: true; shares: string; chain: string; block_number: number }> {
  const deadline = Date.now() + (opts.timeoutMs ?? 600_000);
  const base = nodeUrl.replace(/\/+$/, '');
  for (;;) {
    const seen = await getJson<{ credited: boolean; shares: string; chain: string; block_number: number }>(
      `${base}/v1/account/deposits/${txHash}`, apiKey, DEFAULT_TIMEOUT_MS);
    if (seen.credited) return seen as { credited: true; shares: string; chain: string; block_number: number };
    if (Date.now() > deadline) throw new Error(`${txHash} was not credited within the timeout`);
    await new Promise((resolve) => setTimeout(resolve, opts.pollMs ?? 5_000));
  }
}

async function postJson<T>(url: string, body: unknown, timeoutMs: number): Promise<T> {
  const response = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`${url} answered ${response.status}: ${(await response.text()).slice(0, 200)}`);
  return response.json() as Promise<T>;
}

async function getJson<T>(url: string, apiKey: string, timeoutMs: number): Promise<T> {
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`${url} answered ${response.status}: ${(await response.text()).slice(0, 200)}`);
  return response.json() as Promise<T>;
}

export { OpenAI };
