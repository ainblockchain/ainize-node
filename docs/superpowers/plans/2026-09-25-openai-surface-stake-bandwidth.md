# OpenAI-compatible surface paid by sAIN stake — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Send sAIN to a node, then call its LLM from the `ainize` library using ordinary OpenAI code; the size of the deposit relative to everyone asking at that moment is the caller's share of the node's throughput.

**Architecture:** A new `/v1` router on the existing `ainize-node` Express app exposes OpenAI's shapes over the vLLM backends the node already talks to. An append-only deposit ledger credits addresses from `Transfer` logs on Ethereum and Base. The allocator is a stake-weighted fair queue that replaces the arrival-order tiebreak inside `Runtime.pump()`, so a deposit buys a share of the serving queue rather than a rate cap.

**Tech Stack:** TypeScript (Node ≥ 24, ESM), Express, `node:test` + `tsx`, `viem` for chain reads, `@ainize/core` for identity and config types; Python 3.10+ with `openai` for the client SDK.

**Spec:** `docs/openai-surface-stake-bandwidth-design.md` — read it before Task 1. The plan argues from that spec; where this plan and the spec disagree, the spec wins and the plan is wrong.

## Global Constraints

- **Node ≥ 24, ESM only.** `"type": "module"`; every relative import ends in `.js` even from `.ts` source. Copy the import style of an existing file rather than inventing one.
- **Tests run as** `node --test --import tsx test/<name>.test.ts`, flat in `test/`, kebab-case filenames, `node:test` + `node:assert/strict`. No new test runner, no new assertion library.
- **File names are kebab-case** (`stake-fair-queue.ts`), matching `chat-queue.ts` and `wallet-login.ts`.
- **Identifiers are grep-unique** (project rule): one grep must find a definition and all its uses. `StakeFairQueue`, `depositedShareOf`, `openaiSurfaceRouter` — never `Queue`, `balance`, `router`.
- **Do not add to `src/api.ts`.** It is 2,871 lines. Every new route in this plan lives in its own file.
- **Do not change `/api/chat`, teach mode, or `RUNTIME_PRIORITY` semantics.** This work is additive.
- **Token addresses** (ship as defaults): AIN on Ethereum `0x3a810ff7211b40c4fa76205a14efe161615d0385`; AIN on Base `0xd4423795fd904d9b87554940a95fb7016f172773` (same address on Polygon, BNB Chain, Arbitrum, Optimism, Avalanche).
- **The sAIN vault address and the operator's receiving address have no defaults.** They are required config; a node configured to accept deposits without them must fail at startup, never credit a guessed address.
- **Commit after every task.** Message style: a sentence saying what changed and why, in the repo's existing voice. End with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- **Local dev note:** `node_modules/@ainize/core` is currently a symlink to the local `ainize-core` checkout, because node's source needs core 0.3.3 and npm has 0.3.1. Keep it until core is published.

---

## Phase A — The surface (end-to-end with the free tier)

After Phase A a stock OpenAI client can call this node. Deposits do not exist yet; everyone is on the existing free-try quota.

### Task 1: Backend registry

**Files:**
- Create: `src/inference-backends.ts`
- Test: `test/inference-backends.test.ts`
- Modify: `ainize-core/src/config-schema.ts` (add the `backends` block)

**Interfaces:**
- Consumes: `NodeConfig` from `@ainize/core`.
- Produces:
  - `type InferenceModality = 'chat' | 'transcription' | 'image'`
  - `interface InferenceBackend { id: string; modality: InferenceModality; upstream: string; models: string[]; concurrency: number }`
  - `class InferenceBackendRegistry { constructor(backends: InferenceBackend[]); listModels(): { id: string; object: 'model'; owned_by: string }[]; backendForModel(model: string): InferenceBackend | null; backendsFor(modality: InferenceModality): InferenceBackend[] }`

- [ ] **Step 1: Write the failing test**

```ts
/**
 * What the node says it can serve, and what it refuses to pretend to serve.
 *
 *   node --test --import tsx test/inference-backends.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InferenceBackendRegistry, type InferenceBackend } from '../src/inference-backends.js';

const llm: InferenceBackend = { id: 'llm', modality: 'chat', upstream: 'http://127.0.0.1:8000', models: ['qwen3.8-flash-next'], concurrency: 1 };
const stt: InferenceBackend = { id: 'stt', modality: 'transcription', upstream: 'http://127.0.0.1:8100', models: ['qwen3-asr'], concurrency: 4 };

test('a model maps to the backend that serves it', () => {
  const registry = new InferenceBackendRegistry([llm, stt]);
  assert.equal(registry.backendForModel('qwen3-asr')?.id, 'stt');
});

test('an unknown model maps to nothing rather than to the first backend', () => {
  const registry = new InferenceBackendRegistry([llm, stt]);
  assert.equal(registry.backendForModel('gpt-4'), null);
});

test('a node advertises only what it actually has configured', () => {
  const registry = new InferenceBackendRegistry([llm]);
  assert.deepEqual(registry.listModels().map((m) => m.id), ['qwen3.8-flash-next']);
});

test('two backends may not claim the same model id', () => {
  const clash: InferenceBackend = { ...stt, id: 'stt2', models: ['qwen3.8-flash-next'] };
  assert.throws(() => new InferenceBackendRegistry([llm, clash]), /qwen3\.8-flash-next/);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test --import tsx test/inference-backends.test.ts`
Expected: FAIL — `Cannot find module '../src/inference-backends.js'`.

- [ ] **Step 3: Implement**

```ts
/**
 * What this node can serve, declared rather than discovered.
 *
 * `/v1/models` and routing both read this one list, so a node that runs only the LLM advertises only the LLM
 * instead of accepting a transcription request it will fail. A model id belongs to exactly one backend: two
 * backends claiming the same id would make routing depend on array order, which is not a decision anyone made.
 */
export type InferenceModality = 'chat' | 'transcription' | 'image';

export interface InferenceBackend {
  id: string;
  modality: InferenceModality;
  /** Base URL of the upstream OpenAI-shaped server (vLLM, or the diffusers sidecar). */
  upstream: string;
  models: string[];
  /** How many requests this backend runs at once. The LLM is 1: it is behind the shared lease. */
  concurrency: number;
}

export class InferenceBackendRegistry {
  private readonly byModel = new Map<string, InferenceBackend>();

  constructor(private readonly backends: InferenceBackend[]) {
    for (const backend of backends) {
      for (const model of backend.models) {
        const owner = this.byModel.get(model);
        if (owner) throw new Error(`two backends claim the model ${model}: ${owner.id} and ${backend.id}`);
        this.byModel.set(model, backend);
      }
    }
  }

  listModels(): { id: string; object: 'model'; owned_by: string }[] {
    return [...this.byModel.entries()].map(([id, backend]) => ({ id, object: 'model' as const, owned_by: backend.id }));
  }

  backendForModel(model: string): InferenceBackend | null {
    return this.byModel.get(model) ?? null;
  }

  backendsFor(modality: InferenceModality): InferenceBackend[] {
    return this.backends.filter((b) => b.modality === modality);
  }
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `node --test --import tsx test/inference-backends.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Add the config block**

