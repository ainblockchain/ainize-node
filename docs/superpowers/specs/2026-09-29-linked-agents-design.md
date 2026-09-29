# Linked agents — an external A2A agent a person registers on a node by URL

**Date:** 2026-09-29 · **Status:** implemented (`src/linked-agent-store.ts`, `src/linked-agent-routes.ts`, `src/agents.ts`)

## Why

AIN Teams is moving every agent it shows to *imported from the Ainize catalogue* — its own "paste an A2A URL"
invitation and its in-app agent builder are being retired, so that agents are registered and managed in one place
(ainteams `docs/epics/minhyun/EPIC05-agent-registry-on-ainize.md`). That only works if a person who wrote an agent
somewhere on the internet can put it **in** the catalogue without being this node's operator.

Before this, the catalogue (`GET /api/agents`) had three sources and none of them was that:

| Source | Who writes it | What it is |
| --- | --- | --- |
| `config.agents` | the operator, `ainize agent add` on the node's own machine | a proxied upstream |
| hosted agents | anyone signed in with a wallet, `/api/hosted-agents` | a spec the node RUNS |
| peers' adverts | gossip | somebody else's agents |

## What

A fourth source, **linked agents**: `{ id, name, description, upstream, owner }`. A config agent with an owner.

- **Same shape, same path.** `listAgents(cfg, linked)` returns config agents then linked agents as one list of
  `ProxiedAgent`, so the card at `/agents/<id>/.well-known/agent-card.json`, the JSON-RPC forward at `/agents/<id>`,
  the health probe and the gossip advert all apply unchanged. The catalogue row carries `owner` for a linked agent
  and `null` for a config one; that is the only visible difference.
- **Owned like a hosted agent, but by a wider set of principals.** A wallet address *or* an AIN SSO principal
  (`sso:<sub>`) may register one. `docs/ain-sso.md` §1 says an SSO session manages no hosted agents — those spend the
  node's GPU and Docker. A linked agent is a URL; the node spends nothing on it but a proxy hop that is already rate
  limited and body-capped. AIN Teams users are mostly SSO accounts, and requiring a wallet would exclude them from the
  one feature this exists for.
- **Public upstreams only.** A config agent may point at the LAN — the operator typed it. A linked agent is typed by
  a visitor, so `upstream` must resolve to a public address (`hostedAgentAddressIsPublic` over the DNS answers,
  `upstreamIsPublic`), or the node would be a probe into its own network. Refused with `400 upstream_not_public`
  before any request is made.
- **Registered before it is up is fine.** The card is probed once at registration and the answer says `reachable`;
  a card that does not answer is not a refusal, but then the person must type a name, since there is no card to take
  it from. The catalogue keeps saying "not answering" until it answers.
- **One id namespace.** Config, hosted and linked ids reserve each other (`reserved` in server.ts, both ways). Should
  a file be edited by hand into a collision, `listAgents` lets the config agent win.
- **Storage.** `<dataDir>/linked-agents.json`, atomic write, mode 0600, the same bargain as hosted agents. Limits: 10
  per owner, 500 per node.

## HTTP

| | |
| --- | --- |
| `GET /api/linked-agents` · `?mine=1` | all, or the caller's own (session) |
| `POST /api/linked-agents` | `{ id, upstream, name?, description? }` → 201, `reachable`, `card` summary |
| `GET /api/linked-agents/{id}` | owner only; the one answer that includes `upstream` |
| `PUT /api/linked-agents/{id}` | owner only; id immutable |
| `DELETE /api/linked-agents/{id}` | owner only; the address stops answering |

Refusals: `401 not_signed_in` · `400 invalid_request | upstream_not_public | name_required` · `403 not_owner` ·
`404 not_found` · `409 id_taken` · `429 limit_reached`. Also in `src/openapi.ts` under the `Agents` tag, which is
new and also documents `GET /api/agents` for the first time.

## What AIN Teams does with it

AIN Teams reads `GET /api/agents`, shows the rows, and imports one by handing the row's `a2a_url` — this node's
address, never the upstream — to the same card-fetch-and-join path it always had. "Mine" in AIN Teams is a string
match on `owner` against the person's wallet address and `sso:<sub>`. There is no service token and no delegated
call: the catalogue is public and writes happen only here.

## Not done

- **CLI.** `ainize-cli` does not speak `/api/linked-agents` yet; the web form (`ainize-web /agent/link`) and HTTP do.
- **Visibility.** The catalogue is public. If a private linked agent is ever wanted it is a catalogue decision, not a
  store field.
- **Re-probing on edit only.** Health after registration is the catalogue's existing 30-second/60-second probe cadence.
