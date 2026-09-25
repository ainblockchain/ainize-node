/**
 * The door to the `/v1` surface: prove an address once, leave with a key.
 *
 * The node already knows how to prove an address — `/api/auth/challenge` issues a readable message and
 * `/api/auth/wallet` verifies it — and this reuses that machinery rather than adding a second way to sign in.
 * What differs is only what you leave with: a session cookie is for a browser, and an OpenAI client sends a
 * bearer key, so this door hands out a key instead.
 *
 * Three rules are carried over from the session door because getting any of them wrong is the whole vulnerability:
 *
 *   • The nonce is single-use and is deleted BEFORE the signature is checked, so two simultaneous presentations
 *     of one stolen signature cannot both win the race.
 *   • The signature is verified against the exact bytes the node issued, never against a message rebuilt from the
 *     request. A rebuilt message is a message the caller had a hand in.
 *   • The scheme is fixed when the challenge is asked for. `ain` means a key acted on its own and `eip191` means a
 *     person read a prompt; letting whoever presents the signature say which rules apply would let them choose
 *     which of those two claims the node believes.
 *
 * An expired nonce, an unknown nonce and a bad signature all answer 401 in the same words. Telling them apart
 * would say whether a nonce ever existed, which is not a question a caller who does not hold the key should have
 * answered.
 */
import { Router, type Request } from 'express';
import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import { verifyAuth, LOGIN_NONCE_TTL_MS, type AuthScheme } from '@ainize/core';
import { walletLoginMessage, requestOrigin } from './wallet-login.js';
import type { OpenaiApiKeyStore } from './openai-api-keys.js';

export interface OpenaiAuthDeps {
  keys: OpenaiApiKeyStore;
  /** This node's address, shown in the message so a person can see which node they are signing in to. */
  node: string;
  nodeName?: string;
  /** Swept-open for tests; production callers leave it. */
  now?: () => number;
}

interface OpenaiAuthChallenge {
  address: string;
  message: string;
  scheme: AuthScheme;
  expires: number;
}

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/** One 401, whatever went wrong. See the note above on why these are not told apart. */
const REFUSED = 'that sign-in could not be verified — ask for a new challenge and sign the message it returns';

export function openaiAuthRoutes(deps: OpenaiAuthDeps): Router {
  const router = Router();
  const now = deps.now ?? (() => Date.now());
  /** In memory: a restart forgetting every outstanding challenge is correct, not a bug. */
  const challenges = new Map<string, OpenaiAuthChallenge>();

  const sweep = () => {
    const cutoff = now();
    for (const [nonce, held] of challenges) if (held.expires <= cutoff) challenges.delete(nonce);
  };

  router.post('/auth/nonce', (req: Request, res) => {
    sweep();
    const parsed = z.object({
      address: z.string().regex(EVM_ADDRESS, 'an EVM address is 0x followed by 40 hex characters'),
      scheme: z.enum(['ain', 'eip191']).default('eip191'),
    }).safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: { message: parsed.error.issues[0]?.message ?? 'invalid request', type: 'invalid_request_error', code: 'invalid_address' } });
      return;
    }
    const { address, scheme } = parsed.data;
    const nonce = randomBytes(16).toString('hex');
    const expires = now() + LOGIN_NONCE_TTL_MS;
    const message = walletLoginMessage({
      node: deps.node, nodeName: deps.nodeName, nonce,
      origin: requestOrigin(req.header('origin')), expiresAt: expires,
    });
    challenges.set(nonce, { address: address.toLowerCase(), message, scheme, expires });
    res.json({ nonce, message, scheme, expires_at: expires, node: deps.node });
  });

  router.post('/auth/token', (req: Request, res) => {
    sweep();
    const parsed = z.object({
      nonce: z.string().min(1),
      signature: z.string().min(1),
      label: z.string().max(60).optional(),
    }).safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: { message: 'nonce and signature are required', type: 'invalid_request_error', code: 'invalid_request' } });
      return;
    }
    const { nonce, signature, label } = parsed.data;
    const held = challenges.get(nonce);
    // Deleted before the signature is checked: two presentations of one signature must not both be able to win.
    challenges.delete(nonce);
    if (!held || held.expires <= now() || !verifyAuth(held.scheme, held.message, signature, held.address)) {
      res.status(401).json({ error: { message: REFUSED, type: 'invalid_request_error', code: 'invalid_signature' } });
      return;
    }
    res.json({
      api_key: deps.keys.issue(held.address, label ?? null),
      address: held.address,
      /** Keys do not expire on their own; they are revoked. Said explicitly so a client does not invent a refresh. */
      expires_at: null,
    });
  });

  return router;
}
