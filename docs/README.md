# `docs/` — how Ainize documentation is written, built and kept true

This directory holds two different kinds of writing, and the difference decides where a file goes.

| | Published developer documentation | Internal working documents |
|---|---|---|
| Lives in | `docs/en/**`, `docs/ko/**` | `docs/internal/**` (today: `docs/*.md`, `docs/*.json`, `docs/*.html`) |
| Audience | someone using Ainize | someone building Ainize |
| Listed in a `_toctree.json` | yes — that is what "published" means | never |
| Rendered at `/docs` on the web | yes | no |
| Rule | every page is finished; if a topic can't be documented truthfully, it stays out of the tree | anything goes; these are design specs and review data |

Hugging Face keeps design and internals in the repo but out of the published toctree. Ainize does the same. A `page:`
entry that points at an internal document is a build error, not a shortcut.

**This file is the plan, not a report on finished work.** The tree below does not exist yet; the commits after this one
build it. What *is* settled — and verified against the running repo, see [§2](#2-how-markdown-becomes-docs) and
[§4](#4-what-is-generated-and-from-what) — is the mechanism, the i18n strategy, the generator set, and the page list.

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

`packages/web/src/pages/docs/pages.ts` holds one literal glob:

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

`packages/web/src/components/docs/markdown.ts` (markdown → token tree) and `Markdown.tsx` (tokens → React elements,
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
> A subset renderer is only safe if something enforces the subset. `scripts/docs-check.mjs` parses every file with the
> same parser and **fails** on: a construct outside the subset; an internal link whose target page or `#anchor` does not
> exist; a `_toctree.json` entry with no file; a file in `docs/{en,ko}` that no toctree lists. This is the mechanism that
> stops the renderer and the prose from silently drifting apart. It is the same idea as doc-builder erroring on a
> `local:` that points nowhere.

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

`packages/web/src/App.tsx` is shared with three other workflows. The change there is **one line**:

```diff
-                <Route path="/docs" element={<Layout><DocsPage /></Layout>} />
+                <Route path="/docs/*" element={<Layout><DocsPage /></Layout>} />
```

React Router 7 matches a splat against the empty remainder, so `/docs/*` serves `/docs` too. Re-read `App.tsx`
immediately before making this edit; keep it to this one hunk.

### 2.5 The machine twin

`scripts/docs-gen.mjs` also copies `docs/{en,ko}/**/*.md` into `packages/web/public/docs/` and writes
`packages/web/public/docs/llms.txt` (a flat list of `[Title](<page>.md)`). Vite copies `public/` into `dist/`, and the
running nodes serve `packages/web/dist` directly, so `/docs/get-started/quickstart.md` is fetchable by an agent.
`packages/web/public/` already exists (it holds `static/`), so `docs/` under it is a free slot; add it to `.gitignore`
— it is generated output, and the originals are already in git.

---

## 3. Two languages

**Side-by-side trees**: `docs/en/**` and `docs/ko/**`, each with its own toctree. Chosen over per-page frontmatter
because it is the only option where a Korean reader browsing the repo on GitHub sees a Korean tree.

**Nav and chrome are always Korean.** Sidebar group names, page titles, prev/next labels, the TOC-rail heading, the
search placeholder — all through `packages/web/src/i18n/pages/docs.ts` and the `ko` toctree. Korean is written as
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

`scripts/docs-check.mjs` recomputes it and fails when the English page has moved on. Fixing it is either a retranslation
or a deliberate hash bump — both are visible in review.

**Scope for this workflow:** Get started and Concepts are written properly in Korean (7 pages). Guides and Reference
ship with Korean nav titles and the untranslated banner. That is partial coverage, stated openly — HF ships 67 Korean
pages against 110 English ones and is better for saying so than for machine-translating the gap.

---

## 4. What is generated, and from what

One generator, `scripts/docs-gen.mjs`. Run it with `--check` and it regenerates into memory, compares byte-for-byte,
prints a unified diff of the first divergence and exits 1. Wire as `npm run docs:check` and run it in CI, so a flag that
changes without its docs is a red build rather than a stale page.

| Generated page | Source of truth | How it is read | Verified |
|---|---|---|---|
| `docs/en/reference/cli.md` | `packages/cli/src/bin.ts` | TypeScript AST (`ts.createSourceFile`) | ran it: **81** `.command()`, **144** `.option()`, **36** `.example()` recovered with their object literals intact — exact `describe`, `type`, `default`, `choices`, `demandOption`, `alias` |
| `docs/en/reference/http-api.md` | `buildOpenApi()` in `packages/node/src/openapi.ts` | `tsx` imports the **TS source directly** | ran it: **99 paths / 114 operations / 8 tags / 28 schemas** |
| `docs/en/reference/schemas.md` | same | same | one page of component schemas, `$ref`-linked from the endpoint page |
| `docs/en/reference/config.md` | `configKeys()`, `configField()`, `configFieldType()` in `packages/core/src/config-schema.ts` + `defaultConfig()` | `tsx` imports the source | ran it: **105 keys** enumerated with per-key human types |
| `docs/en/reference/errors.md` | `new TeachError(...)` / `new HttpError(...)` literals across `packages/node/src` | TypeScript AST | status + code + sentence are string literals at every call site |

Both toolchain pieces are **already present**: `typescript@5.9.3` is a root devDependency; `tsx@4.23.13` is hoisted from
`packages/web`. **No new npm dependency is required for any part of this design** — not for loading markdown, not for
rendering it, not for generating reference, not for reading the toctree.

Notes that will bite whoever writes the generator:

- `packages/node/src/openapi.ts` has **zero imports**, which is why `tsx` can load it straight from source with no build
  step. Do not make the generator depend on `dist/` — a stale `dist` is exactly the drift this is meant to end
  ([§8](#8-defects-these-pages-must-not-repeat), H7).
- `packages/cli/src/bin.ts` ends in a top-level `await cli.parseAsync()`. The yargs instance **cannot** be imported and
  introspected. AST or nothing. (The AST route also needs no edit to `bin.ts`, which another workflow owns.)
- `packages/node/src/teach-dataset.ts` contains a raw NUL byte, so `grep` calls it binary and silently matches nothing.
  The generator and any CI check must read files with `fs.readFileSync`, or use `grep -a`, or lose 716 lines in silence.
- Every generated file opens with a banner naming its source file and the regeneration command, and every generated
  page is cross-linked to its hand-written guide and back.
- Generated pages are **English only**. The Korean toctree lists them with Korean titles and the untranslated banner,
  which is truthful: the flag names, types and descriptions are English in the source code they come from.

---

## 5. The tree

Grouping follows the *object a node operator holds* rather than internal package names — the pattern HF uses for the
Hub (a platform) rather than for a library. "Get started" is first and "Reference" is last regardless.

Two jobs this shape has to do: **a cold reader gets a node answering a question inside ten minutes** (Get started, four
pages, read in order), and **a reader who knows the product finds a flag or an endpoint in two clicks** (sidebar group →
generated reference page, then Ctrl-F).

### Get started

Read front to back. This is the ten-minute path.

| Slug | Title | Path | Covers | Drawn from |
|---|---|---|---|---|
| `index` | Ainize | `docs/en/index.md` | What Ainize is in four sentences; the three surfaces (web, CLI, MCP) and who each is for; how to read these docs; the vocabulary you will meet. Card list of the groups below, each blurbed with the question a reader would actually type. | `README.md`, `packages/web/src/i18n/glossary.ts` (26 terms) |
| `install` | Installation | `docs/en/get-started/install.md` | Node 24 requirement; clone → `npm install` → `npm run build` → `npm link -w packages/cli`; the same one-line verification after each path; where `NGRAM_HOME` lives; **states plainly that there is no npm-registry package** and why. | root `package.json`, `packages/cli/package.json`, `packages/cli/src/context.ts` |
| `quickstart` | Quickstart | `docs/en/get-started/quickstart.md` | Three-bullet contract — *run a node, load knowledge, watch the answer change* — then `ainize init` → `start` → `seed` → `chat` before/after → `use`. Expected output shown inside each block, from a real run. Closes with Next-steps bullets naming the sidebar groups. | `packages/cli/src/bin.ts`, `packages/node/src/seed.ts`, `POST /api/chat` in `packages/node/src/api.ts` |
| `mcp` | Connect an agent | `docs/en/get-started/mcp.md` | The one `claude mcp add` line against your own node; the env vars that gate spending (`AINIZE_MCP_SESSION_BUDGET`, `MAX_PER_PURCHASE`, `ALLOW_PUBLISH`, `ALLOW_APPLY`); what the 20 tools can and cannot do without approval. Links to `packages/mcp/README.md` rather than restating it. | `packages/mcp/src/tools/{read,live,money,teach}.ts`, `packages/mcp/README.md`, `packages/mcp/src/context.ts` |

### Guides

Named for the thing you are holding when you need the page.

| Slug | Title | Path | Covers | Drawn from |
|---|---|---|---|---|
| `node` | Run a node | `docs/en/guides/node.md` | `init` options; `start`/`stop`/`status`/`logs`; roles (`seller`, `verifier`, `serving`, `gateway`); peers and gossip; ports and `publicUrl`; which commands work with no config; the node-URL precedence chain. | `packages/cli/src/bin.ts`, `packages/cli/src/context.ts`, `packages/core/src/config.ts`, `packages/node/src/server.ts` |
| `publish` | Publish knowledge you already have | `docs/en/guides/publish.md` | Registering an existing `.npz`; writing `bench.json` (`schema` required, what the CLI defaults); `publish` vs `patch publish --announce`; pricing as a decimal string; what happens between ANNOUNCED and LISTED. | `packages/cli/src/commands/patch.ts`, `packages/node/src/market.ts`, `BenchmarkSpec` in `packages/core/src/types.ts` |
| `teach` | Make knowledge from your own Q&A | `docs/en/guides/teach.md` | Turning teach mode on; the five accepted upload formats; what each row status means and which count as accepted; the job lifecycle QUEUED→READY; effort presets; the `TeachChecks.ok` publish gate; quotas and where to raise them. | `packages/node/src/teach.ts`, `packages/node/src/teach-dataset.ts`, `DEFAULT_TEACH_CONFIG` in `packages/core/src/config.ts` |
| `buy-and-apply` | Buy, load and unload | `docs/en/guides/buy-and-apply.md` | Finding knowledge; the free live-test quota (20/hour/visitor) and its 429; `buy` over x402 and the headers involved; `apply`/`remove`; reading the stack; the shared-runtime lock and the 503 + `Retry-After` you will meet. | `packages/core/src/x402.ts`, `packages/node/src/market.ts`, `packages/node/src/runtime.ts`, `packages/node/src/api.ts` |
| `verify` | Run as a verifier | `docs/en/guides/verify.md` | Turning the verifier on; what an attestation records and what `verified_on` values mean; quorum (default 2) and why self-attestations and hash-only checks are excluded; raising a challenge and what it stops. | `packages/node/src/verifier.ts`, `packages/core/src/catalog.ts`, `verifier.*` in `packages/core/src/config.ts` |

### Concepts

Readable away from a keyboard. Each ends in a position, not a result.

| Slug | Title | Path | Covers | Drawn from |
|---|---|---|---|---|
| `knowledge` | What a knowledge patch actually is | `docs/en/concepts/knowledge.md` | The `.npz` as `addrs`/`before`/`after` over a memory table; why **rows are touched addresses, not sentences**; why comparison happens in bf16; what "size" and "facts covered" each measure; why this is not fine-tuning. | `packages/core/src/npz.ts`, `PatchAnchor` in `packages/core/src/types.ts`, `glossary.ts` |
| `verification` | What "verified" means — and what it does not | `docs/en/concepts/verification.md` | Quorum among independent nodes; executed vs integrity-only; challenge takes an item off sale until re-verified; **no bond is escrowed anywhere**; verified is not a guarantee of correctness, so re-test with your own questions. | `packages/core/src/catalog.ts`, deprecations in `types.ts`, `glossary.ts`, `i18n/pages/public.ts` terms copy |
| `lineage` | Lineage and royalties | `docs/en/concepts/lineage.md` | Ancestors as a relation; the two-pass split (lineage pool at `market.royaltyShare`, default 0.3, split among unique ancestor authors, then the seller's remainder carved for contributors); the depth-16 walk cap; `MAX_CONTRIBUTORS`. States up front that **lineage is off by default** and names the config key that turns it on. | `royaltySplit` in `packages/core/src/catalog.ts`, `Contributor` in `types.ts`, `docs/internal/lineage-teach-design.md` §11 (mined, not published) |

### Reference

Five of six are generated. Ctrl-F territory; nothing collapsed behind an expander.

| Slug | Title | Path | Covers | Drawn from |
|---|---|---|---|---|
| `cli` | CLI reference | `docs/en/reference/cli.md` | **Generated.** Every command and subcommand as nested headings, a usage synopsis, and arguments/options with real type, default and choices. 25 top-level commands, 69 runnable leaves. | `packages/cli/src/bin.ts` via AST |
| `http-api` | HTTP API reference | `docs/en/reference/http-api.md` | **Generated.** Endpoints grouped by tag, with method, path, summary, parameters, response codes, and an auth column. Flat per-endpoint lists; nested request bodies link out to `schemas` rather than being indented into illegibility. | `buildOpenApi()` in `packages/node/src/openapi.ts` |
| `schemas` | Schemas | `docs/en/reference/schemas.md` | **Generated.** One section per component schema, `$ref`s linked as anchors. | same |
| `config` | Configuration reference | `docs/en/reference/config.md` | **Generated.** All 105 dotted keys with type, default and description; the protected keys `config set` refuses; the environment variables that override them. | `packages/core/src/config-schema.ts`, `packages/core/src/config.ts` |
| `errors` | Error codes | `docs/en/reference/errors.md` | **Generated.** Every code with its HTTP status and sentence; the `{error: "<code>: <sentence>"}` envelope and the fact that the machine code is the prefix, not a separate field; the special statuses (499, 423, 503 + `Retry-After`). | `packages/node/src/**` via AST |
| `file-formats` | File formats | `docs/en/reference/file-formats.md` | Hand-written. `.npz` member layout, dtypes and accepted ZIP methods; `bench.json` fields; `rows.jsonl` canonicalisation (fixed key order, LF, UTF-8 no BOM, one trailing LF — the sha256 over those bytes is the dataset's identity); ledger record hashing and canonical JSON. | `packages/core/src/npz.ts`, `packages/node/src/teach-dataset.ts`, `packages/core/src/canonical.ts`, `packages/core/src/local-ledger.ts` |

**18 pages, 13 of them hand-written.** That is deliberately small. A complete 13-page site beats a hollow 40-page one,
and every page above can be finished — and its commands actually run — inside this workflow.

Each group also gets an `overview` entry rendered from the toctree's group blurbs rather than a separate file, so a
group index cannot go stale against the pages it lists.

---

## 6. Authoring rules

1. **In the nav means finished.** No stubs, no lorem, no "TODO: document this". A topic that cannot be documented
   truthfully stays out of the toctree.
2. **Never document a command you have not run.** Paste the command and its real output into the same fenced block, the
   way the quickstart does. Never print a number the system did not measure.
3. **If the code does not do what a page says, that is a defect to report**, not prose to soften.
4. **Callouts are GitHub alert syntax** (`> [!TIP]`, `> [!WARNING]`) so a page renders correctly in a GitHub blob view,
   in an editor preview, and on the site.
5. **Link between guide and reference in both directions.** A guide answers "how do I publish"; the reference answers
   "what does `--ledger` default to". Neither can do the other's job.
6. **Anchors are heading slugs.** Renaming a heading breaks inbound links; `docs-check.mjs` catches the internal ones.
7. **Never hand-edit a generated file.** The banner says so and `npm run docs:check` enforces it.

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
| A **green test** | `packages/mcp/test/skill.test.ts:106` — `readFileSync(join(repo, 'docs', 'ux-test-scenarios.json'))` | hard-coded, no fallback; the test fails immediately |
| A generator script | `scripts/render-ux-results.py:16,18,117,163` | four hard-coded `docs/…` paths, **no argv override** |
| A generator script | `scripts/render-ux-scenarios.py:17-19` | argv-overridable, but the defaults are hard-coded |
| `README.md` | 6 links into `docs/` | **owned by the landing-page workflow — coordinate before moving.** It is being edited live; the line numbers moved while this file was being written, so re-grep rather than trusting a citation |
| ~100 cross-references between the internal documents themselves | `docs/*.md`, `docs/*.json` | `lineage-teach-design.md` alone carries 27 |
| Scenario-id comments in tests | `packages/{core,node,mcp}/test/*.ts`, `packages/e2e/playwright.config.ts` | comments only, but they will mislead |

A full `grep` before moving is the next agent's job; the list above is where to start, and the `README.md` row is the one
that needs another workflow's agreement rather than a `sed`.

---

## 8. Defects these pages must not repeat

Found while inventorying the surface. Each is a thing the current documentation asserts and the code does not do. They
are listed here so no page inherits them.

- **H1 — the hand-written CLI table is already stale.** `CLI_REFERENCE` (`packages/node/src/openapi.ts:378-452`) is
  served at `GET /api/docs` and rendered by the current `DocsPage`. It misses `patch stack`, `patch apply --with-base`
  and `patch remove --cascade` — all added the same morning it was inventoried — plus `patch conflicts`, `patch records`,
  `patch get`, `patch import`, `keys rotate`, `dataset get`, `route` and `nodes`. This is precisely what
  [§4](#4-what-is-generated-and-from-what) exists to end.
- **H2 — `npm install -g ainize` cannot work, and one claim is still live.** `packages/cli/package.json` is
  `"private": true`, and the name is unregistered: `npm view ainize version` → `E404` and
  `https://registry.npmjs.org/ainize` → HTTP 404 (both re-checked while writing this). The landing workflow has already
  fixed its two surfaces — the root `README.md` now says "there is no public npm package" and `LandingPage.tsx` no
  longer carries the line. **What remains is ours to fix:** `packages/node/src/openapi.ts:379` still ships
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
- **H8 — `grep` silently skips `packages/node/src/teach-dataset.ts`** (raw NUL byte → treated as binary). Any CI check
  that greps `packages/node/src` loses 716 lines without an error. Read files, or use `grep -a`.

One correction to the brief while I am here: the web design system is a **single light palette**
(`packages/web/src/theme/theme.ts`). There is no dark theme — only `components/public/Lifecycle.tsx` carries a local
`prefers-color-scheme` block. Docs pages use the same light theme as every other page.

---

## 9. What is deliberately not documented yet

Leaving a topic out is a decision, and each of these has a reason.

| Not documented | Why |
|---|---|
| The P2P compute market | `p2p-compute-market-design.md` is an unimplemented design. Documenting it would advertise a product that does not exist. |
| `ainize-agent` (4 commands) | A demonstration harness for the x402 buyer loop, not a supported surface — and I have not run it. Add it when both are false. |
| A full MCP tool reference | `packages/mcp/README.md` (853 lines) and `packages/mcp/references/` (7 files, 605 lines) are already good developer documentation. Forking them creates the drift this whole design exists to prevent. Get started → *Connect an agent* links to them. Flagged for a later pass: `packages/mcp/references/cli.md` is a **third** hand-written CLI reference and should be reduced to a link into the generated one. |
| Building on someone else's knowledge (lineage how-to) | Off by default and returns 403 (H5). Concept page yes, how-to guide no. |
| USDC, `CanonicalRow.from`/`.replaces`, stakes and bonds | H3, H4, H6 — the code does not do these things. |
| Versioned doc URLs and a version selector | Nothing released is worth pinning to yet. The URL shape leaves room for a version segment; add the selector when there are versions. |
| A product-selection hub page | HF needs one because it ships many products. Ainize is one product; that page would be a landing page with extra steps. |
| Framework/language tabs | There is no PyTorch/TF-style split. A CLI-vs-HTTP tab pair may earn its place later; the machinery is not worth building on spec. |
| Breadcrumbs, "was this helpful", comments, ratings | HF ships none of them. Sidebar and prev/next already locate the reader; feedback belongs where the fix lands. |
| Deployment and GPU host setup | `deploy/README.md` already covers it and is maintained next to the thing it describes. Link, do not copy. |
