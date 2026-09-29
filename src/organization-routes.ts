/**
 * `/api/orgs` — organizations: the page, the members and their roles, invites and join requests, resource
 * groups, the audit log, and what billing and security the node can say (organization-store.ts).
 *
 * Who is asking is decided once (`deps.viewer`): a wallet session is a principal with no email; an AIN SSO
 * session brings the email the issuer vouched for and the organizations its ID token named. Membership is then
 * the store's `membership()` — explicit row, email domain, or SSO organization. Every route answers
 * `{ error: { code, message } }` on refusal, the codes being what the site switches on:
 *
 *   401 not_signed_in · 404 not_found · 403 not_member (the page exists, you are not in it; `can_request` says
 *   whether asking to join is open) · 403 insufficient_role · 400 invalid_request · 409 id_taken / domain_taken /
 *   has_agents · 403 domain_not_yours · 429 limit_reached · 409 last_admin
 */
import { Router, type Request, type Response } from 'express';
import { agentCallStats, agentUrl } from './agents.js';
import type { LinkedAgent } from './linked-agent-store.js';
import type { OpenaiApiKeySummary } from './openai-api-keys.js';
import {
  canSeeOrgAgent, emailDomain, membership, normalisePrincipal, OrgDomainNotYoursError, OrgDomainTakenError, OrgIdTakenError, OrgLastAdminError,
  OrgLimitError, orgCreateInput, orgGroupInput, orgInviteInput, orgJoinInput, orgMemberInput, orgRoleInput, orgUpdateInput, roleAtLeast,
  type Organization, type OrganizationStore, type OrgRole, type OrgViewer,
} from './organization-store.js';

/** What an organization's pages need of one of its agents — a linked agent, or a hosted one without its code. */
export type OrgAgentRow = Pick<LinkedAgent, 'id' | 'name' | 'description' | 'owner' | 'org' | 'visibility' | 'group' | 'version' | 'createdAt' | 'updatedAt'>;

export interface OrganizationRoutesDeps {
  orgs: OrganizationStore;
  /** The organization's agents — linked ones and the ones this node runs under it (server.ts joins the two stores). */
  agents: { listByOrg(org: string): OrgAgentRow[]; list(): OrgAgentRow[] };
  /** Who is signed in, as an organization sees it — or null. */
  viewer: (req: Request) => OrgViewer | null;
  /** Ids an organization may not take — the site's `/org/*` pages are in the store; this adds anything else. */
  reserved?: (id: string) => boolean;
  /** This node's public base URL, for agent addresses and invite links. */
  publicBase: (req: Request) => string;
  /** The site in front of this node, for invite links (`/org/join/<token>`); defaults to `publicBase`. */
  siteBase?: (req: Request) => string;
  /** API keys, so an organization's admins can see the keys made for it. */
  keys?: { listFor(owner: string): OpenaiApiKeySummary[] } | null;
  /** What the security tab says about sign-in. */
  sso?: () => { configured: boolean; issuer: string | null };
}

const refuse = (res: Response, status: number, code: string, message: string, extra: Record<string, unknown> = {}) => {
  res.status(status).json({ error: { code, message }, ...extra });
};

const zodMessage = (issues: { path: PropertyKey[]; message: string }[]) => {
  const issue = issues[0];
  return `${issue?.path.map(String).join('.') || 'body'}: ${issue?.message ?? 'invalid'}`;
};