In `ainize-core/src/config-schema.ts`, beside the existing `runtime` block, add an optional `backends` array whose entries are `{ id, modality, upstream, models, concurrency }` with `concurrency` defaulting to 1. Follow the exact validation style already used for `runtime` in that file — do not introduce a different schema library. Export the inferred type as `NodeBackendConfig`.

- [ ] **Step 6: Typecheck both repos**

Run: `cd ../ainize-core && npm run build && cd ../ainize-node && npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/inference-backends.ts test/inference-backends.test.ts
git commit -m "A node declares what it serves, so it cannot advertise what it has not got

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: API keys bound to an address

**Files:**
- Create: `src/openai-api-keys.ts`
- Test: `test/openai-api-keys.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `interface OpenaiApiKeyRecord { address: string; issuedAt: number; label: string | null }`
  - `class OpenaiApiKeyStore { constructor(file: string); issue(address: string, label?: string | null): string; addressForKey(key: string): string | null; revoke(key: string): boolean; listFor(address: string): { prefix: string; issuedAt: number; label: string | null }[] }`

The returned key is the only time the secret is visible. The store keeps a SHA-256 of it, never the key.

- [ ] **Step 1: Write the failing test**

```ts
/**
 * The key a caller puts in `api_key`, and the address it speaks for.
 *
 * A bearer key is what makes a stock OpenAI client work against this node at all, so it must be cheap on the
 * request path: one hash and one lookup. What it must never be is recoverable from the node's disk, which is why
 * only the hash is stored — an operator reading the file learns which addresses have keys, not what they are.
 *
 *   node --test --import tsx test/openai-api-keys.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenaiApiKeyStore } from '../src/openai-api-keys.js';

const tmp = mkdtempSync(join(tmpdir(), 'ainize-keys-'));
const file = () => join(tmp, `${Math.random().toString(36).slice(2)}.json`);

test('a key resolves to the address it was issued to', () => {
  const store = new OpenaiApiKeyStore(file());
  const key = store.issue('0xAbC0000000000000000000000000000000000001');
  assert.equal(store.addressForKey(key), '0xabc0000000000000000000000000000000000001');
});

test('addresses are compared lowercased, so a checksummed address is the same account', () => {
  const store = new OpenaiApiKeyStore(file());
  const key = store.issue('0xABC0000000000000000000000000000000000001');
  assert.equal(store.addressForKey(key), '0xabc0000000000000000000000000000000000001');
});

test('an unknown key resolves to nothing', () => {
  const store = new OpenaiApiKeyStore(file());
  assert.equal(store.addressForKey('ainize-sk-nope'), null);
});

test('the secret is never written to disk', () => {
  const path = file();
  const store = new OpenaiApiKeyStore(path);
  const key = store.issue('0x0000000000000000000000000000000000000002');
  assert.ok(!readFileSync(path, 'utf8').includes(key));
});

test('a revoked key stops working, and revoking it twice is not an error the second time', () => {
  const store = new OpenaiApiKeyStore(file());
  const key = store.issue('0x0000000000000000000000000000000000000003');
  assert.equal(store.revoke(key), true);
  assert.equal(store.addressForKey(key), null);
  assert.equal(store.revoke(key), false);
});

test('keys survive a restart', () => {
  const path = file();
  const key = new OpenaiApiKeyStore(path).issue('0x0000000000000000000000000000000000000004');
  assert.equal(new OpenaiApiKeyStore(path).addressForKey(key), '0x0000000000000000000000000000000000000004');
});

process.on('exit', () => rmSync(tmp, { recursive: true, force: true }));
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test --import tsx test/openai-api-keys.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface OpenaiApiKeyRecord { address: string; issuedAt: number; label: string | null }

const KEY_PREFIX = 'ainize-sk-';

function hashOpenaiApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/**
 * Bearer keys for the `/v1` surface, each standing for one EVM address.
 *
 * Only the hash is kept. The key is returned once, at issue, and cannot be recovered afterwards — losing it means
 * issuing another, which is the same bargain every API key in the world makes.
 */
export class OpenaiApiKeyStore {
  private records = new Map<string, OpenaiApiKeyRecord>();

  constructor(private readonly file: string) {
    if (!existsSync(file)) return;
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, OpenaiApiKeyRecord>;
      this.records = new Map(Object.entries(parsed));
    } catch { this.records = new Map(); }
  }

  issue(address: string, label: string | null = null): string {
    const key = `${KEY_PREFIX}${randomBytes(24).toString('base64url')}`;
    this.records.set(hashOpenaiApiKey(key), { address: address.toLowerCase(), issuedAt: Date.now(), label });
    this.persist();
    return key;
  }

  addressForKey(key: string): string | null {
    if (!key.startsWith(KEY_PREFIX)) return null;
    return this.records.get(hashOpenaiApiKey(key))?.address ?? null;
  }

  revoke(key: string): boolean {
    const removed = this.records.delete(hashOpenaiApiKey(key));
    if (removed) this.persist();
    return removed;
  }

  listFor(address: string): { prefix: string; issuedAt: number; label: string | null }[] {
    const wanted = address.toLowerCase();
    return [...this.records.entries()]
      .filter(([, r]) => r.address === wanted)
      .map(([hash, r]) => ({ prefix: hash.slice(0, 8), issuedAt: r.issuedAt, label: r.label }));
  }

  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.records)), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}

export { hashOpenaiApiKey, timingSafeEqual };
```

- [ ] **Step 4: Run it and watch it pass**

Run: `node --test --import tsx test/openai-api-keys.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/openai-api-keys.ts test/openai-api-keys.test.ts
git commit -m "A bearer key that stands for an address, stored only as its hash

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Sign-in that issues a key

**Files:**
- Create: `src/openai-auth-routes.ts`
- Test: `test/openai-auth-routes.test.ts`

**Interfaces:**
- Consumes: `OpenaiApiKeyStore` (Task 2); `walletLoginMessage`, `requestOrigin` from `src/wallet-login.ts`; `signMessage` and the login scheme from `@ainize/core`.
- Produces: `function openaiAuthRoutes(deps: { keys: OpenaiApiKeyStore; node: string; nodeName?: string }): Router` mounting `POST /v1/auth/nonce` and `POST /v1/auth/token`.

`POST /v1/auth/nonce` takes `{ address, scheme }` and returns `{ nonce, message, expires_at }`. `POST /v1/auth/token` takes `{ nonce, signature }` and returns `{ api_key, address, expires_at: null }`.

Reuse the existing challenge store and signature verification that `test/wallet-login.test.ts` and `test/device-login.test.ts` already exercise — read both before writing this. Do not add a second signing scheme; the scheme is chosen when the nonce is issued and fixed from then on.

- [ ] **Step 1: Write the failing test**

```ts
/**
 * Getting an API key by proving an address, using the sign-in that already exists.
 *
 *   node --test --import tsx test/openai-auth-routes.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startNode, type RunningNode } from '../src/server.js';
import { personalSign } from './fixtures/metamask.js';

const tmp = mkdtempSync(join(tmpdir(), 'ainize-v1auth-'));
let node: RunningNode;
let base: string;

before(async () => { /* start a node the way test/wallet-login.test.ts does, with AINIZE_HOME=tmp */ });
after(async () => { await node?.stop(); rmSync(tmp, { recursive: true, force: true }); });

