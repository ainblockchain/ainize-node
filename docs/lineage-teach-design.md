# Lineage-first Teach with inherited training sets

**Status:** design, final (2026-09-02). Supersedes the lineage parts of `teach-mode-design.md` (§5.5, §6.2, §7.1, §8.3, §9.2) and revises `teachable-dataset-design.md` decision **D12** and non-goal §1.1 (see §14). No product code was changed for this document; every line reference is to the working copy on 2026-09-02 and may drift because another job is editing the same tree.

**Owner's direction (verbatim, Korean):**
1. "Teach 할때 기존 knowledge 의 계보도를 추적하고 fork merge 등이 가능한게 핵심인데 그런게 안보여. 어떤 knolwedge 위에서 트레이닝 하는건지"
2. "어떤게 잘나가는지, 내가 그 위에서 어떤 지식을 추가해야 되는지 트레이닝 세트가 승계가 되어야 거기에 붙여서 할 수 있는데 그런게 없어"

**Judging outcome this document is built from.** Three candidate designs were scored by three judges; all three judges picked *correctness-first* (totals 33/33/34) as the base. This document is correctness-first plus the grafts every judge asked for (creator-facing chooser and stories, buy-bundle, `samples[].source`, `replaces`, `meta` npz member, reversibility assertion, `fact_addrs`/`timing` in recipe, `covered_by` issues, verifier-recomputed row counts, seed relabelling) and explicit resolutions of the points on which the judges disagreed (§16).

---

## 0. Verified facts this design stands on

Everything below was read from the tree or measured on the demo blobs; the design does not rely on folklore.

| # | Fact | Where |
|---|------|-------|
| F1 | The teach trainer cannot start from a parent patch. It loads the disk table, sets `original[addr]` at first touch on the bare table, exports `before = original`. job.json has no parent field. | `qwen3.8/train/teach.py:260-267, :318, :329, :398`; `ainize-node/src/teach.ts:1221-1234` |
| F2 | Parents reach the trainer only as ≤ 8 benchmark samples used as *contrast*; the contrast probe keeps only pairs the bare model already answers, so parent facts are discarded. | `teach.py:206-210, :350-364`; `teach.ts:1189-1200, :1227` |
| F3 | `train_all.py --init-patch` is a **squash** (parent rows + new rows, `before = disk base` everywhere), verified on `rows-bidir-final.npz` (388,642 rows, contains all 270,053 pin rows, `before == pin.before` on 100 %). | `train_all.py:104-112`; numpy |
| F4 | Apply = write `after`, remove = write `before`; the hook returns `prev` on every write and `patch.py` discards it; `patch.py` has a `_read` path (`live.read`). `status` is a 2,000-row sampled majority test. | `qwen3.8/scripts/patch.py:13-37`; `vllm_patch/patch_hook.py:74-83`; `engram/live.py:56-58` |
| F5 | Chain order is "list order, last wins". `market.removePatch` does not re-assert other pinned patches; the watchdog re-applies per patch and can put a parent back **on top of** its child. | `ainize-node/src/market.ts:693-717, :758-763, :822-855` |
| F6 | Teach CHECKING applies the lesson alone, then the **parents on top** for parent regression — the reverse of deployment order. | `teach.ts:1509, :1554-1563` |
| F7 | Parents are recorded only if the checkbox was ticked **and** the context id is LISTED at READY time; everything else is silently dropped. The dataset door hard-codes `patch_ids: []`. | `teach.ts:1621`; `ainize-web/src/pages/TeachSettingsPage.tsx:99` |
| F8 | Every shipped blob's `before` equals the disk base on 100 % of overlapping rows. pin∩ep12 = 241,992 rows (100 % of ep12); pin∩pixel = 2,170 rows, `after` differs on 2,082 and on 1,737 the two values moved in *opposite* directions. ep6/ep12/pin have identical address sets with 99.9 % differing `after` (a version chain, not a build-on chain). | numpy over `results/train-all/*.npz`, `results/train-fact/픽셀플러스.npz` |
| F9 | `royaltySplit` walks `parents[]` to depth 16 and splits the pool equally among unique ancestor **authors**; pass 2 carves seller-side contributors from a *shrinking* remainder (two 0.5 contributors get 50 %/25 %). | `ainize-core/src/catalog.ts:222-292` |
| F10 | The whole anchor — `recipe.sentences` (≤ 32), `contrast`, `held_out`, and **every** `benchmark.samples` entry (one per trained Q/A) — is written to the ledger and mirrored on AIN. D12's "content is never published" is already false for the trained slice. One teach anchor is 5–12 KB against a ~100 KB AIN free-tier budget. | `teach-recipe.ts:55-76`; `teach.ts:1599-1601`; `ain-ledger.ts:335-362` |
| F11 | `publicEvents` redacts only kind `teach`; `usage` events carry `visitor: 'ip:<addr>'` and are served by public `GET /api/events`. | `api.ts:65-80, :253`; `market.ts:867-872` |
| F12 | `PublishSheet` sends `consent: { permanent: true, rights: true }` unconditionally; no PII scan or server-side declaration exists. | `PublishSheet.tsx:66`; grep `pii` over `packages/*/src` |
| F13 | The dataset parser's duplicate/conflict key is the **normalised prompt**: NFC, control/bidi/zero-width stripped, whitespace collapsed, **case-sensitive**, no punctuation handling; conflict = same key, different normalised answer. `teach.py normalise()` is a *different* rule (NFKC, lower-case, all whitespace removed) used only for hit detection. | `ainize-node/src/teach-dataset.ts:402-410, :559-571`; `teach.py:66-68` |
| F14 | ain-js `explore()` sets `parentEntry = parents[0]` and every other parent as `relatedEntries[].type: 'related' as const`. | `ain-ledger.ts:341-355` |
| F15 | `reconcileSupersedes` writes a supersede whenever this node's new LISTED anchor overlaps any same-schema, same-branch anchor from **any** author; teach lessons get a unique schema `taught/<slug>-<hex>` precisely so this never fires. | `market.ts:430-444`; `teach-recipe.ts:71-76` |
| F16 | `docs/ux-test-scenarios.json` already contains AZ-227 … AZ-233 (235 scenarios). | file |
| F17 | The node has a `stub` teach backend (copies a fixture npz, simulated checks) and a `gradient` backend (docker exec into `flashtrain`, GPUs 4–6). | `ainize-core/src/config.ts:154, :271`; `teach.ts:12, :110, :359` |

---

## 1. Goals and non-goals

### Goals
1. **Explicit base.** In both Teach doors and the CLI the creator chooses *which knowledge this is trained on top of*, separately from *which knowledge is loaded for comparison*. The choice states its three consequences on the spot: the base is recorded as a parent for good; its creators share every sale; buyers must load the base first.
2. **Inherited training set.** Teaching on top of X starts from X's dataset (the canonical `rows.jsonl`), shown and editable as inherited rows, plus my rows. Publishing makes that dataset available to derivative creators by default ('derivative' access) — the honest choice, because ≤ 32-row lessons are already fully public on-chain (F10).
3. **True on-top training.** The trainer loads the base rows before the first probe and step 1 and exports a **delta** whose `before` is the base state. CHECKING measures the chain in deployment order (base, then lesson). If this is not shipped, nothing may be called "built on".
4. **Reversible chains.** The runtime keeps an ordered applied stack, verifies `prev == before` (bf16-exact) on every apply using the value the hook already returns, journals `prev`, and `remove` replays the journal. Removing a child never reverts its parent to base.
5. **Fork and merge as dataset operations.** Fork = copy X's dataset into my line with X as parent. Merge = union two datasets by question, resolve *same question / different answer* per question, then build (cheap union only when rows do not disagree; otherwise retrain or rebuild). Additive or averaged row merges are never offered (F8).
6. **Family tree and demand as first-class views.** Ancestors, descendants, versions, tracks, contributors, *what each node added*, plus "doing well" and "what to add on top of X" fed by real signals — with counts by default and prompt text only with consent.
7. **Money follows the tree, verifiably.** Every ancestor of a sale is paid through `parents[]` (both parents of a merge); a child that inherited X's rows must list X. Σ payouts ≤ price by construction; the pass-2 bug is fixed first.
8. **Small on chain, big off chain.** New anchor fields are ids and sha256s only; dataset bytes, provenance, proofs and manifests live in the content-addressed blob store and travel over `/p2p`.
9. **Nothing silent.** Every drop that exists today (unlisted parent, private base, conflicting rows) becomes an explicit error at the earliest moment it can be known, with copy.

### Non-goals (v1)
- Cross-model transfer (patent claim 18/20 teacher–student synthesis) — reserved as derivation kind `transfer`, not built. A private base cannot be built on in v1; it is refused with a reason.
- Row-weighted royalty payouts. Rows contributed are **recorded** on the anchor and recomputed by verifiers; the payout rule stays the equal split among unique ancestor authors until a separate decision (§11, §16).
- Network-wide aggregation of node-local signals (gossip of counters). Signals are labelled by scope; cross-node rollups are a later P2P message, not a ledger record.
- Benchmark-schema inheritance on the ledger (patent claim 22 "common schema"). Contradiction is detected off-ledger by question key in v1; schema inheritance is gated on the supersede-consent fix (§16 R6).
- Changing the AIN write rule (author = node). The visitor stays a signed contributor; copy says "Taught by {name} · published by {node}".
- Automatic paraphrase detection when merging. Identity is the parser's key (F13); paraphrases train as separate rows (advisory only).

---

## 2. The mental model, in one paragraph

Your **training set** — the questions and answers you wrote — is the thing you own, edit, copy and combine. A **knowledge** is a build of a training set for one model: the file buyers load. When you teach *on top of* someone's knowledge you start from their training set (you see their questions, you add yours, you may correct a few), the trainer loads their rows underneath yours so your knowledge is a true add-on, and the record says so forever: they are in your **family tree** as the base, they get the network's creator share of every sale, and anyone who loads your knowledge loads theirs first. **Copy and continue** gives you your own line starting from theirs; **Combine** takes two training sets, shows you every question they answer differently, and builds one knowledge from the result. The tree shows what each knowledge added, which ones sell and are built on, and what people asked that a knowledge could not answer — so you know where to add.

### Glossary (copy never says git/commit/repo)

| Concept | EN | KO |
|---|---|---|
| lineage | family tree | 계보 |
| parent / base | base knowledge · built on | 기반 지식 · 위에 만듦 |
| child / derivative | built on it · add-on | 위에 만든 지식 · 추가분 |
| fork | copy and continue · new line | 복사해서 이어 만들기 · 새 갈래 |
| merge | combine | 합치기 |
| dataset | training set (questions and answers) | 학습 문답 |
| delta patch | add-on (needs its base) | 추가분 (기반 지식 필요) |
| standalone / squash | stand-alone build | 단독 빌드 |
| conflict | same question, different answer | 같은 질문, 다른 답 |
| supersede / version | newer version | 새 버전 |
| branch / track | different context · track | 다른 맥락용 · 트랙 |
| contributor | taught by | 가르친 사람 |

---

## 3. Creator stories as flows

Each story names the screens (§4), endpoints (§12) and CLI (§13) it touches.

### Story A — Teach on top of X (both doors, with the inherited set)

