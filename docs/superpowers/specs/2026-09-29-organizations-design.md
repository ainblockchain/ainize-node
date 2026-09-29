# Organizations — a team's home on the node

**Date:** 2026-09-29 · **Status:** implemented (`src/organization-store.ts`, `src/organization-routes.ts`,
`src/linked-agent-store.ts` / `src/linked-agent-routes.ts` (org fields), `src/agents.ts` (`?org=`, private rows))

## Why

Until today ainize had no organizations (`docs/ain-sso.md` §2): an AIN organization appeared only as the `orgId`
on an API key. Two things asked for more.

1. **The catalogue became the registry.** AIN Teams and ainmem import every agent they show from this node's
   catalogue (`2026-09-29-linked-agents-design.md`). A company wants *our agents* to be a place — registered under
   the company, managed by whoever the company says, private when they should be — not a filter over one person's
   list. And a workspace scoped to the company should import the company's agents, nothing else.
2. **Who belongs is already proven.** An AIN SSO sign-in carries the email the issuer vouched for. "Everyone at
   `@comcom.ai`" is a membership rule the node can apply without anyone maintaining a list.

The shape follows the organization features of the Hugging Face Hub (profile page with a README card and asset
tabs; settings with Members and roles, Resource groups, Billing, Security & SSO with audit logs) — mapped onto what
this node has: agents are the assets, AIN SSO is the SSO, API keys and agent calls are what billing can count.

## What

An **organization** (`organizations.json`, one JSON file like the other stores):

| Field | Meaning |
| --- | --- |
| `id` | 1–40 lower-case letters, digits, hyphens; the page is `/org/<id>` and never moves. `new` / `join` / `mine` are pages, not ids |
| `name`, `description`, `readme` | the profile; `readme` is markdown shown at the top of the page (the README card) |
| `domains`, `domainRole` | email domains whose sign-ins are members at `domainRole` (default `write`) |
| `ssoOrgIds` | AIN SSO organization ids (`org_…`): their members are members here at `domainRole`; API keys made for them are the organization's |
| `members[]` | `{ principal, role, email, name, addedAt, via }` — `via` records how they got in (creator · domain · sso · invite · request · admin) |
| `joinRequests[]`, `invites[]` | asking to join (admins approve with a role); invite links (one use, optional email pin, expiry) |
| `groups[]` | resource groups `{ id, name, members, agents }` |
| `spendCapCredits` | recorded for billing; see below |

**Roles** rank `read` < `contributor` < `write` < `admin`:

| Role | May |
| --- | --- |
| `read` | open the page; see the organization's private agents (subject to resource groups) |
| `contributor` | register agents under the organization; change or remove their own |
| `write` | change or remove any of the organization's agents; manage resource groups |
| `admin` | members and roles, invites, join requests, settings (README, domains, SSO links, spend cap), billing, security, delete |

**Membership** is decided in one function (`membership(org, viewer)`): an explicit row wins (an admin may have
raised or lowered someone), then the sign-in's email domain, then an AIN SSO organization the ID token named. A
domain or SSO member who visits is written into `members[]` (`via: domain` / `sso`) so admins see who is here and
can change their role. A wallet session has no email and is a member only by explicit row or invite.

**A domain can only be claimed by someone whose own verified email is on it**, and belongs to one organization.
Otherwise the first visitor to type `comcom.ai` would own every comcom sign-in from then on. An operator may seed
organizations at boot (`AINIZE_ORG_SEED="comcom=ComCom:comcom.ai"`) so the company's page exists before its people
do; a seeded organization has no members until the first sign-in on its domain.

**Agents under an organization.** A linked agent gains `org`, `visibility` (`public` | `private`) and `group`.
Registering under an organization needs `contributor` there; a `write` member may change or remove any of its
agents (the organization's agents are the organization's, not one leaver's). A personal agent is always public —
there is nobody for it to be private *from*.

**Private agents** are listed only to callers the organization admits: `GET /api/agents` (with or without
`?org=`), `GET /api/linked-agents`, the organization page, and gossip all leave them out for everyone else
(`canSeeOrgAgent`: members see ungrouped private agents; a grouped one is for its group, its owner and admins).
The address `/agents/<id>` still answers — an importing workspace calls it from a server without a session — and
the agent enforces its own A2A security scheme, as every agent in the catalogue does. Private means *not listed*,
not *not reachable*; the design doc for linked agents said the same of the catalogue as a whole.

**`?org=<id>`** on `GET /api/agents` narrows the list to that organization's agents (hosted and peer agents have no
organization and are left out) — what AIN Teams and ainmem ask for when `AINIZE_ORG` is set. The row carries `org`
so a client can check the scope itself against a node that predates the parameter.

