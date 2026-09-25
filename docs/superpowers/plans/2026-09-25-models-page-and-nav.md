# Models page and nav restructure — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put the models a node serves in the menu, let a visitor press them without a key, hand them the code — and take three record-browsing entries out of the top navigation.

**Architecture:** The node grows one public listing route and two free-tier relays that reuse `/api/chat`'s existing hourly allowance. The web app's `/api/*` catch-all already forwards anything the node adds, so no web route is needed. A new `/models` screen reads the listing, drives the relays, and renders the same call as copyable code. The two navigations change together, which `test/nav-parity.test.ts` enforces.

**Tech Stack:** Node: TypeScript, Express, `node:test` + `tsx`, zod. Web: Next.js, React, RTK Query, styled-components, `node:test` + `tsx`.

**Spec:** `ainize-node/docs/models-page-and-nav-design.md` — read it before Task 1; the plan argues from it.

## Global Constraints

- **Two repositories.** Node work is in `/mnt/newdata/gov/kpi/repos/ainize-node`, web work in `.../ainize-web`. Each has its own test command and its own commits.
- **Node tests:** `node --test --import tsx test/<name>.test.ts`, flat in `test/`, kebab-case, `node:assert/strict`.
- **Web tests:** same runner, `test/<name>.test.ts`. There is **no React renderer in this suite** — web tests assert over sources, data shapes and pure helpers, never rendered components.
- **Do not add to `src/api.ts`** (2,900 lines) or `src/openai-surface.ts` beyond what the spec names. New node routes go in their own file.
- **Identifiers are grep-unique**: `publicModelList`, `freeTierTranscribe`, `modelsPageCodeSnippet` — never `list`, `handler`, `snippet`.
- **Web copy goes through i18n.** Every visible string is a key in `src/i18n/pages/*.ts` with `ko` and `en`. A literal in a component is a bug.
- **`ainize-web/docs/` is inlined into the site** by `scripts/gen-inline.mjs` — never put a plan or spec there.
- **`npm run gen` after touching `docs/`**, and `npm run gen:check` must pass.
- **The free tier is not `/v1` with auth removed.** `/api/*` routes are the visitor's door; `/v1` is the program's. They stay separate files and separate limits.
- **Commit after every task**, ending with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

---

## Task 1: The node says what it serves, in public

**Files:**
- Create: `ainize-node/src/public-models-route.ts`
- Test: `ainize-node/test/public-models-route.test.ts`
- Modify: `ainize-node/src/server.ts` (mount it)

**Interfaces:**
- Consumes: `InferenceBackendRegistry` from `./inference-backends.js`.
- Produces: `function publicModelsRouter(deps: { registry: InferenceBackendRegistry | null; probe: (upstream: string) => Promise<boolean> }): Router` mounting `GET /api/models`, answering `{ object: 'list', data: PublicModelCard[] }` where `PublicModelCard = { id: string; modality: 'chat' | 'transcription' | 'image'; available: boolean }`.

- [ ] **Step 1: Write the failing test**

```ts
/**
 * What a node will tell anybody about what it serves.
 *
 * `/v1/models` keeps requiring a key, because that is what the LLM API specifies and a node that stopped
 * needing one would stop being portable. This answers a different question — *what does this node serve?* —
 * asked by a page that has no key and no visitor to authenticate. The list is not secret: anybody holding a
 * free-tier key sees exactly the same thing.
 *
 *   node --test --import tsx test/public-models-route.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { InferenceBackendRegistry } from '../src/inference-backends.js';
import { publicModelsRouter } from '../src/public-models-route.js';

const LLM = { id: 'llm', modality: 'chat' as const, upstream: 'http://10.0.0.5:8000', models: ['qwen2.5-7b-instruct'], concurrency: 1 };
const STT = { id: 'stt', modality: 'transcription' as const, upstream: 'http://10.0.0.5:8100', models: ['qwen3-asr'], concurrency: 4 };

async function listFrom(registry: InferenceBackendRegistry | null, probe = async () => true) {
  const app = express();
  app.use(publicModelsRouter({ registry, probe }));
  const server = app.listen(0);
  const port = (server.address() as { port: number }).port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/models`);
    return { status: res.status, body: await res.json() as { object: string; data: { id: string; modality: string; available: boolean }[] } };
  } finally { server.close(); }
}

