/**
 * Organizations — a team's home on this node: a name, a README, the agents it owns, the people in it and what
 * each may do.
 *
 * Until 2026-09-29 ainize had no organizations (docs/ain-sso.md §2): an AIN organization appeared only as the
 * `orgId` on an API key. Two things asked for more. AIN Teams and ainmem import every agent they show from this
 * node's catalogue, and a company wants "our agents" to be a place — registered under the company, managed by
 * the company, private when they should be — not a filter over one person's list. And the people who should be
 * in that place are known by something the sign-in already proves: the domain of the email AIN SSO vouched for.
 *
 * So an organization here is:
 *   - a page (`/org/<id>`): name, README (markdown), the agents registered under it;
 *   - a membership: explicit members with a role, plus everyone whose sign-in email is on one of the
 *     organization's DOMAINS (`@comcom.ai` → the comcom organization) at the organization's `domainRole`, plus
 *     everyone whose AIN SSO ID token names one of its `ssoOrgIds`;
 *   - roles, in order: `read` (see the page and its private agents) < `contributor` (register agents under it,
 *     change one's own) < `write` (change or remove any of its agents, manage resource groups) < `admin`
 *     (members, invites, requests, settings, billing, security);
 *   - resource groups: a private agent assigned to a group is visible to that group's members and admins only;
 *   - an audit log of who changed what.
 *
 * A DOMAIN CAN ONLY BE CLAIMED BY SOMEONE WHOSE OWN VERIFIED EMAIL IS ON IT. Otherwise the first visitor to type
 * `comcom.ai` would own every comcom sign-in from then on. A domain belongs to at most one organization.
 *
 * Same file bargain as linked-agent-store.ts: one JSON file, written atomically (tmp + rename, mode 0600), limits
 * in the store so no route can skip them. What is NOT here: the agents themselves (linked-agent-store.ts carries
 * `org` / `visibility` / `group` on each agent) and API keys (openai-api-keys.ts; an organization's keys are the
 * keys its members made for one of its `ssoOrgIds`).
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';

export const ORG_ROLES = ['read', 'contributor', 'write', 'admin'] as const;
export type OrgRole = (typeof ORG_ROLES)[number];
const RANK: Record<OrgRole, number> = { read: 0, contributor: 1, write: 2, admin: 3 };
export const roleAtLeast = (role: OrgRole | null | undefined, min: OrgRole): boolean => role != null && RANK[role] >= RANK[min];

/** 1–40 lower-case letters, digits and hyphens: the page is `/org/<id>` and never moves. */
export const ORG_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** Words that are routes under `/org/` on the site and so cannot name an organization. */
export const ORG_RESERVED_IDS: readonly string[] = ['new', 'join', 'mine'];
const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export type OrgMemberVia = 'creator' | 'domain' | 'sso' | 'invite' | 'request' | 'admin';

export interface OrgMember {
  /** a lower-case wallet address or `sso:<sub>` — the same principal that owns agents and API keys */
  principal: string;
  role: OrgRole;
  email: string | null;
  name: string | null;
  addedAt: number;
  via: OrgMemberVia;
}

export interface OrgJoinRequest { principal: string; email: string | null; name: string | null; message: string; requestedAt: number }

export interface OrgInvite {
  token: string;
  role: OrgRole;
  /** when set, only a sign-in with this email may use the invite */
  email: string | null;
  createdBy: string;
  createdAt: number;
  expiresAt: number;
  usedBy: string | null;
  usedAt: number | null;
}

/** "Agents A, B are for members X, Y": a private agent in a group is visible to the group and to admins. */
export interface OrgResourceGroup { id: string; name: string; members: string[]; agents: string[] }

export interface OrgAuditEntry { seq: number; ts: number; actor: string; action: string; target: string | null; detail: Record<string, unknown> | null }

export interface Organization {
  id: string;
  name: string;
  description: string;
  /** markdown shown at the top of the organization page (the README card) */
  readme: string;
  /** email domains whose sign-ins are members at `domainRole` */
  domains: string[];
  domainRole: OrgRole;
  /** AIN SSO organization ids (`org_…`) whose members are members here at `domainRole`; also what makes an API key "this organization's" */
  ssoOrgIds: string[];
  members: OrgMember[];
  joinRequests: OrgJoinRequest[];
  invites: OrgInvite[];
  groups: OrgResourceGroup[];
  /** a limit the organization records for its API keys, in this node's credit units; null = none. Recorded and shown — this node does not meter per-key spend yet (see billing route) */
  spendCapCredits: number | null;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  version: number;
}