**Billing** (`/api/orgs/:id/billing`, admin): the API keys members made for the organization's `ssoOrgIds`
(openai-api-keys.ts `orgId`), calls to each of the organization's agents (the catalogue's per-agent counters), and
the recorded spend cap. This node does not meter per-key inference spend; the answer says `spend_metered: false`
and the page says so rather than drawing a graph of zeros. When metering lands, the cap is where enforcement hooks.

**Security & SSO** (`/api/orgs/:id/security`, admin): the AIN SSO issuer this node signs people in with and the
linked AIN organizations, the admitting domains, how each member got in, the admins, how many agents are private,
and the newest audit entries. SSO itself is not configured here — it is the node's (`docs/ain-sso.md`); the page
reports it.

**Audit log** (`/api/orgs/:id/audit`, admin): every change to the organization — members, roles, invites,
requests, groups, settings — and to its agents (registered, changed, moved, removed), with the actor. Newest
first, the last 2000 entries kept per organization.

## Errors

`{ error: { code, message } }`: `not_signed_in` 401 · `not_found` 404 · `not_member` 403 (with `can_request`) ·
`insufficient_role` 403 · `invalid_request` 400 · `id_taken` / `domain_taken` / `has_agents` / `already_member` /
`last_admin` 409 · `domain_not_yours` 403 · `limit_reached` 429 · `invite_for_someone_else` 403. Linked-agent
routes add `org_not_found` 404 and `org_role` 403.

## Limits

1000 organizations per node, 5 per creator, 1000 members, 10 domains, 50 groups, 100 open invites, 200 pending
requests, 2000 audit entries per organization, README 20 000 characters.

## Not done

- Per-key spend metering and cap enforcement (billing shows what the node counts and says what it does not).
- Email delivery of invite links — the node has no mailer; the admin copies the link.
- Organization-owned hosted agents: hosted agents stay wallet-owned (`docs/ain-sso.md` §1); an organization can
  link one by URL like any other agent.

## Addendum (2026-09-29): reconciled with the shared agent registry (#40, #41)

This design landed after the shared agent registry (PR #40) had already given every agent `visibility`
(`public` | `org` | `private` | `unlisted`) and `orgId`, and PR #41 had let organization members manage hosted
agents. Both were live, and AIN Teams reads them (contract 1.0, organization API keys). So the organization
store was put under them rather than beside them:

- **Agents keep #40's fields.** There is no `org` or `group` on an agent. An agent belongs to an organization
  when its `visibility` is `org` and its `orgId` is the organization's id, or an AIN SSO org id the
  organization links (`ssoOrgIds`) — `resolveOrganization` in shared-agents.ts. A public agent does not sit
  "under" an organization; an organization's list is its members' list.
- **Roles decide, through one resolver.** `withOrganizations` gives every caller an `orgRole(orgId)`:
  the ainize organization's `membership()` when one claims the id (an organization API key: `write` there),
  otherwise #40's answer (an active AIN SSO member or that org's key: `write`). `canSeeAgent` needs any role,
  `canShareInto` contributor, `canManageAgent` write, `canAdministerAgent` (remove, change sharing) admin — or
  being the owner. Linked agents keep #40's rule that only the registrant is told, and may change, the upstream.
- **Resource groups label, they do not hide.** Hiding by group would have had to be enforced in every list
  (`/api/hosted-agents`, `/api/shared-agents`, the feed, gossip) that #40 already defines; the organization page
  shows each agent's `groups`, and `hidden_agents` is 0.
- **`/api/agents?org=`** lists the organization's agents (hosted and linked) to its members; without `?org=` the
  catalogue stays public-only, as #40 made it. `/api/shared-agents?scope=shared_with_org` still matches `orgId`
  exactly (contract 1.0).
- **Two holes closed on the way.** Linking an AIN SSO org id now needs a session that is an active member of
  it, and each AIN org can be linked once (`sso_org_not_yours`, `sso_org_taken`) — otherwise linking someone
  else's AIN org would have made its agents yours to administer. And a member row written down for a domain or
  SSO member lasts only while that claim holds, so offboarding in AIN SSO takes the person out.
- Principals are compared lower-case everywhere (`normalisePrincipal`), the way `AgentCaller.subject` is.