test('a signature over the issued message buys a key that names the signer', async () => {
  const address = '0x...';                       // from the fixture wallet
  const challenge = await (await fetch(`${base}/v1/auth/nonce`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ address, scheme: 'eip191' }),
  })).json();
  assert.ok(challenge.message.includes(challenge.nonce), 'the nonce the caller signs is in the message it reads');

  const issued = await (await fetch(`${base}/v1/auth/token`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nonce: challenge.nonce, signature: personalSign(challenge.message) }),
  })).json();
  assert.match(issued.api_key, /^ainize-sk-/);
  assert.equal(issued.address.toLowerCase(), address.toLowerCase());
});

test('a nonce is good once', async () => { /* replay the same nonce+signature, expect 400 */ });
test('a signature by another key is refused', async () => { /* sign with a second fixture wallet, expect 401 */ });
test('an unknown nonce is refused without revealing whether it ever existed', async () => { /* expect 400 */ });
```

Fill the `before` hook and the three stub bodies by copying the node-startup and signing patterns from `test/wallet-login.test.ts` — that file is the reference for both.

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test --import tsx test/openai-auth-routes.test.ts`
Expected: FAIL — 404 on `/v1/auth/nonce`.

- [ ] **Step 3: Implement `openaiAuthRoutes`**

Mount the two routes. On `nonce`: store `{ address, scheme, message, expiresAt }` keyed by a random nonce, TTL 10 minutes, and return the message built by `walletLoginMessage({ node, nodeName, nonce, origin: requestOrigin(req.get('origin')), expiresAt })`. On `token`: look the nonce up, delete it before verifying (so a replay cannot race), verify the signature against the stored message under the stored scheme, and on success return `keys.issue(address)`.

- [ ] **Step 4: Run it and watch it pass**

Run: `node --test --import tsx test/openai-auth-routes.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/openai-auth-routes.ts test/openai-auth-routes.test.ts
git commit -m "Sign in once, get a key: the /v1 surface reuses the wallet login the node already had

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: `/v1/models` and `/v1/chat/completions`

**Files:**
- Create: `src/openai-surface.ts`
- Test: `test/openai-surface.test.ts`
- Modify: `src/server.ts` (mount the router)

**Interfaces:**
- Consumes: `InferenceBackendRegistry` (Task 1), `OpenaiApiKeyStore` (Task 2), `openaiAuthRoutes` (Task 3), the existing `Runtime` and `Market`.
- Produces: `function openaiSurfaceRouter(deps: { registry: InferenceBackendRegistry; keys: OpenaiApiKeyStore; runtime: Runtime; market: Market; node: string; nodeName?: string }): Router`.

Routes: `GET /v1/models`, `POST /v1/chat/completions`, `GET /v1/account`, plus the auth routes from Task 3.

Behaviour that has to be exact, because a stock client depends on it:
- Non-streaming returns `{ id: "chatcmpl-…", object: "chat.completion", created, model, choices: [{ index, message: { role, content }, finish_reason }], usage }`.
- Streaming returns `text/event-stream` of `chat.completion.chunk` frames and ends with `data: [DONE]`. `src/chat-stream.ts` and `src/api.ts:2050` already build frames in this shape — reuse, do not re-derive.
- A missing or unknown key is `401` with an OpenAI-shaped `{ error: { message, type: "invalid_request_error", code: "invalid_api_key" } }` body.
- An unknown model is `404` with `code: "model_not_found"`.
- A backend that is down is `503` with `code: "backend_unavailable"`, distinct from being queued.

- [ ] **Step 1: Write the failing test**

```ts
/**
 * The shapes a stock OpenAI client insists on. These assertions are the compatibility claim.
 *
 *   node --test --import tsx test/openai-surface.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

let base: string; let apiKey: string;

before(async () => { /* start a node with a stub upstream; sign in for a key (Task 3 routes) */ });