/** Who is asking, as far as an organization cares. */
export interface OrgViewer {
  principal: string;
  /** the email AIN SSO vouched for, or null (a wallet session has none) */
  email: string | null;
  name: string | null;
  /** AIN SSO organization ids the session's ID token named */
  ssoOrgIds: string[];
}

export const emailDomain = (email: string | null | undefined): string | null => {
  const at = (email ?? '').lastIndexOf('@');
  if (at < 0) return null;
  const d = email!.slice(at + 1).trim().toLowerCase();
  return DOMAIN.test(d) ? d : null;
};

const domainSchema = z.string().trim().toLowerCase().regex(DOMAIN, 'a domain looks like example.com');
const roleSchema = z.enum(ORG_ROLES);

export const orgCreateInput = z.object({
  id: z.string().regex(ORG_ID, 'an id is 1–40 lower-case letters, digits and hyphens, starting with a letter or digit'),
  name: z.string().trim().min(1, 'a name is required').max(80),
  description: z.string().trim().max(500).default(''),
  readme: z.string().max(20_000).default(''),
  domains: z.array(domainSchema).max(10).default([]),
  domainRole: roleSchema.default('write'),
});
export type OrgCreateInput = z.infer<typeof orgCreateInput>;

export const orgUpdateInput = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  description: z.string().trim().max(500).optional(),
  readme: z.string().max(20_000).optional(),
  domains: z.array(domainSchema).max(10).optional(),
  domainRole: roleSchema.optional(),
  ssoOrgIds: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
  spendCapCredits: z.number().int().min(0).max(1_000_000_000).nullable().optional(),
});
export type OrgUpdateInput = z.infer<typeof orgUpdateInput>;

export const orgGroupInput = z.object({
  name: z.string().trim().min(1).max(80),
  members: z.array(z.string().trim().min(1).max(200)).max(1000).default([]),
  agents: z.array(z.string().trim().min(1).max(40)).max(500).default([]),
});
export type OrgGroupInput = z.infer<typeof orgGroupInput>;

export const orgInviteInput = z.object({
  role: roleSchema.default('read'),
  email: z.string().trim().toLowerCase().email().nullable().optional(),
  ttlHours: z.number().int().min(1).max(24 * 30).default(24 * 7),
});
export const orgRoleInput = z.object({ role: roleSchema });
export const orgJoinInput = z.object({ message: z.string().trim().max(500).default('') });
export const orgMemberInput = z.object({ principal: z.string().trim().min(1).max(200), role: roleSchema.default('read') });

export interface OrganizationStoreLimits { total: number; perCreator: number; members: number; groups: number; invites: number; requests: number; audit: number }
export const ORG_DEFAULT_LIMITS: OrganizationStoreLimits = { total: 1000, perCreator: 5, members: 1000, groups: 50, invites: 100, requests: 200, audit: 2000 };

export class OrgLimitError extends Error {}
export class OrgIdTakenError extends Error {}
export class OrgDomainTakenError extends Error {}
export class OrgDomainNotYoursError extends Error {}
export class OrgLastAdminError extends Error {}

/** The principal that made a wallet or SSO session, normalised the way linked agents store owners. */
export const normalisePrincipal = (p: string): string => (/^0x[0-9a-f]{40}$/i.test(p) ? p.toLowerCase() : p);

interface FileShape { orgs?: Organization[]; audit?: Record<string, OrgAuditEntry[]> }

export class OrganizationStore {
  private readonly orgs = new Map<string, Organization>();
  private readonly audits = new Map<string, OrgAuditEntry[]>();