export function organizationRoutes(deps: OrganizationRoutesDeps): Router {
  const router = Router();
  const reserved = deps.reserved ?? (() => false);

  const signedIn = (req: Request, res: Response): OrgViewer | null => {
    const who = deps.viewer(req);
    if (!who) refuse(res, 401, 'not_signed_in', 'sign in to see or manage organizations');
    return who;
  };

  /** The organization, and the caller's role in it at least `min`. Answers the refusal itself otherwise. */
  const access = (req: Request, res: Response, min: OrgRole): { org: Organization; viewer: OrgViewer; role: OrgRole } | null => {
    const viewer = signedIn(req, res);
    if (!viewer) return null;
    const org = deps.orgs.get(String(req.params.id));
    if (!org) { refuse(res, 404, 'not_found', `no organization "${req.params.id}" on this node`); return null; }
    const m = membership(org, viewer);
    if (!m) {
      refuse(res, 403, 'not_member', 'this organization is for its members', {
        org: { id: org.id, name: org.name, description: org.description },
        can_request: !org.joinRequests.some((r) => r.principal === normalisePrincipal(viewer.principal)),
        requested: org.joinRequests.some((r) => r.principal === normalisePrincipal(viewer.principal)),
      });
      return null;
    }
    // a domain or SSO member who shows up is written down, so admins see who is here and can change their role
    if (m.via !== 'member') deps.orgs.setMember(org.id, { principal: viewer.principal, role: m.role, email: viewer.email, name: viewer.name, via: m.via }, normalisePrincipal(viewer.principal));
    if (!roleAtLeast(m.role, min)) { refuse(res, 403, 'insufficient_role', `this needs the ${min} role in the organization (you are ${m.role})`); return null; }
    return { org: deps.orgs.get(org.id)!, viewer, role: m.role };
  };

  const storeError = (res: Response, e: unknown): boolean => {
    if (e instanceof OrgIdTakenError) refuse(res, 409, 'id_taken', e.message);
    else if (e instanceof OrgDomainTakenError) refuse(res, 409, 'domain_taken', e.message);
    else if (e instanceof OrgDomainNotYoursError) refuse(res, 403, 'domain_not_yours', e.message);
    else if (e instanceof OrgLimitError) refuse(res, 429, 'limit_reached', e.message);
    else if (e instanceof OrgLastAdminError) refuse(res, 409, 'last_admin', e.message);
    else return false;
    return true;
  };

  // ---------------------------------------------------------------------------------------------- views

  const agentView = (req: Request, a: OrgAgentRow) => {
    const base = agentUrl(deps.publicBase(req), a.id);
    const stats = agentCallStats(a.id);
    return {
      id: a.id, name: a.name, description: a.description, owner: a.owner, org: a.org, visibility: a.visibility, group: a.group,
      a2a_url: base, card_url: `${base}/.well-known/agent-card.json`, version: a.version, created_at: a.createdAt, updated_at: a.updatedAt,
      calls: stats.total, last_call_at: stats.last_at,
    };
  };

  const memberView = (m: Organization['members'][number], admin: boolean) => ({
    principal: m.principal, role: m.role, name: m.name, added_at: m.addedAt, via: m.via,
    // an address is the member's own business unless you run the organization
    email: admin ? m.email : m.email ? `${m.email[0]}…@${emailDomain(m.email) ?? ''}` : null,
  });

  const summary = (org: Organization, role: OrgRole | null) => ({
    id: org.id, name: org.name, description: org.description, domains: org.domains, member_count: org.members.length,
    agent_count: deps.agents.listByOrg(org.id).length, created_at: org.createdAt, updated_at: org.updatedAt, my_role: role,
  });

  const profile = (req: Request, org: Organization, viewer: OrgViewer, role: OrgRole) => {
    const admin = roleAtLeast(role, 'admin');
    const who = normalisePrincipal(viewer.principal);
    const agents = deps.agents.listByOrg(org.id).filter((a) => canSeeOrgAgent(org, a, viewer, role)).map((a) => agentView(req, a));
    return {
      ...summary(org, role),
      readme: org.readme, domain_role: org.domainRole, sso_org_ids: org.ssoOrgIds, spend_cap_credits: org.spendCapCredits,
      created_by: org.createdBy, version: org.version,
      members: org.members.map((m) => memberView(m, admin)),
      groups: (admin ? org.groups : org.groups.filter((g) => g.members.includes(who))).map((g) => ({ id: g.id, name: g.name, members: g.members, agents: g.agents })),
      pending_requests: admin ? org.joinRequests.length : 0,
      open_invites: admin ? org.invites.filter((i) => i.usedBy === null && i.expiresAt > Date.now()).length : 0,
      agents,
      /** how many of the organization's agents this viewer cannot see — the page says "and N you cannot see" rather than lying about the count */
      hidden_agents: deps.agents.listByOrg(org.id).length - agents.length,
    };
  };

  // ---------------------------------------------------------------------------------------------- organizations

  /** The organizations the caller is in. Anonymous callers get an empty list, not a refusal — the page decides what to say. */
  router.get('/api/orgs', (req, res) => {
    const viewer = deps.viewer(req);
    if (!viewer) return res.json({ orgs: [], signed_in: false });
    const mine = deps.orgs.listFor(viewer).map(({ org, role, via }) => ({ ...summary(org, role), via }));
    // the domain the sign-in is on, and whether an organization already holds it — the "create yours" hint
    const domain = emailDomain(viewer.email);
    res.json({ orgs: mine, signed_in: true, email_domain: domain, domain_org: domain ? deps.orgs.byDomain(domain)?.id ?? null : null });
  });

  router.post('/api/orgs', (req, res) => {
    const viewer = signedIn(req, res);
    if (!viewer) return;
    const parsed = orgCreateInput.safeParse(req.body ?? {});
    if (!parsed.success) return refuse(res, 400, 'invalid_request', zodMessage(parsed.error.issues));
    try {
      const org = deps.orgs.create(parsed.data, viewer, reserved);
      res.status(201).json({ org: profile(req, org, viewer, 'admin') });
    } catch (e) {
      if (!storeError(res, e)) throw e;
    }
  });

  router.get('/api/orgs/:id', (req, res) => {
    const a = access(req, res, 'read');
    if (a) res.json({ org: profile(req, a.org, a.viewer, a.role) });
  });

  router.put('/api/orgs/:id', (req, res) => {
    const a = access(req, res, 'admin');
    if (!a) return;
    const parsed = orgUpdateInput.safeParse(req.body ?? {});
    if (!parsed.success) return refuse(res, 400, 'invalid_request', zodMessage(parsed.error.issues));
    try {
      const org = deps.orgs.update(a.org.id, parsed.data, a.viewer);
      res.json({ org: profile(req, org, a.viewer, a.role) });
    } catch (e) {
      if (!storeError(res, e)) throw e;
    }
  });

  /** An organization with agents is not deleted: move or remove them first, so nothing a workspace imported vanishes by accident. */
  router.delete('/api/orgs/:id', (req, res) => {
    const a = access(req, res, 'admin');
    if (!a) return;
    const agents = deps.agents.listByOrg(a.org.id);
    if (agents.length) return refuse(res, 409, 'has_agents', `remove or move the organization's ${agents.length} agent(s) first`, { agents: agents.map((x) => x.id) });
    deps.orgs.delete(a.org.id, normalisePrincipal(a.viewer.principal));
    res.json({ deleted: a.org.id });
  });

  // ---------------------------------------------------------------------------------------------- members

  router.get('/api/orgs/:id/members', (req, res) => {
    const a = access(req, res, 'read');
    if (!a) return;
    const admin = roleAtLeast(a.role, 'admin');
    res.json({ members: a.org.members.map((m) => memberView(m, admin)), domain_role: a.org.domainRole, domains: a.org.domains });
  });

  /** Add someone by principal (an address or `sso:<sub>`) without an invite — for admins who already know it. */
  router.post('/api/orgs/:id/members', (req, res) => {
    const a = access(req, res, 'admin');
    if (!a) return;
    const parsed = orgMemberInput.safeParse(req.body ?? {});
    if (!parsed.success) return refuse(res, 400, 'invalid_request', zodMessage(parsed.error.issues));
    try {
      const m = deps.orgs.setMember(a.org.id, { principal: parsed.data.principal, role: parsed.data.role, email: null, name: null, via: 'admin' }, normalisePrincipal(a.viewer.principal));
      res.status(201).json({ member: memberView(m, true) });
    } catch (e) {
      if (!storeError(res, e)) throw e;
    }
  });

  router.put('/api/orgs/:id/members/:principal', (req, res) => {
    const a = access(req, res, 'admin');
    if (!a) return;
    const parsed = orgRoleInput.safeParse(req.body ?? {});
    if (!parsed.success) return refuse(res, 400, 'invalid_request', zodMessage(parsed.error.issues));
    const who = normalisePrincipal(String(req.params.principal));
    const prior = a.org.members.find((m) => m.principal === who);
    if (!prior) return refuse(res, 404, 'not_found', 'no such member');
    try {
      const m = deps.orgs.setMember(a.org.id, { ...prior, role: parsed.data.role }, normalisePrincipal(a.viewer.principal));
      res.json({ member: memberView(m, true) });
    } catch (e) {
      if (!storeError(res, e)) throw e;
    }
  });

  /** Anyone may leave; admins remove others. The last admin can do neither. */
  router.delete('/api/orgs/:id/members/:principal', (req, res) => {
    const a = access(req, res, 'read');
    if (!a) return;
    const who = normalisePrincipal(String(req.params.principal));
    const self = who === normalisePrincipal(a.viewer.principal);
    if (!self && !roleAtLeast(a.role, 'admin')) return refuse(res, 403, 'insufficient_role', 'only admins remove other members');
    try {
      const had = deps.orgs.removeMember(a.org.id, who, normalisePrincipal(a.viewer.principal));
      if (!had) return refuse(res, 404, 'not_found', 'no such member');
      res.json({ removed: who });
    } catch (e) {
      if (!storeError(res, e)) throw e;
    }
  });

  // ---------------------------------------------------------------------------------------------- join requests

  router.post('/api/orgs/:id/join', (req, res) => {
    const viewer = signedIn(req, res);
    if (!viewer) return;
    const org = deps.orgs.get(String(req.params.id));
    if (!org) return refuse(res, 404, 'not_found', `no organization "${req.params.id}" on this node`);
    if (membership(org, viewer)) return refuse(res, 409, 'already_member', 'you are already in this organization');
    const parsed = orgJoinInput.safeParse(req.body ?? {});
    if (!parsed.success) return refuse(res, 400, 'invalid_request', zodMessage(parsed.error.issues));
    try {
      const r = deps.orgs.requestJoin(org.id, viewer, parsed.data.message);
      res.status(202).json({ request: { principal: r.principal, requested_at: r.requestedAt } });
    } catch (e) {
      if (!storeError(res, e)) throw e;
    }
  });

  router.get('/api/orgs/:id/requests', (req, res) => {
    const a = access(req, res, 'admin');
    if (a) res.json({ requests: a.org.joinRequests.map((r) => ({ principal: r.principal, email: r.email, name: r.name, message: r.message, requested_at: r.requestedAt })) });
  });

  router.post('/api/orgs/:id/requests/:principal/approve', (req, res) => {
    const a = access(req, res, 'admin');
    if (!a) return;
    const who = normalisePrincipal(String(req.params.principal));
    const r = a.org.joinRequests.find((x) => x.principal === who);
    if (!r) return refuse(res, 404, 'not_found', 'no such request');
    const parsed = orgRoleInput.partial().safeParse(req.body ?? {});
    if (!parsed.success) return refuse(res, 400, 'invalid_request', zodMessage(parsed.error.issues));
    try {
      const m = deps.orgs.setMember(a.org.id, { principal: who, role: parsed.data.role ?? 'read', email: r.email, name: r.name, via: 'request' }, normalisePrincipal(a.viewer.principal));
      res.json({ member: memberView(m, true) });
    } catch (e) {
      if (!storeError(res, e)) throw e;
    }
  });

  router.delete('/api/orgs/:id/requests/:principal', (req, res) => {
    const a = access(req, res, 'admin');
    if (!a) return;
    const had = deps.orgs.rejectRequest(a.org.id, String(req.params.principal), normalisePrincipal(a.viewer.principal));
    if (!had) return refuse(res, 404, 'not_found', 'no such request');
    res.json({ rejected: normalisePrincipal(String(req.params.principal)) });
  });

  // ---------------------------------------------------------------------------------------------- invites

  const inviteView = (req: Request, i: Organization['invites'][number], withToken: boolean) => ({
    token: withToken ? i.token : null, token_prefix: i.token.slice(0, 6), role: i.role, email: i.email, created_by: i.createdBy, created_at: i.createdAt,
    expires_at: i.expiresAt, used_by: i.usedBy, used_at: i.usedAt,
    url: withToken ? `${(deps.siteBase ?? deps.publicBase)(req).replace(/\/+$/, '')}/org/join/${i.token}` : null,
  });

  /** The link is returned once, here. The list shows a prefix, so a link that leaked cannot be read back from the node. */
  router.post('/api/orgs/:id/invites', (req, res) => {
    const a = access(req, res, 'admin');
    if (!a) return;
    const parsed = orgInviteInput.safeParse(req.body ?? {});
    if (!parsed.success) return refuse(res, 400, 'invalid_request', zodMessage(parsed.error.issues));
    try {
      const i = deps.orgs.createInvite(a.org.id, { role: parsed.data.role, email: parsed.data.email ?? null, ttlHours: parsed.data.ttlHours }, normalisePrincipal(a.viewer.principal));
      res.status(201).json({ invite: inviteView(req, i, true) });
    } catch (e) {
      if (!storeError(res, e)) throw e;
    }
  });

  router.get('/api/orgs/:id/invites', (req, res) => {
    const a = access(req, res, 'admin');
    if (a) res.json({ invites: a.org.invites.filter((i) => i.expiresAt > Date.now() || i.usedBy).map((i) => inviteView(req, i, false)) });
  });

  router.delete('/api/orgs/:id/invites/:token', (req, res) => {
    const a = access(req, res, 'admin');
    if (!a) return;
    const had = deps.orgs.revokeInvite(a.org.id, String(req.params.token), normalisePrincipal(a.viewer.principal));
    if (!had) return refuse(res, 404, 'not_found', 'no such invite');
    res.json({ revoked: true });
  });

  /** What an invite link leads to, before accepting: the organization's name and the role offered. */
  router.get('/api/orgs/join/:token', (req, res) => {
    const hit = deps.orgs.findInvite(String(req.params.token));
    if (!hit) return refuse(res, 404, 'not_found', 'this invite is unknown, used or expired');
    res.json({ org: { id: hit.org.id, name: hit.org.name, description: hit.org.description }, role: hit.invite.role, email: hit.invite.email ? `…@${emailDomain(hit.invite.email)}` : null, expires_at: hit.invite.expiresAt });
  });

  router.post('/api/orgs/join/:token', (req, res) => {
    const viewer = signedIn(req, res);
    if (!viewer) return;
    const hit = deps.orgs.findInvite(String(req.params.token));
    if (!hit) return refuse(res, 404, 'not_found', 'this invite is unknown, used or expired');
    if (hit.invite.email && hit.invite.email !== (viewer.email ?? '').toLowerCase()) return refuse(res, 403, 'invite_for_someone_else', 'this invite was made for a different email address');
    try {
      const used = deps.orgs.useInvite(hit.invite.token, viewer);
      if (!used) return refuse(res, 404, 'not_found', 'this invite is unknown, used or expired');
      res.json({ org: profile(req, deps.orgs.get(used.org.id)!, viewer, used.member.role) });
    } catch (e) {
      if (!storeError(res, e)) throw e;
    }
  });

  // ---------------------------------------------------------------------------------------------- resource groups

  const groupBody = (req: Request, res: Response) => {
    const parsed = orgGroupInput.safeParse(req.body ?? {});
    if (!parsed.success) { refuse(res, 400, 'invalid_request', zodMessage(parsed.error.issues)); return null; }
    return parsed.data;
  };

  router.get('/api/orgs/:id/groups', (req, res) => {
    const a = access(req, res, 'read');
    if (!a) return;
    const who = normalisePrincipal(a.viewer.principal);
    const groups = roleAtLeast(a.role, 'write') ? a.org.groups : a.org.groups.filter((g) => g.members.includes(who));
    res.json({ groups });
  });

  router.post('/api/orgs/:id/groups', (req, res) => {
    const a = access(req, res, 'write');
    if (!a) return;
    const body = groupBody(req, res);
    if (!body) return;
    try {
      res.status(201).json({ group: deps.orgs.setGroup(a.org.id, body, normalisePrincipal(a.viewer.principal)) });
    } catch (e) {
      if (!storeError(res, e)) throw e;
    }
  });

  router.put('/api/orgs/:id/groups/:groupId', (req, res) => {
    const a = access(req, res, 'write');
    if (!a) return;
    if (!a.org.groups.some((g) => g.id === req.params.groupId)) return refuse(res, 404, 'not_found', 'no such group');
    const body = groupBody(req, res);
    if (!body) return;
    res.json({ group: deps.orgs.setGroup(a.org.id, { ...body, id: String(req.params.groupId) }, normalisePrincipal(a.viewer.principal)) });
  });

  router.delete('/api/orgs/:id/groups/:groupId', (req, res) => {
    const a = access(req, res, 'write');
    if (!a) return;
    const had = deps.orgs.removeGroup(a.org.id, String(req.params.groupId), normalisePrincipal(a.viewer.principal));
    if (!had) return refuse(res, 404, 'not_found', 'no such group');
    res.json({ deleted: req.params.groupId });
  });

  // ---------------------------------------------------------------------------------------------- audit · billing · security

  router.get('/api/orgs/:id/audit', (req, res) => {
    const a = access(req, res, 'admin');
    if (!a) return;
    const limit = Math.min(1000, Math.max(1, Number(req.query.limit ?? 200) || 200));
    res.json({ audit: deps.orgs.audit(a.org.id, limit) });
  });

  /**
   * What this node can honestly put on a billing page. The organization's API keys are the keys its members made
   * for one of its AIN SSO organizations (openai-api-keys.ts `orgId`). Usage this node counts is A2A calls to the
   * organization's agents; per-key inference spend is NOT metered on this node yet, and the answer says so
   * (`spend_metered: false`) rather than drawing a graph of zeros. The spend cap is recorded for when it is.
   */
  router.get('/api/orgs/:id/billing', (req, res) => {
    const a = access(req, res, 'admin');
    if (!a) return;
    const keys = deps.keys
      ? a.org.members.flatMap((m) => deps.keys!.listFor(m.principal).filter((k) => k.org_id && a.org.ssoOrgIds.includes(k.org_id)).map((k) => ({ ...k, owner: m.principal })))
      : [];
    const agents = deps.agents.listByOrg(a.org.id).map((x) => ({ id: x.id, name: x.name, visibility: x.visibility, ...agentCallStats(x.id) }));
    res.json({
      spend_cap_credits: a.org.spendCapCredits, sso_org_ids: a.org.ssoOrgIds, keys_available: !!deps.keys, keys,
      agents, agent_calls_total: agents.reduce((n, x) => n + x.total, 0),
      spend_metered: false,
    });
  });

  router.get('/api/orgs/:id/security', (req, res) => {
    const a = access(req, res, 'admin');
    if (!a) return;
    const sso = deps.sso?.() ?? { configured: false, issuer: null };
    const via = a.org.members.reduce<Record<string, number>>((acc, m) => ({ ...acc, [m.via]: (acc[m.via] ?? 0) + 1 }), {});
    res.json({
      sso: { ...sso, org_ids: a.org.ssoOrgIds },
      domains: a.org.domains, domain_role: a.org.domainRole,
      members_by_via: via, admins: a.org.members.filter((m) => m.role === 'admin').map((m) => m.principal),
      private_agents: deps.agents.listByOrg(a.org.id).filter((x) => x.visibility === 'private').length,
      audit: deps.orgs.audit(a.org.id, 20),
    });
  });

  return router;
}