test('GET /v1/models lists what the registry holds, in OpenAI shape', async () => {
  const body = await (await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${apiKey}` } })).json();
  assert.equal(body.object, 'list');
  assert.ok(body.data.every((m: { object: string }) => m.object === 'model'));
});

test('a completion comes back in the shape the client parses', async () => {
  const body = await (await fetch(`${base}/v1/chat/completions`, {
    method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'qwen3.8-flash-next', messages: [{ role: 'user', content: 'hi' }] }),
  })).json();
  assert.equal(body.object, 'chat.completion');
  assert.match(body.id, /^chatcmpl-/);
  assert.equal(body.choices[0].message.role, 'assistant');
  assert.equal(typeof body.choices[0].message.content, 'string');
  assert.equal(body.choices[0].finish_reason, 'stop');
});

test('a stream is chunk frames and ends with [DONE]', async () => {
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'qwen3.8-flash-next', messages: [{ role: 'user', content: 'hi' }], stream: true }),
  });
  assert.equal(res.headers.get('content-type')?.split(';')[0], 'text/event-stream');
  const text = await res.text();
  assert.ok(text.includes('"object":"chat.completion.chunk"'));
  assert.ok(text.trimEnd().endsWith('data: [DONE]'));
});

test('no key is 401 in OpenAI error shape', async () => {
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'qwen3.8-flash-next', messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error.code, 'invalid_api_key');
});

test('an unknown model is 404 model_not_found, not a 500', async () => {
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error.code, 'model_not_found');
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test --import tsx test/openai-surface.test.ts`
Expected: FAIL — 404 on `/v1/models`.

- [ ] **Step 3: Implement the router**

Bearer middleware resolves `Authorization` to an address via `keys.addressForKey`. The chat handler validates the body with `zod` (the file already in use across `src/api.ts`), resolves the backend via the registry, and runs the generation through `runtime.exclusive('chat', …)` so it takes the same shared lease everything else does. Reuse `market.chatQuota` for callers with no deposit, returning `429 quota_exhausted` with the existing `quota_reset` field.

- [ ] **Step 4: Run it and watch it pass**

Run: `node --test --import tsx test/openai-surface.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Mount it and check nothing else moved**

In `src/server.ts`, mount `openaiSurfaceRouter(...)` beside the existing `/api` router. Then run the whole suite: `npm test`.
Expected: the pre-existing 321 pass / 3 skip, plus the new tests. No previously-passing test fails.

- [ ] **Step 6: Commit**

```bash
git add src/openai-surface.ts test/openai-surface.test.ts src/server.ts
git commit -m "Serve the model in OpenAI's shapes, so a client that knows OpenAI needs to learn nothing

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Phase B — `import ainize` (the goal, end to end)

### Task 5: The Python SDK

**Files:**
- Create: `sdk/python/pyproject.toml`, `sdk/python/ainize/__init__.py`, `sdk/python/ainize/_connect.py`
- Test: `sdk/python/tests/test_connect.py`

**Interfaces:**
- Consumes: the wire contract from Tasks 3 and 4.
- Produces: `ainize.connect(node_url: str, *, private_key: str | None = None, api_key: str | None = None) -> openai.OpenAI`, `ainize.deposit_address(node_url: str) -> str`, `ainize.await_deposit(node_url, tx_hash, *, timeout=600) -> dict`.

`connect()` signs the challenge with `eth_account` and returns a real `openai.OpenAI` with `base_url=f"{node_url}/v1"` and the issued key. Nothing in the caller's code changes after that line.

- [ ] **Step 1: Write the failing test**

```python
"""What `import ainize` promises: after one line, it is just OpenAI.

    cd sdk/python && python -m pytest
"""
import openai
import ainize


def test_connect_returns_a_real_openai_client(node_url, wallet_key):
    client = ainize.connect(node_url, private_key=wallet_key)
    assert isinstance(client, openai.OpenAI)
    assert str(client.base_url).rstrip("/").endswith("/v1")


def test_an_existing_key_skips_signing(node_url, issued_key):
    client = ainize.connect(node_url, api_key=issued_key)
    assert client.api_key == issued_key


def test_chat_completion_round_trips(node_url, wallet_key):
    client = ainize.connect(node_url, private_key=wallet_key)
    out = client.chat.completions.create(
        model="qwen3.8-flash-next", messages=[{"role": "user", "content": "hi"}]
    )
    assert out.choices[0].message.content


def test_streaming_yields_chunks(node_url, wallet_key):
    client = ainize.connect(node_url, private_key=wallet_key)
    chunks = list(client.chat.completions.create(
        model="qwen3.8-flash-next", messages=[{"role": "user", "content": "hi"}], stream=True
    ))
    assert chunks and chunks[0].object == "chat.completion.chunk"


def test_neither_key_nor_private_key_is_an_error_naming_both(node_url):
    try:
        ainize.connect(node_url)
    except ValueError as e:
        assert "private_key" in str(e) and "api_key" in str(e)
    else:
        raise AssertionError("expected ValueError")
```

`conftest.py` starts a real node with `npm run start` against a stub upstream and yields its URL; copy the process handling from `e2e/` rather than inventing it.

- [ ] **Step 2: Run it and watch it fail**

Run: `cd sdk/python && python -m pytest -x`
Expected: FAIL — `ModuleNotFoundError: ainize`.

- [ ] **Step 3: Implement**

```python
"""Point OpenAI at an Ainize node.

The library does one thing on top of `openai`: it proves which address is calling, and gets a key back. It does
not wrap the client, subclass it, or re-export a narrowed version of it — it returns the real thing, because the
whole promise is that nothing after this line is different.

It also never signs a transfer. `deposit_address()` says where to send AIN and `await_deposit()` waits for the
node to see it; moving funds stays with the wallet the person already trusts.
"""
from __future__ import annotations

import time
import httpx
import openai
from eth_account import Account
from eth_account.messages import encode_defunct


def connect(node_url: str, *, private_key: str | None = None, api_key: str | None = None) -> openai.OpenAI:
    node_url = node_url.rstrip("/")
    if api_key is None:
        if private_key is None:
            raise ValueError("connect() needs either private_key (to sign in) or api_key (already issued)")
        api_key = _sign_in(node_url, private_key)
    return openai.OpenAI(base_url=f"{node_url}/v1", api_key=api_key)


def _sign_in(node_url: str, private_key: str) -> str:
    account = Account.from_key(private_key)
    with httpx.Client(timeout=30) as http:
        challenge = http.post(
            f"{node_url}/v1/auth/nonce", json={"address": account.address, "scheme": "eip191"}
        ).raise_for_status().json()
        signature = account.sign_message(encode_defunct(text=challenge["message"])).signature.hex()
        issued = http.post(
            f"{node_url}/v1/auth/token", json={"nonce": challenge["nonce"], "signature": signature}
        ).raise_for_status().json()
    return issued["api_key"]


def deposit_address(node_url: str) -> str:
    with httpx.Client(timeout=30) as http:
        return http.get(f"{node_url.rstrip('/')}/v1/account/deposit-address").raise_for_status().json()["address"]


def await_deposit(node_url: str, tx_hash: str, *, timeout: float = 600) -> dict:
    """Wait until the node has credited a transfer. Polls; the node is the authority on when it counts."""
    deadline = time.monotonic() + timeout
    with httpx.Client(timeout=30) as http:
        while True:
            seen = http.get(
                f"{node_url.rstrip('/')}/v1/account/deposits/{tx_hash}"
            ).raise_for_status().json()
            if seen.get("credited"):
                return seen
            if time.monotonic() > deadline:
                raise TimeoutError(f"{tx_hash} was not credited within {timeout}s")
            time.sleep(5)
```

`__init__.py` re-exports `connect`, `deposit_address`, `await_deposit`.

- [ ] **Step 4: Run it and watch it pass**

Run: `cd sdk/python && python -m pytest -x`
Expected: PASS, 5 tests. (`deposit_address` / `await_deposit` routes land in Task 8; their tests are added there.)

- [ ] **Step 5: Commit**

```bash
git add sdk/python
git commit -m "import ainize: one line to point OpenAI at a node, and nothing different after it

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Phase C — Deposits

### Task 6: The deposit ledger (pure)

**Files:**
- Create: `ainize-core/src/deposit-ledger.ts`
- Test: `ainize-core/test/deposit-ledger.test.ts`

**Interfaces:**
- Produces:
  - `interface DepositEvent { chain: string; txHash: string; logIndex: number; from: string; shares: bigint; blockNumber: number }`
  - `class DepositLedger { credit(event: DepositEvent): boolean; depositedShareOf(address: string): bigint; totalDepositedShares(): bigint; creditedAt(chain: string, txHash: string, logIndex: number): DepositEvent | null; snapshot(): DepositEvent[]; static from(events: DepositEvent[]): DepositLedger }`

`credit` returns `false` when the event was already credited. Amounts are `bigint` sAIN share units — never `number`, because share amounts exceed `Number.MAX_SAFE_INTEGER` at 18 decimals.

- [ ] **Step 1: Write the failing test**

```ts
/**
 * Who has deposited how much, in one unit, across chains.
 *
 * Deposits arrive as log events, and log events arrive more than once: a watcher restarts, a range is re-scanned,
 * a reorg replays a block. Crediting twice would mint share out of nothing, so identity is
 * (chain, txHash, logIndex) and crediting is idempotent on it. Amounts are bigint because sAIN has 18 decimals
 * and a deposit of ten tokens does not fit in a double.
 *
 *   node --test --import tsx test/deposit-ledger.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DepositLedger, type DepositEvent } from '../src/deposit-ledger.js';

const event = (over: Partial<DepositEvent> = {}): DepositEvent => ({
  chain: 'base', txHash: '0xaa', logIndex: 0, from: '0xAbC0000000000000000000000000000000000001',
  shares: 10n ** 18n, blockNumber: 100, ...over,
});

test('a credit shows up under the sender, lowercased', () => {
  const ledger = new DepositLedger();
  assert.equal(ledger.credit(event()), true);
  assert.equal(ledger.depositedShareOf('0xabc0000000000000000000000000000000000001'), 10n ** 18n);
});

test('the same log credited twice counts once', () => {
  const ledger = new DepositLedger();
  ledger.credit(event());
  assert.equal(ledger.credit(event()), false);
  assert.equal(ledger.depositedShareOf('0xabc0000000000000000000000000000000000001'), 10n ** 18n);
});

test('the same tx hash on two chains is two deposits', () => {
  const ledger = new DepositLedger();
  ledger.credit(event({ chain: 'base' }));
  ledger.credit(event({ chain: 'ethereum' }));
  assert.equal(ledger.depositedShareOf('0xabc0000000000000000000000000000000000001'), 2n * 10n ** 18n);
});

test('two logs in one tx are two deposits', () => {
  const ledger = new DepositLedger();
  ledger.credit(event({ logIndex: 0 }));
  ledger.credit(event({ logIndex: 1 }));
  assert.equal(ledger.depositedShareOf('0xabc0000000000000000000000000000000000001'), 2n * 10n ** 18n);
});

test('an address that never deposited holds zero, not undefined', () => {
  assert.equal(new DepositLedger().depositedShareOf('0x00'), 0n);
});

test('the total is the sum over everyone', () => {
  const ledger = new DepositLedger();
  ledger.credit(event({ from: '0x01', shares: 3n }));
  ledger.credit(event({ from: '0x02', shares: 7n, logIndex: 1 }));
  assert.equal(ledger.totalDepositedShares(), 10n);
});

test('a ledger rebuilt from its snapshot holds the same balances', () => {
  const ledger = new DepositLedger();
  ledger.credit(event({ from: '0x01', shares: 3n }));
  ledger.credit(event({ from: '0x02', shares: 7n, logIndex: 1 }));
  const rebuilt = DepositLedger.from(ledger.snapshot());
  assert.equal(rebuilt.totalDepositedShares(), 10n);
  assert.equal(rebuilt.depositedShareOf('0x01'), 3n);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd ../ainize-core && node --test --import tsx test/deposit-ledger.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

A `Map<string, DepositEvent>` keyed by `${chain}:${txHash}:${logIndex}` and a `Map<string, bigint>` of running totals, updated on credit. `from` is lowercased on the way in. No I/O in this file — core stays a protocol and type layer.

- [ ] **Step 4: Run it and watch it pass**

Run: `cd ../ainize-core && node --test --import tsx test/deposit-ledger.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Export it and rebuild**

Add the export to `ainize-core/src/index.ts`, then `npm run build` in core so the linked package picks it up.

- [ ] **Step 6: Commit (in ainize-core)**

```bash
cd ../ainize-core
git add src/deposit-ledger.ts test/deposit-ledger.test.ts src/index.ts
git commit -m "An append-only record of who deposited what, idempotent on the log that said so

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: The deposit watcher

**Files:**
- Create: `src/deposit-watcher.ts`
- Test: `test/deposit-watcher.test.ts`
- Modify: `package.json` (add `viem`)

**Interfaces:**
- Consumes: `DepositLedger`, `DepositEvent` from `@ainize/core`.
- Produces:
  - `interface DepositChainConfig { chain: string; rpcUrl: string; token: string; confirmations: number; isVaultShare: boolean }`
  - `class DepositWatcher { constructor(deps: { chains: DepositChainConfig[]; receivingAddress: string; ledger: DepositLedger; sharesFor: (chain: string, amount: bigint) => Promise<bigint>; readLogs: ChainLogReader; journalFile: string }); scanOnce(): Promise<number>; start(intervalMs: number): void; stop(): void; lastScannedBlock(chain: string): number }`
  - `type ChainLogReader = (chain: string, fromBlock: number, toBlock: number) => Promise<{ txHash: string; logIndex: number; from: string; value: bigint; blockNumber: number }[]>`

`readLogs` is injected so the tests drive it without a chain. The `viem` implementation of it is a separate exported function, `viemLogReader(chains)`, and is not unit-tested against a live network.

`sharesFor` converts a raw AIN amount into sAIN share units through the vault's `convertToShares`; when `isVaultShare` is true the amount is already shares and is passed through.

- [ ] **Step 1: Write the failing test**

```ts
/**
 * Turning transfers into credited share, without crediting anything twice or too early.
 *
 *   node --test --import tsx test/deposit-watcher.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DepositLedger } from '@ainize/core';
import { DepositWatcher, type DepositChainConfig } from '../src/deposit-watcher.js';

const tmp = mkdtempSync(join(tmpdir(), 'ainize-deposits-'));
const chains: DepositChainConfig[] = [
  { chain: 'base', rpcUrl: 'unused', token: '0xd4423795fd904d9b87554940a95fb7016f172773', confirmations: 3, isVaultShare: false },
];

function watcher(logs: Record<number, { txHash: string; logIndex: number; from: string; value: bigint; blockNumber: number }[]>, head: number) {
  const ledger = new DepositLedger();
  const w = new DepositWatcher({
    chains, receivingAddress: '0xNODE', ledger,
    sharesFor: async (_chain, amount) => amount / 2n,        // a vault where one share costs two AIN
    readLogs: async (_chain, from, to) => Object.entries(logs)
      .filter(([b]) => Number(b) >= from && Number(b) <= to).flatMap(([, v]) => v),
    journalFile: join(tmp, `${Math.random().toString(36).slice(2)}.json`),
    chainHead: async () => head,
  });
  return { w, ledger };
}

const transfer = (over = {}) => ({ txHash: '0xaa', logIndex: 0, from: '0xDEP', value: 100n, blockNumber: 10, ...over });

test('a confirmed transfer is credited, converted to share units', async () => {
  const { w, ledger } = watcher({ 10: [transfer()] }, 20);
  await w.scanOnce();
  assert.equal(ledger.depositedShareOf('0xdep'), 50n);
});

test('a transfer shallower than the confirmation depth is not credited yet', async () => {
  const { w, ledger } = watcher({ 10: [transfer()] }, 11);   // 11 - 10 = 1 < 3
  await w.scanOnce();
  assert.equal(ledger.depositedShareOf('0xdep'), 0n);
});

test('rescanning the same range credits nothing extra', async () => {
  const { w, ledger } = watcher({ 10: [transfer()] }, 20);
  await w.scanOnce();
  await w.scanOnce();
  assert.equal(ledger.depositedShareOf('0xdep'), 50n);
});

test('a direct sAIN deposit is credited without conversion', async () => {
  const ledger = new DepositLedger();
  const w = new DepositWatcher({
    chains: [{ ...chains[0], isVaultShare: true }], receivingAddress: '0xNODE', ledger,
    sharesFor: async () => { throw new Error('must not convert a share'); },
    readLogs: async () => [transfer()], journalFile: join(tmp, 'v.json'), chainHead: async () => 20,
  });
  await w.scanOnce();
  assert.equal(ledger.depositedShareOf('0xdep'), 100n);
});

test('progress survives a restart, so a restart does not rescan from genesis', async () => {
  const file = join(tmp, 'j.json');
  const make = () => new DepositWatcher({
    chains, receivingAddress: '0xNODE', ledger: new DepositLedger(),
    sharesFor: async (_c, a) => a, readLogs: async () => [], journalFile: file, chainHead: async () => 500,
  });
  const first = make();
  await first.scanOnce();
  assert.ok(first.lastScannedBlock('base') > 0);
  assert.equal(make().lastScannedBlock('base'), first.lastScannedBlock('base'));
});

process.on('exit', () => rmSync(tmp, { recursive: true, force: true }));
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test --import tsx test/deposit-watcher.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Scan `[lastScanned + 1, head - confirmations]` per chain, filter logs to `to === receivingAddress`, convert, credit, then persist `{ chain: lastScannedBlock }` to the journal atomically (write-temp-then-rename, as `OpenaiApiKeyStore` does). Never advance the journal past a block whose credits were not persisted.

- [ ] **Step 4: Run it and watch it pass**

Run: `node --test --import tsx test/deposit-watcher.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Add `viemLogReader` and the startup guard**

`viemLogReader` builds a `publicClient` per chain and calls `getLogs` for the ERC-20 `Transfer` event filtered on `to`. In `src/server.ts`, when the `deposits` config block is present, refuse to start unless both the sAIN vault address and the receiving address are set — an unconfigured node must not credit a guessed address.

- [ ] **Step 6: Run the whole suite and commit**

```bash
npm test
git add src/deposit-watcher.ts test/deposit-watcher.test.ts package.json package-lock.json src/server.ts
git commit -m "Credit a deposit when the chain has confirmed it, and only once however often we look

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: `/v1/account` and the deposit routes

**Files:**
- Modify: `src/openai-surface.ts`
- Test: `test/openai-account.test.ts`

**Interfaces:**
- Consumes: `DepositLedger` (Task 6), `DepositWatcher` (Task 7).
- Produces: `GET /v1/account`, `GET /v1/account/deposit-address`, `GET /v1/account/deposits/:txHash` — the three the Python SDK in Task 5 already calls.

`GET /v1/account` returns `{ address, deposited_shares, share_of_active, recent_throughput }`. `share_of_active` is `0` until Task 9 lands and is computed from the scheduler after it.

- [ ] **Step 1: Write the failing test**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('an account reports what it deposited, as a decimal string', async () => {
  const body = await (await fetch(`${base}/v1/account`, { headers: { authorization: `Bearer ${apiKey}` } })).json();
  assert.equal(typeof body.deposited_shares, 'string');   // bigint does not survive JSON
  assert.equal(body.address.toLowerCase(), body.address);
});

test('a deposit not yet seen reports credited:false rather than 404', async () => {
  const body = await (await fetch(`${base}/v1/account/deposits/0xnotyet`, { headers: { authorization: `Bearer ${apiKey}` } })).json();
  assert.equal(body.credited, false);
});

test('the deposit address is the one the operator configured', async () => {
  const body = await (await fetch(`${base}/v1/account/deposit-address`)).json();
  assert.match(body.address, /^0x[0-9a-fA-F]{40}$/);
});
```

- [ ] **Step 2: Run it and watch it fail** — 404 on `/v1/account`.
- [ ] **Step 3: Implement the three routes.** Serialise `bigint` as a decimal string; `JSON.stringify` throws on `bigint` and a silent `Number()` would lose precision.
- [ ] **Step 4: Run it and watch it pass.**
- [ ] **Step 5: Enable the Python SDK's deposit tests** — add `test_deposit_address` and `test_await_deposit_times_out` to `sdk/python/tests/test_connect.py` and run `python -m pytest`.
- [ ] **Step 6: Commit.**

---

## Phase D — The allocator

### Task 9: Stake-weighted fair queue (pure)

**Files:**
- Create: `src/stake-fair-queue.ts`
- Test: `test/stake-fair-queue.test.ts`

**Interfaces:**
- Produces:
  - `interface StakeFairEntry { priority: number; seq: number; address: string; cost: number }`
  - `class StakeFairQueue { constructor(opts: { weightOf: (address: string) => number; weightFloor: number; now: () => number }); admit(entry: StakeFairEntry): number; take(entries: StakeFairEntry[]): StakeFairEntry | null; activeShareOf(address: string): number }`

`admit` returns the entry's virtual finish time and records it. `take` picks the next entry by `(priority, vft, seq)`. `weightFloor` is the weight a caller with no deposit gets — small but never zero, since zero means infinite `vft` and permanent starvation.

- [ ] **Step 1: Write the failing test**

```ts
/**
 * Dividing one serialised model between callers in proportion to what they deposited.
 *
 * The model runs one request at a time behind a shared lease, so a deposit cannot buy a rate — it buys a share of
 * the queue. Weighted fair queueing gives each waiter a virtual finish time of
 * `max(now, lastVft[address]) + cost / weight`, and serving lowest-first makes long-run throughput converge to the
 * weight ratio. The `max(now, …)` clamp is what stops a returning idle address from arriving with a credit that
 * would starve everyone else — and is also why nothing has to track who is "active": an address that is not
 * asking has no entry, and so has no claim.
 *
 *   node --test --import tsx test/stake-fair-queue.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StakeFairQueue, type StakeFairEntry } from '../src/stake-fair-queue.js';

/** Run `rounds` services against saturating demand from everyone, and count who got served. */
function simulate(weights: Record<string, number>, rounds: number): Record<string, number> {
  let clock = 0;
  const queue = new StakeFairQueue({ weightOf: (a) => weights[a] ?? 0, weightFloor: 0.01, now: () => clock });
  const served: Record<string, number> = {};
  let seq = 0;
  const waiting: StakeFairEntry[] = [];
  const enqueue = (address: string) => {
    const entry = { priority: 0, seq: ++seq, address, cost: 1 };
    queue.admit(entry);
    waiting.push(entry);
  };
  for (const a of Object.keys(weights)) enqueue(a);
  for (let i = 0; i < rounds; i++) {
    const next = queue.take(waiting)!;
    waiting.splice(waiting.indexOf(next), 1);
    served[next.address] = (served[next.address] ?? 0) + 1;
    clock += 1;
    enqueue(next.address);                       // saturating: it immediately asks again
  }
  return served;
}

test('two saturating callers at 2:1 are served about 2:1', () => {
  const served = simulate({ big: 2, small: 1 }, 300);
  const ratio = served.big / served.small;
  assert.ok(ratio > 1.8 && ratio < 2.2, `expected about 2:1, got ${ratio}`);
});

test('three callers at 3:2:1 are served about 3:2:1', () => {
  const served = simulate({ a: 3, b: 2, c: 1 }, 600);
  assert.ok(Math.abs(served.a / served.c - 3) < 0.4, `a:c was ${served.a / served.c}`);
  assert.ok(Math.abs(served.b / served.c - 2) < 0.4, `b:c was ${served.b / served.c}`);
});

test('an idle address takes nothing from the ones that are asking', () => {
  const served = simulate({ busy: 1, alsoBusy: 1 }, 200);
  assert.equal(Object.keys(served).sort().join(','), 'alsoBusy,busy');
});

test('an address returning after an idle stretch does not arrive holding a backlog', () => {
  let clock = 0;
  const queue = new StakeFairQueue({ weightOf: () => 1, weightFloor: 0.01, now: () => clock });
  queue.admit({ priority: 0, seq: 1, address: 'gone', cost: 1 });
  clock = 10_000;
  const returning = queue.admit({ priority: 0, seq: 2, address: 'gone', cost: 1 });
  const fresh = queue.admit({ priority: 0, seq: 3, address: 'new', cost: 1 });
  assert.equal(returning, fresh, 'a returning address starts from now, exactly like a new one');
});

test('priority still wins: WFQ orders within a class, never across it', () => {
  const queue = new StakeFairQueue({ weightOf: () => 1, weightFloor: 0.01, now: () => 0 });
  const serving: StakeFairEntry = { priority: 0, seq: 2, address: 'tiny', cost: 1000 };
  const verify: StakeFairEntry = { priority: 9, seq: 1, address: 'huge', cost: 1 };
  queue.admit(verify); queue.admit(serving);
  assert.equal(queue.take([verify, serving])?.priority, 0);
});

test('a caller with no deposit is served last, not never', () => {
  const queue = new StakeFairQueue({ weightOf: (a) => (a === 'free' ? 0 : 1), weightFloor: 0.01, now: () => 0 });
  const free: StakeFairEntry = { priority: 0, seq: 1, address: 'free', cost: 1 };
  queue.admit(free);
  assert.ok(Number.isFinite(queue.take([free]) ? 1 : 0));
  assert.equal(queue.take([free]), free, 'alone in the queue, the free caller runs');
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test --import tsx test/stake-fair-queue.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
export interface StakeFairEntry { priority: number; seq: number; address: string; cost: number }

export class StakeFairQueue {
  private readonly lastVirtualFinish = new Map<string, number>();
  private readonly virtualFinish = new WeakMap<StakeFairEntry, number>();

  constructor(private readonly opts: { weightOf: (address: string) => number; weightFloor: number; now: () => number }) {}

  admit(entry: StakeFairEntry): number {
    const weight = Math.max(this.opts.weightOf(entry.address), this.opts.weightFloor);
    const start = Math.max(this.opts.now(), this.lastVirtualFinish.get(entry.address) ?? 0);
    const finish = start + entry.cost / weight;
    this.lastVirtualFinish.set(entry.address, finish);
    this.virtualFinish.set(entry, finish);
    return finish;
  }

  take(entries: StakeFairEntry[]): StakeFairEntry | null {
    let best: StakeFairEntry | null = null;
    for (const entry of entries) {
      if (!best) { best = entry; continue; }
      if (entry.priority !== best.priority) { if (entry.priority < best.priority) best = entry; continue; }
      const a = this.virtualFinish.get(entry) ?? Infinity;
      const b = this.virtualFinish.get(best) ?? Infinity;
      if (a < b || (a === b && entry.seq < best.seq)) best = entry;
    }
    return best;
  }

  activeShareOf(address: string): number {
    const mine = Math.max(this.opts.weightOf(address), this.opts.weightFloor);
    let total = 0;
    for (const a of this.lastVirtualFinish.keys()) total += Math.max(this.opts.weightOf(a), this.opts.weightFloor);
    return total === 0 ? 0 : mine / total;
  }
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `node --test --import tsx test/stake-fair-queue.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/stake-fair-queue.ts test/stake-fair-queue.test.ts
git commit -m "Weighted fair queueing: a deposit buys a share of the queue, and an idle one costs nobody anything

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 10: Wire the queue into `Runtime`

**Files:**
- Modify: `src/runtime.ts:124` (the `waiters` type), `src/runtime.ts:148-171` (`serial` and `pump`)
- Test: `test/runtime-stake-order.test.ts`

**Interfaces:**
- Consumes: `StakeFairQueue` (Task 9).
- Produces: `Runtime` gains an optional constructor dependency `scheduler?: StakeFairQueue` and `serial()` gains an optional `address` argument. With no scheduler, ordering is exactly today's `priority, seq` — this is what keeps all 321 existing tests passing.

- [ ] **Step 1: Write the failing test**

```ts
/**
 * The shared model, handed out in proportion to stake — and handed out exactly as before when nobody staked.
 *
 *   node --test --import tsx test/runtime-stake-order.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Runtime } from '../src/runtime.js';
import { StakeFairQueue } from '../src/stake-fair-queue.js';

test('without a scheduler the order is arrival order, exactly as before', async () => {
  const runtime = new Runtime({ api: 'http://unused' } as never);
  const order: string[] = [];
  await Promise.all(['a', 'b', 'c'].map((id) =>
    runtime.exclusive('chat', async () => { order.push(id); })));
  assert.deepEqual(order, ['a', 'b', 'c']);
});

test('with a scheduler, the bigger stake gets more of a contended queue', async () => {
  const weights: Record<string, number> = { big: 10, small: 1 };
  const scheduler = new StakeFairQueue({ weightOf: (a) => weights[a] ?? 0, weightFloor: 0.01, now: () => Date.now() });
  const runtime = new Runtime({ api: 'http://unused' } as never, undefined, scheduler);
  const served: string[] = [];
  const work = [
    ...Array.from({ length: 10 }, () => 'small'),
    ...Array.from({ length: 10 }, () => 'big'),
  ].map((address) => runtime.exclusive('chat', async () => { served.push(address); }, { address }));
  await Promise.all(work);
  const bigInFirstTen = served.slice(0, 10).filter((s) => s === 'big').length;
  assert.ok(bigInFirstTen >= 7, `expected the 10x stake to dominate the front of the queue, got ${bigInFirstTen}/10`);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test --import tsx test/runtime-stake-order.test.ts`
Expected: FAIL — `Runtime` takes two constructor arguments, `exclusive` has no `address` option.

- [ ] **Step 3: Implement**

Add `address?: string` to the waiter record and to `serial`/`exclusive`/`exclusiveTry` options. In `serial`, after pushing the waiter, call `this.scheduler?.admit({ priority, seq, address: address ?? 'anonymous', cost })`. Replace the body of `pump()`:

```ts
private pump(): void {
  if (this.active || !this.waiters.length) return;
  const next = this.scheduler
    ? this.scheduler.take(this.waiters)!
    : this.waiters.sort((a, b) => a.priority - b.priority || a.seq - b.seq)[0];
  this.waiters.splice(this.waiters.indexOf(next), 1);
  this.active = true;
  next.start();
}
```

`cost` is `max_tokens` for chat and `1` for everything else; the caller passes it through the same options object.

- [ ] **Step 4: Run it and watch it pass**

Run: `node --test --import tsx test/runtime-stake-order.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Run the whole suite — this is the task's real gate**

Run: `npm test`
Expected: 321 pass / 3 skip as before, plus the new tests. `queueState()` and `test/cluster.test.ts` both read the waiter list; if either changed behaviour, the scheduler leaked outside its class and the change is wrong.

- [ ] **Step 6: Build the weight source and connect it**

Create `src/stake-weight-source.ts` exporting `stakeWeightFrom(ledger: DepositLedger): (address: string) => number`, converting `depositedShareOf` from `bigint` share units to a `number` weight by dividing by 10^18 (precision loss is irrelevant to a ratio). Construct the `StakeFairQueue` in `src/server.ts` only when the `deposits` block is configured, so a node without deposits behaves exactly as it does today.

- [ ] **Step 7: Commit**

```bash
git add src/runtime.ts src/stake-weight-source.ts test/runtime-stake-order.test.ts src/server.ts
git commit -m "The shared model's queue is divided by stake; with no stake configured, it is divided as before

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 11: `queue_too_deep` and honest queue reporting

**Files:**
- Modify: `src/openai-surface.ts`
- Test: `test/openai-queue-limits.test.ts`

Under WFQ a small share means waiting longer, never being refused, so there is no "your share is too low" error. A request is refused only when the node cannot honestly promise to run it.

- [ ] **Step 1: Write the failing test** — a request whose estimated wait at the caller's share exceeds the bound gets `429` with `code: "queue_too_deep"` and a body carrying `share`, `position` and `retry_after`; a caller with no deposit past the free bucket gets `429 quota_exhausted` with the existing `quota_reset` field.
- [ ] **Step 2: Run it and watch it fail.**
- [ ] **Step 3: Implement.** Estimated wait is `sum(cost of entries ahead) / weight(caller)`; the bound comes from config with a default of 120 s.
- [ ] **Step 4: Run it and watch it pass.**
- [ ] **Step 5: Fill in `share_of_active` on `GET /v1/account`** from `scheduler.activeShareOf(address)`, and update `test/openai-account.test.ts` to assert it is a number in `[0, 1]`.
- [ ] **Step 6: Commit.**

---

## Phase E — The other two modalities

### Task 12: STT — Qwen3-ASR behind `/v1/audio/transcriptions`

**Files:**
- Modify: `src/openai-surface.ts`, `deploy/` (a compose service for the second vLLM)
- Test: `test/openai-transcriptions.test.ts`

vLLM serves Qwen3-ASR on the OpenAI transcription endpoint directly, so this backend is a second vLLM container and a proxy route — no new serving code.

- [ ] **Step 1: Bring the backend up.** Add a compose service pinned to GPU 5 serving `Qwen/Qwen3-ASR-1.7B` on port 8100, following the flags and comments in `/mnt/newdata/qwen3.8/serve.sh` for this host's A100s. Verify by hand: `curl -F file=@fixtures/hello.wav -F model=qwen3-asr localhost:8100/v1/audio/transcriptions`.
- [ ] **Step 2: Write the failing test** — a multipart POST to `/v1/audio/transcriptions` with a fixture wav returns `{ text: string }`; a missing file is `400`; an unknown model is `404 model_not_found`.
- [ ] **Step 3: Run it and watch it fail.**
- [ ] **Step 4: Implement the route** — multipart passthrough to the backend's upstream, admitted through the transcription modality's own queue (cost = audio seconds). Do not route it through the LLM's shared lease; it is a different GPU.
- [ ] **Step 5: Run it and watch it pass.**
- [ ] **Step 6: Commit.**

### Task 13: Image — Qwen-Image-2512 behind `/v1/images/generations`

**Files:**
- Create: `deploy/image-sidecar/` (a small `diffusers` FastAPI server), `src/openai-surface.ts` route
- Test: `test/openai-images.test.ts`

vLLM cannot serve diffusion models, so this is the one new serving process in the plan.

- [ ] **Step 1: Write the sidecar** — FastAPI exposing `POST /v1/images/generations` taking `{ model, prompt, n, size, response_format }` and returning `{ created, data: [{ b64_json }] }`, loading `Qwen/Qwen-Image-2512` in bf16 on GPU 6. Verify by hand with `curl` before writing any node code.
- [ ] **Step 2: Write the failing test** — the node route returns OpenAI's image shape; `n > 4` is `400`; the backend being down is `503 backend_unavailable`.
- [ ] **Step 3: Run it and watch it fail.**
- [ ] **Step 4: Implement the route**, admitted through the image modality's queue with cost `steps × n`.
- [ ] **Step 5: Run it and watch it pass.**
- [ ] **Step 6: Commit.**

---

## Phase F — The TypeScript SDK

### Task 14: `@ainize/sdk`

**Files:**
- Create: `sdk/typescript/package.json`, `sdk/typescript/src/connect.ts`, `sdk/typescript/test/connect.test.ts`

**Interfaces:**
- Produces: `connectAinize(nodeUrl: string, opts: { privateKey?: string; apiKey?: string }): Promise<OpenAI>` — the same contract as the Python `connect()`, returning a real `openai` client.

- [ ] **Step 1: Write the failing test** — mirrors `sdk/python/tests/test_connect.py` assertion for assertion: the returned object is an `OpenAI`, its `baseURL` ends in `/v1`, a completion round-trips, a stream yields `chat.completion.chunk`, and passing neither key throws an error naming both options.
- [ ] **Step 2: Run it and watch it fail.**
- [ ] **Step 3: Implement** using `viem`'s `signMessage` (already a dependency after Task 7) against the same `/v1/auth/*` contract.
- [ ] **Step 4: Run it and watch it pass.**
- [ ] **Step 5: Commit.**

### Task 15: The end-to-end check

**Files:**
- Create: `e2e/stake-to-completion.test.ts`

One test that walks the whole claim, driven by the real `openai` npm client against a real node:

- [ ] **Step 1:** Credit a deposit for a test address by feeding a synthetic log through `DepositWatcher` with an injected `readLogs`.
- [ ] **Step 2:** `connectAinize()` with that address's key.
- [ ] **Step 3:** Run a completion through the stock client and assert on its content.
- [ ] **Step 4:** Assert `GET /v1/account` reports the deposit and a `share_of_active` above zero.
- [ ] **Step 5:** Run it, then run `npm test` whole.
- [ ] **Step 6:** Commit, and update `README.md` with the five-line quickstart this test just proved.

---

## Self-review

**Spec coverage.** §1 allocation → Tasks 9, 10, 11. §2 surface → Tasks 1, 2, 3, 4, 12, 13; the model table → Tasks 4, 12, 13; authentication → Tasks 2, 3. §3 deposit ledger → Tasks 6, 7; required config with no default → Task 7 Step 5. §4 SDKs → Tasks 5, 14; "depositing is not done by the SDK" → Task 5 (`deposit_address`/`await_deposit` only). §5 errors → Task 11; `backend_unavailable` → Tasks 4, 13. §6 testing → the three named suites are Tasks 6, 9 and 15. §7 out of scope → no task touches bridging, withdrawals, a registry, yield distribution, or `/api/chat`.

**Gap found and closed.** The spec says queues are per modality; Task 1 gives each backend a `concurrency` but nothing named the per-modality queues. Tasks 12 and 13 now say explicitly that transcription and image are admitted through their own queues and must not take the LLM's shared lease.

**Type consistency.** `depositedShareOf` returns `bigint` everywhere (Tasks 6, 7, 8, 10); it is converted to `number` in exactly one place, `stakeWeightFrom` (Task 10 Step 6), and serialised as a decimal string in exactly one place, `GET /v1/account` (Task 8 Step 3). `StakeFairEntry` has the same four fields in Tasks 9 and 10. `connect()` (Python) and `connectAinize()` (TypeScript) take the same two options and return a real OpenAI client in both.

**Ordering.** Phases A and B deliver the stated goal — `import ainize`, then an OpenAI call — before any chain code exists, so the thing being built is demonstrable from Task 5 onward rather than at the end.