  constructor(private readonly file: string, private readonly limits: OrganizationStoreLimits = ORG_DEFAULT_LIMITS) {
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as FileShape;
      for (const o of parsed.orgs ?? []) if (o?.id) this.orgs.set(o.id, { ...o, members: o.members ?? [], joinRequests: o.joinRequests ?? [], invites: o.invites ?? [], groups: o.groups ?? [], domains: o.domains ?? [], ssoOrgIds: o.ssoOrgIds ?? [] });
      for (const [id, rows] of Object.entries(parsed.audit ?? {})) this.audits.set(id, rows);
    }
  }

  // ------------------------------------------------------------------------------------------------ reading

  list(): Organization[] {
    return [...this.orgs.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  get(id: string): Organization | null {
    return this.orgs.get(id) ?? null;
  }

  byDomain(domain: string): Organization | null {
    const d = domain.toLowerCase();
    return this.list().find((o) => o.domains.includes(d)) ?? null;
  }

  /** The organizations this viewer belongs to, with how. */
  listFor(viewer: OrgViewer): { org: Organization; role: OrgRole; via: 'member' | 'domain' | 'sso' }[] {
    const out: { org: Organization; role: OrgRole; via: 'member' | 'domain' | 'sso' }[] = [];
    for (const org of this.list()) {
      const m = membership(org, viewer);
      if (m) out.push({ org, ...m });
    }
    return out;
  }

  audit(orgId: string, limit = 200): OrgAuditEntry[] {
    return (this.audits.get(orgId) ?? []).slice(-limit).reverse();
  }

  // ------------------------------------------------------------------------------------------------ writing

  /**
   * `reserved` is every id spoken for on the site. Every domain claimed must be the creator's own (`viewer.email`)
   * and free. The creator is the first admin; when the sign-in named an AIN organization, that id is linked so the
   * organization's API keys are known from the start.
   */
  create(input: OrgCreateInput, viewer: OrgViewer, reserved: (id: string) => boolean = () => false, now = Date.now()): Organization {
    const who = normalisePrincipal(viewer.principal);
    if (this.orgs.has(input.id) || ORG_RESERVED_IDS.includes(input.id) || reserved(input.id)) throw new OrgIdTakenError(`the id "${input.id}" is taken`);
    if (this.orgs.size >= this.limits.total) throw new OrgLimitError(`this node holds its maximum of ${this.limits.total} organizations`);
    if (this.list().filter((o) => o.createdBy === who).length >= this.limits.perCreator) throw new OrgLimitError(`one account may create ${this.limits.perCreator} organizations on this node`);
    this.checkDomains(input.domains, viewer, null);
    const org: Organization = {
      id: input.id, name: input.name, description: input.description, readme: input.readme,
      domains: [...new Set(input.domains)], domainRole: input.domainRole,
      ssoOrgIds: viewer.ssoOrgIds.length === 1 ? [...viewer.ssoOrgIds] : [],
      members: [{ principal: who, role: 'admin', email: viewer.email, name: viewer.name, addedAt: now, via: 'creator' }],
      joinRequests: [], invites: [], groups: [], spendCapCredits: null,
      createdBy: who, createdAt: now, updatedAt: now, version: 1,
    };
    this.orgs.set(org.id, org);
    this.record(org.id, who, 'org.create', org.id, { name: org.name, domains: org.domains }, now);
    this.save();
    return org;
  }

  /**
   * An operator-seeded organization (server.ts `AINIZE_ORG_SEED`): exists before anyone joins, with no members —
   * the first sign-in on one of its domains is a member at `domainRole`, and an operator makes the first admin by
   * hand if the domain default is not enough. Domains are claimed on the operator's authority; a domain another
   * organization already holds is refused all the same.
   */
  seed(id: string, name: string, domains: string[], operator: string, now = Date.now()): Organization {
    if (this.orgs.has(id) || ORG_RESERVED_IDS.includes(id)) throw new OrgIdTakenError(`the id "${id}" is taken`);
    for (const d of domains) {
      if (!DOMAIN.test(d)) throw new Error(`"${d}" is not a domain`);
      const holder = this.byDomain(d);
      if (holder) throw new OrgDomainTakenError(`${d} already belongs to the organization "${holder.id}"`);
    }
    const org: Organization = {
      id, name, description: '', readme: '', domains: [...new Set(domains)], domainRole: 'write', ssoOrgIds: [],
      members: [], joinRequests: [], invites: [], groups: [], spendCapCredits: null,
      createdBy: operator, createdAt: now, updatedAt: now, version: 1,
    };
    this.orgs.set(id, org);
    this.record(id, operator, 'org.seed', id, { name, domains: org.domains }, now);
    this.save();
    return org;
  }

  /** Settings an admin changes. A newly claimed domain must be the admin's own; dropping one needs nothing. */
  update(id: string, patch: OrgUpdateInput, viewer: OrgViewer, now = Date.now()): Organization {
    const prior = this.must(id);
    if (patch.domains) this.checkDomains(patch.domains.filter((d) => !prior.domains.includes(d)), viewer, prior.id);
    const next: Organization = {
      ...prior,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.readme !== undefined ? { readme: patch.readme } : {}),
      ...(patch.domains !== undefined ? { domains: [...new Set(patch.domains)] } : {}),
      ...(patch.domainRole !== undefined ? { domainRole: patch.domainRole } : {}),
      ...(patch.ssoOrgIds !== undefined ? { ssoOrgIds: [...new Set(patch.ssoOrgIds)] } : {}),
      ...(patch.spendCapCredits !== undefined ? { spendCapCredits: patch.spendCapCredits } : {}),
      updatedAt: now, version: prior.version + 1,
    };
    this.orgs.set(id, next);
    const changed = Object.keys(patch).filter((k) => patch[k as keyof OrgUpdateInput] !== undefined);
    this.record(id, normalisePrincipal(viewer.principal), 'org.update', id, { fields: changed, ...(patch.domains ? { domains: next.domains } : {}), ...(patch.spendCapCredits !== undefined ? { spendCapCredits: patch.spendCapCredits } : {}) }, now);
    this.save();
    return next;
  }

  delete(id: string, actor: string, now = Date.now()): boolean {
    const had = this.orgs.delete(id);
    if (had) {
      this.record(id, actor, 'org.delete', id, null, now);
      this.save();
    }
    return had;
  }

  /**
   * Add or change a member. A domain or SSO member who visits is written here too (`via: domain` / `sso`), so
   * admins see them in the list and can change their role — an explicit role then outranks the domain default.
   */
  setMember(orgId: string, member: Omit<OrgMember, 'addedAt'> & { addedAt?: number }, actor: string, now = Date.now()): OrgMember {
    const org = this.must(orgId);
    const who = normalisePrincipal(member.principal);
    const prior = org.members.find((m) => m.principal === who);
    if (!prior && org.members.length >= this.limits.members) throw new OrgLimitError(`an organization may have ${this.limits.members} members on this node`);
    if (prior?.role === 'admin' && member.role !== 'admin' && this.adminCount(org) <= 1) throw new OrgLastAdminError('an organization keeps at least one admin');
    const row: OrgMember = { principal: who, role: member.role, email: member.email ?? prior?.email ?? null, name: member.name ?? prior?.name ?? null, addedAt: prior?.addedAt ?? member.addedAt ?? now, via: prior?.via ?? member.via };
    org.members = [...org.members.filter((m) => m.principal !== who), row];
    org.joinRequests = org.joinRequests.filter((r) => r.principal !== who);
    this.touch(org, now);
    if (!prior) this.record(orgId, actor, 'member.add', who, { role: row.role, via: row.via }, now);
    else if (prior.role !== row.role) this.record(orgId, actor, 'member.role', who, { from: prior.role, to: row.role }, now);
    this.save();
    return row;
  }

  removeMember(orgId: string, principal: string, actor: string, now = Date.now()): boolean {
    const org = this.must(orgId);
    const who = normalisePrincipal(principal);
    const prior = org.members.find((m) => m.principal === who);
    if (!prior) return false;
    if (prior.role === 'admin' && this.adminCount(org) <= 1) throw new OrgLastAdminError('an organization keeps at least one admin');
    org.members = org.members.filter((m) => m.principal !== who);
    for (const g of org.groups) g.members = g.members.filter((p) => p !== who);
    this.touch(org, now);
    this.record(orgId, actor, 'member.remove', who, null, now);
    this.save();
    return true;
  }

  requestJoin(orgId: string, viewer: OrgViewer, message: string, now = Date.now()): OrgJoinRequest {
    const org = this.must(orgId);
    const who = normalisePrincipal(viewer.principal);
    if (!org.joinRequests.some((r) => r.principal === who) && org.joinRequests.length >= this.limits.requests) throw new OrgLimitError('this organization has too many pending requests');
    const row: OrgJoinRequest = { principal: who, email: viewer.email, name: viewer.name, message, requestedAt: now };
    org.joinRequests = [...org.joinRequests.filter((r) => r.principal !== who), row];
    this.touch(org, now);
    this.record(orgId, who, 'request.create', who, null, now);
    this.save();
    return row;
  }

  rejectRequest(orgId: string, principal: string, actor: string, now = Date.now()): boolean {
    const org = this.must(orgId);
    const who = normalisePrincipal(principal);
    const before = org.joinRequests.length;
    org.joinRequests = org.joinRequests.filter((r) => r.principal !== who);
    if (org.joinRequests.length === before) return false;
    this.touch(org, now);
    this.record(orgId, actor, 'request.reject', who, null, now);
    this.save();
    return true;
  }

  createInvite(orgId: string, input: { role: OrgRole; email?: string | null; ttlHours: number }, actor: string, now = Date.now()): OrgInvite {
    const org = this.must(orgId);
    org.invites = org.invites.filter((i) => i.usedBy === null && i.expiresAt > now);
    if (org.invites.length >= this.limits.invites) throw new OrgLimitError('this organization has too many open invites');
    const invite: OrgInvite = {
      token: randomBytes(18).toString('base64url'), role: input.role, email: input.email ?? null,
      createdBy: actor, createdAt: now, expiresAt: now + input.ttlHours * 3600_000, usedBy: null, usedAt: null,
    };
    org.invites.push(invite);
    this.touch(org, now);
    this.record(orgId, actor, 'invite.create', invite.token.slice(0, 6), { role: invite.role, email: invite.email }, now);
    this.save();
    return invite;
  }

  revokeInvite(orgId: string, token: string, actor: string, now = Date.now()): boolean {
    const org = this.must(orgId);
    const before = org.invites.length;
    org.invites = org.invites.filter((i) => i.token !== token);
    if (org.invites.length === before) return false;
    this.touch(org, now);
    this.record(orgId, actor, 'invite.revoke', token.slice(0, 6), null, now);
    this.save();
    return true;
  }

  /** The organization an open invite belongs to, or null when the token is unknown, used or expired. */
  findInvite(token: string, now = Date.now()): { org: Organization; invite: OrgInvite } | null {
    for (const org of this.orgs.values()) {
      const invite = org.invites.find((i) => i.token === token);
      if (invite) return invite.usedBy === null && invite.expiresAt > now ? { org, invite } : null;
    }
    return null;
  }

  /** Accept an invite: the viewer becomes a member at the invite's role (an existing member keeps the higher role). */
  useInvite(token: string, viewer: OrgViewer, now = Date.now()): { org: Organization; member: OrgMember } | null {
    const hit = this.findInvite(token, now);
    if (!hit) return null;
    if (hit.invite.email && hit.invite.email !== (viewer.email ?? '').toLowerCase()) return null;
    const who = normalisePrincipal(viewer.principal);
    const prior = hit.org.members.find((m) => m.principal === who);
    const role = prior && roleAtLeast(prior.role, hit.invite.role) ? prior.role : hit.invite.role;
    hit.invite.usedBy = who;
    hit.invite.usedAt = now;
    const member = this.setMember(hit.org.id, { principal: who, role, email: viewer.email, name: viewer.name, via: 'invite' }, who, now);
    return { org: hit.org, member };
  }

  setGroup(orgId: string, input: OrgGroupInput & { id?: string }, actor: string, now = Date.now()): OrgResourceGroup {
    const org = this.must(orgId);
    const memberSet = new Set(org.members.map((m) => m.principal));
    const id = input.id ?? `g${randomBytes(4).toString('hex')}`;
    const prior = org.groups.find((g) => g.id === id);
    if (!prior && org.groups.length >= this.limits.groups) throw new OrgLimitError(`an organization may have ${this.limits.groups} resource groups`);
    const group: OrgResourceGroup = {
      id, name: input.name,
      members: [...new Set(input.members.map(normalisePrincipal).filter((p) => memberSet.has(p)))],
      agents: [...new Set(input.agents)],
    };
    org.groups = [...org.groups.filter((g) => g.id !== id), group];
    this.touch(org, now);
    this.record(orgId, actor, prior ? 'group.update' : 'group.create', id, { name: group.name, members: group.members.length, agents: group.agents }, now);
    this.save();
    return group;
  }

  removeGroup(orgId: string, groupId: string, actor: string, now = Date.now()): boolean {
    const org = this.must(orgId);
    const before = org.groups.length;
    org.groups = org.groups.filter((g) => g.id !== groupId);
    if (org.groups.length === before) return false;
    this.touch(org, now);
    this.record(orgId, actor, 'group.delete', groupId, null, now);
    this.save();
    return true;
  }

  /** Something outside the store changed an organization's things (an agent registered under it, say). */
  note(orgId: string, actor: string, action: string, target: string | null, detail: Record<string, unknown> | null = null, now = Date.now()): void {
    if (!this.orgs.has(orgId)) return;
    this.record(orgId, actor, action, target, detail, now);
    this.save();
  }

  // ------------------------------------------------------------------------------------------------ internals

  private must(id: string): Organization {
    const org = this.orgs.get(id);
    if (!org) throw new Error(`no organization "${id}"`);
    return org;
  }

  private adminCount(org: Organization): number {
    return org.members.filter((m) => m.role === 'admin').length;
  }

  private touch(org: Organization, now: number): void {
    org.updatedAt = now;
    org.version += 1;
  }

  private checkDomains(domains: string[], viewer: OrgViewer, exceptOrg: string | null): void {
    const mine = emailDomain(viewer.email);
    for (const d of domains) {
      if (d !== mine) throw new OrgDomainNotYoursError(`only someone signed in with an @${d} address can claim ${d}`);
      const holder = this.byDomain(d);
      if (holder && holder.id !== exceptOrg) throw new OrgDomainTakenError(`${d} already belongs to the organization "${holder.id}"`);
    }
  }

  private record(orgId: string, actor: string, action: string, target: string | null, detail: Record<string, unknown> | null, now: number): void {
    const rows = this.audits.get(orgId) ?? [];
    const seq = (rows[rows.length - 1]?.seq ?? 0) + 1;
    rows.push({ seq, ts: now, actor, action, target, detail });
    this.audits.set(orgId, rows.slice(-this.limits.audit));
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ orgs: this.list(), audit: Object.fromEntries(this.audits) } satisfies FileShape), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}