**A1 Chat door.** Visitor loads `krx-all-2761` (and optionally `pixelplus`) in the picker, gets a wrong answer, presses *Teach the right answer*. The basket (SC-1) opens with **Built on: krx-all-2761** pre-filled from the first loaded knowledge; `pixelplus` is listed as *loaded for comparison only*. The consequence line is visible under the row. Pre-flight (`POST /api/teach/preflight { facts, base_ids:[krx], context_ids:[krx,pixel] }`) runs with the **base** loaded; each row comes back `will_train` (X does not answer it), `in_base` (X already answers it the same way — dropped, counted for X as coverage), or `base_conflict` (X answers it differently — the row is shown as *Changes X's answer* and the visitor confirms it, which makes the lesson an *update* candidate). *Train* → `POST /api/teach/jobs { facts, base_ids:[krx], context_ids:[krx,pixel] }`. The node resolves the base (blob held, `mayUseEntry`, dataset access ≥ derivative or owned, no cycle, depth ≤ 8), copies X's npz into `<job>/parents/0-<sha>.npz`, fetches X's dataset blob into `<job>/known.jsonl`, snapshots the lesson rows into `<job>/snapshot.jsonl`, writes `job.json` with `parents`, `known_file`, `export: 'delta'`. Trainer loads X's rows, trains, exports a delta (§7). CHECKING applies X then the lesson (§7.6). READY card (SC-7): *Built on krx-all-2761 · adds 3 questions · krx-all-2761 still answers 10/10 of its own questions with your lesson on top.* Publish (SC-8): training-set access, licence, declaration → anchor `parents:[krx]`, `derivation:{kind:'extend', …}`, `base:{stack:[krx], export:'delta', pre_state_sha256}`, `dataset:{…, access:'derivative', parents:[{krx, sha, rows}]}`. X's page now shows *Built on 1 time*.

**A2 Dataset door.** `TeachSettingsPage` gains a required **Start from** block (SC-4): a base picker plus *Start from scratch*. Choosing X shows *Start from its 2,761 questions* (on by default when X's access ≥ derivative; disabled with the reason when private). The preview (SC-5) shows inherited rows greyed with a *from krx-all-2761* chip, own rows normal, and D11 conflict rows where the upload answers an inherited question differently (*Your answer differs from krx-all-2761's — keep which?*). Pre-flight probes with the base loaded. Training, checking and publishing are identical to A1. CLI: `ainize teach train q.csv --on krx-all-2761`.

**A3 Chain my own lessons.** The visitor's own private READY draft may be the base (`mayUseEntry`). Lineage is recorded to the draft id at job creation; publish is blocked with `parent_not_listed` (*Publish krx-lesson-1 first — it is the base of this lesson*) until the base is LISTED or ANNOUNCED. Nothing is dropped.

### Story B — Fork (copy and continue)

On X's page (SC-9) or from *My datasets*: **Copy and continue** → `POST /api/patches/krx-all-2761/fork { name? }`. The node fetches X's dataset blob (local, else from any peer advertising the sha), creates a dataset in the caller's *My datasets* with `parent_patch = X`, `parent_dataset_sha`, `source:'derived'`, all rows carrying `from:'krx-all-2761#<i>'`, revision 1. Re-forking returns the same dataset (de-dupe on owner+sha). The editor opens; inherited rows are read-only until *Change this answer* marks a row `overrides`. *Train* preselects base = X (extend). A second choice, **Detach — start from scratch on this line**, trains a stand-alone build with `parents:[X]` and `dataset.parents:[X]` but no `base` stack; the credit note is stated at the moment of choice (*X's creators are still credited as the data source and receive the creator share*). CLI: `ainize patch fork krx-all-2761 --name "KRX + biotech"`.

**Fork outcomes.** After training, the diff engine classifies the child from the dataset diff: only additions → `extend` (*Add to it*); changed answers to X's questions by X's own teaching key or the node operator → `update` with an opt-in *This replaces X* (writes a supersede record signed by X's author when the child lists); changed answers by another key → `contradict` (*Correct it* or *Different context*): published as a child; with context attributes it lands on a track (branch record, patent claim 24). X's author can later **adopt** a correction into a new version, listing the corrector as `data_provider` contributor and signing the supersede (the only path by which a cross-author change becomes a claim-23/59 update).

### Story C — Merge with conflicts

From X's page *Combine with…* or CLI `ainize patch merge a b --preview`. `POST /api/teach/merge/preview { a, b }` returns question overlap (same / different answers), row overlap (shared addresses, disagreeing bf16 `after`), allowed build tiers and the licence floor. The merge screen (SC-14) walks four steps: **Overlap → Different answers → How to build → Checking**. Every *same question, different answer* pair must be resolved (Keep A / Keep B / Write my own / Drop; bulk Prefer A / Prefer B). Build tiers: *Just combine* (no training; only when address sets are disjoint or every shared row is bf16-identical and no question conflicts remain), *Retrain the disagreeing questions on top of both* (default when rows disagree; masked, minutes), *Rebuild everything from the combined set* (hours; required when > 20 % of a parent's shared rows disagree — both demo pairs exceed this). Verification is stratified per source (A's samples, B's samples, resolved conflicts). The anchor lists `parents:[A,B]`, `derivation:{kind:'merge', bases:[A,B], policy, tier}`, `dataset.parents:[A,B]`; both lines are paid.

### Story D — Browse the tree and the demand view; buy a child and have its parents loaded

**D1 Browse.** Explore (SC-17) gains three shelves — *Selling now* (network), *Being built on* (network), *Asked for* (this node) — and sorts *Most built on* / *Doing well this week*. A knowledge page opens on the **Family tree** tab (SC-9): ancestors above, this, versions beside, corrections/children below, tracks as dashed side nodes, each with *+n questions / k changed*, sales, loads, built-on count. The **Training set** block (SC-10) shows availability and licence with *Preview 20 questions*, *Copy and continue*, *Download* (public only). The **What to add on top of this** panel (SC-12) lists X's own failing benchmark questions (public), clusters of pre-flight *wrong today* rows with X as base (counts), free questions marked wrong (text only after the per-turn consent, SC-13), buyer requests, and coverage gaps against siblings in the same topic. Each item has *Teach this on top* → Story A with base = X and the prompt pre-filled when text exists. An item flips to *covered by {child}* when a descendant's dataset contains its key.

**D2 Buy a child.** Explore card shows *Add-on to krx-all-2761 · needs it to use*. Buying returns a 402 whose body carries `requires: [{ id, name, price, held }]`; the buy sheet (SC-15) offers *Buy both* (two settle records: the base sale and the child sale — the base author is paid twice by design, once as seller and once through lineage; the sheet says so). `ainize use <child>` / *Load with its base* applies the stack in order with `prev == before` verification and journal; removing the base while the child is applied is refused (*Remove {child} first*); removing the child replays the journal and leaves the base's rows exactly as they were. After a vLLM restart the watchdog re-applies the whole ordered stack.

---

## 4. Screens with exact copy (EN · KO)

i18n keys are proposed names under `ainize-web/src/i18n/pages/{teach,detail,chat,explore}.ts`. `{lineage}` is the network creator share in percent (from config `royaltyShare`).

### SC-1 Basket base row (chat door, `LessonBasket.tsx`) — replaces the `builds_on` checkbox
| key | EN | KO |
|---|---|---|
| `teach.basket.base` | Built on: {name} [Change] | 바탕 지식: {name} [바꾸기] |
| `teach.basket.base_none` | Built on: nothing — teaching the plain model [Choose] | 바탕 지식 없음 — 기본 모델에 가르칩니다 [고르기] |
| `teach.basket.base_consequences` | Recorded as built on {name} · its creators receive {lineage}% of every sale · buyers must load {name} first. | {name}을(를) 바탕으로 만든 지식으로 기록됩니다 · 그 제작자가 판매마다 {lineage}%를 받습니다 · 구매자는 {name}을(를) 먼저 넣어야 합니다. |
| `teach.basket.compare_only` | Also loaded, for comparison only: {names} | 비교용으로만 넣음: {names} |
| `teach.basket.inherits` | Starts from its {n} questions (view) | 그 지식의 질문 {n}개에서 시작합니다 (보기) |
| `teach.basket.base_private` | Cannot build on {name}: its creator kept the questions private. You can still teach the plain model with it loaded for comparison. | {name} 위에는 만들 수 없습니다: 제작자가 질문을 비공개로 두었습니다. 비교용으로 넣고 기본 모델에 가르칠 수는 있습니다. |
| `teach.basket.base_unlisted` | Not listed yet ({status}). You can build on it now; you can publish only after it is listed. | 아직 등록 전이에요 ({status}). 지금 가르칠 수는 있지만, 등록된 뒤에만 공개할 수 있습니다. |
| `teach.basket.base_retired` | Retired — build on its newer version {name} | 퇴역됨 — 새 버전 {name} 위에 만드세요 |

### SC-2 Build-on chooser (modal from *Build on this*)
| key | EN | KO |
|---|---|---|
| `detail.chooser.title` | What do you want to do with {name}? | {name}(으)로 무엇을 하시겠어요? |
| `detail.chooser.add` | Add to it — Teach it things it does not know. {name} stays as it is. | 내용 추가하기 — 모르는 것을 더 가르칩니다. {name}은(는) 그대로 둡니다. |
| `detail.chooser.correct` | Correct it — Fix answers it gets wrong. Published as an add-on to {name}. | 틀린 답 고치기 — 틀린 답을 바로잡습니다. {name} 추가분으로 발행됩니다. |
| `detail.chooser.context` | Make a version for a different context — Same questions, different answers (another country, date or policy). Lives on its own track. | 다른 맥락용 버전 만들기 — 같은 질문에 다른 답 (다른 나라·시점·정책). 별도 트랙에 올라갑니다. |
| `detail.chooser.footer` | Creators of {name} will earn {lineage}% of each sale. Buyers of your knowledge will also need {name} ({price}). | {name} 제작자가 판매마다 {lineage}%를 받습니다. 구매자는 {name}({price})도 필요합니다. |
| `detail.chooser.chat` / `.file` | Continue in chat / Continue with a file | 채팅으로 계속 / 파일로 계속 |

### SC-3 Base picker sheet (both doors)
| key | EN | KO |
|---|---|---|
| `teach.pick.title` | What are you building on? | 무엇을 바탕으로 만드나요? |
| `teach.pick.loaded` / `.mine` / `.bought` / `.search` | Loaded now / Your knowledge / Bought / Search the catalog | 지금 넣은 지식 / 내 지식 / 구매한 지식 / 카탈로그 검색 |
| `teach.pick.row` | {name} · {author} · {status} · Questions: {n} · {shareable\|private} · Built on {k} times · {open} open questions | {name} · {author} · {status} · 질문 {n}개 · {공유 가능\|비공개} · 바탕으로 쓰임 {k}회 · 못 하는 질문 {open}개 |
| `teach.pick.one` | One base only. Combining two? Use Combine on the knowledge page. | 바탕 지식은 하나만 고를 수 있습니다. 둘을 합치려면 지식 페이지의 "합치기"를 쓰세요. |
| `teach.pick.suggested` | Suggested — {n} of your questions overlap {name} | 추천 — 내 질문 {n}개가 {name}과(와) 겹쳐요 |
| `teach.pick.not_held` | Not on this node — buy or download it first | 이 노드에 없음 — 먼저 구매하거나 내려받으세요 |

### SC-4 Dataset door "Start from" block (`TeachSettingsPage.tsx`)
| key | EN | KO |
|---|---|---|
| `teach.settings.start_from` | Start from | 기반 지식 |
| `teach.settings.scratch` | Start from scratch | 처음부터 |
| `teach.settings.required` | Choose a base or start from scratch | 기반 지식을 고르거나 "처음부터"를 선택하세요 |
| `teach.settings.inherit` | Start from its questions ({n} rows will be added to your table) | 그 지식의 질문에서 시작하기 ({n}개 행이 표에 추가됩니다) |
| `teach.settings.checked_with` | Checked with {name} loaded | {name}을(를) 넣은 상태로 확인했습니다 |

### SC-5 Rows table (`TeachDatasetPage.tsx`)
| key | EN | KO |
|---|---|---|
| `teach.rows.from` | from {name} | {name}에서 |
| `teach.rows.filters` | Mine ({a}) · Inherited ({b}) · Changed ({c}) · Conflicts ({d}) | 내 것 ({a}) · 물려받음 ({b}) · 바꿈 ({c}) · 충돌 ({d}) |
| `teach.rows.summary` | Adds {x} questions, changes {y}, keeps {z} from {name} | {name}에서 {z}개 유지, {y}개 바꿈, {x}개 추가 |
| `teach.rows.change` | Change this answer | 이 답 바꾸기 |
| `teach.rows.base_conflict` | Your answer differs from {name}'s — Keep mine / Keep theirs | {name}의 답과 다릅니다 — 내 답 유지 / 그쪽 답 유지 |
| `teach.rows.inherited_note` | Inherited questions are trained again as known answers so your lesson does not undo them. | 물려받은 질문은 아는 답으로 다시 학습해서 내 지식이 그것을 지우지 않게 합니다. |

### SC-6 Pre-flight statuses (`PreflightList.tsx`)
| key | EN | KO |
|---|---|---|
| `teach.pre.in_base` | {name} already answers this | {name}이(가) 이미 답합니다 |
| `teach.pre.base_conflict` | {name} answers this differently today ({name} says: {answer}). Your row will replace it for anyone who loads your add-on. | {name}이(가) 지금은 다르게 답합니다 ({name}의 답: {answer}). 내 추가분을 넣은 사람에게는 내 답이 대신 나옵니다. |

### SC-7 Result card (`LessonCard.tsx`, `TeachLessonPage.tsx`)
| key | EN | KO |
|---|---|---|
| `teach.res.built_on` | Built on {name} · adds {m} questions · changes {k} ({rows} rows) | {name} 바탕 · 질문 {m}개 추가 · {k}개 수정 (행 {rows}개) |
| `teach.res.parent_ok` | {name} still answers its own questions with your lesson on top: {hit}/{total} | 내 수업을 위에 얹어도 {name}은(는) 자기 질문에 {hit}/{total} 답합니다 |
| `teach.res.parent_broken` | Your lesson breaks {k} of {name}'s answers ({list}). It cannot be published on top of {name}. Fix the conflicting rows, correct them on purpose with Correct it, or rebuild. | 내 수업이 {name}의 답 {k}개({list})를 망가뜨립니다. 이대로는 {name} 위에 공개할 수 없어요. 겹치는 질문을 고치거나, "틀린 답 고치기"로 의도적으로 바꾸거나, 다시 만드세요. |
| `teach.res.closes` | Closes {n} open questions of {name} | {name}의 못 하던 질문 {n}개를 해결합니다 |
| `teach.res.reversible` | Removing your lesson leaves {name} exactly as it was: checked. | 내 수업을 빼면 {name}은(는) 원래 그대로: 확인됨. |

### SC-8 Publish sheet (`PublishSheet.tsx`)
| key | EN | KO |
|---|---|---|
| `teach.pub.built_on` | Built on: {names} | 기반 지식: {names} |
| `teach.pub.money` | Every sale: {lineage}% to the creators of {names}, {contributor}% to you, the rest to {node}. | 판매마다: {names} 제작자에게 {lineage}%, 나에게 {contributor}%, 나머지는 {node}에게. |
| `teach.pub.ds_title` | Your questions | 내 질문 |
| `teach.pub.ds_public` | Anyone can download and build on them | 누구나 내려받고 바탕으로 쓸 수 있음 |
| `teach.pub.ds_derivative` | Only people building on this knowledge can get them (recommended) | 이 지식 위에 만드는 사람만 받을 수 있음 (권장) |
| `teach.pub.ds_private` | Keep private — nobody can build on this knowledge | 비공개 — 아무도 이 지식 위에 만들 수 없음 |
| `teach.pub.ds_honesty` | Note: the {n} questions used to check this lesson are already public on its record; "private" protects only notes and untrained rows. | 참고: 확인에 쓰인 질문 {n}개는 이미 공개 기록에 있습니다. "비공개"는 메모와 학습되지 않은 행만 보호합니다. |
| `teach.pub.ds_retention` | You chose to delete the file after training, so nobody can build on this knowledge. | 학습 뒤 파일을 지우기로 했기 때문에 아무도 이 지식 위에 가르칠 수 없습니다. |
| `teach.pub.ds_license` | Licence for the questions | 질문의 이용 조건 |
| `teach.pub.ds_license_forced` | {parent} is {licence}, so yours must be {licence}. | {parent}이(가) {licence}이므로 이 지식도 {licence}여야 합니다. |
| `teach.pub.decl_source` | Where did these questions come from? Own work / Public source / Licensed to me | 이 질문의 출처: 직접 작성 / 공개 자료 / 이용 허락 받음 |
| `teach.pub.decl_pii` | They contain no personal information | 개인정보가 없습니다 |
| `teach.pub.pii_block` | Rows {list} look like personal information ({kinds}). Remove them to publish. | {list}행에 개인정보({kinds})로 보이는 내용이 있습니다. 지우면 공개할 수 있습니다. |
| `teach.pub.decl_missing` | Tell us where these {n} questions come from. | 이 {n}개 문답의 출처를 알려주세요. |
| `teach.pub.base_unlisted` | {name} is not listed yet. Publish after it is listed. | {name}이(가) 아직 등록 전이에요. 등록된 뒤에 공개하세요. |
| `teach.pub.outcome_title` | This lesson changes {k} of {name}'s answers. Publish as: | 이 수업은 {name}의 답 {k}개를 바꿉니다. 공개 방식: |
| `teach.pub.outcome_extend` | Addition to {name} (keep {name}'s answers) | {name}에 더하기 ({name}의 답 유지) |
| `teach.pub.outcome_correct` | Correction to {name} | {name}의 수정판 |
| `teach.pub.outcome_track` | A different track (for: region, date, policy) | 다른 트랙 (지역·시점·정책) |
| `teach.pub.outcome_update` | Newer version replacing {name} (only you, as its creator, can do this) | {name}을(를) 대체하는 새 버전 (제작자 본인만 가능) |
| `teach.pub.include_notes` | Include my notes in the shared questions | 공유되는 질문에 내 메모 포함 |

### SC-9 Knowledge page header and Family tree tab (`PatchPage.tsx`)
| key | EN | KO |
|---|---|---|
| `detail.taught_by` | Taught by {name} · published by {node} | {name} 가르침 · {node} 공개 |
| `detail.build_on` | Build on this | 이 지식 위에 만들기 |
| `detail.build_on_private` | The creator kept the training set private, so nobody can build on it. | 창작자가 학습 문답을 비공개로 두어 이어 만들 수 없습니다. |
| `detail.addon_badge` | Add-on to {name} · needs {name} to use | {name} 추가분 · 사용하려면 {name} 필요 |
| `detail.tab.tree` | Family tree | 계보 |
| `detail.tree.legend` | Base / Built on it / Correction / Newer version / Different context / Combined from | 기반 / 위에 만든 지식 / 수정판 / 새 버전 / 다른 맥락용 / 합쳐서 만듦 |
| `detail.tree.added` | +{m} questions · {k} changed · {rows} rows ({new} new) | 질문 {m}개 추가 · {k}개 수정 · 행 {rows}개 (새 행 {new}개) |
| `detail.tree.node_hover` | {name} · taught by {teacher} · {sales} sales · loaded on {loads} nodes · built on {c}× | {name} · {teacher} 가르침 · 판매 {sales} · 노드 {loads}곳에 로드 · 바탕 {c}회 |
| `detail.tree.missing` | Unknown knowledge {id} (not on this node) | 알 수 없는 지식 {id} (이 노드에 없음) |
| `detail.tree.legacy` | Declared parent — not trained on top | 부모로 표시됨 — 그 위에서 학습되진 않음 |
| `detail.tree.family` | This family: {sales} sales · {n} knowledges · {authors} creators | 이 계보: 판매 {sales} · 지식 {n}개 · 제작자 {authors}명 |
| `detail.tree.money` | Each sale: {seller}% to {seller_name}, {lineage}% shared by the creators of {names} | 판매 1건당: {seller_name}에게 {seller}%, {lineage}%는 {names} 제작자에게 |
| `detail.tree.buttons` | Teach on top of this / Copy and continue / Combine with… / Get its questions | 이 위에 가르치기 / 복사해서 이어 만들기 / 합치기… / 질문 받기 |
| `detail.tree.corrections` | Corrections available ({n}) | 수정판 {n}개 |
| `detail.tree.adopt` | Adopt this correction into your next version | 이 수정판을 다음 버전에 반영하기 |

### SC-10 Training set block
| key | EN | KO |
|---|---|---|
| `detail.ds.line` | {n} questions · {available to anyone who builds on it \| public \| private} · {licence} | 문답 {n}개 · {이어 만드는 사람에게 제공 \| 공개 \| 비공개} · {licence} |
| `detail.ds.private_note` | Training set: private. Only the {n} verification questions are public. | 학습 문답: 비공개. 검증용 질문 {n}개만 공개됩니다. |
| `detail.ds.buttons` | Preview 20 questions / Copy and continue / Download | 문답 20개 미리보기 / 복사해서 이어 만들기 / 내려받기 |
| `detail.ds.unavailable` | Training set not available on this node (no peer holds it). | 이 노드에서 학습 문답을 구할 수 없습니다 (보유한 노드 없음). |

### SC-11 Doing-well strip (knowledge page header, Explore card)
| key | EN | KO |
|---|---|---|
| `detail.signals.strip` | Sales {s} · Loaded on {l} nodes · Live tests {t} (✓{h}) · Built on {c} times · Track subscribers {w} · Verified {p}/{q} | 판매 {s} · 노드 {l}곳에 로드 · 실전 테스트 {t}회 (✓{h}) · 바탕으로 쓰임 {c}회 · 트랙 구독 {w} · 검증 {p}/{q} |
| `detail.signals.scope_net` / `.scope_node` | Network / This node, last 30 days | 네트워크 / 이 노드, 최근 30일 |

### SC-12 "What to add on top of this" panel
| key | EN | KO |
|---|---|---|
| `detail.missing.title` | What to add on top of this ({n}) | 이 위에 무엇을 더하면 좋을까요? ({n}) |
| `detail.missing.own` | Its own questions it got wrong in live tests ({k} of {total}) | 실전 테스트에서 틀린 자기 질문 ({total}개 중 {k}개) |
| `detail.missing.preflight` | Questions people tried to teach on top of it ({k}, {u} people): {clusters} | 사람들이 이 위에 가르치려 한 질문 ({k}개, {u}명): {clusters} |
| `detail.missing.free` | Free questions marked wrong ({k}) — {shared} shared by visitors | 틀렸다고 표시된 자유 질문 ({k}개) — 방문자가 공유한 것 {shared}개 |
| `detail.missing.requests` | Requested by buyers ({k}) | 구매자 요청 ({k}개) |
| `detail.missing.gap` | Coverage gaps in {topic} ({k}) | {topic}에서 빠진 부분 ({k}개) |
| `detail.missing.count` | asked {c} times | {c}번 물어봄 |
| `detail.missing.covered` | covered by {child} | {child}이(가) 해결함 |
| `detail.missing.teach` | Teach this on top | 이 위에 가르치기 |
| `detail.missing.request` | Ask the creator to add… | 제작자에게 요청하기… |
| `detail.missing.empty` | Nothing reported yet. Load it in Chat and ask around. | 아직 보고된 것이 없습니다. 채팅에 넣고 이것저것 물어보세요. |

### SC-13 Chat per-turn consent (`ChatPage.tsx`)
| key | EN | KO |
|---|---|---|
| `chat.mark_wrong` | Mark wrong | 틀림 표시 |
| `chat.share_q` | Share this question with {name}'s creator? (they see the text; otherwise only a count) [Share / Count only] | 이 질문을 {name} 제작자에게 보낼까요? (보내면 본문이 보이고, 아니면 횟수만 셉니다) [보내기 / 횟수만] |

### SC-14 Merge screen (`/teach/merge?a=&b=`)
| key | EN | KO |
|---|---|---|
| `merge.title` | Combine {A} + {B} | {A} + {B} 합치기 |
| `merge.steps` | Overlap / Different answers / How to build / Checking | 겹침 / 서로 다른 답 / 다시 만들 방법 / 검증 |
| `merge.questions` | Questions: {a} only in {A} · {b} only in {B} · {same} same · {conf} same question, different answer | 질문: {A}에만 {a} · {B}에만 {b} · 같음 {same} · 같은 질문 다른 답 {conf} |
| `merge.rows` | Rows: {ra} only in {A} · {rb} only in {B} · {shared} written by both ({dis} disagree) | 행: {A}만 {ra} · {B}만 {rb} · 둘 다 쓴 행 {shared} (다른 값 {dis}) |
| `merge.conflict_card` | {A} says: {a_answer} · {B} says: {b_answer} — Keep {A}'s / Keep {B}'s / Write my own / Drop this question | {A}의 답: {a_answer} · {B}의 답: {b_answer} — {A} 답 유지 / {B} 답 유지 / 직접 쓰기 / 이 질문 빼기 |
| `merge.bulk` | Prefer {A} everywhere / Prefer {B} everywhere | 모두 {A} 답으로 / 모두 {B} 답으로 |
| `merge.unresolved` | {n} questions still need a choice | 아직 고르지 않은 질문 {n}개 |
| `merge.tier_union` | Just combine — no training (only when rows do not disagree) | 바로 합치기 — 학습 없음 (겹치는 행이 같을 때만) |
| `merge.tier_union_off` | Not available: {dis} shared rows disagree. | 불가: 겹치는 행 {dis}개의 값이 다릅니다. |
| `merge.tier_retrain` | Retrain the {d} disagreeing questions on top of both (~{min} min) | 서로 다른 질문 {d}개만 두 지식 위에서 다시 학습 (~{min}분) |
| `merge.tier_rebuild` | Rebuild everything from the combined questions (~{h} h, best quality) | 합친 질문 전체로 처음부터 다시 만들기 (~{h}시간, 최고 품질) |
| `merge.tier_untimed` | This node has not timed a rebuild yet — it may take hours. | 이 노드는 아직 재구축 시간을 잰 적이 없습니다 — 수 시간이 걸릴 수 있습니다. |
| `merge.result` | Passes {A}'s questions {m}/{n} · Passes {B}'s questions {p}/{q} · Resolved answers {r}/{s} | {A}의 질문 통과 {m}/{n} · {B}의 질문 통과 {p}/{q} · 고른 답 {r}/{s} |
| `merge.footer` | Creators of {A} and {B} share {lineage}% equally. Buyers need both. | 두 제작자가 {lineage}%를 똑같이 나눕니다. 구매자는 둘 다 필요합니다. |
| `merge.private_parent` | {name}'s questions are private: only "Just combine" is possible, and only if the rows do not overlap. | {name}의 질문이 비공개라 "바로 합치기"만 가능하며, 행이 겹치지 않을 때만 됩니다. |

### SC-15 Buy / apply for a child (`BuySheet`, operator apply dialog, CLI)
| key | EN | KO |
|---|---|---|
| `buy.addon` | This is an add-on to {name}. To use it you need {name} as well. | {name} 추가분입니다. 사용하려면 {name}도 필요합니다. |
| `buy.lines` | This knowledge {p1} · {name} {p2} (you do not have it) · Total {sum} | 이 지식 {p1} · {name} {p2} (보유하지 않음) · 합계 {sum} |
| `buy.both` | Buy both | 둘 다 구매 |
| `buy.twice_note` | {name}'s creators are paid for {name} and receive {lineage}% of this sale too. | {name} 제작자는 {name} 판매 대금과 이 판매의 {lineage}%를 함께 받습니다. |
| `apply.needs_base` | {child} is built on {parent}. Load {parent} first? [Load both] [Cancel] | {child}은(는) {parent} 위에 만든 지식입니다. {parent}을(를) 먼저 넣을까요? [둘 다 넣기] [취소] |
| `apply.order` | Loaded in order: {parent} → {child} | 불러온 순서: {parent} → {child} |
| `apply.has_dependents` | Remove {children} before removing {parent}. | {parent}을(를) 빼려면 {children}을(를) 먼저 빼세요. |
| `apply.mismatch` | The model does not have {parent} loaded the way {child} expects (something else changed these rows). Reload {parent} and try again. | 모델에 {child}이(가) 기대하는 상태로 {parent}이(가) 올라가 있지 않습니다 (다른 것이 이 행을 바꿨습니다). {parent}을(를) 다시 넣고 시도하세요. |

### SC-16 My datasets card
| key | EN | KO |
|---|---|---|
| `teach.ds.card_from` | Copied from {name} (knowledge) · {inherited} inherited, {mine} mine | {name}(지식)에서 복사 · 물려받음 {inherited}, 내 것 {mine} |
| `teach.ds.card_used` | Used by {n} lessons, {p} published | 수업 {n}개에서 사용, {p}개 공개됨 |
| `teach.ds.card_pinned` | Published — kept as long as the knowledge is listed | 공개됨 — 지식이 판매되는 동안 보관됩니다 |

### SC-17 Explore (`ExplorePage.tsx`)
| key | EN | KO |
|---|---|---|
| `explore.shelf.selling` | Selling now | 잘 팔리는 지식 |
| `explore.shelf.built_on` | Being built on | 위에 만들어지고 있는 지식 |
| `explore.shelf.asked` | Asked for (this node) | 사람들이 찾는 지식 (이 노드 기준) |
| `explore.shelf.asked_row` | {topic} — asked {n} times — nobody teaches it yet [Teach this] | {topic} — {n}번 요청 — 아직 아무도 가르치지 않음 [가르치기] |
| `explore.sort.built_on` / `.trending` | Most built on / Doing well this week | 바탕으로 많이 쓰임 / 이번 주 인기 |
| `explore.card.built_on` | Built on {c}× | 바탕 {c}회 |
| `explore.card.needs` | Needs {name} | {name} 필요 |

### SC-18 Operator console
| key | EN | KO |
|---|---|---|
| `ops.stack` | Loaded stack (in order): {list} | 올라간 지식 (순서대로): {list} |
| `ops.ledger_budget` | Ledger space used: {used} KB of ~{cap} KB — raise the app stake at 80 %. | 원장 공간 사용: {used} KB / 약 {cap} KB — 80 %에서 앱 스테이크를 올리세요. |
| `ops.uncredited` | {child} fetched this training set under "derivative" access but does not list it as a base. (visible to the operator only) | {child}이(가) "이어 만들기" 접근으로 학습 문답을 받았지만 기반 지식으로 표시하지 않았습니다. (운영자에게만 표시) |

---

## 5. Data-model diff

### 5.1 `PatchAnchor` (`ainize-core/src/types.ts`) — all new fields optional, ids/hashes only

```ts
export type DerivationKind = 'extend' | 'update' | 'contradict' | 'merge' | 'transfer'; // transfer reserved (claim 18)

derivation?: {
  kind: DerivationKind;
  bases: { patch_id: string; patch_sha256: string; dataset_sha256?: string; rows: number }[]; // ⊆ parents
  added_rows: number; changed_rows: number; removed_rows: number;
  policy?: 'keep_a' | 'keep_b' | 'manual';          // merge only
  tier?: 'union' | 'retrain' | 'rebuild';            // merge only
};
base?: {
  stack: { patch_id: string; patch_sha256: string }[]; // ordered; the table state the delta was trained against (claim 55)
  export: 'delta' | 'squash';
  pre_state_sha256: string;   // sha256 over sorted (addr int64 LE ‖ bf16(before) bytes) of the child's rows
};
dataset?: {
  sha256: string; rows: number; source: TeachDatasetSource;                 // unchanged
  access?: 'public' | 'derivative' | 'private';                             // absent = 'private'
  license?: string;                                                         // validated list (§6.4)
  parents?: { patch_id: string; sha256: string; rows: number }[];           // ⊆ parents
  merkle_root?: string;                                                     // leaf = sha256(canonical row); for private parents
};
```

Invariant validated in `market.createDraft` for anchors this node writes (readers are tolerant): `new Set(parents) ⊇ base.stack ids ∪ dataset.parents ids ∪ derivation.bases ids` and every child row carrying `from:'<X>#i'` implies `X ∈ parents`. Absent `base` ⇒ stand-alone build (today's semantics). Absent `derivation` ⇒ "declared parent — not trained on top" (SC-9 legacy chip). Size: ≈ 250 B per base, < 1 KB for a two-parent merge. Every new array needs a `withEmptyArrays` entry in `ain-ledger.ts:112-127` (`derivation.bases`, `base.stack`, `dataset.parents`).

`BenchmarkSpec`: `samples` capped at **32** on-chain for teach anchors (child's own first, then one per parent, every override question included); `answers_hash` (already typed, unused) = sha256 over the canonical full sample list; each sample gains `source?: string` (patch id) so stratified verification scores per source without fetching parents. The full list lives in the dataset blob manifest (`benchmark.jsonl`).

`PatchRecipe` gains `parents?: { patch_id; sha256; rows }[]`, `export?`, `pre_state_sha256?`, `fact_addrs?: Record<number, number[]>` (kept off-chain: recipe.json only, the on-chain recipe keeps sentences ≤ 32).

### 5.2 Dataset canonical row and blob (off-chain)

`CanonicalRow = { prompt, answer, alt_prompt?, note?, from?: string, replaces?: string }` — `from = '<parent_patch_id>#<row_index>'` for an unchanged inherited row; `replaces` for an overridden one (the edited row keeps the pointer so the diff engine can say *changed k*). Both are inside the hashed bytes, so provenance is part of `dataset.sha256`. `note` is stripped from published copies unless the owner opts in.

Blob layout (new content-addressed kind, `ainize-node/src/blobs.ts` accepts it beside `.npz`):
```
<dataDir>/blobs/datasets/<sha256>/rows.jsonl        exact canonical bytes (sha256 == anchor.dataset.sha256)
<dataDir>/blobs/datasets/<sha256>/manifest.json     { sha256, rows, license, access, parents[], row_origin[], changed[], removed[],
                                                      benchmark_sha256, merkle_root, contrast_used[], fact_addrs, pii_scan:{ok, rows[]},
                                                      declaration, include_notes }
<dataDir>/blobs/datasets/<sha256>/benchmark.jsonl   full sample list (answers_hash preimage)
<dataDir>/blobs/datasets/<sha256>/merkle.json       leaves for inclusion proofs (optional)
```
Snapshot at **job creation** (`<job>/snapshot.jsonl`, copied from `teach/datasets/<id>/rows.jsonl`) so edits, `delete_after_training` and the 7-day sweep cannot change what a published lesson needs; promoted to `blobs/datasets/` at publish; published copies are immutable and exempt from sweep and owner delete (tombstone keeps bytes while any LISTED/ANNOUNCED anchor references the sha). `PeerInfo` gains `datasets: string[]` (sliced to 40 like `blobs`).

### 5.3 `teach_datasets`, `teach_jobs` (`ainize-node/src/store.ts`)

`teach_datasets` +: `parent_patch TEXT`, `parent_dataset_sha TEXT`, `inherited_rows INTEGER`, `access TEXT`, `pinned INTEGER`. `parent_dataset` (uuid, same-owner fork) stays. Uniqueness stays `(owner, sha256, revision)`; a stranger's fork is a new owner-scoped row whose bytes may equal the parent's.

`teach_jobs` +: `bases TEXT` (ordered JSON `[{patch_id, sha256}]`), `context TEXT` (unchanged: loaded for comparison), `mode TEXT` (`scratch|extend|fork|merge`), `derivation TEXT`, `resolutions TEXT` (merge choices), `export_mode TEXT`, `parent_check TEXT` (per parent `{hit,total,failed:[sample_index]}` in deployment order), `reversibility_ok INTEGER`. `builds_on` kept for old rows, ignored for new ones. `parent_job` unchanged (retrain chain = *attempts*, never lineage).

### 5.4 Runtime stack (`applied` table, journal)

`applied` +: `position INTEGER`, `journal_path TEXT`, `stack_sha256 TEXT`. Journal file `<patchDir>/journal/<patch_sha256>.npz = { addrs int64[N], prev float32[N,160], applied_at, stack_sha256 }` written from the hook's returned `prev`. kv `runtime.stack` = ordered ids, re-asserted as a whole by the watchdog.

Child npz: members `addrs/before/after` unchanged in shape; a delta has N = touched rows only; plus a `meta` JSON member `{ export, base_stack:[{patch_id, patch_sha256}], pre_state_sha256, trainer_version }` so a bare file is self-describing to `scripts/patch.py` and RUN-LOCALLY users.

### 5.5 Catalog lineage graph (`ainize-core/src/catalog.ts`, `api.ts`)

Children still derived from `parents[]`. New derived fields per entry: `edges_out: {to, kind}[]` where kind = `derivation.kind` when present, `'version'` for supersede records, `'track'` when `branch` differs from the parent's, `'declared'` when `derivation` is absent. `GET /api/patches/:id/tree` (§12.5) walks `entryMap()` (drafts + test anchors included) and filters per caller with `relativeVisible`/`mayUseEntry`, visited set (cycle-safe), depth cap 16, placeholder `{ missing: true }` for unknown ancestors.

### 5.6 Signals aggregates (node-local, materialised at write time)

```
patch_signals_daily(patch_id, day, tests, hits, misses, unscored, marked_wrong, preflight_wrong_today,
                    preflight_in_base, preflight_base_conflict, overlaps_pointed, derive_fetches, builds_on_jobs,
                    parent_regression_fails, visitors_hll BLOB)
patch_issues(id, patch_id, kind 'own_miss'|'preflight'|'free_wrong'|'request'|'gap', cluster_key, count, people,
             text NULL unless consented, sample_index NULL, topic, first_seen, last_seen, status 'open'|'covered_by:<id>')
requests(id, patch_id, topic, prompt_hash, prompt NULL, visitor_hmac, ts)
```
`events.data.visitor` becomes `'v:' + HMAC-SHA256(node_secret, ip|address)[:16]` at write time; `publicEvents` strips `visitor` and the `by …` suffix for every kind; `events` gets a 90-day retention now that counters are materialised.

### 5.7 Ledger

No new `RecordKind`. Fork, extend, update, contradict and merge are anchors with `derivation`; a consented update emits the existing `supersede` record, signed by the superseded anchor's author (same teaching key via the node, or an adopted correction). `LocalLedger`/`AinLedger` ingest stays hash + signature only; readers treat unknown parents as placeholders. AIN `explore()` keeps `parentEntry = parents[0]` and the others as `type: 'related'` (F14) — documented limitation; `/market/patches` mirror carries the full anchor and is the authoritative source for the tree.

---

## 6. Dataset inheritance rules

### 6.1 Availability levels (`anchor.dataset.access`, chosen in SC-8, enforced in `teach.publish` and `market.announce`)
- **public** — anyone with a valid `x-ainize-auth` signature may `GET /p2p/dataset/<sha>`; the knowledge page offers *Download*.
- **derivative** (default for `origin:'teach'` anchors created after this feature) — served to a teaching key that posts a signed *derive intent* `{ parent_id, child_key, ts, sig }` to any node holding the blob; the intent is logged as a count (*built on N times*). A child that carries rows `from:'<X>#i'` without `X ∈ parents` is rejected at announce (`missing_dataset_parent`). A child published elsewhere without listing X cannot be prevented cryptographically; X's operator sees it in the console (SC-18) — it is **never** shown on a public page (§16 R7).
- **private** — sha only; *Build on this* disabled with SC-9 copy; *Combine* possible only as *Just combine* when rows are disjoint (no questions needed). Default for operator-registered anchors and for every anchor that predates the feature. `retention: delete_after_training` forces private (SC-8 copy).

Honesty note: because `benchmark.samples` already publish the trained slice (F10), "private" protects only notes, untrained rows and failed alt prompts until the 32-sample cap ships; SC-8 says so.

### 6.2 What is inherited
`rows.jsonl` `{prompt, answer, alt_prompt}` (+ `note` only if opted in), the full benchmark list, `contrast_used`, and `fact_addrs` (the addr→question map) from the manifest — enough to show and edit the rows, use them as the keep-set in the trainer, detect conflicts by key, and recompute the sha. Never: `source.<ext>`, `report.json`, the owner key beyond the contributor entry, visitor ids.

### 6.3 Proof by sha
- **Whole-copy (extend/fork):** verifier fetches parent and child blobs; every parent canonical row `(prompt, answer)` must appear byte-equal in the child unless listed in `manifest.changed[]`/`removed[]`; `child.rows = parent.rows + added − removed`; `removed == 0` for `extend`, `changed > 0 ∨ removed > 0` forces `update`/`contradict`.
- **Partial (merge, delta-only):** each child row with `from` must byte-equal the referenced parent row at that index.
- **Private parent:** the parent anchor's `merkle_root` lets the child ship inclusion proofs (`log2(rows) × 32 B` each) in its manifest without revealing the rest.
- The verifier records `dataset_ok` and the recomputed `inherited_rows` per parent in the attestation score (§11 uses the verified numbers, never publisher-reported ones).
- Failure at announce: `dataset_inheritance_mismatch`.

### 6.4 Licences (dataset-first; the .npz is a build)
Fixed list in core: `CC0-1.0`, `CC-BY-4.0`, `CC-BY-SA-4.0`, `ODC-By-1.0`, `Proprietary`. Rules at child publish: CC0/CC-BY/ODC-By parent → any child licence, attribution automatic via `parents[]` plus *Built on {name} by {author}* appended to the description; CC-BY-SA parent → child must be CC-BY-SA with access ≥ parent's; Proprietary parent → child may build on top (parent earns the lineage share) but publishes **delta-only**: inherited rows are excluded from the child's blob and referenced by parent sha + row indexes, and their benchmark samples are omitted. Unknown string → `400 bad_license`; incompatible → `400 license_incompatible { parent, parent_license }`.

### 6.5 PII and rights (design §12.2, now server-side)
Parser adds row status `pii` (email, phone incl. `010-`, 주민등록번호 pattern, card numbers via Luhn): trains fine, hard-blocks publish above private (`400 dataset_pii { rows }`). Publish body carries `declaration: { source: 'own'|'public'|'licensed', license, no_pii: true }`, required when `rows ≥ declarationRows` (100) → `400 dataset_declaration`. `PublishSheet` sends the real checkbox state; the node refuses when either consent is false. Fetched parent rows are re-run through control/bidi stripping and the operator's `blockedTopics` and are rendered as text, never markdown.

### 6.6 Storage, serving, mirroring
`GET /p2p/dataset/:sha` uses the `/p2p/blob` gate (`x-ainize-auth` over `dataset:<sha>`, 5-min skew) plus `mayReadDataset(sha, address, intent|token)` reading `access` from the catalog. `GET /p2p/datasets` lists held shas; `PeerInfo.datasets` advertises them. A child node keeps the parent blob it fetched and re-advertises it, so a parent node going offline does not orphan the line. ~0.6 KB/row → a 2,761-row set ≈ 1.7 MB.

### 6.7 Fork and merge identity
Fork: `POST /api/patches/:id/fork` creates the owner-scoped dataset described in Story B; editing an inherited row's answer rewrites it in place with `replaces` set. Merge key = the parser's normalised prompt (F13); identical prompt + answer → one row keeping the first parent's `from`; same key + different answer → the existing D11 `conflict` status carried into SC-14; resolutions stored in `teach_jobs.resolutions`.

---

## 7. Trainer contract (`/mnt/newdata/qwen3.8/train/teach.py`, `flashtrain`, GPUs 4–6)

**Corrected 2026-09-05 (L3, as built).** There is no version gate: nothing in `packages/node` reads a trainer version, and a node cannot know what its container holds before it runs it. The trainer reports `{"event":"version","version":2,…}` on its first stdout line and the recipe carries `trainer_version`, but neither *enables* anything — the real gate is the post-hoc refusal in `teach.ts train()`: with `parents` in the job, a run that finishes without `recipe.parents[].loaded`, `recipe.export` and `recipe.pre_state_sha256` fails the job with `trainer_no_parents`, and a second, softer gate (`lineageFields`) omits `anchor.base` entirely, so the lesson publishes as *declared parent — not trained on top* rather than claiming a base it never had.

### 7.1 job.json additions
```json
{
  "parents":     [{ "patch_id": "krx-all-2761", "sha256": "…", "npz": "/work/.teach/<job>/parents/0-<sha>.npz" }],
  "known_file":  "known.jsonl",            // inherited rows: KEEP targets (answer must stay), up to max_known of them
  "max_known":   64,                        // clamp(8, ceil(added_rows/2), 64); always includes rows whose addresses intersect the new facts
  "replaces":    [3, 7],                    // fact indexes that deliberately override inherited rows: not frozen, not in the keep-set
  "export":      "delta",                   // "delta" | "squash"
  "mask":        { "mode": "none" },        // or { "mode": "only", "facts": [0], "addrs": ["4001",…]|null } for retrain-tier merges
  "probe_with_parents": true
}
```

Two more corrections from building it (L3): `max_known` rows are sampled **once per run**, not per step — the corpus is built once, `known_used` is one number, and resampling would widen the delta and the step time across a run whose whole budget is the 30-minute `trainer.timeoutMs`; what the sampling is *for*, the F8 guard ("always including rows whose addresses intersect the new facts'"), is kept exactly and reported as `recipe.known.intersecting`. And `mask` is `facts` + `addrs` as the node actually writes it, not an `allowed.npy` file: `addrs: null` means the trainer resolves the addresses from those questions itself (via `engram.core.addresses`) and **fails the job** if it cannot.

### 7.2 Load sequence (~30 lines)
After `hf_model.load_model`: for each parent in order `d = np.load(p.npz)`; verify `sha256(file) == p.sha256`; `pa = torch.from_numpy(d['addrs'])`; for squash only, `base_vals.setdefault(addr, rows.table[pa])`; `rows.table[pa] = torch.from_numpy(d['after']).to(torch.bfloat16)` (the `train_all.py:105` pattern). Emit `{"event":"parents","loaded":n,"rows":N}`. ~~Compute `pre_state_sha256` over the union of parent addrs.~~ **Corrected 2026-09-05:** `pre_state_sha256` is computed at export time over **the child's own exported rows** (§5.1) — `ainize-node/src/api.ts` recomputes it from the published file's `addrs`+`before` when a lesson is imported, so a hash over anything else makes the anchor unrecomputable from the artefact and silently breaks `patch import`. **Then** run the baseline probe and the contrast probe, so parent samples survive the "does the model already answer it" filter (F2) and act as a regulariser. The existing `original.setdefault(ad, rc[i].clone())` stays untouched — first touch now records the parent-loaded value, which is exactly the delta `before`.

### 7.3 Loss and masks
New facts train as today. `known` rows are trained as keep targets (answer-token loss on the parent's own `Q:/A:` renderings), never as new facts; rows in `replaces` are excluded from the keep-set. `mask.mode == 'only'` zeroes gradients outside `allowed` (the `pinpoint.py:43,55` pattern). This addresses the measured failure (shared digit/template rows pushed in opposite directions, F8) in the trainer, not by row arithmetic.

### 7.4 Export
- **delta:** rows = touched addrs; `before` = value at first touch (parent.after on overlap, disk base elsewhere); `after` = table.
- **squash:** rows = touched ∪ all parent addrs; `before` = disk base everywhere (from `base_vals`); `after` = table. Offered for buyers who cannot stack; the anchor records `derivation` but `base.export = 'squash'` and an empty stack.
- Both: bf16-rounded float32 so equality checks are exact; `meta` member (§5.4).

### 7.5 recipe.json additions
`parents[{patch_id, sha256, rows, loaded: true}]`, `export`, `pre_state_sha256`, `fact_addrs {fact_index: [addr…]}` (via `engram.core.addresses` over every trained rendering — `pinpoint.py` already does this), `known_used`, `timing { load_s, step_s_mean, eval_s_mean, steps, evals }`, and `touched_rows`. RUN-LOCALLY.md: *Load {parents} first, in this order, then this file.*

**Corrected 2026-09-05 (L3 adversarial pass).** `timing` does not "populate `teach_stats`": `load_s`, `steps`, `avg_step_s`, `total_s` and `rows` have always flowed from the `done` EVENT (`teach.ts putTeachStat`), and the only field that was ever missing is `sentences`, which the node was faking as `questions × 4` and the trainer now sends. `timing` lives in recipe.json so §7.8 can be re-measured from artefacts; nothing reads it at runtime. `touched_rows` is added because it is not derivable: for a squash, a file that CARRIED its parent's rows and one that OVERWROTE them have the same address list, and only the count of rows the run actually wrote through separates them — `scripts/lineage-verify.py` bounds the movement with it.

### 7.6 CHECKING with the chain (`teach.ts` worker, replaces the reverse-order step at :1554)
1. Remove everything under the cross-process lock.
2. Apply `bases` in order with `prev == before` verification (read-first, §8).
3. Measure the parent baseline: each parent's benchmark samples (capped per parent by `parentSamplesMax` but always including every question the child overrides).
4. Apply the lesson delta on top; a `prev != before` here is a trainer bug → job fails `base_state_mismatch`.
5. Measure `taught`, `heldout`, `locality` as today **and** `parent_regression` per parent with the lesson ON TOP: ≥ 0.9 per parent, and 100 % on inherited rows the child did not override; store failing sample ids in `parent_check` so SC-7 names them. Squash exports are additionally measured ALONE against parent samples (they carry the parent rows).
6. **Reversibility assertion:** remove the lesson via the journal, re-ask the parent samples, require them unchanged → `reversibility_ok` (SC-7 `teach.res.reversible`).
7. Remove the stack in reverse, re-apply pinned patches. Call budget stays ≤ 68 with slots reserved per source.

### 7.7 Verifier (`runtime.verify` → `verifyStack`, `verifier.ts`)
For anchors with `base`: apply the stack, then the candidate; benchmark stratified — `min(20, n_child)` child samples + every override/conflict question + parent samples filling the cap (raised to 64 for lineage anchors); pre-apply baseline measured with parents loaded; pass = child ≥ 95 % (all if < 10) **and** each parent ≥ 90 % **and** `dataset_ok`; restore in reverse via the journal; re-apply-on-restart re-applies the whole stack. Attestation score gains `stack`, `per_source`, `dataset_ok`, `inherited_rows`. Verifier eligibility: the node must hold every parent blob — verify children preferentially on nodes that already pin the parent and grant verifier download tokens for parent blobs.

### 7.8 Cost (measured, to be re-measured before shown)
Model load 67.1 s (`.teach/measure-1/recipe.json`); measure-1 wall time implies ≈ 107 s per step + eval cycle (the "~35 s/step" figure is not reproducible from artifacts); retrain-tier merge ≈ 67 s + a few masked steps ≈ 2–5 min; full rebuild of a krx-scale set ≈ 6 h of 3 GPUs; row union: seconds. SC-14 minutes come from `teach_stats` once `timing` is populated; until then the `merge.tier_untimed` copy is shown.

---

## 8. Apply and remove along a chain (`runtime.ts`, `market.ts`, `scripts/patch.py`)

1. **Ordered stack.** `market.applyStack(ids)` resolves each anchor's `base.stack`, orders bases before children, takes the cross-process lock once for the whole sequence.
2. **Read-first verification.** For each patch: `patch.py check <npz>` reads the current rows (`_read`, F4) and compares to `before` bf16-exact on **all** rows (not a sample); mismatch → `409 base_mismatch` and nothing is written. Then `apply`, which writes `after` and saves the hook's `prev` to the journal. Legacy anchors (no `base`) go through the same path but skip the equality gate (their `before` is the disk base and may legitimately differ under other patches); they still get a journal.
3. **Rule for delta children.** The base stack must be applied **below, in order**; an unrelated patch between parent and child is allowed as long as the full `prev == before` check passes (§16 R8).
4. **Remove.** `market.removePatch(id)` refuses when a child of `id` is applied (`409 has_dependents { ids }`) unless `--cascade`; otherwise it replays the journal (restoring whatever was there, which equals `before` when the stack was correct) and re-asserts the remaining stack. `status` becomes journal-aware (compare sampled rows to the `after` of the topmost patch owning each addr) instead of the 2,000-row majority test.
5. **Watchdog.** Checks the top of the stack; on revert (vLLM restart) re-applies the entire ordered stack instead of per-patch `isApplied → apply` (fixes F5).
6. **Chat stack builder.** Selecting a child in the picker auto-adds its `base.stack` (*Loaded with {name}*); the chat `applyRaw` list order is derived from base stacks, not tick order.
7. **Buy time.** 402 body carries `requires[]`; `?bundle=1` buys the missing bases first (separate settle records); `ainize use <child>` applies the stack.

---

## 9. Merge algorithm, conflict UI, rebuild option

**Step 1 — question-level merge (always).** Union A and B by the parser key (F13). Identical → one row (first parent's `from`). Same key, different answer → conflict; must be resolved before any build (`409 merge_unresolved`). Resolutions: `keep_a | keep_b | own(answer) | drop`; recorded per key; bulk *Prefer A/B* fills the rest. The merged canonical rows keep `from` for every surviving inherited row; `dataset.parents = [A, B]`.

**Step 2 — row-level measurement (`npz.ts`: `intersectionCount` + new `valuesEqualCount` over bf16 `after`).** Reports shared addresses, disagreeing rows, and the questions that own them (from each parent's `fact_addrs`, or rebuilt offline with `engram.core.addresses` when the parent recipe predates the field).

**Step 3 — build tier.**
- **T0 Just combine** (node-side numpy, seconds): allowed iff address sets are disjoint OR every shared address has bf16-identical `after`, AND no question conflicts. Output = row union, `before` = disk base (stand-alone, `export:'squash'`, empty stack) — or a delta over `[A, B]` when the creator wants an add-on that needs both.
- **T1 Retrain the disagreeing questions** (default when rows disagree): trainer loads A then B (order chosen, default larger first), `known` = merged dataset, targets = conflicting questions with the chosen answers + new rows, `mask.only` = addresses of those questions' renderings, export delta over `[A, B]`; minutes.
- **T2 Rebuild everything** (publish-grade): full run from the merged dataset with no parents loaded, export squash; hours for krx-scale; **required** when > 20 % of a parent's shared rows disagree (pin/pixel 96 %, ep6/ep12 99.9 %).
- **Forbidden:** additive (base + ΔA + ΔB) and averaged rows (F8). Row-wise prefer-A/B without retraining is exactly today's apply order and is never a merge result.

**Step 4 — verification** stratified per source: A's samples ∪ B's samples ∪ resolved conflicts (with the resolved answers), ≥ 90 % per parent, ≥ 95 % on resolved conflicts, `per_source` in the attestation; SC-14 shows the three numbers.

A private parent can only be a T0 candidate when rows are disjoint (SC-14 `merge.private_parent`). Retrain chains (`parent_job`) are attempts, never merges. Supersede of A by the merge only with A's author's consent (Story B outcomes).

---

## 10. Demand and quality signals

| Signal | Scope | Source | Shown as |
|---|---|---|---|
| sales, unique buyers, revenue | network | `settle` records (30 d + all-time), price-0 and author/verifier fetches excluded | SC-11, Explore shelves |
| royalties received from descendants | network (approximate, address-keyed) | `settle.royalty` | teacher profile |
| children by kind, versions, tracks | network | `parents[]` + `derivation` + supersede/branch records | tree |
| holders of body / dataset | network | `PeerInfo.blobs / datasets` | SC-11 "loaded on N nodes" |
| track subscribers, challenge, verification ratio, `per_source` scores | network | ledger | SC-11, tree |
| live tests, ✓/✗, unscored, unique visitors (HLL over HMAC ids) | this node, 30 d | `patch_signals_daily` | SC-11, SC-12 |
| per-benchmark-sample misses | this node | usage events now record the matched `sample_index` | SC-12 *own* (prompts public) |
| pre-flight `will_train` / `in_base` / `base_conflict` with X as base | this node | recorded at `/preflight` and worker preflight | SC-12 *preflight* clusters (counts + cluster label; text only if later published or shared) |
| free questions marked wrong | this node | SC-13 (`POST /api/chat/feedback`), text only with *Share* | SC-12 *free* |
| buyer requests | this node | `POST /api/patches/:id/requests` | SC-12 *requests* (requester's own text) |
| coverage gaps | this node | siblings in `topic_path` whose keys X lacks | SC-12 *gap* |
| derive fetches, builds-on jobs | this node (serving node) | derive intents, job creation | *built on N times* |

**Doing well this week** score (Explore sort, per node): `3·sales7d + 2·builds_on7d + 1·loads7d + 0.5·tests7d·hit_rate`. **Most built on** = children + derive fetches all-time. **popular** keeps status-first then downloads then passed, minus price-0 settlements.

**Issue lifecycle.** `patch_issues.status` flips from `open` to `covered_by:<child>` when a descendant's published dataset contains the issue's key; the READY card says *Closes n open questions of {name}*.

**Privacy preconditions (ship first):** HMAC visitor ids at write time; `publicEvents` strips `visitor` and the `by …` suffix for every kind; prompt text stored only with the per-turn or per-row consent flag (otherwise `HMAC(prompt)` for *asked N times*); `events` retention 90 days; `/api/patches/:id/demand` exposes counters only; guard-truncated answers are counted, not stored.

---

## 11. Royalties along multi-parent lineage

**Rule (revised 2026-09, critique-3 item 192 / critique-4 items 309, 310, 325 — `royaltyPlan` in `ainize-core/src/catalog.ts` is the single implementation).**

`pool = amount × share` where **`share` is the anchor's own `royalty_share`**, floored at `NETWORK_MIN_ROYALTY_SHARE` (0.3) — never the SELLING node's `market.royaltyShare`, which the seller controls (item 191). `createDraft` writes `royalty_share = max(floor, this node's config, every parent anchor's declared share)`: a derivative may promise its ancestors more than they promised, never less.

The pool is split **equally among the unique ancestor authors other than the seller**, reached through `parents[]` with a visited set and **no depth cut** (item 192: the old `depth > 16` return paid an 18-hop ancestor nothing, and the walk is capped at `MAX_LINEAGE_ANCHORS` = 4096 anchors with a `truncated` flag instead). An ancestor authored by the seller is **not a payee and not a divisor**: a version chain of the seller's own bakes no longer halves every outside creator's share from day 2 (which is what worked example 8 below used to cause).

A parent id the seller's node cannot resolve is **not skipped**: the anchor that names it also names `parent_authors[i]`, so the slice is paid to that author; only when nothing names an author is the slice **held back** and written onto the settlement as `royalty_unresolved[parent_id]` (item 310 — before this the pool was 0 and the seller silently kept 100 %).

Pass 1b shares an outside ancestor anchor's slice with that anchor's `contributors[]`. A contributor credited on one of the **seller's own** ancestor anchors is instead paid from the seller side in pass 2, once per address at the largest share they hold, so "your share of this node's take" survives the seller re-baking on top of itself.

Pass 2 spends the seller side `(amount − pool)` in one order: **the verification fee** `sellerSide × verifier_share` (anchor field, floored at `NETWORK_MIN_VERIFIER_SHARE` = 0.05) divided equally among the attestations that currently count toward the quorum (item 325 — verifying was unpaid work everywhere in this product); then each data provider's `c.share` of what is left; then the seller keeps the remainder.

Addresses are summed **case-insensitively** under their first-seen spelling (item 309), and every reader — `creditBalance`, `/api/me/wallet`, `payouts.enqueue` — compares them case-insensitively too. Σ payouts + Σ unresolved ≤ price holds structurally (pool ≤ amount×share, every carve ≤ its base, `settlePayment` last-line guard).

**Fix first (F9).** Pass 2 carves each seller-side contributor from the **fixed** remainder `(amount − pool) × share` and `createDraft`/`publish` clamp Σ contributor shares ≤ 1.

**Enforcement.** A child whose `dataset.parents` or `from` rows name X must list X in `parents[]` (`missing_dataset_parent`), so inheriting rows without paying X is impossible by construction. Dataset fetches are free by default; an optional `billing.dataset_price` (x402) counts as a sale and triggers the same split.

**Recorded, not paid (v1).** `derivation.bases[].rows` and the verifier's recomputed `inherited_rows` make a rows-weighted "계보 지분" computable later without a ledger change; payouts stay equal-split until a separate decision (§16 R4).

**Worked examples (share 0.3, price 10 unless stated; all sums equal price).**
1. *Extend.* A (author a) ← B (author b, extend). Sale of B: pool 3 → a 3; b 7. With B's contributor d at share 0.5: b's remainder 7 → d 3.5, b 3.5. Σ = 10.
2. *Depth.* A ← B ← C (authors a, b, c). Sale of C: pool 3 split {a, b} → 1.5 each; c 7 (matches `core.test.ts:264-268`).
3. *Merge.* M (author m) = merge(B, C) where B ← A (a), C by c. Ancestors of M: {b, a, c} → pool 3 → 1 each; m 7. Σ = 10.
4. *Same author twice.* M = merge(A, C), both by a. Unique authors {a} → a gets the whole pool 3; pass 1b splits a's slice equally across anchors A and C (1.5 each) and carves each anchor's contributors from its 1.5; m 7.
5. *Pass-2 fix.* M has contributors p (0.5) and q (0.5). Today: p 3.5, q 1.75, seller 1.75. Fixed: p 3.5, q 3.5, seller 0. Σ = 10 both ways; only the split is corrected.
6. *Seller is an ancestor.* B by b, sold by b, with parent A by b: a-slice folds into the seller → b 10 (minus contributors).
7. *Bundle purchase.* Child C (price 5, author c) built on X (price 25, author x); buyer holds neither. Two settlements: X sale 25 → x 25 (minus X's contributors); C sale 5 → pool 1.5 → x 1.5; c 3.5. Each sale Σ = its price; the buy sheet states that x is paid twice.
8. *Update with consent.* V2 supersedes V1 (both by v); V2 lists V1 as parent. Sale of V2: v is the seller, so V1 creates **no pool and no divisor**; V1's contributors still earn, from the seller side (pass 2). A 20-day chain of v's bakes on top of a's original therefore still pays a the full 3, on day 2 and on day 20.
9. *Verification fee.* K (author k, no parents, price 10) verified by v1 and v2: seller side 10 → fee 0.5 → v1 0.25, v2 0.25, k 9.5. With a parent by a: pool 3 → a 3; seller side 7 → fee 0.35; a data provider at 0.5 → 3.325; k 3.325.
10. *Unresolved ancestor.* C names parent P that this node does not hold. `parent_authors[0] = 0xA…` → 0xA… is paid the 3 as if P had resolved. With no author named anywhere, the settlement carries `royalty_unresolved: {P: "3"}` and the seller is paid 7, not 10.

**Display.** SC-8 `teach.pub.money` and the tree's *Money* line are computed by `royaltySplit` on a unit price so the creator sees the actual recipients before publishing; `/api/teacher/:address` adds *earned from knowledge built on yours: {amount} ({n} sales)* labelled approximate.

---

## 12. API

All new fields optional unless stated. Errors are `{ error: '<code>', ...details }`.

### 12.1 Teach jobs
`POST /api/teach/jobs` body +: `base_ids: string[]` (ordered, ≤ 2: one for extend/fork, two for merge; replaces `builds_on_context`), `context_ids: string[]` (comparison-only loads, ≤ 3), `mode: 'scratch'|'extend'|'fork'|'merge'`, `inherit?: boolean` (default true), `resolutions?: { [key]: 'a'|'b'|{answer}|'drop' }`, `tier?: 'union'|'retrain'|'rebuild'`, `export?: 'delta'|'squash'`. Errors: `400 base_unknown`, `400 base_private { id }`, `400 base_retired { id, newer }` (SUPERSEDED — allowed with `force:true`, warned), `400 base_rejected`, `403 base_not_available` (another key's draft), `409 base_not_held { id }`, `400 base_cycle`, `400 base_stack_too_deep` (> 8), `400 too_many_bases`, `400 base_unresolved_conflicts { rows }`, `409 merge_unresolved { conflicts }`, `400 tier_not_allowed { reason: 'rows_disagree'|'private_parent' }`. Legacy `builds_on_context: true` maps to `base_ids = patch_ids` with a `Deprecation` header. Response +: `bases`, `inherited_rows`, `conflicts`, `mode`.

`POST /api/teach/preflight` body +: `base_ids`, `context_ids`; per-fact status +: `in_base { base_id }`, `base_conflict { base_id, base_answer }`. Side effect: increments `patch_signals_daily.preflight_*` per base.

`GET /api/teach/jobs/:id` +: `bases`, `mode`, `derivation`, `checks.parent_check[]`, `checks.reversibility_ok`.

`POST /api/teach/jobs/:id/publish` body +: `dataset: { access, license, include_notes?, declaration?: { source, license, no_pii } }`, `outcome?: 'extend'|'correct'|'track'|'update'`, `track?: { name, context: Record<string,string> }`, `consent: { permanent, rights }` (real values). Errors: `400 parent_not_listed { id }`, `400 dataset_pii { rows }`, `400 dataset_declaration`, `400 bad_license`, `400 license_incompatible { parent, parent_license }`, `400 missing_dataset_parent { id }`, `403 update_needs_author_consent`, `400 consent_required`.

### 12.2 Merge
`POST /api/teach/merge/preview { a, b }` → `{ questions: { a_only, b_only, same, conflicts: [{ key, prompt, a_answer, b_answer, a_row, b_row }] }, rows: { a_only, b_only, shared, disagree, opposing }, tiers: { union: { allowed, reason? }, retrain: { allowed, est_min|null }, rebuild: { allowed, est_min|null } }, licenses: { a, b, child_min } }`. Private parents → `questions: null`, rows only. Then `POST /api/teach/jobs { mode:'merge', base_ids:[a,b], resolutions, tier }`.

### 12.3 Fork and datasets
`POST /api/patches/:id/fork { name? }` → `201 { dataset_id, inherited_rows, parent: { patch_id, dataset_sha256 }, license }`; `403 dataset_private`, `404 dataset_unavailable` (no holder), `402` when `billing.dataset_price` is set.
`GET /api/patches/:id/dataset` → `{ sha256, rows, access, license, parents, preview: [20 rows] }` or `403 dataset_private | dataset_derivative_only`; `GET /api/patches/:id/dataset/rows` (public access, or owner/operator) → `application/x-ndjson`; `GET /api/patches/:id/dataset/manifest`.
`POST /api/patches/:id/derive-intent { child_key, sig }` → `{ token, expires }` (counted).
P2P: `GET /p2p/dataset/:sha` (auth as `/p2p/blob`, header `x-ainize-derive` for derivative), `GET /p2p/dataset/:sha/manifest`, `GET /p2p/datasets`.

### 12.4 Buy, apply, remove
`POST /api/patches/:id/buy` on a child → `402` body +: `requires: [{ id, name, price, currency, held }]`; `?bundle=1` buys the missing bases first (one settle per purchase).
`POST /api/patches/:id/apply { with_base?: true }` → `409 needs_base { missing }`, `409 base_not_held { missing }`, `409 base_mismatch { patch_id, rows_differ }`. `DELETE /api/patches/:id/apply { cascade?: true }` → `409 has_dependents { ids }`. `GET /api/runtime/stack` → ordered applied list with journal presence.
Operator `POST /api/patches` accepts `parents`, `base_stack`, `derivation`, `dataset { access, license, file }`.

### 12.5 Tree, signals, issues
`GET /api/patches/:id/tree?depth=4&dir=both` → `{ root, nodes: [{ id, name, author, author_name, taught_by?, contributors[], status, superseded_by[], branch, derivation, base_stack[], export, dataset: { sha256, rows, access, license }, added: { rows, questions, changed, removed }, signals: { sales_30d, sales_all, loads, tests, hits, builds_on, subscribers, passed, open_questions }, missing?: true }], edges: [{ from, to, kind: 'extend'|'update'|'contradict'|'merge'|'version'|'track'|'declared' }], truncated }`.
`GET /api/patches/:id/signals` → `{ network: {…}, node: { window_days: 30, … } }`.
`GET /api/patches/:id/issues?kind=&limit=` → `{ items: [{ id, kind, count, people, topic, text: string|null, sample_index: number|null, status, first_seen, last_seen }] }`; `POST /api/patches/:id/issues { kind:'request', topic, text?, share }`.
`POST /api/chat/feedback { turn_id, patch_ids, verdict:'wrong', share: boolean }`.
`GET /api/patches/:id` +: `derivation`, `base`, `dataset.access/license/parents`, `requires: [{ id, name, held, price }]`; `lineage` stays one level deep for compatibility. `GET /api/events` and `/api/patches/:id/events` no longer return `data.visitor`.

### 12.6 Announce-time validation (shared by both doors)
Every parent resolves in `entryMap()` and is LISTED/ANNOUNCED/VERIFYING; no cycle; `base.stack ⊆ parents`; `derivation.bases ⊆ parents`; `dataset.parents ⊆ parents`; `from` rows imply parent membership; `dataset.sha256` recomputed from the snapshot blob; licence compatibility; ≤ 32 on-chain samples + `answers_hash`; Σ contributor shares ≤ 1. `conflicts()` skips pairs where one anchor is the declared base of the other; `reconcileSupersedes` writes a supersede only for anchors with `derivation.kind = 'update'` whose supersede is signed by the old anchor's author (§16 R6).

---

## 13. CLI (`packages/cli`)

```
ainize teach train <file|dataset-id> --on <id>[,<id>] [--compare a,b] [--mode extend|merge] [--tier union|retrain|rebuild]
                   [--resolve conflicts.json] [--export delta|squash] [--no-inherit]
ainize teach preflight <file> --on <id>
ainize teach publish <job> --dataset-access public|derivative|private --dataset-license <spdx> --declare own|public|licensed
                     [--include-notes] [--outcome extend|correct|track|update] [--track name k=v,…]
ainize teach status <job>          → "Built on {name} (delta) · adds n · changes k · {name} still answers h/t with the lesson on top · reversible: yes"
ainize patch fork <id> [--name …] [--copy-only]
ainize patch merge <a> <b> [--preview] [--resolve file] [--tier …]      (unresolved conflicts printed as JSON, exit 3)
ainize patch tree <id> [--depth n]  (ASCII family tree with "+n questions" per node)
ainize patch missing <id>           (open questions, counts and consented text)
ainize patch signals <id>
ainize patch buy <child> [--bundle] (prompts "also needs {name} ({price}); buy both? [y/N]")
ainize patch apply <id> [--with-base]   ·   ainize patch remove <id> [--cascade]   ·   ainize patch stack
ainize dataset get <patch-id|sha> [-o file] [--manifest] [--include-notes]   (403 prints the plain-language reason; exit 3)
ainize publish … --parents a,b --dataset-access derivative --dataset-license CC-BY-4.0
```
`teach train --patch a,b` remains as comparison-only context with a warning that it no longer records a base.

---

## 14. Compatibility, and the revision of D12

**Existing anchors.** Anchors without `derivation`/`base` are stand-alone builds: apply order last-wins as today, equal royalty split, one-level `lineage` unchanged, tree edge kind `declared` with the SC-9 legacy chip. They gain a journal on their next apply, so removing one no longer reverts neighbours — a strict improvement. Old peers ignore the new optional fields. The AIN round-trip needs `withEmptyArrays` entries for the three new arrays.

**Demo seed (`ainize-node/src/seed.ts`).** `ep6 → ep12 → krx-all-2761` is relabelled as **versions** (supersede records), not parents, because their address sets are identical with 99.9 % divergent `after` (F8) — apply order is meaningless there; the `pixelplus → krx-all` parent link is dropped (it is a measured conflict, not a derivation).

**Design decisions revised.**
- `teachable-dataset-design.md` **D12** — *keep* hash-only provenance on the anchor; **overturn** "the dataset content is never published". New wording: *The anchor carries `{sha256, rows, source, access, license, parents}`; dataset bytes live in the content-addressed blob store and are served to derivative creators under `access`; ≤ 32 trained questions are public on the record in any case (benchmark samples).* Rationale: the patent ships R = (S, B) inside P by default (claim 8, [0032]) and degrades to synthesis only when S is withheld (claim 20); inheritance is impossible without content; and the promise is already broken by `benchmark.samples` (F10).
- `teachable-dataset-design.md` §1.1 non-goal "sharing a dataset between teaching keys, or publishing the dataset itself" — **overturned** for datasets whose knowledge is published with access ≥ derivative.
- `teach-mode-design.md` §2 non-goal "row-level merging; stacking is last-write-wins" — **overturned** (§9).
- `teach-mode-design.md` §5.5 `builds_on_context` — **retired**; replaced by `base_ids` + `context_ids`.
- Unique benchmark schema per lesson (§7.1) — **kept in v1**; schema inheritance is gated (§16 R6).

**Scenarios whose expectations change** (rewrite, do not delete): AZ-196 and AZ-199 ("dataset content is never published", "anchor carries no copy of the questions beyond benchmark samples") → *published under the chosen access level; anchor carries hashes and ≤ 32 samples*; AZ-201 / AZ-215 (owner-only 404 for a stranger's dataset; fork de-dupes per owner) → *strangers may fork when access ≥ derivative; de-dupe stays per owner*; AZ-105 / AZ-159 / AZ-188 (pre-flight semantics) → *judged with the base loaded*; AZ-114 (lineage pool pass 1b) → *unchanged, plus the pass-2 fix*; AZ-107 / AZ-120 (private draft as context) → *becomes Story A3 with `parent_not_listed`*; AZ-180 (retrain no fork) → *unchanged, attempts are not lineage*; AZ-101 (last wins) → *order derived from base stacks, journal restore*.

---

## 15. Risks and guards

| Risk | Guard |
|---|---|
| Delta children break today's runtime (remove writes `before`, parent removed under a child) | Stack + journal + read-first `prev == before` ship **before** the first delta anchor; until then the node sends `export:'squash'` only, gated by `trainer.version`. |
| Cycles in `parents[]` (peer anchors can claim anything) | Tree walk with visited set; `base_cycle` at job creation; announce validation; `royaltySplit` already cycle-safe. |
| Hidden/test parents leak through the tree | Nodes filtered by `relativeVisible`/`mayUseEntry`; test anchors and drafts visible only to owner/operator; children derivation still links them internally. |
| Drafts as parents | Allowed at job time (own drafts), blocked at publish with `parent_not_listed`; never silently dropped. |
| Superseded / rejected parents | `base_retired` redirects to the newer version (claim-58 proxy); `force` allowed with a warning; REJECTED/CHALLENGED refused. |
| Cross-node parents | Blob required locally (`base_not_held`); dataset fetched from any advertising peer and mirrored; placeholders for unknown ancestors; `dataset_unavailable` when no holder. |
| Size growth of anchors / AIN free tier (~100 KB) | New fields ≈ 0.3–1 KB; 32-sample cap + `answers_hash`; `withEmptyArrays`; console meter (SC-18) and a stake-raise runbook at 80 %. |
| Cross-author supersede by overlap (F15) | `conflicts()` skips declared base pairs; `reconcileSupersedes` limited to consented updates — ships in the same PR as the outcome chooser. |
| Silent parent overwrite in training (F1/F2) | Parents loaded before probes; keep-set; CHECKING in deployment order; reversibility assertion. |
| Watchdog flips order after restart (F5) | Whole-stack re-assert. |
| Dataset exposure widens (PII, injection, rights) | Server-side PII scan, declaration, licence validation, control-char stripping + blockedTopics on fetched rows, text-only rendering, notes excluded by default. |
| Raw visitor IPs public (F11) | HMAC + strip precede any demand view. |
| Publisher-inflated row counts | Verifier recomputes `inherited_rows`; payouts do not use rows in v1. |
| Unverified per-step timings | Minutes only from `teach_stats`; `merge.tier_untimed` otherwise. |
| Verifier pool shrinks for krx-scale parents | Verify on nodes pinning the parent; verifier grants for parent blobs. |
| Merge identity misses paraphrases | Documented; advisory `shared_ending` stays; no auto-merge. |
| D11 "Keep this answer" drops other rejected rows on re-derivation | Fix before SC-14 relies on it. |
| Concurrent UX job on the same tree | Line numbers here are advisory; PRs rebase on the current files. |

---

## 16. Judges' disagreements, resolved

| # | Point | Positions | Decision |
|---|---|---|---|
| R1 | Merge / conflict **key** | creator-first: `teach.py normalise()` (NFKC, lower, punctuation stripped); git-mental-model: "casing/whitespace/punctuation-normalised"; correctness-first: parser rule | **Parser rule (F13):** NFC + control/bidi/zero-width strip + whitespace collapse, case-sensitive, no punctuation handling — the rule that already defines duplicates and D11 conflicts. `teach.py normalise()` remains the hit-detection rule only. |
| R2 | Scenario ids | brief says start at AZ-227; judges say AZ-232/233 now exist | **Start at AZ-234** (F16). |
| R3 | `prev == before` check | creator-first: 2,000-row sample + rows where `before != base`; correctness-first: all rows, read-first | **All rows, read-first dry pass** (`patch.py check`), no partial write to roll back. Legacy anchors skip the gate but get a journal. |
| R4 | Royalty weighting by rows | git-mental-model: rows-weighted with 10 % floor from `bases[].rows`; others: equal split | **Equal split stays.** Rows recorded on the anchor and recomputed by the verifier; a weighted rule needs verified numbers and an explicit decision. |
| R5 | ain-js `extends` edge per parent | git-mental-model: emit one per parent | **Not promised.** `relatedEntries[].type` is `'related' as const` (F14); the mirror is authoritative; documented limitation. |
| R6 | Benchmark-schema inheritance (claim 22) | git-mental-model: inherit; correctness-first: open | **Gated.** v1 keeps unique schemas; contradiction is detected off-ledger by key from dataset blobs. Schema inheritance for `extend`/`update` children lands only after `reconcileSupersedes` is limited to consented updates (PR-L5), behind a config flag. |
| R7 | "Took the training set without credit" badge | creator-first: public badge | **Operator-only** (SC-18): it is inferred from one node's derive intents and unprovable. |
| R8 | Base stack "directly below" | correctness-first strict; judges asked to relax | **Applied below, in order**, gated by the full `prev == before` check — an unrelated disjoint patch in between is allowed. |
| R9 | Derivation kind `correct` | creator-first introduced it | Not a patent concept. Creator label *Correct it* maps to `update` (same key or author consent) or `contradict` (other key; track when context attrs given). |
| R10 | Number of bases | 1 / ≤ 3 / depth ≤ 8 | `base_ids ≤ 2` (extend: 1; merge: 2), resulting `base.stack` depth ≤ 8 including ancestors. |
| R11 | Default dataset access | inherit-by-default vs opt-in | **derivative** for teach-origin anchors created after the feature; **private** for older and operator anchors; `delete_after_training` forces private. |
| R12 | Claim-20 fallback for private bases | build vs block | **Blocked in v1** with copy; `transfer` reserved. |
| R13 | Where "what's doing well" starts | correctness-first: knowledge page; creator-first: home shelves | **Both:** Explore shelves (SC-17) ship read-only after PR-L0 with derivation inferred from `parents[]`; the tree and issues panel on the knowledge page. |
| R14 | Bundle purchase paying the base author twice | creator-first | **Adopted and stated** on the buy sheet. |

---

## 17. Test plan (`docs/ux-test-scenarios.json`, new ids from **AZ-234**)

Each row: id · persona · title → expectation. `[stub]` = verifiable on the stub backend; `[gradient]` = needs the gradient trainer on GPUs 4–6; `[both]` = runtime/stack behaviour verifiable against the live hook with fixture npz files, no training.

- **AZ-234** Visitor · Chat door base row → the first loaded knowledge is the default base; the three consequences are visible; other loaded knowledges say *comparison only*; `POST /api/teach/jobs` carries `base_ids`/`context_ids`. [stub]
- **AZ-235** Visitor · Private-dataset base → `Build on` refused with `base_private` and SC-1 copy; the knowledge can still be loaded for comparison. [stub]
- **AZ-236** Visitor · Own private draft as base → job runs; publish blocked with `parent_not_listed`; after the draft lists, publish succeeds and `parents` names it. [stub]
- **AZ-237** Visitor · Superseded base → `base_retired` with the newer version named; `force` proceeds with a warning. [stub]
- **AZ-238** Visitor · Dataset door *Start from* required; *Start from its questions* merges inherited rows with `from` chips; filter counts Mine/Inherited/Changed/Conflicts correct. [stub]
- **AZ-239** Visitor · Pre-flight with base → statuses `in_base` and `base_conflict` returned; `base_conflict` rows block training until confirmed; counters written to `patch_signals_daily`. [stub]
- **AZ-240** Node · job.json carries `parents[]`, `known_file`, `export`; recipe.json records parents + sha256, `export:'delta'`, `pre_state_sha256`, `fact_addrs`, `timing`. [gradient]
- **AZ-241** Node · Delta export: `before == parent.after` on every overlapping address (numpy), only touched rows exported, `meta` member present; squash export carries parent rows with `before == disk base`. [gradient]
- **AZ-242** Node · CHECKING in deployment order → a lesson that overwrites an inherited answer fails `parent_regression` and SC-7 names the failing question; `reversibility_ok` recorded. [gradient]
- **AZ-243** Operator · `applyStack` on fixture parent+child → refuses a delta child without its base (`needs_base`), verifies `prev == before` on all rows, journals `prev`. [both]
- **AZ-244** Operator · Remove parent under an applied child → `has_dependents`; remove child → parent rows bf16-equal to before the child (parent benchmark unchanged). [both]
- **AZ-245** Operator · Simulated table reset → watchdog re-applies the whole ordered stack, order preserved (pin/ep12 fixtures). [both]
- **AZ-246** Operator · Legacy anchors (no `base`) load/unload through the journal without reverting neighbours (pin/pixel fixtures). [both]
- **AZ-247** Visitor · Publish records `derivation.kind 'extend'`, `base.stack`, `dataset.access 'derivative'`, licence, ≤ 32 samples + `answers_hash`; anchor ≤ 12 KB. [stub]
- **AZ-248** Stranger · Fork → owner-scoped dataset with `parent_patch`, rows `from:'X#i'`, re-fork de-duped, base preselected; *Detach* trains a stand-alone with `parents:[X]` and no stack. [stub]
- **AZ-249** Visitor · Fork that changes base answers → outcome chooser shows Addition / Correction / Different track; *Newer version* hidden for non-authors; *Different track* creates the branch record and `route` resolves it. [stub]
- **AZ-250** Author · Adopt a correction → new version lists the corrector as `data_provider`, supersede signed by the author; cross-author overlap alone never supersedes. [stub]
- **AZ-251** Any · `dataset get` for public / derivative / private → jsonl / requires derive intent / 403 with reason; notes excluded unless opted in; `PeerInfo.datasets` advertises fetched blobs. [stub]
- **AZ-252** Verifier · Tampered inherited row → announce rejected `dataset_inheritance_mismatch`; clean child → `dataset_ok` and recomputed `inherited_rows` in the attestation. [stub]
- **AZ-253** Visitor · Licence flow: CC-BY-SA parent forces child licence; Proprietary parent yields a delta-only blob and no inherited on-chain samples; unknown string → `bad_license`. [stub]
- **AZ-254** Visitor · PII row blocks publish above private with row indexes; ≥ 100 rows without declaration → `dataset_declaration`; unticked consent → `consent_required`. [stub]
- **AZ-255** Node · Published dataset survives sweep, `delete_after_training` and owner delete (tombstone keeps bytes); `delete_after_training` forces private with copy. [stub]
- **AZ-256** Any · Tree endpoint: cycle-safe, depth-capped, placeholder for an unknown ancestor, drafts/test anchors hidden from strangers, edge kinds version/track/declared correct, *added n / changed k* per node. [stub]
- **AZ-257** Any · Doing-well strip and Explore shelves/sorts computed from ledger + counters; price-0 settlements excluded; scope labels present. [stub]
- **AZ-258** Any · `/api/events` carries no IP; usage events store HMAC visitor ids; retention purges > 90 days while counters persist. [stub]
- **AZ-259** Visitor · Open questions: own misses (public prompts), pre-flight clusters (counts only), free question text only after SC-13 *Share*, buyer request, coverage gap; item flips to `covered_by` when a child publishes the key. [stub]
- **AZ-260** Visitor · *Teach this on top* opens Teach with base and prompt pre-filled. [stub]
- **AZ-261** Visitor · Merge preview on pin+pixel-like fixtures: question and row counts correct, T0 disabled with reason, T2 recommended (> 20 % disagree); disjoint fixtures allow T0. [both]
- **AZ-262** Visitor · Conflict step requires resolution; bulk prefer works; "Keep this answer" keeps other rows; policy recorded. [stub]
- **AZ-263** Node · T0 merge completes without GPU and passes both parents' benchmarks; additive option absent. [both]
- **AZ-264** Node · T1 merge trains only the conflicting questions under `mask.only`; verification stratified per source (a 1-question source failing fails the check). [gradient]
- **AZ-265** Any · Merge anchor has two parents, `derivation.kind 'merge'`, bases with rows; a sale pays both lines; worked examples 1–8 reproduce with Σ = price and the fixed pass-2 arithmetic. [stub]
- **AZ-266** Buyer · Child purchase without the base → 402 `requires[]`, *Buy both* creates two settlements, `ainize use` applies the stack in order. [stub]
- **AZ-267** CLI · `teach train --on`, `patch fork`, `patch merge --preview`, `patch tree`, `patch missing`, `dataset get`, `patch apply --with-base`, `patch remove --cascade` produce the same results and error codes as the API. [stub]
- **AZ-268** Ledger · AIN round-trip preserves `derivation`, `base.stack`, `dataset.parents` (`withEmptyArrays`); ledger-space meter reports usage. [stub]
- **AZ-269** Operator · Seed relabel: ep6/ep12/krx-all appear as versions, pixelplus is not a parent of krx-all; legacy chip shows on any remaining declared-only parent. [stub]

---

## 18. Implementation plan (PRs in order)

Legend: **[stub]** verifiable with `AINIZE_TEACH_BACKEND=stub` and fixture npz files; **[hook]** needs the live PLE hook (a throwaway vLLM with `ENGRAM_HOOK=1` on GPUs 4–6, never :8000/:8001 or the cluster :3402-3404); **[gradient]** needs `teach.py` in the `flashtrain` container on GPUs 4–6.

| PR | Scope | Files | Verify |
|---|---|---|---|
| **L0** Prerequisites | HMAC visitor ids + `publicEvents` strip; `events` retention; `patch_signals_daily`; `royaltySplit` pass-2 fix + two-parent test + Σ-shares clamp; licence list in core; PII row status; server-side declaration + real consent; `conflicts()` skips declared base pairs; seed relabel | `ainize-node/src/{market,api,store,teach,teach-dataset,seed}.ts`, `ainize-core/src/{catalog,types,config}.ts`, `ainize-core/test/core.test.ts`, `ainize-web/src/components/chat/PublishSheet.tsx`, `docs/ux-test-scenarios.json` (AZ-254, 258, 265, 269) | [stub] |
| **L1** Anchor + dataset blob | `derivation`/`base`/`dataset.*` types, `withEmptyArrays`, 32-sample cap + `answers_hash`, `samples[].source`; dataset blob kind + manifest + snapshot at job creation + pin at publish; `/p2p/dataset`, `PeerInfo.datasets`, `mayReadDataset`, derive intents; announce validation (§12.6) | `ainize-core/src/{types,ain-ledger,local-ledger,catalog}.ts`, `ainize-node/src/{blobs,p2p,teach-datasets,teach,market,api,openapi}.ts` | [stub] |
| **L2** Runtime stack | `patch.py check/apply-with-journal/remove-from-journal/status`; ordered `applied`, journal dir, `applyStack`, `has_dependents`, whole-stack watchdog, chat stack builder from base stacks, `GET /api/runtime/stack`, `verifyStack` with stratified `per_source` | `qwen3.8/scripts/patch.py`, `qwen3.8/engram/live.py` (read helper only), `ainize-node/src/{runtime,market,verifier,store,api}.ts`, `ainize-core/src/npz.ts` (`valuesEqualCount`) | [hook] with pin/ep12/pixel fixtures (AZ-243–246, 263) |
| **L3** Trainer on-top | `teach.py` `parents`/`known_file`/`replaces`/`export`/`mask`/`probe_with_parents`, `meta` member, recipe `parents/fact_addrs/timing`, version line; node writes parents into job.json, CHECKING in deployment order + reversibility assertion, `teach_stats` populated | `qwen3.8/train/teach.py`, `ainize-node/src/{teach,teach-recipe}.ts` | [gradient] on a measure-scale job (AZ-240–242); job.json shape [stub] |
| **L4** Base selection (both doors) + fork | `base_ids`/`context_ids`/`mode`, base picker sheet, basket base row, dataset-door *Start from*, inherited rows table, pre-flight `in_base`/`base_conflict`, `POST /fork`, My datasets card, publish sheet dataset section, `parent_not_listed` | `ainize-web/src/components/chat/{LessonBasket,PreflightList,PublishSheet,LessonCard}.tsx`, `ainize-web/src/pages/{TeachSettingsPage,TeachDatasetPage,TeachLessonPage,ChatPage}.tsx`, `ainize-web/src/lib/teachStore.ts`, `ainize-web/src/i18n/pages/teach.ts`, `ainize-node/src/{teach,teach-datasets,api}.ts` | [stub] (AZ-234–239, 247–248, 251–255) |
| **L5** Outcomes + supersede consent | Outcome chooser, `update` with author-signed supersede, `contradict` → track creation, correction adoption, `reconcileSupersedes` limited to consented updates, schema-inheritance flag (off) | `ainize-node/src/{market,teach,api}.ts`, `ainize-cli/src/commands/branch.ts`, `ainize-web/src/components/chat/PublishSheet.tsx`, `PatchPage.tsx` | [stub] (AZ-249–250) |
| **L6** Family tree + signals + issues | `/tree`, `/signals`, `/issues`, `/chat/feedback`, `patch_issues` + `covered_by`, Family tree tab (SVG), training-set block, doing-well strip, missing panel, chat consent, Explore shelves/sorts, operator stack + ledger meter | `ainize-node/src/{api,market,store,teach}.ts`, `ainize-web/src/pages/{PatchPage,ExplorePage,ChatPage,LedgerPage}.tsx`, `ainize-web/src/i18n/pages/{detail,explore,chat}.ts` | [stub] (AZ-256–260) |
| **L7** Merge | `/merge/preview`, resolutions, T0 union (numpy on node), T1 `mask.only` job, T2 rebuild job, stratified verification, merge screen, `ainize patch merge` | `ainize-node/src/{teach,api,market}.ts`, `ainize-core/src/npz.ts`, `ainize-web/src/pages/MergePage.tsx` (new), `ainize-cli/src/commands/patch.ts` | T0 [hook]; T1/T2 [gradient] (AZ-261–265) |
| **L8** Buy bundle + CLI parity | 402 `requires[]`, `?bundle=1`, buy sheet, `ainize patch buy/apply/remove/stack/tree/missing/signals`, `ainize dataset get`, `teach train --on`, `teach publish` flags | `ainize-node/src/{api,market}.ts`, `ainize-web/src/components/BuySheet.tsx`, `ainize-cli/src/{bin.ts,commands/teach.ts,commands/teach-dataset.ts,commands/patch.ts}` | [stub] (AZ-266–268) |
| **L9** Docs | D12 revision note in `teachable-dataset-design.md`, `teach-mode-design.md` §5.5/§8.3 pointers to this document, scenario rewrites listed in §14, RUN-LOCALLY template | `docs/*` , `ainize-node/src/teach-recipe.ts` | — |

**Gating.** *Build on this*, the basket base row and `--on` stay hidden/disabled (feature flag `teach.lineage`) until L2 and L3 are verified end to end on GPUs 4–6 (AZ-240–246).

> **What the GPU window still has to decide (2026-09-05).** L3's contract now holds on the trainer's real training > path without a GPU: `scripts/lineage-cpu-run.py` drives `teach.py` through its own CLI against a model stand-in > that produces logits from the PLE rows a sentence reads, so the row table, the addresses, LazyAdam, `export()` and > every artefact are real and only the numbers in the rows are invented (AZ-327, 51 assertions — the bf16-exact > `before == parent.after`, remove-restores-the-parent, both export modes, the mask, and the F2 probe pair). That > harness exists because the first L3 commit shipped a defect that killed **every** gradient run and no `--dry-run`, > unit test or stub-backend test could see it (AZ-326). What the window is still for: the same properties against > real weights, `before ==` the disk base read from the checkpoint, the live PLE hook, node-side CHECKING, and §7.8's > cost numbers. `scripts/lineage-gpu-window.sh` runs it in two phases — the trainer and the serving table cannot > overlap, because both want GPUs 4–6. L0, L1, L6 (read-only tree/shelves with `declared` edges) and the seed relabel can ship first. Rough sizing: L0 1 wk · L1 1.5 wk · L2 1.5 wk · L3 1 wk + GPU time · L4 2 wk · L5 1 wk · L6 1.5 wk · L7 2 wk · L8 1 wk · L9 0.5 wk ≈ 13 engineer-weeks.