test('a configured node lists its models with their modality', async () => {
  const { status, body } = await listFrom(new InferenceBackendRegistry([LLM, STT]));
  assert.equal(status, 200);
  assert.equal(body.object, 'list');
  assert.deepEqual(body.data.map((m) => [m.id, m.modality]).sort(),
    [['qwen2.5-7b-instruct', 'chat'], ['qwen3-asr', 'transcription']]);
});

test('a node serving nothing answers an empty list, not 404', async () => {
  const { status, body } = await listFrom(null);
  assert.equal(status, 200, 'a 404 is indistinguishable from a node too old to have this route');
  assert.deepEqual(body.data, []);
});

test('the upstream address is never in the answer', async () => {
  const { body } = await listFrom(new InferenceBackendRegistry([LLM, STT]));
  const json = JSON.stringify(body);
  assert.ok(!json.includes('10.0.0.5'), 'the model server is an internal address on every real deployment');
  assert.ok(!json.includes('8000'));
});

test('a backend that is not answering is listed as unavailable, not hidden', async () => {
  const { body } = await listFrom(new InferenceBackendRegistry([LLM, STT]), async (upstream) => upstream.endsWith('8000'));
  const byId = Object.fromEntries(body.data.map((m) => [m.id, m.available]));
  assert.equal(byId['qwen2.5-7b-instruct'], true);
  assert.equal(byId['qwen3-asr'], false, 'hiding it would look like a node that never offered it');
});

