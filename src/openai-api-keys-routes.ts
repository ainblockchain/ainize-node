/**
 * Getting an API key the way every other model API hands one out.
 *
 * The quickstart used to say `private_key="0x…"`, and that is not merely unfamiliar: no other model API asks for
 * one, and what is being pasted into a source file is the whole wallet. A key that can sign a transfer does not
 * belong in a repository, a CI variable or a screenshot.
 *
 * The browser is where a wallet already lives and where the person is already signed in, so a key is issued from
 * the session they already have. One signature, in the place signatures belong, and a bearer string afterwards —
 * which is exactly the shape every caller already knows.
 *
 * The store keeps only a hash of each key, so the secret exists exactly once: in the response that creates it.
 * That is not a limitation to work around. A list that could show it again would mean the node had kept it.
 */
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { OpenaiApiKeyStore } from './openai-api-keys.js';
import type { Store } from './store.js';
import { siteSession } from './site-session.js';

export interface OpenaiApiKeysRoutesDeps {
  keys: OpenaiApiKeyStore;
  store: Store;
  /** This node's own address — what a session predating subjects resolves to. */
  nodeAddress: string;
}

function refuse(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { message, type: 'invalid_request_error', code, param: null } });
}

const createRequest = z.object({
  /** The caller's own words about which machine this is. Shown back in the list so two keys can be told apart. */
  label: z.string().max(60, 'a label is a name, not a note').optional(),
});

export function openaiApiKeysRoutes(deps: OpenaiApiKeysRoutesDeps): Router {
  const router = Router();

  /** Every route here is about the caller's own keys. There is no route that takes an address. */
  const mine = (req: Request, res: Response): string | null => {
    const session = siteSession(req, deps.store, deps.nodeAddress);
    if (!session) {
      refuse(res, 401, 'not_signed_in', 'sign in on this node to manage API keys — anonymous callers use the free tier');
      return null;
    }
    return session.address.toLowerCase();
  };

  router.get('/api/keys', (req, res) => {
    const address = mine(req, res);
    if (!address) return;
    res.json({ keys: deps.keys.listFor(address) });
  });

  router.post('/api/keys', (req, res) => {
    const address = mine(req, res);
    if (!address) return;
    const parsed = createRequest.safeParse(req.body ?? {});
    if (!parsed.success) {
      refuse(res, 400, 'invalid_request', parsed.error.issues[0]?.message ?? 'invalid request');
      return;
    }
    const apiKey = deps.keys.issue(address, parsed.data.label ?? null);
    const created = deps.keys.listFor(address).find((k) => k.label === (parsed.data.label ?? null));
    res.json({
      // The only time this value exists outside the caller's own hands. The page says so; so does this comment,
      // for whoever later wonders why there is no route to read it back.
      api_key: apiKey,
      prefix: created?.prefix ?? '',
      label: parsed.data.label ?? null,
    });
  });

  router.delete('/api/keys/:prefix', (req, res) => {
    const address = mine(req, res);
    if (!address) return;
    const prefix = String(req.params.prefix ?? '');
    // Revoked by prefix, looked up within this caller's own keys. A prefix is public enough to appear in a list,
    // so treating it as a capability would let anybody who saw one revoke somebody else's key.
    const revoked = deps.keys.revokeByPrefixFor(address, prefix);
    if (!revoked) {
      refuse(res, 404, 'key_not_found', 'no key of yours has that prefix');
      return;
    }
    res.json({ revoked: true, prefix });
  });

  return router;
}