/**
 * How this viewer belongs to this organization, or null. An explicit row wins (an admin may have raised or
 * lowered the role); then the sign-in's email domain; then an AIN SSO organization the ID token named.
 */
export function membership(org: Organization, viewer: OrgViewer | null): { role: OrgRole; via: 'member' | 'domain' | 'sso' } | null {
  if (!viewer) return null;
  const who = normalisePrincipal(viewer.principal);
  const explicit = org.members.find((m) => m.principal === who);
  if (explicit) return { role: explicit.role, via: 'member' };
  const d = emailDomain(viewer.email);
  if (d && org.domains.includes(d)) return { role: org.domainRole, via: 'domain' };
  if (viewer.ssoOrgIds.some((id) => org.ssoOrgIds.includes(id))) return { role: org.domainRole, via: 'sso' };
  return null;
}

/**
 * May this viewer see this agent of the organization? Public agents: everyone. Private agents: members — and
 * when the agent is in a resource group, only that group's members and admins.
 */
export function canSeeOrgAgent(
  org: Organization,
  agent: { visibility: 'public' | 'private'; group: string | null; owner: string },
  viewer: OrgViewer | null,
  role: OrgRole | null = membership(org, viewer)?.role ?? null,
): boolean {
  if (agent.visibility === 'public') return true;
  if (!role) return false;
  if (roleAtLeast(role, 'admin')) return true;
  const who = viewer ? normalisePrincipal(viewer.principal) : null;
  if (who && agent.owner === who) return true;
  if (!agent.group) return true;
  const group = org.groups.find((g) => g.id === agent.group);
  // a group that no longer exists hides nothing — the agent falls back to "members"
  return !group || (who !== null && group.members.includes(who));
}
