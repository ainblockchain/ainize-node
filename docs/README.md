# `docs/` — how Ainize documentation is written, built and kept true

Two different kinds of writing, and the difference now decides which REPOSITORY a file goes in, not only which
directory. The packages were split in September 2026; the published pages went with the thing that builds them.

| | Published developer documentation | Internal working documents |
|---|---|---|
| Lives in | **[ainize-web](https://github.com/ainblockchain/ainize-web)**, at `docs/en/**` and `docs/ko/**` | **here** — `ainize-node/docs/*.md`, `*.json`, `*.html` |
| Audience | someone using Ainize | someone building Ainize |
| Listed in a `_toctree.json` | yes — that is what "published" means | never |
| Rendered at `/docs` on the web | yes | no |
| Rule | every page is finished; if a topic can't be documented truthfully, it stays out of the tree | anything goes; these are design specs and review data |

Hugging Face keeps design and internals in the repo but out of the published toctree. Ainize does the same. A `page:`
entry that points at an internal document is a build error, not a shortcut.

**Why the published half moved.** `ainize-web/src/pages/docs/pages.ts` inlines every page with
`import.meta.glob` at build time, and it is the only thing that reads them — the node serves no markdown. When
the glob reached across the old monorepo it matched nothing after the split, the build stayed green, and `/docs`
shipped empty; `docs-shell.test.ts` now asserts a floor on the page count so that cannot happen quietly again.

**One seam is left open, and it is worth knowing about.** `../scripts/docs-gen.mjs` still generates five of those
pages out of `src/openapi.ts`, `@ainize/core`'s config schema and the CLI — all of which live here or next door,
while its output belongs in ainize-web. It writes into a sibling checkout now rather than a sibling package, and
`npm test` no longer runs `docs:check` alongside it, so a change to the API no longer fails a build when the
reference page goes stale. Re-generating is a deliberate step until that is wired up again.

**This file is part map, part plan, and it says which is which.** Built and running today: the loader, the renderer,
the toctrees, the chrome, the `/docs/*` route, the five generated reference pages and the index — [§2](#2-how-markdown-becomes-docs)
and [§4](#4-what-is-generated-and-from-what) describe things you can open. Planned and not yet written: the twelve
guide pages of [§5.2](#52-the-guide-half--twelve-pages-in-four-modes), the subset-and-link checker of
[§2.2](#22-rendering--a-small-in-repo-renderer-no-new-dependency), and the machine twin of [§2.5](#25-the-machine-twin--planned-not-built).
Every future tense in this file is load-bearing: where it says *will*, the thing does not exist yet.

---

## 1. Source of truth

Documentation is **markdown files in this directory**. There is no second copy.

- On disk and on GitHub, `docs/en/get-started/quickstart.md` reads correctly as a plain markdown file.
- On the web, `/docs/get-started/quickstart` renders that same file.
- Reference material that describes flags, endpoints, config keys or error codes is **generated from the code that
  defines them** ([§4](#4-what-is-generated-and-from-what)). Hand-written command tables are forbidden: the repo already
  has three copies of the CLI reference and they have already drifted apart ([§8](#8-defects-these-pages-must-not-repeat), H1).

---

## 2. How markdown becomes `/docs`

### 2.1 Loading — Vite `import.meta.glob`, no new dependency

`ainize-web/src/pages/docs/pages.ts` holds one literal glob:

```ts
const PAGES = import.meta.glob('../../../../../docs/{en,ko}/**/*.md', {
  query: '?raw', import: 'default', eager: true,
}) as Record<string, string>;
```

**Verified, not assumed.** A scratch Vite 8.2.2 project laid out at the same depth as `packages/web` was built and
served against a `docs/` tree outside its root:

- `npx vite build` → both `docs/get-started/install.md` and `docs/ko/get-started/install.md` were inlined, with the
  repo-relative path preserved as the record key and Korean UTF-8 intact.
- `npx vite` (dev) → the glob rewrote to `/@fs/…/docs/ko/get-started/install.md?import&raw` and the dev server served
  it. `server.fs.allow` defaults to the npm-workspace root, and `docs/` is inside it, so no config change is needed.

The glob is imported only from inside the `/docs` route, and `DocsPage` is already `lazy()` in `App.tsx:30`. Vite
therefore puts the markdown in the docs chunk, not the main bundle — a visitor who never opens `/docs` never downloads
it. Budget: at ~18 pages of prose this is tens of KB gzipped. **If the tree passes ~40 pages, switch to `eager: false`**
(one chunk per page) and generate a headings index for search; do not let the docs chunk grow unbounded.

### 2.2 Rendering — a small in-repo renderer, no new dependency

`ainize-web/src/components/docs/markdown.ts` (markdown → token tree) and `Markdown.tsx` (tokens → React elements,
styled with the existing theme tokens).

**Why not `marked` / `markdown-it` / `react-markdown`:**

1. `package.json` is shared with three other live workflows. Every dependency added here is a merge conflict and a
   lockfile churn for all of them.
2. Every one of those libraries emits an HTML string, which means `dangerouslySetInnerHTML`, which means a sanitizer
   (`dompurify`) as a *second* dependency — because generated reference pages interpolate `description` strings out of
   `openapi.ts`. Emitting React elements has no HTML-injection path at all, so the sanitizer question never arises.
3. We write the markdown. A general-purpose CommonMark implementation is solving a problem we do not have.

**The supported subset** — chosen because it is exactly what the pages below need, and all of it renders identically on
GitHub:

ATX headings `#`–`####` with GitHub-compatible slugs · paragraphs · fenced code with an info string · inline code ·
`**bold**` / `_italic_` · links · unordered and ordered lists, one level of nesting · GFM pipe tables ·
`> [!NOTE|TIP|IMPORTANT|WARNING|CAUTION]` alerts · plain blockquotes · `---` rules · YAML-ish frontmatter (flat
`key: value` only).

**Deliberately unsupported:** raw HTML blocks, images, footnotes, reference-style links, task lists, nested
blockquotes, setext headings. A page that needs one of these is a page that should be rewritten.

> [!IMPORTANT]
> **A subset renderer is only safe if something enforces the subset, and today nothing does.** `npm run docs:check` is
> `scripts/docs-gen.mjs --check`: it catches a *generated* page drifting from its source, and nothing else.
> `scripts/docs-check.mjs` — which would parse every file with the same parser and fail on a construct outside the
> subset, an internal link whose target page or `#anchor` does not exist, a `_toctree.json` entry with no file, or a
> file in `docs/{en,ko}` that no toctree lists — **does not exist yet**. `buildSite()` in `docsTree.ts` already computes
> `missing`, `orphans` and `mislabelled`; the missing piece is a script that reads them and exits non-zero. Until it
> exists, "in nav means finished" is a rule people keep, not a rule the build keeps. Writing it is the natural companion
> commit to the guide half, because twelve new pages of cross-links are exactly what it is for.

### 2.3 Navigation is a separate file from the pages

`docs/en/_toctree.json` and `docs/ko/_toctree.json` — JSON, not YAML, so both Vite and plain `node` read it with zero
parser dependency (`resolveJsonModule` is already on in `packages/web/tsconfig.json`).

```jsonc
[ { "group": "Get started",
    "pages": [ { "page": "index",                "title": "Ainize" },
               { "page": "get-started/install",  "title": "Installation" } ] } ]
```

Keeping the tree out of the pages is what lets navigation be translated, reordered and validated without touching a
word of content — and it is the natural place to enforce **in nav = finished**.

### 2.4 URLs, chrome, and the one shared-file edit

- `/docs` · `/docs/<group>/<page>` · `/docs/ko/<group>/<page>` · `#anchor`. English and current are the defaults, so a
  bare URL is pasteable. A version segment can slot in later without breaking these.
- Left sidebar from the toctree; on-this-page rail at **H2 + H3 only**, page title first; prev/next at the foot showing
  the **neighbour's title**, walking the flattened tree across group boundaries; copy button per fenced block.
- No breadcrumbs, no "was this helpful", no comments, no version selector.
- Search is a client-side filter over page title, group, summary and headings — honest at this size, and it needs no
  index-building step.

`ainize-web/src/App.tsx` is shared with three other workflows, and the change there was **one line** — already made
and already in `App.tsx`:

```tsx
<Route path="/docs/*" element={<Layout><DocsPage /></Layout>} />
```

React Router 7 matches a splat against the empty remainder, so `/docs/*` serves `/docs` too. **The guide half needs no
further edit to any shared file**: twelve new pages are twelve new markdown files and two toctree entries each. If a
page seems to need a component, a route or a renderer feature, that is a signal the page is shaped wrong — say so
rather than growing the shared surface.

### 2.5 The machine twin — planned, not built

`scripts/docs-gen.mjs` **will also** copy `docs/{en,ko}/**/*.md` into `packages/web/public/docs/` and write
`packages/web/public/docs/llms.txt` (a flat list of `[Title](<page>.md)`). Vite copies `public/` into `dist/`, and the
running nodes serve `packages/web/dist` directly, so `/docs/get-started/quickstart.md` is fetchable by an agent.
`packages/web/public/` already exists (it holds `static/`), so `docs/` under it is a free slot; add it to `.gitignore`
— it is generated output, and the originals are already in git.

---

## 3. Two languages

**Side-by-side trees**: `docs/en/**` and `docs/ko/**`, each with its own toctree. Chosen over per-page frontmatter
because it is the only option where a Korean reader browsing the repo on GitHub sees a Korean tree.

**Nav and chrome are always Korean.** Sidebar group names, page titles, prev/next labels, the TOC-rail heading, the
search placeholder — all through `ainize-web/src/i18n/pages/docs.ts` and the `ko` toctree. Korean is written as
Korean, never transliterated English.

**A Korean reader never lands on a silently-English page.** A page not yet translated keeps its entry in the Korean
toctree with `"untranslated": true`. The renderer shows the English body under a Korean banner that says the page is
not yet translated, why, and links to the English original. Content is better than a blank stub, but it is never
unannounced.

**Staleness — the gap Hugging Face has and we close.** Per-language directories are honest about *missing*
translations and blind to *stale* ones; HF's own Korean quicktour still teaches a framework the English one dropped.
So each translated page carries in frontmatter the sha256 of the English file it was translated from:

```yaml
---
title: 둘러보기
source: en/get-started/quickstart.md
source_sha256: <64 hex>
---
```

`docs/ko/index.md` already carries both fields. The checker that recomputes the hash and fails when the English page
has moved on is the same unwritten `scripts/docs-check.mjs` as in [§2.2](#22-rendering--a-small-in-repo-renderer-no-new-dependency),
so today the frontmatter is a promise a human keeps. Write it with the guide half; twelve pairs of pages is where
hand-kept promises start failing quietly.

**Translation order for the guide half.** Korean is not a second pass over the whole tree, it is part of finishing each
page — an English page whose Korean twin is missing is a page half done. But some pages are worth more in Korean than
others, so the order is: Get started first (a reader who cannot install cannot start), then Concepts (prose, and the
part a reader most wants in their own language), then How-to, then Tutorials — longest, most command output, and the
commands themselves are English either way. A page that genuinely cannot be translated in a pass keeps its Korean
toctree entry with `"untranslated": true` and the reader gets the English body under a Korean banner rather than a
404. **That flag is a debt entry, not a destination**: every use of it belongs in the workflow's report with the reason.

---

## 4. What is generated, and from what

One generator, `scripts/docs-gen.mjs`. Run it with `--check` and it regenerates into memory, compares byte-for-byte,
prints a unified diff of the first divergence and exits 1. Wire as `npm run docs:check` and run it in CI, so a flag that
changes without its docs is a red build rather than a stale page.

| Generated page | Source of truth | How it is read | Verified |
|---|---|---|---|
| `docs/en/reference/cli.md` | `ainize-cli/src/bin.ts` | TypeScript AST (`ts.createSourceFile`) | ran it: **81** `.command()`, **144** `.option()`, **36** `.example()` recovered with their object literals intact — exact `describe`, `type`, `default`, `choices`, `demandOption`, `alias` |
| `docs/en/reference/http-api.md` | `buildOpenApi()` in `ainize-node/src/openapi.ts` | `tsx` imports the **TS source directly** | ran it: **99 paths / 114 operations / 8 tags / 28 schemas** |
| `docs/en/reference/schemas.md` | same | same | one page of component schemas, `$ref`-linked from the endpoint page |
| `docs/en/reference/config.md` | `configKeys()`, `configField()`, `configFieldType()` in `ainize-core/src/config-schema.ts` + `defaultConfig()` | `tsx` imports the source | ran it: **105 keys** enumerated with per-key human types |
| `docs/en/reference/errors.md` | `new TeachError(...)` / `new HttpError(...)` literals across `ainize-node/src` | TypeScript AST | status + code + sentence are string literals at every call site |

Both toolchain pieces are **already present**: `typescript@5.9.3` is a root devDependency; `tsx@4.23.13` is hoisted from
`packages/web`. **No new npm dependency is required for any part of this design** — not for loading markdown, not for
rendering it, not for generating reference, not for reading the toctree.

Notes that will bite whoever writes the generator:

- `ainize-node/src/openapi.ts` has **zero imports**, which is why `tsx` can load it straight from source with no build
  step. Do not make the generator depend on `dist/` — a stale `dist` is exactly the drift this is meant to end
  ([§8](#8-defects-these-pages-must-not-repeat), H7).
- `ainize-cli/src/bin.ts` ends in a top-level `await cli.parseAsync()`. The yargs instance **cannot** be imported and
  introspected. AST or nothing. (The AST route also needs no edit to `bin.ts`, which another workflow owns.)
- `ainize-node/src/teach-dataset.ts` contains a raw NUL byte, so `grep` calls it binary and silently matches nothing.
  The generator and any CI check must read files with `fs.readFileSync`, or use `grep -a`, or lose 716 lines in silence.
- Every generated file opens with a banner naming its source file and the regeneration command, and every generated
  page is cross-linked to its hand-written guide and back.
- Generated pages are **English only**. The Korean toctree lists them with Korean titles and the untranslated banner,
  which is truthful: the flag names, types and descriptions are English in the source code they come from.

---

## 5. The tree

The site has two halves and they were built in that order. The **reference half** exists: the index page and five
generated pages, six files, live on `/docs` today. The **guide half** is what this section plans — twelve hand-written
pages that take a reader from "what is this" to "I published a knowledge and somebody else bought it".

Reference answers *what is `--ledger`'s default*. It cannot answer *why would I run a verifier*, and no amount of
generating will make it. That is the gap.

### 5.1 What is on the site today

| Slug | Title | Written by |
|---|---|---|
| `index` | Ainize | hand · what the product is, the three surfaces, the vocabulary |
| `reference/cli` | CLI reference | generated · 25 top-level commands, 69 runnable leaves |
| `reference/http-api` | HTTP API reference | generated · 114 operations on 99 paths, 10 tag groups |
| `reference/schemas` | Schemas | generated · 28 component schemas |
| `reference/config` | Configuration reference | generated · 105 keys, the env overrides, the default file |
| `reference/errors` | Error codes | generated · 41 codes in 92 messages, and how a throw becomes a status |

A developer arriving today can look up `--effort`'s three values and cannot find out what effort *is*.

### 5.2 The guide half — twelve pages in four modes

Four modes, four sidebar groups, and the mode is the group. This is the discipline the whole plan rests on: a page
belongs to exactly one of them and does exactly that one job.

- **Get started** is *paced*. It assumes nothing, states every precondition before the step that needs it, and its
  success condition is a working node, not comprehension.
- **Tutorials** are *paced too, but narrower*: one whole task, start to finish, with a result you can point at.
- **Concepts** are *unpaced*. No commands to run — they are readable away from a keyboard and they end in a position:
  what the design buys, and what it costs.
- **How-to** is *direct*. It assumes the vocabulary the concepts pages taught and answers one operator question with
  the shortest correct path.

**Needs a model** below is the honest column, and it is why the order of writing matters. A node without a serving
model still does most of this product: it publishes, announces, attests, reaches quorum, sells over x402, settles on
the ledger, accepts a dataset and parses it. What it cannot do is *answer* — so a page marked yes has at least one
step that no pass can verify until a model runtime is free ([§5.3](#53-what-was-run-to-write-this-plan)). Those steps
still get written, marked in the source with `<!-- unverified: needs a model runtime -->`, and listed in the
workflow's report.

#### Get started — the ten-minute path

Two pages, read in order. Nothing else in the tree is a prerequisite for them.

| Slug | Title | Covers | Needs a model | Drawn from |
|---|---|---|---|---|
| `get-started/install` | Installation | Node 24 and where the requirement is declared; clone → `npm install` → `npm run build` → `npm link -w packages/cli`, and `npx ainize` as the no-link alternative inside the repo; that **there is no npm-registry package** and `npm install -g ainize` cannot work ([§8](#8-defects-these-pages-must-not-repeat), H2); what `AINIZE_HOME` is and what `ainize init` writes into it; one verification line at the end. | no | root `package.json` (`engines`), `ainize-cli/package.json`, `ainize-cli/src/context.ts`, [`reference/config`](en/reference/config.md) |
| `get-started/quickstart` | Quickstart | The contract first — *run a node, load knowledge, watch the answer change*. `ainize init` → point `runtime.api` at your own serving model → `ainize start -d` → `ainize status`, reading the `runtime` line as the go/no-go gate → `ainize login` → join a peer or seed local knowledge → `ainize chat --list` → `ainize chat <id> "<question>"` for the before/after → `ainize use <id>`. Real pasted output for every step; the two model steps flagged. Ends with which group to read next and why. | **yes** — `chat` and the before/after are the last two steps | `ainize-cli/src/bin.ts`, `ainize-node/src/api.ts` (`POST /api/chat`), `ainize-node/src/runtime.ts` |

#### Tutorials — one whole task each

Three, because there are three whole tasks a newcomer actually wants: make knowledge from a file, make knowledge from
a conversation, use somebody else's. The first two are the two doors of teach mode and they are genuinely different
experiences, not one page with a tab.

| Slug | Title | Covers | Needs a model | Drawn from |
|---|---|---|---|---|
| `tutorials/teach-from-a-file` | Teach from a file of questions | `teach.enabled` is **off by default** and how to turn it on (and that the node keeps the value it started with, so it must be restarted); `ainize teach status` as the precondition check — trainer state, publish mode, per-key and per-IP quotas, the three effort presets; the five accepted formats and the column-mapping escape hatches; `ainize teach dataset upload`, and reading the *lines that will not train* table row by row — `empty`, `duplicate`, `conflict`, `too_long`, `blocked`, `over_cap`; fixing the file and re-uploading onto the same dataset; `ainize teach train --effort … --wait` and what each stage means; the checks block — taught vs side effects — and `TeachChecks.ok` as the gate that decides whether it may be published at all; what `--no-check` costs you. | **yes** — everything from `teach train` on | `ainize-node/src/teach.ts`, `ainize-node/src/teach-datasets.ts`, `ainize-core/src/config.ts` (`DEFAULT_TEACH_CONFIG`), [`reference/schemas`](en/reference/schemas.md) (`TeachJob`, `TeachChecks`, `TeachDataset`) |
| `tutorials/teach-in-chat` | Teach by correcting the model | The browser door: `<node>/chat?teach=1`, no account. The **teaching key** minted on first use — the one thing a reader can lose irrecoverably, so it is stated before the first correction, not after; where it is kept (`<home>/teaching-key.json`) and how the CLI reads it back (`--key`, `--key-file`, `AINIZE_TEACH_KEY`). Collecting corrections up to `teach.factsPerJob`; the lesson page at `/teach/lesson/<jobId>`; following the same lesson from the CLI with `ainize teach status <lesson-url> --key-file …`; keeping it private versus publishing, and what `teach.publish: review` means for how long that takes. | **yes** — a correction is a correction *to an answer* | `ainize-node/src/teach.ts`, `ainize-node/src/teach-auth.ts`, `ainize-web/src/pages/ChatPage.tsx`, `ainize-web/src/pages/TeachLessonPage.tsx` |
| `tutorials/buy-and-apply` | Use knowledge someone else published | Finding it — `ainize patch ls --q`, and `/explore` for the same catalog in a browser. Reading `ainize patch get`: price, verification count, lineage, address-set overlaps. Trying before buying: the free live test, **20 per visitor per hour**, and the `429 quota_chat` when it runs out. Then `ainize patch buy` with its x402 trace line by line, or `ainize use` as the one-liner — including why `use` refuses a patch that is not LISTED, which is the first error most readers will hit. Then `patch apply`, `patch stack`, `patch remove --cascade`, and the `503` + `retry-after: 30` that means another process holds the shared runtime. | **yes** — the live test and every `apply` | `ainize-core/src/x402.ts`, `ainize-node/src/market.ts`, `ainize-node/src/runtime.ts`, `ainize-node/src/api.ts` |

#### Concepts — four ideas you cannot proceed without

Four, and not one more. Each is an idea a reader hits in the first hour and cannot route around: what the thing being
traded *is*, what the network's promise about it *is worth*, where the money goes, and how it moves.

| Slug | Title | Covers | Needs a model | Drawn from |
|---|---|---|---|---|
| `concepts/knowledge-patch` | What a knowledge patch is | The `.npz` as `addrs` / `before` / `after` over the serving model's memory table. Why **a row is a touched address, not a sentence**, and why "4 rows" and "1 fact" are both true of the same file. Why it can be applied to a running model with no restart: a file-based hook writes the `after` values into the live table, and the journal records what was displaced so `remove` can put it back. Why comparison is bf16-exact. What this design costs: the patch is bound to one model id, and two patches that touch the same addresses conflict — which is what the overlap table on `patch get` is for. Why it is not fine-tuning, stated as a difference in kind rather than a boast. | no | `ainize-core/src/npz.ts`, `ainize-core/src/lineage.ts` (`bf16Bits`), `ainize-node/src/runtime.ts`, `PatchAnchor` in `ainize-core/src/types.ts` |
| `concepts/verification` | What "verified" proves — and what it does not | An attestation is one node's run, signed and on the record. Quorum counts **independent** attestations only: the author's own never counts (`verifier.allowSelfAttest` is false and the node refuses the write outright), so a network of two can never list anything and the default `verifier.quorum: 2` means *two nodes besides the publisher*. Executed versus `hash-only`, and the rule that decides everything: a patch that declares benchmark samples is never listed on integrity checks alone. `REJECTED` when failures reach quorum. A challenge holds an entry off sale **only until a verifier re-runs it** — and the honest wording of that, because nothing is escrowed, transferred or slashed anywhere in this product ([§8](#8-defects-these-pages-must-not-repeat), H6). Ends on the position: verified means somebody independent loaded it and scored it, not that it is right, so live-test it with your own questions. | no | `ainize-core/src/catalog.ts`, `ainize-node/src/verifier.ts`, [`reference/config`](en/reference/config.md) (`verifier.*`) |
| `concepts/lineage-and-royalties` | Lineage and royalties | Parents are a relation on the anchor, frozen at publish. The split in two passes: a lineage pool of `market.royaltyShare` (0.3) divided evenly among the **unique ancestor authors**, each author's slice divided again across their own anchors and carved for that anchor's contributors; then the seller keeps the remainder, out of which a data provider is paid `teach.contributorShare` (0.7 by default) — so "70 %" and "30 %" are percentages of different things, which is the sentence this page exists to get right. The depth-16 walk cap, the cycle guard, at most 4 contributors and Σ share ≤ 1. States plainly up front that **building on someone else's knowledge is off by default** (`teach.lineage: false`, H5), so today lineage is what `--parents` and `--contributor` record at publish, not something the teach pipeline produces. | no | `royaltySplit` in `ainize-core/src/catalog.ts`, `Contributor` in `ainize-core/src/types.ts`, `ainize-core/src/lineage.ts` |
| `concepts/payment` | Paying without an account | HTTP 402 as a quote, not an error: the node answers with `x-payment-required` carrying base64 requirements, the client retries the same URL with `X-PAYMENT`, and the 200 comes back with `x-payment-tx-hash`. The two schemes that exist — `local-credit`, an HMAC proof against one node's own credit book, and `ain-transfer`, a real transfer on the AIN chain — and how `market.currency` picks between `CREDIT` and `AIN`. Why the settle record on the ledger is the receipt and what it proves. That a sale only happens for an entry the catalog calls `sellable`, which is where this page hands back to verification. **USDC is not listed** even though a type allows it ([§8](#8-defects-these-pages-must-not-repeat), H4). | no | `ainize-core/src/x402.ts`, `ainize-node/src/market.ts`, `ainize-core/src/local-ledger.ts`, [`reference/schemas`](en/reference/schemas.md) (`X402Requirement`, `X402Payload`) |

#### How-to — the three operator questions

Direct, vocabulary assumed, one question each. These are the three that come up the moment a node stops being a toy:
other people cannot reach it, it has no price, and it will not list.

| Slug | Title | Covers | Needs a model | Drawn from |
|---|---|---|---|---|
| `how-to/reachable-node` | Run a node others can reach | `host` binds, `publicUrl` is what peers are told — the distinction that decides whether gossip works at all. Seeding peers with `--peer` at `init` or `start` versus `ainize peers add` later, and how to tell the difference between "not peered" and "peered and silent" from `ainize nodes`. Which of the four roles each job needs, and what dropping `serving` costs. Running detached: the pid file, `ainize logs -f --kind p2p`, and `ainize status --check` as the one line a monitor or a deploy script should call. | no | `ainize-node/src/server.ts`, `ainize-node/src/p2p.ts`, `ainize-cli/src/context.ts`, [`reference/config`](en/reference/config.md) |
| `how-to/price-knowledge` | Set a price and get paid | `market.defaultPrice` versus `--price`, and that **money is a decimal string everywhere**, never a JSON number. What `market.currency` settles as in each of its two values. Crediting a data provider with `--contributor addr:name:share`, what that share is a share *of*, and the ≤ 4 / Σ ≤ 1 rule the node enforces. Where the money then shows up: `ainize wallet` for balance and sales, `ainize payouts ls` for what is owed, and the settle record for the buyer's side. What can still be changed after an anchor is on the record and what cannot. | no | `ainize-node/src/market.ts`, `ainize-node/src/payouts.ts`, `validateContributors` in `ainize-core/src`, [`reference/cli`](en/reference/cli.md#ainize-publish) |
| `how-to/failed-verification` | When it will not list | Reading the evidence first: `ainize patch get` for the count, `ainize patch records` for who attested what and when. Then the three reasons an entry sits at `VERIFYING` and the different fix for each — no peer has a compatible model, the only attester is the author, or quorum needs more nodes than the network has. The grace window before a verifier gives up on a real run and falls back to `hash-only`, and why that fallback lists some patches and not others. `ainize patch challenge --reason` from the other side of the table: what it stops, what lifts it, and when superseding is the better move than arguing. | no | `ainize-node/src/verifier.ts`, `ainize-core/src/catalog.ts`, [`reference/errors`](en/reference/errors.md) |

**Twelve hand-written pages, eighteen in the tree.** Four of the twelve need a model runtime and eight do not, which
is also the order to write them in: the eight can be finished and verified today, and the four can be written today
and verified the first time the engine is free.

### 5.3 What was run to write this plan

None of the above is a guess about what the commands do. Three throwaway nodes were run on ports **3602 / 3612 / 3622**
with `runtime.api` and `runtime.hookApi` pointed at `http://127.0.0.1:9`, `runtime.repo` unset, and homes under a
scratch directory — never `node-a/b/c`, never the shared engine on `:8000`–`:8002`. All three were stopped afterwards.

What ran, and therefore what a page-writing pass can paste as real output:

| Ran for real | What it established |
|---|---|
| `init`, `config set/unset`, `start -d`, `status`, `stop`, `login`, `logs`, `nodes`, `peers`, `wallet`, `ledger ls`, `ledger verify` | The whole operator surface works with no model. `status` prints `runtime unavailable (serving API unreachable)` and everything else keeps working — which is exactly the shape the quickstart's go/no-go step needs. |
| `publish` (a synthetic 4-row `.npz` + a `bench.json`) | Registering and announcing knowledge **needs no runtime at all**. `how-to/price-knowledge` and most of `tutorials/teach-from-a-file`'s tail are fully verifiable today. |
| Two peer nodes attesting, reaching `2/2`, `LISTED` | Quorum is reachable without a model *for a patch that declares no benchmark samples* — the attestations come back `hash-only`. With samples declared it stays at `VERIFYING` for ever without a model. Both halves of that rule are what `concepts/verification` has to say. |
| `patch buy` over x402, `wallet` on both sides, `patch records` | The full payment chain settles with no model: `quorum → 402 → pay → settled → download`, seller `+2 CREDIT`, buyer `−2`, a `settle` record on all three ledgers. `concepts/payment` and the buy half of `tutorials/buy-and-apply` can carry a real trace. |
| `patch challenge --reason …` | The challenge records and propagates, and the CHALLENGED state is real — see H10 for what happened next. |
| `teach dataset upload` (with `teach.enabled` on) | Parsing, deduplication and the *lines that will not train* table are entirely model-free. The first half of `tutorials/teach-from-a-file` is verifiable today. |
| `patch verify` on the publisher's own node | Refused, by design: *"cannot verify your own knowledge … a self-check never counts toward the quorum"*. This is the sentence `concepts/verification` is built around, and it came from the program, not from reading the code. |
| `use` on an unverified patch | Refused with the verification count in the message — the precondition `tutorials/buy-and-apply` must state before the step, not after it fails. |

What could **not** run, and must therefore be written and flagged: `chat` in any mode, the before/after live test,
`teach train` on the real gradient backend, `patch apply` / `remove` / `stack` against a live table, and an *executed*
(non-`hash-only`) attestation.

One near-miss worth recording so the next pass does not mistake it for verification: with `teach.backend: "stub"` and
`AINIZE_TEACH_STUB_OFFLINE=1` the entire teach pipeline runs to completion without a GPU, and the node labels its own
output honestly — `(stub model) I do not know:` in the before column and `note: stub backend (offline) — checks were
simulated, not measured in a live model`. That is a good CI story and a bad documentation story. **Stub output must
never be pasted into a page as if it were a training run.**

### 5.4 Where each mode ends

The failure this shape is built to avoid is the page that starts as a tutorial, remembers a caveat, and ends as a
reference table nobody can follow. So each mode has an edge it does not cross:

A tutorial that needs to explain *why* links to the concept page and keeps walking. A concept page that finds itself
listing flags has drifted into reference and should link to the generated page instead. A how-to that has to teach a
word before it can be used is missing a link to the concept page that defines it. And Get started never sends the
reader anywhere mid-path — every precondition it needs is stated in it, before the step that needs it.

---

## 6. Authoring rules

1. **In the nav means finished.** No stubs, no lorem, no "TODO: document this". A topic that cannot be documented
   truthfully stays out of the toctree.
2. **Never document a command you have not run.** Paste the command and its real output into the same fenced block, the
   way the quickstart does. Never print a number the system did not measure.
3. **A step you could not run is written and marked, never dropped.** When the runtime a step needs is not available,
   write the step as it will be, put `<!-- unverified: needs a model runtime -->` on the line above it in the source,
   and list it in the workflow report so a later pass can execute it. Quietly ending a quickstart one step before the
   model answers is worse than an honest mark: it turns a gap in the environment into a gap in the product.
4. **If the code does not do what a page says, that is a defect to report**, not prose to soften.
5. **Callouts are GitHub alert syntax** (`> [!TIP]`, `> [!WARNING]`) so a page renders correctly in a GitHub blob view,
   in an editor preview, and on the site.
6. **Link between guide and reference in both directions.** A guide answers "how do I publish"; the reference answers
   "what does `--ledger` default to". Neither can do the other's job.
7. **One mode per page.** A tutorial that starts explaining the design should link to the concept page; a concept page
   that starts listing flags should link to the generated reference. See [§5.4](#54-where-each-mode-ends).
8. **Introduce a term before you use it, and link it to the page that defines it.** The first *quorum*, *anchor*,
   *attestation* or *patch* on a page is a link, not an assumption.
9. **Anchors are heading slugs.** Renaming a heading breaks inbound links, and nothing catches that yet
   ([§2.2](#22-rendering--a-small-in-repo-renderer-no-new-dependency)) — so grep for the old slug before renaming.
10. **Never hand-edit a generated file.** The banner says so and `npm run docs:check` enforces it.

---

## 7. The 24 internal files

All 24 files currently at the top level of `docs/` are internal — 7 design specs and 17 UX-review artefacts. There is no
developer documentation among them.

`lineage-teach-design.md` · `mcp-integration-design.md` · `p2p-compute-market-design.md` ·
`production-verification-plan.md` · `teach-mode-design.md` · `teach-mode-dataset-ux.md` · `teachable-dataset-design.md` ·
`ux-critique{,-2,-3,-4}.{md,json}` · `ux-critique-owner.json` · `ux-test-results{,-dataset}.{md,json}` ·
`ux-test-results.meta.json` · `ux-test-scenarios.{json,md,html}`

**They all belong in `docs/internal/`. Do not move them in the same commit as the new tree.**

The new tree lives under `docs/en/` and `docs/ko/`, so it collides with none of them. Building it is purely additive and
carries no risk. The move is a separate, later commit — because moving these files today breaks working code:

| What breaks | Where | Note |
|---|---|---|
| A **green test** | `ainize-mcp/test/skill.test.ts:106` — `readFileSync(join(repo, 'docs', 'ux-test-scenarios.json'))` | hard-coded, no fallback; the test fails immediately |
| A generator script | `scripts/render-ux-results.py:16,18,117,163` | four hard-coded `docs/…` paths, **no argv override** |
| A generator script | `scripts/render-ux-scenarios.py:17-19` | argv-overridable, but the defaults are hard-coded |
| `README.md` | 6 links into `docs/` | **owned by the landing-page workflow — coordinate before moving.** It is being edited live; the line numbers moved while this file was being written, so re-grep rather than trusting a citation |
| ~100 cross-references between the internal documents themselves | `docs/*.md`, `docs/*.json` | `lineage-teach-design.md` alone carries 27 |
| Scenario-id comments in tests | `packages/{core,node,mcp}/test/*.ts`, `ainize-node/e2e/playwright.config.ts` | comments only, but they will mislead |

A full `grep` before moving is the next agent's job; the list above is where to start, and the `README.md` row is the one
that needs another workflow's agreement rather than a `sed`.

---

## 8. Defects these pages must not repeat

Found while inventorying the surface. Each is a thing the current documentation asserts and the code does not do. They
are listed here so no page inherits them.

- **H1 — the hand-written CLI table is already stale.** `CLI_REFERENCE` (`ainize-node/src/openapi.ts:378-452`) is
  served at `GET /api/docs` and rendered by the current `DocsPage`. It misses `patch stack`, `patch apply --with-base`
  and `patch remove --cascade` — all added the same morning it was inventoried — plus `patch conflicts`, `patch records`,
  `patch get`, `patch import`, `keys rotate`, `dataset get`, `route` and `nodes`. This is precisely what
  [§4](#4-what-is-generated-and-from-what) exists to end.
- **H2 — `npm install -g ainize` cannot work, and one claim is still live.** `ainize-cli/package.json` is
  `"private": true`, and the name is unregistered: `npm view ainize version` → `E404` and
  `https://registry.npmjs.org/ainize` → HTTP 404 (both re-checked while writing this). The landing workflow has already
  fixed its two surfaces — the root `README.md` now says "there is no public npm package" and `LandingPage.tsx` no
  longer carries the line. **What remains is ours to fix:** `ainize-node/src/openapi.ts:379` still ships
  `install: ['npm install -g ainize', …]`, and that is exactly the string the current `/docs` page renders;
  `openapi.ts:162` repeats `npx ainize --help` inside the OpenAPI description. `npx ainize` resolves only inside the
  repo, through the workspace symlink `node_modules/.bin/ainize`. The install page documents the clone-and-link path,
  which is the only one that works, and says so.
- **H3 — `CanonicalRow.from` and `.replaces` are documented but nothing writes or accepts them** (`openapi.ts:36-37`).
  The serializer, the TS interface, the API row schema and `publishedRows` all carry exactly four fields. Keep them out
  of `file-formats`.
- **H4 — `USDC` is listed as a currency and nothing can settle in it.** `openapi.ts:13` and `types.ts:118` allow it;
  `config-schema.ts:118` restricts `market.currency` to `AIN|CREDIT` and x402 has only `ain-transfer` and `local-credit`.
  Do not list it.
- **H5 — the lineage API is documented as usable and is off by default.** `teach.lineage` defaults to `false` and the
  node answers `403 lineage_disabled` to any `base_ids`. The concept page must name the config key; there is no how-to
  guide until it is on by default.
- **H6 — the stake/bond story is dead but the fields survive.** `Attestation.stake`, `Challenge.stake` and
  `verifier.stake` are deprecated; nothing was ever escrowed, transferred or slashed. The honest mechanism is *a
  challenge takes it off sale until re-verified*. Every page inherits that wording.
- **H7 — `/docs` truth is currently per-node-build.** The page renders whatever the running node's build returns; a node
  serving 89 paths against a source that builds 99 shows a stale reference with no indication. Generating from source in
  CI removes this. If any part of the new `/docs` still reads `GET /api/docs` live, it must show the node's build stamp.
- **H8 — `grep` silently skips `ainize-node/src/teach-dataset.ts`** (raw NUL byte → treated as binary). Any CI check
  that greps `ainize-node/src` loses 716 lines without an error. Read files, or use `grep -a`.

The next three were found by running the product while writing [§5.3](#53-what-was-run-to-write-this-plan), not by
reading it. H9 and H10 are code defects and belong in the workflow report as well as here.

- **H9 — a `bench.json` whose `format` is a string is accepted at publish and then breaks `patch get` for ever.**
  `BenchmarkSpec.format` is `string[]` (`ainize-core/src/types.ts:33`), but `market.ts:352` only fills a default —
  `format: input.benchmark.format ?? ['template']` — and validates nothing. Publishing with `"format": "exact"`
  succeeded, announced, and anchored; `ainize patch get <id>` then died with
  `error: a.benchmark.format.join is not a function` (`ainize-cli/src/commands/patch.ts:65`), and since the anchor is
  on the record the entry can never be inspected from the CLI again. Reproduced twice: the same file with
  `"format": ["template"]` prints normally. The `--benchmark` help string — `{schema, queries, format, samples}` —
  does not say `format` is an array, so a reader following the reference writes the broken form first. **Fix the
  validation, not the docs**; until then no guide page may show a `bench.json` without the brackets.
- **H10 — a challenge against a patch that declares no benchmark samples clears itself.** `catalog.ts:150` holds a
  challenged entry "until a verifier re-runs it", and for a sample-less patch that re-run is a sha256 check that cannot
  fail. Observed: `patch challenge` was recorded at `11:32:14`, the challenger's own verifier re-attested `hash-only` at
  `11:32:15`, and the entry was back to `LISTED` before the next `patch ls`. So the dispute mechanism has real teeth
  only where verification is executed — which is the same boundary as H6, and `concepts/verification` must draw it
  rather than promise a challenge that holds.
- **H11 — this file described a checker that does not exist.** §2.2 and §3 asserted `scripts/docs-check.mjs` in the
  present tense; `npm run docs:check` is `docs-gen.mjs --check` and validates only the generated pages. Corrected in
  place above. It is listed here because it is the same failure mode as H1: a document asserting a mechanism nobody
  built, which is exactly what a reader cannot tell from the outside.

One correction to the brief while I am here: the web design system is a **single light palette**
(`ainize-web/src/theme/theme.ts`). There is no dark theme — only `components/public/Lifecycle.tsx` carries a local
`prefers-color-scheme` block. Docs pages use the same light theme as every other page.

---

## 9. What is deliberately not documented yet

Leaving a topic out is a decision, and each of these has a reason. Twelve pages that are finished are worth more than
forty that are started, so the cut had to be real: the guide half covers **one path taken twice** — make knowledge,
sell it; find knowledge, buy it — and everything that is not on that path waits. The eight rows added below are the
cuts this plan makes; the rest were already settled.

| Not documented | Why |
|---|---|
| **Knowledge branches** (`ainize branch`, `ainize route`, the `gateway` role) | Real, working, and off the path. A newcomer never meets a branch, and an operator who needs one has `--help` and the generated reference. It earns a how-to when somebody is running a gateway in anger. |
| **`ainize drive`** (aindrive: files and change history) | A separate product surface bolted to the node. Documenting it inside a marketplace guide would teach the reader that it is part of the loop, and it is not. |
| **`ainize chain`** (the local AIN docker chain) | It exists so `--ledger ain` has something to talk to on a developer machine. `deploy/README.md` owns host setup, and `concepts/payment` says what the AIN ledger *is* without teaching anyone to run one. |
| **The dataset market** (`ainize dataset get`, access levels, dataset licences) | The access levels and licences are wired and the walk is real, but the reader who needs them is building on someone else's knowledge — which is off by default (H5). It follows lineage, whenever lineage lands. |
| **A hand-written `file-formats` reference page** | An earlier draft of this plan listed one. It is the exact thing [§4](#4-what-is-generated-and-from-what) exists to stop multiplying — a hand-kept table of things the code defines. What a guide actually needs from it (the `.npz` members, the `bench.json` shape) belongs in `concepts/knowledge-patch`, where it is *explained* rather than tabulated, and the rest belongs in a generator when someone writes one. |
| **A separate "run a verifier" how-to** | Verifying is a role, not a job: `verifier` is on by default and `verifier.auto` runs the rounds. What an operator needs is on `how-to/reachable-node` (roles) and `how-to/failed-verification` (what the rounds decided). A third page would be two paragraphs and a link. |
| **A separate royalties/payouts operator page** | `ainize payouts` is one command with two subcommands and it belongs beside the price that produced the payout. It lives inside `how-to/price-knowledge`. |
| **Anything about MCP or the agent** | `ainize-mcp/**` is another session's ground in this workflow, and its own `README.md` (853 lines) plus `ainize-mcp/references/` (7 files) are already good developer documentation. A *Connect an agent* page linking to them is the right page and the wrong workflow. Flagged for whoever takes it: `ainize-mcp/references/cli.md` is a **third** hand-written CLI reference and should become a link into the generated one. |
| The P2P compute market | `p2p-compute-market-design.md` is an unimplemented design. Documenting it would advertise a product that does not exist. |
| `ainize-agent` (4 commands) | A demonstration harness for the x402 buyer loop, not a supported surface — and I have not run it. Add it when both are false. |
| Building on someone else's knowledge (lineage how-to) | Off by default and returns 403 (H5). Concept page yes, how-to guide no. |
| USDC, `CanonicalRow.from`/`.replaces`, stakes and bonds | H3, H4, H6 — the code does not do these things. |
| Versioned doc URLs and a version selector | Nothing released is worth pinning to yet. The URL shape leaves room for a version segment; add the selector when there are versions. |
| A product-selection hub page | HF needs one because it ships many products. Ainize is one product; that page would be a landing page with extra steps. |
| Framework/language tabs | There is no PyTorch/TF-style split. A CLI-vs-HTTP tab pair may earn its place later; the machinery is not worth building on spec. |
| Breadcrumbs, "was this helpful", comments, ratings | HF ships none of them. Sidebar and prev/next already locate the reader; feedback belongs where the fix lands. |
| Deployment and GPU host setup | `deploy/README.md` already covers it and is maintained next to the thing it describes. Link, do not copy. |
