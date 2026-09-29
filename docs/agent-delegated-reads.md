# Delegated reads — an agent reads a file on the person's behalf

Internal working document (see `docs/README.md`). The cross-product design is ain-integration
`docs/08-agent-delegation.md`; this page is the AGENT side as this node implements it.

## Why

aindrive's file handoff (`docs/…/hostedAgentAindriveHandoff.ts`) lets a drive OWNER hand an agent a grant. A
person who was only *shared* a file is not its owner and cannot make a handoff. What they can do is let their
product ask AIN SSO for a **resource delegation** (`ain-rdlg+jwt`) naming the agent and the file, and attach it to
the A2A message. The agent then reads the file from aindrive with that token — and with proof that it holds the
key the token was bound to, so a token copied out of a message is useless to anyone else.

## The agent's key

| | |
|---|---|
| Kind | ES256 (EC P-256), one keypair per hosted agent |
| Made | when the agent is created (`hosted-agent-routes.ts` → `hosted-agent-pop.ts`), or at boot for an agent stored before keys existed (`server.ts` → `ensureHostedAgentPopKeys`) |
| Private half | in the encrypted secret store under `__POP_KEY__` — a name outside the `secretNames` pattern, so no route can set, clear or list it. It reaches the runtime beside the secrets: in-process as an executor option, in Docker as `AINIZE_POP_JWK` in the env file (scrubbed by the entry point). Never in the spec JSON, a card, a log, or `ctx.secret()` |
| Public half | on the spec (`popJwk`), in the agent card as the extension below, and in `/api/shared-agents` items as `ref.popJwk` (optional field; contract v1.1). `kid` is the RFC 7638 SHA-256 thumbprint |
| Rotation | `HostedAgentStore.setPopJwk` with a different `kid` bumps the version — a new `releaseId`, so a product that pinned one re-reads the card |

Agent card:

```json
"capabilities": { "extensions": [ { "uri": "https://ainetwork.ai/a2a-extension/pop/v1", "required": false,
  "params": { "jwk": { "kty": "EC", "crv": "P-256", "x": "…", "y": "…", "kid": "…" } } } ] }
```

## The data parts (§3 of the design doc)

A2A 0.3 `kind: "data"` parts (the 1.0 `content.$case: "data"` shape is read too), told apart by `metadata.type`:

| `metadata.type` | `data` | Meaning |
|---|---|---|
| `ai.ain/file-refs` | `{ refs: FileRef[] }` (≤ 64) | Which files. A `FileRef` is `{ contract, issuer, driveId, fileId, revision, kind, mimeType?, displayName, ownerRef, availability: { state }, sourceUrl?, legacy?: { path }, size?, sha256? }`. No bytes, no token. aindrive still reads by path, so a ref without `legacy.path` is listed but cannot be read |
| `ai.ain/delegation` | `{ token, audience: string[], expiresAt, jti }` | The `ain-rdlg+jwt`. Its `cnf.jkt` must be the thumbprint of this agent's key — aindrive checks that on every read |

The shapes are re-declared in `hostedAgentDelegatedReads.ts` rather than imported: the contracts package lives in
another repository and a node builds alone. `fileKey` is the contract's `${issuer}#${driveId}#${fileId}`.

## What the runtime does with them

Only when **both** parts are present, the runtime holds a key, and `refs[].issuer`'s host passes the agent's
`allowedHosts`, the turn gets two built-in tools (prompt agents included):

- `list_files()` → `{ files: [{ fileKey, name, kind, mimeType, size, availability }] }`
- `read_file({ fileKey })` → `GET {issuer}/api/drives/{driveId}/fs/read?path={legacy.path}` with
  `Authorization: Bearer <token>` and `X-AIN-PoP: <JWS>`; text as text (≤ 1 MiB served, first 20 000 characters
  shown), a PDF read (`hostedAgentPdf.ts`), a picture shown to the model.

`X-AIN-PoP` is a compact JWS, header `{ alg: "ES256", typ: "ain-pop+jwt", jwk: <public JWK> }`, payload
`{ htm: "GET", htu: <the URL without its query>, iat, jti }`, a fresh `jti` per request — what
aindrive-run `web/lib/resource-delegation.ts` verifies (thumbprint = `cnf.jkt`, ±60 s, jti accepted once).

The rules are the handoff's:

- **the model decides** — nothing is read because of what the question says, nothing is read up front;
- **the token is in the headers and nowhere else** — not in the text the model reads, not in a log line, not in
  the conversation memory, not in the task a streamed turn publishes (its `history` keeps the message with the
  `ai.ain/delegation` and handoff parts removed, since a task is read back through `tasks/get`). Memory keeps the
  file *names* ("no longer readable"); the next message brings its own delegation;
- **the listing is data, not instructions, and not permission** — the origin decides on every read;
- **refusals are said plainly**: 401 → "the delegation expired or is not valid here; ask for a fresh one",
  403 → "no permission on that file", 410 → deleted, 503 → "the device holding it is offline", 413 → "larger than
  its origin serves in one read", and a delegation whose `expiresAt` has passed is not sent at all.

The origin answers a read with aindrive's `fs/read` envelope — `{ content, encoding: "utf8" | "base64", mime }` as
JSON, never raw bytes — and the runtime decodes it before the text / PDF / picture branches; `bytes` in the tool
result is the file's decoded size. A body that is not that envelope is refused in words rather than shown as the file.

When the tools are not offered, the model is told why in one sentence: the issuer is not among the agent's
allowed hosts; the delegation's `audience` does not name the issuer (the token is never sent to an origin it was
not issued for); refs came without a delegation; the runtime has no key. A delegation with no refs says nothing.

When an aindrive handoff and a delegation arrive in one message, the delegated tools are `list_files_delegated`
/ `read_file_delegated` so each name still reaches one server.

## Files

- `src/hosted-agent-runtime/hostedAgentPop.ts` — key generation, thumbprint, the signer, the card extension, the host matcher
- `src/hosted-agent-runtime/hostedAgentDelegatedReads.ts` — the parts, the note, the tools, the refusal words
- `src/hosted-agent-pop.ts` — the node side: issue at create / boot, the reserved secret name
- `test/hosted-agent-delegated-reads.test.ts` — a fake aindrive that verifies the proof the way the real one does
