/**
 * Point OpenAI at an Ainize node.
 *
 * The same contract as the Python package, deliberately: one call proves which address is asking and returns the
 * genuine `OpenAI` client. It does not wrap, subclass or re-export a narrowed version of it — the whole promise
 * is that the code after that line is unchanged, and a wrapper would have to grow a method every time OpenAI's
 * client does while being a second place for bugs to live.
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

/**
 * Return an `OpenAI` pointed at `nodeUrl`, signing in if it has to.
 *
 * Every call, parameter and exception on the returned client is OpenAI's.
 */
export async function connectAinize(nodeUrl: string, opts: ConnectOptions = {}): Promise<OpenAI> {
  const base = nodeUrl.replace(/\/+$/, '');
  const apiKey = opts.apiKey ?? await signIn(base, opts);
  return new OpenAI({ baseURL: `${base}/v1`, apiKey });
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
