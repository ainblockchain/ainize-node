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
import { siteSession, ssoSession, type SsoSiteSession } from './site-session.js';
import { siteSubject } from './site-assertion.js';
import type { SsoService } from './sso.js';

export interface OpenaiApiKeysRoutesDeps {
  keys: OpenaiApiKeyStore;
  store: Store;
  /** This node's own address — what a session predating subjects resolves to. */
  nodeAddress: string;
  /**
   * The secret shared with the site in front of this node (site-assertion.ts), or null. With it, a Google account
   * the site signed in can hold keys of its own, under `google:<sub>`. Without it, only a node session can.
   */
  siteAssertionSecret?: string | null;
  /**
   * AIN SSO state (sso.ts). With it, an SSO session holds keys as its principal, and a vouched Google account that
   * AIN SSO suspended is refused — whether or not AIN SSO is configured right now, since a suspension must outlive
   * turning SSO off.
   */
  sso?: SsoService | null;
}

function refuse(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { message, type: 'invalid_request_error', code, param: null } });
}

const createRequest = z.object({
  /** The caller's own words about which machine this is. Shown back in the list so two keys can be told apart. */
  label: z.string().max(60, 'a label is a name, not a note').optional(),
  /**
   * AIN SSO sessions only: the organization this key is for, or null for a personal key. Omitted = the organization
   * selected at sign-in, or the only one the session has. An organization key stops working when AIN SSO suspends
   * the person in that organization; a personal key never does.
   */
  org_id: z.string().max(200).nullable().optional(),
});

export function openaiApiKeysRoutes(deps: OpenaiApiKeysRoutesDeps): Router {
  const router = Router();

  /**
   * Every route here is about the caller's own keys. There is no route that takes an address.
   *
   * Three ways to be the caller, strongest first: a wallet session (it is what a deposit is tied to), an AIN SSO
   * session (its principal — `sso:<sub>` or the legacy `google:<sub>` it is linked to), and a Google account the
   * site vouches for. The last two are refused while AIN SSO has the account suspended everywhere.
   */
  const mine = (req: Request, res: Response): { owner: string; sso: SsoSiteSession | null } | null => {
    const session = siteSession(req, deps.store, deps.nodeAddress);
    if (session) return { owner: session.address.toLowerCase(), sso: null };
    const sso = ssoSession(req, deps.store);
    if (sso) {
      if (deps.sso?.isBlocked(sso.iss, sso.sub)) { refuse(res, 403, 'account_suspended', 'this account is suspended by its organization'); return null; }
      return { owner: sso.principal, sso };
    }
    const vouched = siteSubject(req, deps.siteAssertionSecret ?? null);
    if (vouched) {
      if (deps.sso?.principalState(vouched).blocked) { refuse(res, 403, 'account_suspended', 'this account is suspended by its organization'); return null; }
      return { owner: vouched, sso: null };
    }
    refuse(res, 401, 'not_signed_in', 'sign in on this node to manage API keys — anonymous callers use the free tier');
    return null;
  };

  router.get('/api/keys', (req, res) => {
    const who = mine(req, res);
    if (!who) return;
    res.json({ keys: deps.keys.listFor(who.owner) });
  });

  router.post('/api/keys', (req, res) => {
    const who = mine(req, res);
    if (!who) return;
    const parsed = createRequest.safeParse(req.body ?? {});
    if (!parsed.success) {
      refuse(res, 400, 'invalid_request', parsed.error.issues[0]?.message ?? 'invalid request');
      return;
    }
    // Which organization, if any. Only an SSO session knows any organization, and only the ones its ID token named.
    let orgId: string | null = null;
    if (who.sso) {
      const orgs = who.sso.orgs.map((o) => o.id);
      if (parsed.data.org_id === undefined) {
        orgId = who.sso.org ?? (orgs.length === 1 ? orgs[0]! : null);
        if (!orgId && orgs.length > 1) {
          refuse(res, 400, 'org_required', `say which organization this key is for (org_id: one of ${orgs.join(', ')}), or org_id: null for a personal key`);
          return;
        }
      } else if (parsed.data.org_id !== null) {
        if (!orgs.includes(parsed.data.org_id)) { refuse(res, 403, 'org_not_allowed', 'this session was not signed in for that organization'); return; }
        orgId = parsed.data.org_id;
      }
      if (orgId && deps.sso && !deps.sso.orgKeyUsable(who.owner, orgId)) { refuse(res, 403, 'account_suspended', 'your access to that organization is suspended'); return; }
    } else if (parsed.data.org_id) {
      refuse(res, 400, 'org_needs_sso', 'organization keys are made in a session signed in with AIN SSO');
      return;
    }
    // A key made in an SSO session remembers which AIN account made it: if that account's link to a legacy
    // principal is rolled back, the keys it made there go with the link (sso.ts, protocol §4.4).
    const apiKey = deps.keys.issue(who.owner, parsed.data.label ?? null, orgId, who.sso ? { iss: who.sso.iss, sub: who.sso.sub } : null);
    const created = deps.keys.listFor(who.owner).find((k) => k.label === (parsed.data.label ?? null) && k.org_id === orgId);
    res.json({
      // The only time this value exists outside the caller's own hands. The page says so; so does this comment,
      // for whoever later wonders why there is no route to read it back.
      api_key: apiKey,
      prefix: created?.prefix ?? '',
      label: parsed.data.label ?? null,
      org_id: orgId,
    });
  });

  router.delete('/api/keys/:prefix', (req, res) => {
    const who = mine(req, res);
    if (!who) return;
    const address = who.owner;
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
