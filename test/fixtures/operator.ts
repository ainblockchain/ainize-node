/**
 * Sign in as a node's operator, for tests.
 *
 * There is no password any more. The node's own key is always an operator, so a test signs the challenge with the
 * identity from the config it started the node with — which is what a real operator does on the machine that holds
 * it (`ainize login`). One helper, so the twelve test files that used to POST a password do not each grow their own
 * two-step version of this.
 */
import { operatorLoginMessage, signMessage } from '@ainize/core';

export async function operatorToken(url: string, identity: { privateKey: string; address: string }): Promise<string> {
  const ch = await (await fetch(`${url}/api/auth/challenge`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json() as { nonce: string; message: string };
  const r = await fetch(`${url}/api/auth/wallet`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ address: identity.address, nonce: ch.nonce, signature: signMessage(ch.message, identity.privateKey) }),
  });
  const j = await r.json() as { token?: string; error?: string };
  if (!r.ok || !j.token) throw new Error(`operator sign-in failed (${r.status}): ${j.error ?? 'no token'}`);
  return j.token;
}