test('a probe that throws is an unavailable backend, not a failed request', async () => {
  const { status, body } = await listFrom(new InferenceBackendRegistry([LLM]), async () => { throw new Error('ECONNREFUSED'); });
  assert.equal(status, 200);
  assert.equal(body.data[0].available, false);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd ainize-node && node --test --import tsx test/public-models-route.test.ts`
Expected: FAIL — `Cannot find module '../src/public-models-route.js'`.

- [ ] **Step 3: Implement**

```ts
/**
 * `GET /api/models` — what this node serves, for anybody who asks.
 *
 * `/v1/models` requires a key by design. This does not, because it answers a different question: not "let me
 * use a model" but "what is here?" — asked by a page with no visitor to authenticate. The answer is public
 * information; the only thing withheld is the upstream address, which is internal on every real deployment.
 *
 * Availability is probed rather than assumed, and a backend that is down is listed as unavailable rather than
 * omitted. Omitting it would look identical to a node that never offered it, which is the wrong thing to tell
 * somebody deciding whether to wait or go elsewhere.
 */
import { Router } from 'express';
import type { InferenceBackendRegistry, InferenceModality } from './inference-backends.js';

export interface PublicModelCard {
  id: string;
  modality: InferenceModality;
  available: boolean;
}

/** How long a probe result is reused. Long enough that a page load is one probe per backend, short enough to notice a restart. */
export const MODEL_PROBE_TTL_MS = 15_000;

export interface PublicModelsDeps {
  /** Null when this node has no `backends` block — it then serves no models over the API. */
  registry: InferenceBackendRegistry | null;
  probe: (upstream: string) => Promise<boolean>;
}

export function publicModelsRouter(deps: PublicModelsDeps): Router {
  const router = Router();
  const cache = new Map<string, { at: number; up: boolean }>();

  const availability = async (upstream: string): Promise<boolean> => {
    const seen = cache.get(upstream);
    if (seen && Date.now() - seen.at < MODEL_PROBE_TTL_MS) return seen.up;
    let up = false;
    try { up = await deps.probe(upstream); } catch { up = false; }
    cache.set(upstream, { at: Date.now(), up });
    return up;
  };

  router.get('/api/models', async (_req, res) => {
    const registry = deps.registry;
    if (!registry) { res.json({ object: 'list', data: [] }); return; }
    const data: PublicModelCard[] = [];
    for (const modality of ['chat', 'transcription', 'image'] as const) {
      for (const backend of registry.backendsFor(modality)) {
        const available = await availability(backend.upstream);
        // Model ids only. `backend.upstream` is deliberately not spread in.
        for (const id of backend.models) data.push({ id, modality, available });
      }
    }
    res.json({ object: 'list', data });
  });

  return router;
}

/** The default probe: the backend's own model list, which every one of them serves. */
export async function probeBackend(upstream: string): Promise<boolean> {
  const res = await fetch(`${upstream}/v1/models`, { signal: AbortSignal.timeout(3000) });
  return res.ok;
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `node --test --import tsx test/public-models-route.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Mount it**

In `ainize-node/src/server.ts`, beside the `openaiSurfaceRouter` mount, add — note it mounts **whether or not** `backends` is configured, so an unconfigured node answers `[]` rather than 404:

```ts
app.use(publicModelsRouter({
  registry: cfg.backends?.length
    ? new InferenceBackendRegistry(cfg.backends.map((b) => ({ ...b, concurrency: b.concurrency ?? 1 })))
    : null,
  probe: probeBackend,
}));
```

The registry is constructed twice now — once here and once for the `/v1` surface. Lift it to a single `const registry = …` above both and pass it to each; two registries built from one config would be two things to keep in step.

- [ ] **Step 6: Run the whole node suite**

Run: `npm test`
Expected: the existing count plus 5, no previously-passing test failing.

- [ ] **Step 7: Commit**

```bash
git add src/public-models-route.ts test/public-models-route.test.ts src/server.ts
git commit -m "A node will tell anybody what it serves

/v1/models keeps requiring a key, because that is what the LLM API
specifies. This answers a different question — what is here? — asked by a
page with no visitor to authenticate, and the answer is public: anybody with
a free-tier key sees the same list.

A node with no backends answers an empty list rather than 404, which would be
indistinguishable from a node too old to have the route. A backend that is
down is listed as unavailable rather than omitted, because omitting it looks
identical to never having offered it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 2: Free-tier transcription and image, on the allowance that already exists

**Files:**
- Create: `ainize-node/src/free-tier-routes.ts`
- Test: `ainize-node/test/free-tier-routes.test.ts`
- Modify: `ainize-node/src/server.ts`

**Interfaces:**
- Consumes: `InferenceBackendRegistry`, `ModalityGate` from `./modality-gate.js`, and the market's quota helpers (`market.chatQuota`, `market.visitorId`, `market.refundChatQuota`) used by `/api/chat`.
- Produces: `function freeTierRouter(deps: { registry: InferenceBackendRegistry | null; market: Market; gates: Map<string, ModalityGate> }): Router` mounting `POST /api/transcribe` and `POST /api/image`.

Read `src/api.ts`'s `/api/chat` handler first — specifically how it takes `browserId(req, res)` and `market.visitorId('ip:' + req.ip)`, checks with `market.chatQuota(bucket, LIMIT, 3600_000, true)` before doing work, and calls `market.refundChatQuota(bucket)` when the work fails. These routes use the same two buckets so a visitor cannot get three separate allowances by changing modality.

- [ ] **Step 1: Write the failing test**

```ts
/**
 * The visitor's door to the two models that had none.
 *
 * `/api/chat` already lets a signed-out visitor reach the language model on an hourly allowance. Transcription
 * and image generation had no equivalent, so a browser playground for them would have meant the site holding
 * one key on behalf of every visitor — with everyone's usage indistinguishable from everyone else's.
 *
 * These are NOT `/v1` with the authentication removed. `/v1` is what a program calls with a key and a deposit
 * behind it; this is the door somebody presses once to see whether it works. Separate routes mean the free tier
 * can be tightened without touching the paid surface.
 *
 *   node --test --import tsx test/free-tier-routes.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Start a node with a stub transcription and image backend, as test/openai-transcriptions.test.ts does.

test('a visitor with no key can transcribe', async () => {
  const form = new FormData();
  form.set('model', 'qwen3-asr');
  form.set('file', new Blob([wavBytes()], { type: 'audio/wav' }), 'hello.wav');
  const res = await fetch(`${url}/api/transcribe`, { method: 'POST', body: form });
  assert.equal(res.status, 200);
  assert.equal((await res.json() as { text: string }).text, 'hello from the audio');
});

test('a visitor with no key can generate an image', async () => {
  const res = await post('/api/image', { model: 'qwen-image-2512', prompt: 'a red square' });
  assert.equal(res.status, 200);
  assert.equal((await res.json() as { data: unknown[] }).data.length, 1);
});

test('the free image route caps harder than /v1 does', async () => {
  // A visitor pressing a button must not be able to occupy a GPU for a minute.
  const many = await post('/api/image', { model: 'qwen-image-2512', prompt: 'x', n: 4 });
  assert.equal(many.status, 400, 'n is capped at 1 here; /v1 allows 4');
  const slow = await post('/api/image', { model: 'qwen-image-2512', prompt: 'x', steps: 60 });
  assert.equal(slow.status, 400, 'steps are capped below /v1 here');
});

test('the three modalities share one allowance, so switching does not reset it', async () => {
  // Spend the chat allowance, then ask for an image from the same browser.
  for (let i = 0; i < CHAT_TRIES_PER_HOUR + 1; i++) await post('/api/chat', chatBody);
  const res = await post('/api/image', { model: 'qwen-image-2512', prompt: 'x' });
  assert.equal(res.status, 429);
  const body = await res.json() as { error?: { code?: string }; quota_reset?: number };
  assert.ok(body.quota_reset, 'the visitor is told when it refills, not only that it is gone');
});

test('a failed generation gives the allowance back', async () => {
  // With the backend down, the try must not be spent: the visitor got nothing.
  imageDown = true;
  try {
    const before = await remainingAllowance();
    await post('/api/image', { model: 'qwen-image-2512', prompt: 'x' });
    assert.equal(await remainingAllowance(), before);
  } finally { imageDown = false; }
});

test('an unknown model is 404, not routed to whatever this node has', async () => {
  const res = await post('/api/image', { model: 'dall-e-3', prompt: 'x' });
  assert.equal(res.status, 404);
});

test('a node with no backends answers 503 rather than crashing', async () => {
  // Started without a `backends` block.
  const res = await post('/api/image', { model: 'anything', prompt: 'x' });
  assert.equal(res.status, 503);
});
```

Fill the harness (`url`, `post`, `wavBytes`, the stub servers, `imageDown`) by copying `test/openai-transcriptions.test.ts` and `test/openai-images.test.ts` — they already start a node with stub backends, and `wavBytes()` is written there.

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test --import tsx test/free-tier-routes.test.ts`
Expected: FAIL — 404 on `/api/transcribe`.

- [ ] **Step 3: Implement**

`freeTierRouter` mirrors the `/v1` handlers in `openai-surface.ts` with three differences, each of which is the reason the file is separate:

1. No bearer middleware. The caller is a browser, identified for quota purposes by `browserId(req, res)` and `req.ip`, exactly as `/api/chat` does.
2. Both buckets are checked **before** any work and refunded when the work fails, so a visitor is never charged for an answer they did not get.
3. Lower caps: `FREE_IMAGE_MAX_N = 1`, `FREE_IMAGE_MAX_STEPS = 20`. Export both, so the page can say what they are rather than discovering them through a 400.

Requests are admitted through the **same** `ModalityGate` instances the `/v1` routes use — passed in, not constructed here. Two gates over one GPU would each think they owned it.

- [ ] **Step 4: Run it and watch it pass**

Run: `node --test --import tsx test/free-tier-routes.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Mount it, sharing the gates**

In `src/server.ts`, build the gates once and pass the same map to both `openaiSurfaceRouter` and `freeTierRouter`. Move the gate construction out of `openai-surface.ts` into the server if that is what it takes — but do not construct a second set.

- [ ] **Step 6: Run the whole node suite**

Run: `npm test`
Expected: no previously-passing test failing. In particular `test/openai-transcriptions.test.ts` and `test/openai-images.test.ts` must still pass — they exercise the gates that are now shared.

- [ ] **Step 7: Commit**

```bash
git add src/free-tier-routes.ts test/free-tier-routes.test.ts src/server.ts src/openai-surface.ts
git commit -m "A visitor can try the other two models without a key

/api/chat already gave a signed-out visitor the language model on an hourly
allowance. Transcription and image had no equivalent, so a browser playground
would have meant the site holding one key for every visitor, with everybody's
usage indistinguishable from everybody else's.

These are not /v1 with the auth taken off. /v1 is what a program calls with a
key and a deposit behind it; this is the door somebody presses once. Separate
routes mean the free tier can be tightened without touching the paid surface,
and somebody who outgrows it is pointed at a different thing rather than the
same thing with a limit lifted.

All three modalities share one allowance, so switching does not reset it, and
a failed generation gives the try back — the visitor got nothing.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 3: The web app can read the model list

**Files:**
- Modify: `ainize-web/src/api/types.ts`, `ainize-web/src/api/api.ts`
- Test: `ainize-web/test/models-api.test.ts`

**Interfaces:**
- Produces: `type PublicModelCard = { id: string; modality: 'chat' | 'transcription' | 'image'; available: boolean }`, `type ModelsResponse = { object: 'list'; data: PublicModelCard[] }`, and `useModelsQuery()` from the RTK Query slice.

- [ ] **Step 1: Write the failing test**

```ts
/**
 * The shape the page is built on, pinned where it crosses the repository boundary.
 *
 * The node and the web app are released separately, so this type is a contract between two things that can
 * move independently. A test that asserts the parse is what stops a field rename in the node from becoming a
 * blank page here.
 *
 *   node --test --import tsx test/models-api.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseModelsResponse, modelsByModality } from '../src/api/models';

test('a node answer parses into cards', () => {
  const parsed = parseModelsResponse({ object: 'list', data: [{ id: 'qwen3-asr', modality: 'transcription', available: true }] });
  assert.deepEqual(parsed, [{ id: 'qwen3-asr', modality: 'transcription', available: true }]);
});

test('an empty list is a node that serves nothing, not a failure', () => {
  assert.deepEqual(parseModelsResponse({ object: 'list', data: [] }), []);
});

test('a malformed answer is an empty list rather than a crash', () => {
  assert.deepEqual(parseModelsResponse(null), []);
  assert.deepEqual(parseModelsResponse({ data: 'nonsense' }), []);
});

test('an unknown modality is dropped rather than rendered as a broken card', () => {
  const parsed = parseModelsResponse({ object: 'list', data: [
    { id: 'ok', modality: 'chat', available: true },
    { id: 'future', modality: 'video', available: true },
  ] });
  assert.deepEqual(parsed.map((m) => m.id), ['ok'], 'a newer node may serve a modality this page cannot drive');
});

test('cards group by modality in the order the page shows them', () => {
  const grouped = modelsByModality([
    { id: 'i', modality: 'image', available: true },
    { id: 'c', modality: 'chat', available: true },
    { id: 't', modality: 'transcription', available: false },
  ]);
  assert.deepEqual(grouped.map((g) => g.modality), ['chat', 'transcription', 'image']);
});
```

- [ ] **Step 2: Run it and watch it fail** — module not found.

- [ ] **Step 3: Implement** `src/api/models.ts` with `parseModelsResponse` and `modelsByModality`, then add the endpoint to the RTK slice beside the others:

```ts
models: builder.query<ModelsResponse, void>({ query: () => '/models' }),
```

- [ ] **Step 4: Run it and watch it pass** — 5 tests.

- [ ] **Step 5: Commit.**

---

## Task 4: The nav changes, in both navigations at once

**Files:**
- Modify: `ainize-web/src/components/ui/Header.tsx`, `ainize-web/src/screens/LandingPage.tsx`, `ainize-web/src/i18n/pages/common.ts`, `ainize-web/test/nav-parity.test.ts`
- Test: the existing `test/nav-parity.test.ts`

This task has no new page yet — `/models` is added to both navs and routed to a placeholder screen in Task 5. Doing the nav first means the parity test guards every later step.

- [ ] **Step 1: Update the parity test's named list**

In `test/nav-parity.test.ts`, the test *"the three destinations this drifted on before are in both"* lists `/docs`, `/network`, `/ledger`. Replace `/network` and `/ledger` with `/models`, and record why in the test's own words:

```ts
for (const [to, why] of [
  ['/docs', 'Finding 69 — documentation was on every page but the front one'],
  ['/models', 'what this node serves, and the reason the menu had room for it'],
] as const) {
```

Then add the two removals to the allowed-difference maps — with their reasons, which the last test in that file enforces:

```ts
const ALLOWED_ONLY_IN_HEADER: Record<string, string> = {
  '/dashboard': 'the node runner\'s screen, shown only to an owner; the landing has no session yet',
};
// /network and /ledger are no longer in either nav: they moved into /account, and keep their public URLs.
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd ainize-web && node --test --import tsx test/nav-parity.test.ts`
Expected: FAIL — `/models is missing from the shared header`.

- [ ] **Step 3: Change both navigations**

In `Header.tsx`: remove the `/chat`, `/network` and `/ledger` items, add `<NavItem to="/models">{t('nav.models')}</NavItem>` after Agents.
In `LandingPage.tsx`: the same three removals and the same addition, using `NavLink`.

Leave `/chat?teach=1` and `/teach` alone — those are the teaching door, not the live test.

- [ ] **Step 4: Rename the knowledge entry**

In `src/i18n/pages/common.ts`:

```ts
'nav.explore': { ko: '지식', en: 'Knowledge' },
'nav.models': { ko: '모델', en: 'Models' },
```

And `landing.nav.explore` likewise, wherever it is defined.

- [ ] **Step 5: Run it and watch it pass**

Run: `node --test --import tsx test/nav-parity.test.ts` then `npm test`
Expected: parity passes; the whole suite passes.

- [ ] **Step 6: Check nothing else linked to what was removed**

Run: `grep -rn 'to="/chat"' src/ --include=*.tsx`
Expected: the landing hero's `SecondaryPill` and the patch pages still link there — they must keep working, because only the menu entry was removed. If any of them broke, the change went too far.

- [ ] **Step 7: Commit.**

---

## Task 5: The Models page

**Files:**
- Create: `ainize-web/src/screens/ModelsPage.tsx`, `ainize-web/src/screens/models/modelsPageCodeSnippet.ts`, `ainize-web/src/i18n/pages/models.ts`
- Test: `ainize-web/test/models-snippet.test.ts`
- Modify: `ainize-web/src/App.tsx` (route)

**Interfaces:**
- Consumes: `useModelsQuery`, `parseModelsResponse`, `modelsByModality` (Task 3).
- Produces: `function modelsPageCodeSnippet(opts: { language: 'python' | 'typescript' | 'curl'; modality: 'chat' | 'transcription' | 'image'; model: string; nodeUrl: string; prompt?: string }): string`.

The snippet builder is a pure function in its own file, which is the only part of this page the test suite can reach — and it is the part worth testing, because a snippet that does not run is worse than no snippet.

- [ ] **Step 1: Write the failing test**

```ts
/**
 * The code somebody copies off the page.
 *
 * This is the part of the page that leaves with the visitor, so it is the part that must be right. A snippet
 * that does not run is worse than no snippet: it is a promise the site made and the caller discovers broken in
 * their own editor.
 *
 *   node --test --import tsx test/models-snippet.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modelsPageCodeSnippet } from '../src/screens/models/modelsPageCodeSnippet';

const base = { model: 'qwen2.5-7b-instruct', nodeUrl: 'https://node.example', prompt: 'hello' } as const;

test('the python snippet installs, connects and calls', () => {
  const s = modelsPageCodeSnippet({ ...base, language: 'python', modality: 'chat' });
  assert.match(s, /pip install ainize/);
  assert.match(s, /import ainize/);
  assert.match(s, /ainize\.connect\("https:\/\/node\.example"/);
  assert.match(s, /model="qwen2\.5-7b-instruct"/);
});

test('the model and the node URL are the ones on screen, not placeholders', () => {
  for (const language of ['python', 'typescript', 'curl'] as const) {
    const s = modelsPageCodeSnippet({ ...base, language, modality: 'chat' });
    assert.ok(s.includes('qwen2.5-7b-instruct'), `${language} lost the model id`);
    assert.ok(s.includes('https://node.example'), `${language} lost the node URL`);
    assert.ok(!s.includes('…') && !s.includes('YOUR_'), `${language} still has a placeholder`);
  }
});

test('each modality calls its own method', () => {
  assert.match(modelsPageCodeSnippet({ ...base, language: 'python', modality: 'chat' }), /chat\.completions\.create/);
  assert.match(modelsPageCodeSnippet({ ...base, language: 'python', modality: 'transcription' }), /audio\.transcriptions\.create/);
  assert.match(modelsPageCodeSnippet({ ...base, language: 'python', modality: 'image' }), /images\.generate/);
});

test('the curl snippet targets /v1 and carries a key header', () => {
  const s = modelsPageCodeSnippet({ ...base, language: 'curl', modality: 'chat' });
  assert.match(s, /https:\/\/node\.example\/v1\/chat\/completions/);
  assert.match(s, /Authorization: Bearer/);
});

test('a prompt with a quote does not break the snippet it is pasted into', () => {
  const s = modelsPageCodeSnippet({ ...base, language: 'python', modality: 'chat', prompt: 'she said "hi"' });
  assert.ok(!s.includes('content": "she said "hi""'), 'an unescaped quote would make the snippet a syntax error');
  assert.match(s, /she said/);
});

test('a prompt containing a newline stays inside the string literal', () => {
  const s = modelsPageCodeSnippet({ ...base, language: 'python', modality: 'chat', prompt: 'line one\nline two' });
  assert.ok(!/content": "line one\nline two/.test(s), 'a raw newline would end the literal');
});
```

- [ ] **Step 2: Run it and watch it fail** — module not found.

- [ ] **Step 3: Implement the snippet builder.** Escape the prompt with `JSON.stringify` for every language — Python, TypeScript and shell all accept a JSON string literal, and hand-rolled escaping is how the quote test fails later.

- [ ] **Step 4: Run it and watch it pass** — 6 tests.

- [ ] **Step 5: Build the page.** Three sections, in the order the spec names them:

  1. **What this node serves** — a card per model from `useModelsQuery`, grouped by modality. Empty list renders the "this node serves no models over the API" state with the config that changes it; a query error renders "this node is not answering" and no model list. These are the states production is in today, so build them first and look at them.
  2. **Try it** — the input each modality needs, posting to `/api/chat`, `/api/transcribe` or `/api/image`. Show the remaining allowance before it runs out. On 429, show `quota_reset` and link to `/docs/how-to/call-the-model`.
  3. **Take the code** — `modelsPageCodeSnippet` over the current model and prompt, three language tabs, one copy button.

  Every string through `src/i18n/pages/models.ts`, with `ko` and `en`.

- [ ] **Step 6: Route it.** In `src/App.tsx`, beside the other `Layout` routes:

```tsx
<Route path="/models" element={<Layout><ModelsPage /></Layout>} />
```

- [ ] **Step 7: Verify in a browser.** Run `npm run build && PORT=24902 npm start`, open `/models`, and check all three empty states by pointing the node URL at something unreachable, at a node with no `backends`, and at a working one. A page whose failure states were never looked at has not been built.

- [ ] **Step 8: Run the whole web suite and commit.**

---

## Task 6: `/account` gains the two sections that left the menu

**Files:**
- Modify: `ainize-web/src/screens/AccountPage.tsx`, `ainize-web/src/i18n/pages/*` (the account dictionary)
- Test: `ainize-web/test/account-sections.test.ts`

- [ ] **Step 1: Write the failing test** — over the pure selector, not the component:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { salesForAddress } from '../src/screens/account/salesForAddress';

const rows = [
  { seller: '0xAAA', buyer: '0xBBB', amount: '10', at: 3 },
  { seller: '0xCCC', buyer: '0xAAA', amount: '5', at: 2 },
  { seller: '0xaaa', buyer: '0xDDD', amount: '7', at: 1 },
];

test('a sale is one this address sold, not one it bought', () => {
  assert.deepEqual(salesForAddress(rows, '0xAAA').map((r) => r.buyer), ['0xBBB', '0xDDD']);
});

test('the address matches however either side is cased', () => {
  assert.equal(salesForAddress(rows, '0xaaa').length, 2);
});

test('sales come back newest first, which is the order the section reads', () => {
  assert.deepEqual(salesForAddress(rows, '0xAAA').map((r) => r.at), [3, 1]);
});

test('an address that has sold nothing gets an empty list, not every row', () => {
  assert.deepEqual(salesForAddress(rows, '0xZZZ'), []);
});
```

- [ ] **Step 2: Run it and watch it fail.**
- [ ] **Step 3: Implement `salesForAddress`,** then add two sections to `AccountPage`: **Network** (peer summary, link to `/network`) and **Sales history** (`salesForAddress` over the ledger query, link to `/ledger`). Summaries with a link through — not copies of those pages.
- [ ] **Step 4: Run it and watch it pass.**
- [ ] **Step 5: Confirm the public pages still answer signed out.** Run the built site, sign out, and open `/network` and `/ledger` directly. Both must render. The footer links to them must still be there. This is the check that the menu change did not become an access change.
- [ ] **Step 6: Run the whole web suite and commit.**

---

## Task 7: Point the documentation at the page, and the page at the documentation

**Files:**
- Modify: `ainize-web/docs/en/how-to/call-the-model.md`, `ainize-web/src/screens/ModelsPage.tsx`
- Regenerate: `npm run gen`

- [ ] **Step 1:** Add a line at the top of the how-to linking to `/models` — "to try these without writing anything, the models page does it in the browser".
- [ ] **Step 2:** From the Models page, link to the how-to for the parts the page does not cover: deposits, limits, errors.
- [ ] **Step 3:** `npm run gen && npm run gen:check`.
- [ ] **Step 4:** Run the whole web suite, build, and commit.

---

## Task 8: The production node actually serves this

The spec notes production answers 502 on `/api/info` and `/api/auth/me`, which means the site's node is unreachable — so every state this page renders on production today is an error state.

- [ ] **Step 1: Find out what the site's node is.** `AINIZE_NODE_URL` in the web app's environment on the deploy host. Report what it points at and whether it answers.
- [ ] **Step 2: Report, do not guess.** If the node is down or has no `backends` block, say so with what was checked. Do not edit production configuration as part of this plan — the empty states built in Task 5 are what makes that safe to leave until somebody decides.
- [ ] **Step 3:** Write down the `backends` block that would make the site serve models, in `ainize-node/deploy/` beside `deposits.example.json`, so applying it is a decision and not an investigation.

---

## Self-review

**Spec coverage.** §1 public listing → Task 1. §2 free-tier relays → Task 2. §3 the page's three parts → Tasks 3 and 5. §4 the menu → Task 4, including that `/network`, `/ledger` and `/chat` keep their routes (Task 4 Step 6, Task 6 Step 5). §5 `/account` sections → Task 6. Errors and empty states → Task 5 Step 5 and Step 7. Testing → the named suites are Tasks 1, 2, 3, 5 and 6. Out of scope — no task signs in from the playground, deposits from the browser, or merges the three signed-in pages.

**Gap found and closed.** The spec says the free-tier routes share the `/v1` routes' gates; nothing said who constructs them. Task 2 Step 5 now says explicitly that the gates are built once in the server and passed to both, because two gates over one GPU would each think they owned it.

**Type consistency.** `PublicModelCard` has the same three fields in Tasks 1, 3 and 5. `modality` is `'chat' | 'transcription' | 'image'` everywhere, matching `InferenceModality` in the node. `modelsPageCodeSnippet` takes the same options object in its test and its use.

**Ordering.** Task 4 puts the nav parity test in front of every later change, so a page added without a menu entry — or a menu entry without a page — fails before it is committed.
