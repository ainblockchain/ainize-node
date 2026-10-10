# AIN SSO on the node — design, configuration, rollout

Internal working document (see [docs/README.md](README.md) for what that means). The code is
`src/sso.ts` (rules), `src/sso-routes.ts` (HTTP), `src/site-call.ts` (the site's signed calls),
and the additive schema in `src/store.ts`. The other half — the sign-in button and the OIDC relying
party — lives in [ainize-web](https://github.com/ainblockchain/ainize-web) (`src/lib/ainSso.ts`).

Normative references in [ainetwork-ai/sso](https://github.com/ainetwork-ai/sso): `docs/specs/adapter-protocol.md`
(provisioning protocol v1), `docs/adr/0003` (subjects), `0004` (legacy linking, incl. the ainize
amendment), `0005` (sessions and revocation), `docs/specs/ownership.md`,
`docs/runbooks/migration-rollback.md`, and `docs/inventory/ainize.md` (the Phase 0 inventory this
design follows).

## 1. What an AIN account is here

The node has no users table. An identity is a string: a wallet address, or `google:<sub>` — the
owner of API keys made through ainize.ai's Google sign-in, which the site vouches for on
`/api/keys` (site-assertion.ts). An AIN account becomes one more such string, a **principal**:

| Principal | When |
| --- | --- |
| `sso:<sub>` | The account is new here (first sign-in, or provisioned by the adapter). |
| `google:<sub>` | The account was proven to be that pre-SSO Google account: by AIN SSO's verified legacy mapping (`legacyUserId`), or by the person showing the legacy Google session in the same browser (in-app `app_proof`, reported back to AIN SSO). |

`sso_identities (issuer, subject) → principal` is the link: unique on (issuer, subject) and unique on
principal, created with insert-if-absent so two concurrent first logins end with one identity.
**Nothing is ever matched or linked by email.** A wallet address is never a principal an SSO account
can take over (the adapter answers `409 legacy_user_not_found` for one): an address is proven by its
own signature, and the node key and `operatorAddresses` are the recovery path.

### What an SSO session can do — and not

An SSO session is a row in `sessions` with `scheme = 'sso'` and `sso_iss/sso_sub/sso_sid`. It stands
for exactly what a Google session stood for: **a name and API keys**. `siteSession()` does not show it
to any other reader, so it cannot own the node, spend the node wallet, change payouts, approve a CLI
or node link (those need an eip191 signature anyway), manage hosted agents or claim deposits.
`/api/auth/me` reports it in a separate `sso` field and leaves `signedIn`/`subject` meaning "an
address is here".

One more thing it can do, since 2026-09-29: register **linked agents** (`/api/linked-agents`,
`docs/superpowers/specs/2026-09-29-linked-agents-design.md`). A linked agent is an external A2A URL the
node lists and proxies — not a node resource the way a hosted agent is — and its owner is the same
principal string that owns API keys. Hosted agents stay wallet-only.

## 2. Organizations

Since 2026-09-29 ainize has organizations of its own (`/api/orgs`,
`docs/superpowers/specs/2026-09-29-organizations-design.md`): a team's page, members with roles
(`read` < `contributor` < `write` < `admin`), invites, join requests, resource groups, an audit log, and
the agents shared with it (`visibility: org` with `orgId` = the organization's id or one of its `ssoOrgIds` —
deploy/HOSTED-AGENTS.md §5 has the role table). AIN SSO is what admits people to one:

- **The sign-in's email domain.** An organization holds domains (`comcom.ai`); a session whose
  vouched email is on one is a member at the organization's `domainRole`. A domain can be claimed
  only by someone whose own email is on it.
- **A linked AIN organization.** An organization may link AIN SSO organization ids (`ssoOrgIds`) —
  only ones the admin's own session is an active member of, and each to one organization. Their members
  are members here at `domainRole` while their membership is active (`sso_memberships` first, else the
  ID token); API keys made for them count as the organization's — `write` over its agents — and on its
  billing page. An agent shared with such an AIN org id is the organization's.
- **A row written down** for a domain or SSO member who visited lasts only while that claim holds, so
  offboarding in AIN SSO takes the person out; rows an admin added, invites and approved requests stay.
- **An AIN org id no ainize organization links** still works as before: its SSO members and its
  organization API key may share agents with it and change them (`write`).

Neither grants anything on the node beyond the organization: node ownership is never derived from
SSO (inventory §6.5 — a future operator grant must require a signature-proven linked address).
`appRole` and `groups` from the adapter are stored and reported back on `GET` but grant nothing.

What was here before still holds for API keys:

- **API keys made in an SSO session carry `orgId`** — the organization chosen when the key is made
  (`POST /api/keys {org_id}`), defaulting to the organization selected at sign-in (`active_org`) or
  the only one the ID token named. `org_id: null` makes a personal key. Only organizations the ID
  token named are accepted; wallet and Google-vouched callers make personal keys only.

That is what suspension switches off. A suspended or offboarded SSO account also loses the
organizations it was in through its AIN organization (see above).

## 3. Provisioning adapter (protocol v1)

Base URL (register this at AIN SSO): `https://ainize.ai/api/sso/adapter` — the site relays `/api/*`
to the node unchanged. `AIN_SSO_ADAPTER_URL` must be exactly that public URL: the request JWT's
`htu` is compared with it, not with the loopback URL the node sees.

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/sso/adapter/v1/health` | no auth |
| `PUT` | `/api/sso/adapter/v1/orgs/:orgId/users/:sub` | apply a `DesiredUserState` |
| `GET` | `/api/sso/adapter/v1/orgs/:orgId/users/:sub` | `CurrentUserState` |

Every non-health request is verified before anything happens (§3.2 of the protocol): RS256/ES256/
PS256/EdDSA signature from the JWKS at `{issuer}/oidc/jwks` (cached 10 min, refetched on an unknown
`kid`), `typ: ain-adapter+jwt`, `iss`, `aud` = our client_id, lifetime and age ≤ 60 s, `htm`, `htu`,
`bsh` over the raw body bytes (the adapter path gets `express.raw` ahead of the JSON parser), and a
single-use `jti` — checked last, so a mismatched request never burns one. The body must parse as a
`DesiredUserState` whose `sub`/`org.id` equal the path. Limit 64 KiB (413).

Version check-and-set, linking, the status change and every revocation run in **one SQLite
transaction** and finish before the 200. A request with `version ≤ applied` is a 200 no-op that
reports the applied state.

| `status` | Before answering 200 |
| --- | --- |
| `active` | Link/create the principal; store role and groups; re-enable this organization's keys that suspension switched off (deleted ones stay deleted). |
| `suspended` | End **every** SSO session of the account (per person, protocol §4.3); disable this organization's keys (`disabled` in `openai-keys.json`, refused at use). Personal keys untouched. |
| `deprovisioned` | End every SSO session of the account, and **delete** this organization's keys. Not a suspension: the account is not blocked, so the person signs in again personally (ainize.ai is `any_account`) with the same principal and personal keys; only this organization's access is gone. `ownershipTransferTo`: nothing here is organization-owned and transferable (organization keys are bearer secrets — revoked, never handed on), so it is recorded and nothing moves. |

Keys are written to a copy of the key set and swapped in only after the file is written, so a disk
failure leaves nothing "disabled until the next restart". At use time an organization key is also
checked against the stored membership (`orgGate`), so a key whose organization access ended stops
working even if disabling it had failed.

**Legacy linking** (protocol §4.4, ADR-0004):

- `legacyUserId` is `google:<sub>` (what the importer exports from `openai-keys.json`). For an
  account that does not exist here yet (protocol §4.4): any other shape → `409
  legacy_user_not_found`; linked to another account → `409 legacy_conflict`, never re-pointed.
- **An account that already exists here is never refused over its mapping.** AIN SSO sends
  `legacyUserId` with every state, whatever the status, so a 409 would also refuse the suspension or
  offboarding that comes with it — on every retry. A mapping the node cannot apply (not
  `google:<sub>`, taken by another account, contradicting the link the app proved, or an account that
  holds keys of its own) is logged (`legacy mapping … not applied`) and the rest of the state is
  applied; `localUserId` in the answer shows the administrator which principal the account holds.
- Linked when the account has no principal here yet — or has one that holds nothing (an `sso:<sub>`
  with no keys), so a mapping that arrives after the first login still links. An account that already
  holds keys of its own keeps them; merging two key sets must be explicit (logged, not applied).
- A link made from `legacyUserId` that a later state drops or changes (rolled back at AIN SSO) is
  undone: the account returns to `sso:<sub>`, its SSO sessions end, and what the person obtained on
  the legacy principal through the link is deleted — its organization keys, and every key an SSO
  session of that account made there (keys record the AIN account that made them, `via`). The legacy
  principal keeps the personal keys it made itself. (Keys made before `via` existed cannot be told
  apart: a personal key made through a wrong link before this change stays until its owner deletes
  it.) `sso_link_history` keeps every previous link.
- A link the app proved (`app_proof:legacy_session`) is authoritative here: a later state with
  `legacyUserId: null` (the report did not reach AIN SSO) keeps it, and so does a *different* legacy
  user (logged for an administrator, never re-pointed).

Adapter errors use the protocol body `{error, message, retryable}`; unexpected failures are
`500 adapter_error` without internals. Every applied change is written to the node's event log with
kind `sso` and actor `ain-sso`; those lines are hidden from the public `/api/events` feed.

## 4. Sessions, sign-in and back-channel logout

`POST /api/auth/sso/session` — the site, after validating the ID token (signature, `iss`, `aud`,
`exp`, `nonce`, PKCE), sends `{iss, sub, sid, name, email, orgs, activeOrg, link, allowConnect,
replaces}`. The node refuses another issuer, a suspended account (`403 account_suspended`), and link
conflicts (`409`); otherwise it resolves the principal and creates a session (14 days, ADR-0005's
absolute SSO lifetime) keyed by `sid`. With no link yet and `allowConnect` it creates nothing and
answers `needs_link`, so the site can offer "connect your existing account". It answers the same for
an account it already knows that is still an empty `sso:<sub>` (no keys) — typically made by an
automatic sign-in, which never asks — so the button can still connect the old account.

`POST /api/auth/sso/principal {principal}` — the site asks before honouring a legacy Google session:
`{linked, blocked, notBefore}`. **Mounted whenever the node shares a secret with the site, even with
AIN SSO off**, because the suspension must outlive every rollback switch.

Both demand `x-ainize-site-call: <ts>.<nonce>.<hmac>` (site-call.ts): HMAC-SHA256 under
`site-assertion.secret` over a label of its own, method, path, time, nonce and body hash; 60 s,
single use. The site strips the header from everything it relays.

`POST /api/auth/sso/backchannel-logout` (register as the client's `backchannel_logout_uri`:
`https://ainize.ai/api/auth/sso/backchannel-logout`) — form field `logout_token`. Checked per OIDC
Back-Channel Logout 1.0: signature, `typ: logout+jwt`, `iss`, `aud`, `iat` ≤ 120 s old, the
back-channel `events` member, no `nonce`, `sid` and/or `sub`, single-use `jti`. With `sid`: ends only
that OIDC session's sessions. With `sub` alone: ends every SSO session of the account and stamps
`sessions_not_before`, which the site compares with the minting time of legacy Google cookies.
`400` for a bad token, `500` (retried by AIN SSO) for a transient failure.

**Blocked** means: some organization has the account `suspended` and none has it `active` (the account-level status). Offboarding (`deprovisioned`) alone never blocks — it removes the organization's keys and membership only, and the person signs in again without it.

**A suspended person cannot get in by any path:** SSO sign-in (403), the legacy Google sign-in and
its cookie (the site asks `/principal`), `/api/keys` with a vouched Google principal or an SSO
session (403), and existing SSO sessions (deleted). Wallet sign-in is personal and unaffected — a
wallet is never linked to an SSO account here.

Replay caches (`jti`, site-call MACs) are in process memory. The node runs as one process; a
deployment with several would need a shared cache.

## 5. Configuration

| Variable | Meaning |
| --- | --- |
| `AIN_SSO_ISSUER` | e.g. `https://auth.comcom.ai` (https; plain http only on loopback) |
| `AIN_SSO_CLIENT_ID` | ainize's client_id at AIN SSO (`aud` of adapter and logout tokens) |
| `AIN_SSO_ADAPTER_URL` | the adapter URL registered at AIN SSO, e.g. `https://ainize.ai/api/sso/adapter`; unset = adapter answers 503 |
| `AIN_SSO_JWKS_URI` | optional; default `{issuer}/oidc/jwks` |
| `AIN_SSO_CLIENT_SECRET` | optional; ainize's client secret at AIN SSO (`client_secret_basic`). Only for what the node does **as itself**: `client_credentials` machine tokens that let it clone project repositories from aindrive (`docs/PROJECTS.md`, `src/sso-service-token.ts`). Sign-in needs none |
| `<AINIZE_HOME>/site-assertion.secret` | already required for Google vouching; also signs the site's SSO calls |

**AIN SSO is on only when `AIN_SSO_ISSUER` and `AIN_SSO_CLIENT_ID` are both set.** Otherwise the
adapter, sign-in and logout routes are not mounted and the node behaves as before; stored SSO state
is still enforced. Sign-in needs no client secret; `AIN_SSO_CLIENT_SECRET` only gives the node a machine
identity (AIN SSO architecture §4.9) for reading project repositories.

On ainize.ai the unit `ainize-public-node.service` has no environment file today; add the variables
with `systemctl --user edit ainize-public-node` (a drop-in `Environment=` or `EnvironmentFile=`)
when AIN SSO is live. Nothing in `deploy/ainize-ai/config.overlay.json` turns it on.

## 6. Storage (additive)

- `sso_identities`, `sso_link_history`, `sso_memberships` — new tables.
- `sessions` gains `sso_iss, sso_sub, sso_sid, sso_orgs, sso_org` (+ indexes on `sso_sub`, `sso_sid`).
- `openai-keys.json` records may carry `orgId`, `disabled` and `via` (`{iss, sub}` of the AIN
  account whose session made the key); keys made outside an SSO session are written exactly as
  before. A switched-off key is stored under `disabled:<hash>` instead of `<hash>`, so a build from
  before this change cannot find it: rolling the node back never revives a suspended key. (It would
  show in that build's key list with the prefix `disabled`, and its owner could delete it.)

## 7. Rollout (runbook `migration-rollback.md`)

1. Deploy (this change): nothing configured, nothing changes.
2. Register the ainize client at AIN SSO: redirect URI `https://ainize.ai/api/auth/sso/callback`,
   back-channel logout URI above, adapter URL above, first-party.
3. Configure the node (`AIN_SSO_ISSUER`, `AIN_SSO_CLIENT_ID`, `AIN_SSO_ADAPTER_URL`), restart;
   `GET https://ainize.ai/api/sso/adapter/v1/health` answers. Then the site (ainize-web
   `deploy/README.md`) — its "Continue with AIN" button appears (`LEGACY_LOGIN=true`).
4. Import `google:<sub>` owners from `openai-keys.json` as `upstream_subject` mappings (ADR-0004
   amendment) after the cross-client Google `sub` test.
5. `LEGACY_LOGIN=unlinked_only`, then `false` on the site, per the runbook's criteria.

Rollback: unset the site's `AIN_SSO_*` (button gone; SSO-linked Google accounts use Google again,
suspensions still hold), or the node's (adapter and logout off; suspensions still hold).

## 8. Provenance

The token checks in `src/sso.ts` (`verifyAdapterRequest`, `verifyLogoutToken`, `ReplayCache`) and the
`DesiredUserState` schema are re-implementations of `@ain-sso/sdk` and `@ain-sso/contracts` from
ainetwork-ai/sso at `8e721fa3f54aa8b70ae437fcacfe40a647de3095` (`packages/sdk/src/adapter/verify.ts`,
`packages/sdk/src/rp/backchannel.ts`, `packages/sdk/src/replay.ts`,
`packages/contracts/src/adapter.ts`), which are not published to npm. Keep them in step with the
protocol document when it changes.

Tests: `test/ain-sso.test.ts` (protocol, sign-in, suspension, linking, logout, SSO off — against a
stand-in AIN SSO that signs real RS256 tokens and serves its JWKS over HTTP) and
`test/ain-sso-store.test.ts` (migration, key-store durability).
