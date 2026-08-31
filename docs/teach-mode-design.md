# Teach mode — design spec

**Status:** final design, ready for implementation · **Date:** 2026-08-31 · **Owner direction (verbatim):**

> chatmode 가 있고 여러 knowledge들을 써볼 수 있고 그 위에서 teach mode가 있고 save & publish 하면 node operator가 아니라도 data provider로 기여를 받으면 될 것 같고 일단 나만쓸때는 내 로컬에서 실행하는 법을 알려줘야 되는거고

This document merges three candidate designs (user-first, risk-first, mvp-first) and two judge rounds into one spec. The shape is the **user-first** flow (everything happens on `/chat`, no jargon, no sign-in), with the **risk-first** guardrails grafted in (signed contributor claim on the anchor, review-by-default publishing, locality and parent-regression publish gates, measured timing only, payouts table with retry, trainer-slot lease, `exclusiveTry`), and the **mvp-first** mechanics where they are cheaper (raw `Q:/A:` template shared by trainer and verifier, `PROGRESS`/`DONE` stdout protocol, stub trainer backend for CI, draft preview through the existing `/api/chat`).

Facts below marked *(verified)* were checked against the repo or the live host during this session; facts marked *(projected)* are estimates and must be measured before they appear in UI copy.

---

## 1. Goals

1. **Try several knowledges.** A visitor can load up to three knowledges together in Live test and see before/after answers.
2. **Teach on top.** From any wrong answer the visitor types the right answer; the node trains new memory-table rows (a knowledge file) from those corrections without touching the serving model during training.
3. **Save & Publish as a data provider.** The visitor publishes the taught knowledge *through the node they are on* and is credited and paid as a **data provider** — no node, no operator sign-in. Credit is verifiable on the ledger (signed claim in the anchor), and payment flows through the existing settlement path.
4. **Only me.** The visitor can keep the knowledge private: download the file plus a recipe, see the exact commands to run it on their own server, or keep it on this node as a private draft for a limited time.
5. **Remove the sign-in wall.** The landing creator CTA no longer dead-ends at "Sign in to your node".

## 2. Non-goals (v1)

- Sovereign / device-held private rows (patent claims 25–29, 46–50). Not built; the UI must not imply it.
- Making the visitor the **on-chain author**. The AIN write rule `auth.addr === newData.author` on `/apps/knowledge/market/patches/$id` (*verified* `packages/core/src/ain-ledger.ts`) forces `author = node`. The visitor is a signed **contributor**.
- Row-level merging of overlapping knowledge files. Stacking is last-write-wins with an overlap warning.
- Consumer-hardware local run (llama.cpp etc.). The only target is the identical `Qwen3.8-Flash-Next-W4A16` checkpoint.
- Training through the live vLLM (SPSA / `scripts/edit_one_fact.py`). It mutates the shared table during search and succeeded 0/6…3/8; it stays an operator experiment flag, never the visitor path.
- Long-form answers. v1 trains single-line facts (answer ≤ 200 chars).

## 3. Vocabulary (UI ↔ code)

| UI word (en / ko) | Code / patent concept |
|---|---|
| knowledge / 지식 | patch (`PatchAnchor` + `.npz` blob) |
| lesson / 수업 | one teach job = 1–8 corrections trained into one knowledge file |
| correction / 바로잡기 | one `{question, answer, alt_question?}` fact |
| Teaching key / 가르치기 키 | browser-generated secp256k1 key; AIN-compatible address |
| Taught by / …님이 가르침 | `anchor.contributors[]` with `role: 'data_provider'` |
| Creator node / 제작 노드 | `anchor.author` (node address) |
| loaded / 넣음 | rows written into the live PLE table (`patch.py apply`) |
| Verified / 검증됨 | quorum-2 executed attestations (unchanged) |

No UI string may contain: patch, rows, npz, anchor, LISTED, quorum, lock, GPU slot. "Memory entries" is allowed (existing glossary).

---

## 4. User flows

### 4.1 Visitor: teach → save → publish as a data provider

1. Landing → card "I want to teach the model something" → **Teach the model** → `/chat?teach=1`.
2. Live test: tick up to 3 knowledges, ask a question, get "Before loading" / "After loading".
3. Under a wrong answer click **Teach the right answer** → drawer (question prefilled, model's answer read-only, right answer, optional "ask it another way"). **Add to lesson**. Repeat up to 8 corrections. The lesson basket is in `localStorage`.
4. **Train this lesson** → first time only: **Who gets the credit?** sheet creates the Teaching key (display name optional, payout wallet optional, backup download). Returning visitors skip it.
5. Pre-flight (≤ 30 s, under a short runtime lock): each correction is re-asked with the same stack; "Wrong today — will train" / "Already correct — skipped" / "Too close to {name} — skipped". Nothing left → "Nothing to teach". Otherwise **Queue training ({k})**.
6. Sticky **Your lesson** card on `/chat` (also `/chat?lesson=<jobId>`): Queued → Warming up → Teaching (step k/max, hits) → Checking → Ready | Needs more | Failed. Visitor can keep chatting.
7. Ready: per-correction Before / After / Other phrasing ✓✗, plus "Knowledge you had loaded still answers its own questions m/n" and "Unrelated questions unchanged m/n". Buttons **Try it now** (adds the lesson to the stack via the normal `/api/chat` path — drafts resolve through `entry()` *(verified)*), **Publish so others can use it**, **Keep it private**.
8. Publish sheet: name, shown-as, price, license, payout, two consent boxes, split explained → **Publish**. The browser signs a claim over `{patch_sha256, benchmark_hash, address, share}`; the node writes `contributors[]` into the draft, then either announces (policy `auto`) or parks it for operator review (policy `review`, default).
9. Result: "Sent to the node operator for review" or "Announced — verifier nodes are checking it". Links: **Your knowledge page**, **Your earnings** (`/teacher/<address>`).
10. **Your knowledge** panel (`/chat?mine=1`): lessons with state, earnings (owed / paid / pending), key backup/restore.

### 4.2 Visitor: teach → save → run locally ("only me")

Steps 1–7 as above, then **Keep it private** sheet with three honest options, in this order:

1. **Keep it on this node for 7 days** (default for people without hardware) — private draft, testable from this browser, visible to the node operator, auto-deleted after 7 days unless published.
2. **Download the knowledge file** — 7-day token link to `lesson-<slug>.npz`, `recipe.json`, `RUN-LOCALLY.md` (+ sha256).
3. **Run it on my own machine** — hardware notice first ("needs the exact model, 2×40 GB GPUs or 1×80 GB, ~110 GB RAM, no laptop version"), toggle "I have this hardware — show me the commands", then the recipe in §10.

Buttons: **Done**, **Publish later** (returns to 4.1 step 8 any time from Your knowledge).

### 4.3 Operator moderation

Dashboard → **Teaching** tab: policy switches (accept lessons, publish mode review/auto/never, corrections per lesson, lessons per key/day and per IP/day, queue size, data-provider share, pause reason), live queue (cancel), review inbox (approve → announce; decline with reason shown to the visitor), contributors (hide name, block key, block IP), payouts (owed / paid / failed, retry). Node-wide settings persist in the kv store; `/api/info` advertises `accepts_contributions` and `contributor_share` so agents and other nodes can discover the policy.

---

## 5. Screens and copy

All strings live in a new `packages/web/src/i18n/pages/teach.ts` (en + ko) plus edits to `public.ts` (landing) and `operator.ts` (sign-in notice, dashboard tab). Placeholders in `{}`.

### 5.1 Landing creator card (`public.ts`)

| key | en | ko |
|---|---|---|
| `landing.audience.creator.title` | I want to teach the model something | 모델에게 가르치고 싶어요 |
| `landing.audience.creator.s1` | Ask the model in Live test and correct it when it is wrong. | 라이브 테스트에서 물어보고, 틀리면 바로잡습니다. |
| `landing.audience.creator.s2` | This node trains your corrections into knowledge — no sign-in, no server of your own. | 이 노드가 내 바로잡기를 지식으로 학습합니다. 로그인도 내 서버도 필요 없습니다. |
| `landing.audience.creator.s3` | Keep it private, or publish it and get paid on every sale. | 나만 쓰거나, 공개해서 팔릴 때마다 정산받습니다. |
| `landing.audience.creator.cta` | Teach the model | 모델 가르치기 |
| `landing.audience.creator.operator_link` | Already have a knowledge file (.npz) and run a node? Register a file → | 이미 지식 파일(.npz)이 있고 노드를 운영하나요? 파일 등록 → |

### 5.2 Sign-in page notice (`operator.ts`)

| key | en | ko |
|---|---|---|
| `op.sign.visitor_notice` | Want to try or teach the model? You do not need to sign in — that is only for the person who runs this node. | 모델을 써보거나 가르치고 싶다면 로그인이 필요 없습니다. 로그인은 이 노드를 운영하는 사람만 합니다. |
| `op.sign.visitor_cta` | Go to Live test | 라이브 테스트로 가기 |
| `op.sign.login.subtitle` | Only the person who runs this node needs a password. | 이 노드를 운영하는 사람만 비밀번호가 필요합니다. |

`/new-patch` when not signed in renders a public pre-screen instead of redirecting: title **Add knowledge — two ways** / **지식 추가 — 두 가지 방법**; card A "Teach it in chat — Correct a wrong answer and this node trains it for you. No account." → Open Live test; card B "I run this node and have a knowledge file — Sign in with the operator password to upload a .npz file." → Sign in.

### 5.3 Live test additions (`teach.ts`)

| key | en | ko |
|---|---|---|
| `chat.picker.multi_title` | Knowledge to load (pick up to 3) | 넣을 지식 (최대 3개) |
| `chat.picker.multi_help` | They load in the order you tick them. If two overlap, the one ticked last wins. | 체크한 순서대로 넣습니다. 겹치면 나중에 체크한 쪽이 이깁니다. |
| `chat.picker.overlap` | These two overlap on {n} memory entries. | 이 둘은 메모리 항목 {n}개가 겹칩니다. |
| `chat.picker.contaminated` | This node also has {names} loaded for everyone, so "Before loading" already includes it. | 이 노드에는 {names}이(가) 항상 넣어져 있어 "넣기 전"에도 포함됩니다. |
| `chat.picker.mine` | Your lessons | 내 수업 |
| `chat.banner.teach` | Wrong answer? Click "Teach the right answer" under any reply and the model learns it. No account needed. | 답이 틀렸나요? 답변 아래 "정답 가르치기"를 누르면 모델이 배웁니다. 계정이 필요 없습니다. |
| `chat.turn.teach` | Teach the right answer | 정답 가르치기 |

### 5.4 Teach drawer

| key | en | ko |
|---|---|---|
| `teach.drawer.title` | Teach the right answer | 정답 가르치기 |
| `teach.drawer.sub` | Tell it what it should have said. Short, exact answers work best. | 어떻게 답했어야 하는지 알려주세요. 짧고 정확한 답이 가장 잘 됩니다. |
| `teach.drawer.question` | The question | 질문 |
| `teach.drawer.model_said` | The model said | 모델의 답 |
| `teach.drawer.answer` | The right answer | 정답 |
| `teach.drawer.answer_ph` | Short and exact — one line, like a name, number or date | 짧고 정확하게 — 이름, 숫자, 날짜처럼 한 줄로 |
| `teach.drawer.alt` | Ask it another way (optional) | 다른 말로 물어보기 (선택) |
| `teach.drawer.alt_hint` | Used to check the model learned the fact, not just the wording. | 표현이 아니라 사실을 배웠는지 확인하는 데 씁니다. |
| `teach.drawer.suggest` | Suggest phrasings | 표현 제안 |
| `teach.drawer.add` | Add to lesson | 수업에 추가 |
| `teach.drawer.v_answer` | Please type the right answer. | 정답을 입력해 주세요. |
| `teach.drawer.v_long` | Keep the answer under 200 characters — teach long explanations as several short facts. | 정답은 200자 이내로 — 긴 설명은 짧은 사실 여러 개로 나눠 가르치세요. |
| `teach.drawer.storage` | Your question and answer are stored on this node while it trains. | 학습하는 동안 질문과 정답이 이 노드에 저장됩니다. |

### 5.5 Lesson basket

| key | en | ko |
|---|---|---|
| `teach.basket.title` | Your lesson ({n} of 8) | 내 수업 ({n}/8) |
| `teach.basket.empty` | No corrections yet. When an answer is wrong, click "Teach the right answer" under it. | 아직 바로잡은 것이 없습니다. 답이 틀리면 아래 "정답 가르치기"를 누르세요. |
| `teach.basket.train` | Train this lesson | 이 수업 학습하기 |
| `teach.basket.policy_open` | Teaching on this node: open · {q} waiting · recent lessons took {p50}–{p90} min | 이 노드에서 가르치기: 가능 · 대기 {q} · 최근 수업 {p50}–{p90}분 |
| `teach.basket.policy_untimed` | Teaching on this node: open · this node has not timed a lesson yet — the first one may take up to 30 minutes | 이 노드에서 가르치기: 가능 · 아직 측정된 수업이 없어 첫 수업은 최대 30분 걸릴 수 있습니다 |
| `teach.basket.policy_paused` | Teaching is paused on this node right now. {reason} | 지금은 이 노드에서 가르치기가 잠시 중단되었습니다. {reason} |
| `teach.basket.policy_off` | This node does not accept lessons. Try another node or run your own. | 이 노드는 수업을 받지 않습니다. 다른 노드를 쓰거나 직접 노드를 운영하세요. |
| `teach.basket.builds_on` | This builds on the knowledge I have loaded (its creators share in sales) | 지금 넣은 지식을 바탕으로 합니다 (그 제작자도 수익을 나눕니다) |

### 5.6 Who gets the credit? (Teaching key sheet, first time only)

| key | en | ko |
|---|---|---|
| `teach.key.title` | Who gets the credit? | 누구의 이름으로 남길까요? |
| `teach.key.body` | Ainize just created a teaching key in this browser. It signs your lessons and is where sales revenue is paid. No account, no node, no sign-in. Ainize never sees the private key. | 이 브라우저에 가르치기 키를 만들었습니다. 내 수업에 서명하고 판매 수익을 받는 곳입니다. 계정도, 노드도, 로그인도 없습니다. Ainize는 비밀키를 볼 수 없습니다. |
| `teach.key.name` | Display name (optional, shown as "Taught by …") | 표시 이름 (선택, "…님이 가르침"으로 표시) |
| `teach.key.payout` | Payout wallet (optional) — an AIN address that receives your share. Defaults to this key. | 정산 지갑 (선택) — 내 몫을 받을 AIN 주소. 기본값은 이 키입니다. |
| `teach.key.backup` | Download key backup | 키 백업 내려받기 |
| `teach.key.warn` | If you clear this browser without a backup, you lose access to your lessons and any unpaid earnings. | 백업 없이 브라우저를 지우면 내 수업과 미지급 수익에 접근할 수 없습니다. |
| `teach.key.continue` | Continue | 계속 |
| `teach.key.import` | I already have a key | 이미 키가 있어요 |
| `teach.key.chip` | Teaching as {name} · {short} | {name}(으)로 가르치는 중 · {short} |

### 5.7 Pre-flight

| key | en | ko |
|---|---|---|
| `teach.pre.title` | Checking what the model already knows | 모델이 이미 아는지 확인 중 |
| `teach.pre.will_train` | Wrong today — will train | 지금 틀림 — 학습합니다 |
| `teach.pre.known` | Already correct — skipped | 이미 맞음 — 건너뜀 |
| `teach.pre.overlap` | Too close to "{name}", which is already on this node — skipped | 이미 이 노드에 있는 "{name}"과 너무 비슷함 — 건너뜀 |
| `teach.pre.none` | Nothing to teach: the model already answers all of this correctly. | 가르칠 것이 없습니다. 모델이 이미 모두 맞게 답합니다. |
| `teach.pre.queue` | Queue training ({k} corrections) | 학습 대기열에 넣기 (바로잡기 {k}개) |
| `teach.pre.quota` | {n} of {limit} lessons left today for this key | 이 키로 오늘 남은 수업 {n}/{limit} |

### 5.8 Lesson card

| key | en | ko |
|---|---|---|
| `teach.card.title` | Your lesson: {name} | 내 수업: {name} |
| `teach.card.queued` | Waiting for a free training slot — {n} lesson(s) ahead of you. | 학습 차례를 기다리는 중 — 앞에 {n}개 있습니다. |
| `teach.card.blocked` | Training is fully booked right now. Your place in line is kept — leave this tab open or come back later from Your knowledge. | 지금은 학습이 꽉 찼습니다. 순서는 유지됩니다. 탭을 열어 두거나 나중에 내 지식에서 확인하세요. |
| `teach.card.lock` | Waiting for the model server (someone is running a live test). | 모델 서버를 기다리는 중 (다른 사람이 라이브 테스트 중). |
| `teach.card.loading` | Warming up the model (about a minute). | 모델을 준비하는 중 (약 1분). |
| `teach.card.training` | Teaching… step {step} of up to {max} · answers {hits} of {total} phrasings correctly so far. | 가르치는 중… {step}/{max}단계 · 지금까지 {total}개 중 {hits}개 표현 정답. |
| `teach.card.checking` | Double-checking the answer in the live model. | 실제 모델에서 다시 확인하는 중. |
| `teach.card.revert_note` | The model server restarted during the check; we re-loaded the lesson and measured again. | 확인 중 모델 서버가 재시작되어 수업을 다시 넣고 측정했습니다. |
| `teach.card.ready` | It learned it — {hits} of {total} answers correct in the live model. | 배웠습니다 — 실제 모델에서 {total}개 중 {hits}개 정답. |
| `teach.card.check_parent` | Knowledge you had loaded still answers its own questions: {m}/{n} | 넣어 둔 지식이 자기 질문에 여전히 답함: {m}/{n} |
| `teach.card.check_locality` | Unrelated questions unchanged: {m}/{n} | 무관한 질문 변화 없음: {m}/{n} |
| `teach.card.needs_more` | It did not stick well enough ({hits} of {total}). Add another phrasing and try again. | 충분히 배우지 못했습니다 ({total}개 중 {hits}개). 표현을 하나 더 넣고 다시 해보세요. |
| `teach.card.failed` | Something went wrong while teaching. Nothing was charged. Try again in a moment. | 가르치는 중 문제가 생겼습니다. 비용은 없습니다. 잠시 후 다시 시도하세요. |
| `teach.card.cancelled` | Cancelled. | 취소됨. |
| `teach.card.timing_tip` | Times are this node's recent average, measured on the real model. Training runs on spare GPUs; the model server stays available for everyone. | 시간은 이 노드의 최근 실측 평균입니다. 학습은 여분 GPU에서 돌고, 모델 서버는 계속 쓸 수 있습니다. |
| `teach.card.try` | Try it now | 지금 써보기 |
| `teach.card.publish` | Publish so others can use it | 공개해서 다른 사람도 쓰게 하기 |
| `teach.card.keep` | Keep it private | 나만 쓰기 |
| `teach.card.publish_gated` | Publishing is off for this lesson because it changed answers to unrelated questions. You can still save it. | 무관한 질문의 답이 바뀌어 이 수업은 공개할 수 없습니다. 저장은 할 수 있습니다. |
| `teach.card.improve` | Improve & retry | 보완해서 다시 |
| `teach.card.cancel` | Cancel | 취소 |
| `teach.card.expiry` | Unsaved lessons are deleted after 7 days. | 저장하지 않은 수업은 7일 뒤 삭제됩니다. |

### 5.9 Publish sheet

| key | en | ko |
|---|---|---|
| `teach.pub.title` | Publish your knowledge | 내 지식 공개하기 |
| `teach.pub.sub` | It goes on the public record through this node, credited to you. | 이 노드를 통해 공개 기록에 올라가고, 내 이름으로 남습니다. |
| `teach.pub.name` | Name | 이름 |
| `teach.pub.desc` | Description (optional) | 설명 (선택) |
| `teach.pub.shown_as` | Shown as | 표시 이름 |
| `teach.pub.price` | Price per download ({currency}) — 0 = free | 내려받기당 가격 ({currency}) — 0 = 무료 |
| `teach.pub.license` | License | 라이선스 |
| `teach.pub.payout` | Get paid to | 정산 받을 곳 |
| `teach.pub.payout_key` | This browser's teaching key ({short}) | 이 브라우저의 가르치기 키 ({short}) |
| `teach.pub.payout_wallet` | My own wallet address | 내 지갑 주소 |
| `teach.pub.payout_none` | No payment, just credit me | 정산 없이 이름만 |
| `teach.pub.split` | You receive {contributor}% of every sale. {node} keeps the rest for training, hosting and verification. If you ticked "builds on", the creators of that knowledge receive the network's creator share ({lineage}%) first. | 판매마다 {contributor}%를 받습니다. 나머지는 {node}가 학습·호스팅·검증 비용으로 가집니다. "바탕으로 합니다"를 켰다면 그 지식의 제작자가 먼저 제작자 몫({lineage}%)을 받습니다. |
| `teach.pub.consent_permanent` | I understand this becomes a permanent public record: the questions, answers, my display name and payout address cannot be edited or deleted, and verifier nodes will read them. | 영구 공개 기록이 된다는 것을 이해합니다: 질문, 정답, 표시 이름, 정산 주소는 수정·삭제할 수 없고 검증 노드가 읽습니다. |
| `teach.pub.consent_rights` | I have the right to share this information, and it is not private or personal data. | 이 정보를 공유할 권리가 있으며, 사적이거나 개인적인 정보가 아닙니다. |
| `teach.pub.button` | Publish | 공개하기 |
| `teach.pub.done_auto` | Announced. Independent verifier nodes are now checking it on the real model; it goes on sale when {quorum} agree. | 공개했습니다. 독립 검증 노드가 실제 모델에서 확인 중이며 {quorum}곳이 동의하면 판매가 시작됩니다. |
| `teach.pub.done_review` | Sent to the node operator for review. You will see it in Your knowledge when it goes live. | 노드 운영자 검토로 보냈습니다. 공개되면 내 지식에서 볼 수 있습니다. |
| `teach.pub.off` | This node accepts lessons but does not publish them. Download the file instead. | 이 노드는 수업은 받지만 공개하지는 않습니다. 대신 파일을 내려받으세요. |
| `teach.pub.rejected` | The node operator declined to publish this lesson: {reason}. Your file is still available to download. | 노드 운영자가 이 수업의 공개를 거절했습니다: {reason}. 파일은 계속 내려받을 수 있습니다. |
| `teach.pub.link_page` | Your knowledge page | 내 지식 페이지 |
| `teach.pub.link_earnings` | Your earnings | 내 수익 |

### 5.10 Keep it private sheet

| key | en | ko |
|---|---|---|
| `teach.keep.title` | Keep it private | 나만 쓰기 |
| `teach.keep.sub` | Nothing is published. Pick how you want to keep it. | 아무것도 공개되지 않습니다. 어떻게 보관할지 고르세요. |
| `teach.keep.node_title` | Keep it on this node for 7 days | 이 노드에 7일간 두기 |
| `teach.keep.node_body` | Only your key (and the node operator) can load it. Use it from Your knowledge → Try. Not private from the operator. | 내 키(그리고 노드 운영자)만 넣을 수 있습니다. 내 지식 → 써보기에서 씁니다. 운영자에게는 비공개가 아닙니다. |
| `teach.keep.dl_title` | Download the knowledge file | 지식 파일 내려받기 |
| `teach.keep.dl_body` | {size} MB · {rows} memory entries · link valid for 7 days; make a new one any time from Your knowledge. | {size} MB · 메모리 항목 {rows}개 · 링크 7일 유효, 내 지식에서 언제든 새로 만들 수 있습니다. |
| `teach.keep.run_title` | Run it on my own machine | 내 컴퓨터에서 돌리기 |
| `teach.keep.run_hw` | This knowledge only works inside the exact model this node serves ({model}, 168 GB). Running it yourself needs two 40 GB GPUs (or one 80 GB GPU) and about 110 GB of RAM. There is no laptop version yet. | 이 지식은 이 노드가 서빙하는 바로 그 모델({model}, 168 GB)에서만 동작합니다. 직접 돌리려면 40 GB GPU 2장(또는 80 GB 1장)과 약 110 GB RAM이 필요합니다. 노트북용은 아직 없습니다. |
| `teach.keep.run_toggle` | I have this hardware — show me the commands | 이 하드웨어가 있어요 — 명령어 보기 |
| `teach.keep.copy` | Copy commands | 명령어 복사 |
| `teach.keep.readme` | Download RUN-LOCALLY.md | RUN-LOCALLY.md 내려받기 |
| `teach.keep.done` | Done | 완료 |
| `teach.keep.later` | Publish later | 나중에 공개 |
| `teach.keep.delete` | Delete from this node | 이 노드에서 삭제 |

### 5.11 Your knowledge panel

| key | en | ko |
|---|---|---|
| `teach.mine.title` | Your knowledge | 내 지식 |
| `teach.mine.empty` | No lessons yet on this browser. Teach the model in Live test to start. | 이 브라우저에는 아직 수업이 없습니다. 라이브 테스트에서 모델을 가르쳐 보세요. |
| `teach.mine.identity` | This browser · {short} | 이 브라우저 · {short} |
| `teach.mine.backup` / `restore` / `forget` | Back up key / Restore key / Forget key on this browser | 키 백업 / 키 복원 / 이 브라우저에서 키 지우기 |
| `teach.mine.status.*` | Queued / Training / Ready · private / In review / Being verified / On sale / Declined / Failed / Expired | 대기 / 학습 중 / 준비됨 · 비공개 / 검토 중 / 검증 중 / 판매 중 / 거절됨 / 실패 / 만료 |
| `teach.mine.earnings` | Earned {earned} · paid {paid} · pending {pending} | 발생 {earned} · 지급 {paid} · 대기 {pending} |
| `teach.mine.pending_hint` | Pending means a sale was recorded but the transfer from this node has not completed yet. | 대기는 판매는 기록됐지만 이 노드의 송금이 아직 끝나지 않았다는 뜻입니다. |

### 5.12 Catalog / knowledge page

| key | en | ko |
|---|---|---|
| `detail.taught_by` | Taught by {name} | {name} 님이 가르침 |
| `detail.taught_by_anon` | Taught by a visitor | 방문자가 가르침 |
| `detail.people` | Creator node: {author_name} · Data provider: {name} ({share}%) | 제작 노드: {author_name} · 데이터 제공자: {name} ({share}%) |
| `detail.taught_badge` | Taught lesson | 가르친 수업 |
| `detail.use_yourself` | Use it yourself | 직접 쓰기 |

### 5.13 Operator Teaching tab (`operator.ts`)

Title **Teaching** / **가르치기**. Settings: "Accept lessons from visitors" · "Publish lessons: Review each one / Automatically / Never" · "Corrections per lesson" · "Lessons per key per day" · "Lessons per IP per day" · "Queue size" · "Data-provider share of each sale" (slider 0–90 %, helper "The rest stays with this node for GPU time and hosting.") · "Pause reason shown to visitors". Queue columns: Lesson · Contributor · Corrections · Status · Started · Actions. Review: **Approve and announce** / **Decline** / "Reason (shown to the contributor)". Contributors: **Hide name** / **Block key** / **Block IP**. Payouts: Owed / Paid / Failed / **Retry**. Note: "Lessons are published under this node's identity; the contributor's share is written into every sale record." / "수업은 이 노드의 이름으로 공개되고, 기여자 몫은 모든 판매 기록에 적힙니다."

### 5.14 Error mapping (`mapTeachError`, same style as `mapChatError`)

| server message prefix | HTTP | en | ko |
|---|---|---|---|
| `teaching_disabled` | 403 | This node does not accept lessons. | 이 노드는 수업을 받지 않습니다. |
| `trainer_paused` | 503 | Training is paused on this node right now. Your lesson is saved in this browser — try again later. | 지금은 학습이 중단되었습니다. 수업은 브라우저에 저장되어 있으니 나중에 다시 시도하세요. |
| `quota_key` / `quota_ip` | 429 | You have reached today's lesson limit here. Come back tomorrow or run your own node. | 오늘 이 노드의 수업 한도에 도달했습니다. 내일 다시 오거나 직접 노드를 운영하세요. |
| `banned` | 403 | This node is not accepting lessons from this key. | 이 노드는 이 키의 수업을 받지 않습니다. |
| `already_known` | 409 | The model already answers this correctly, so there is nothing to train. | 모델이 이미 맞게 답하므로 가르칠 것이 없습니다. |
| `overlaps_listing` | 409 | This looks like knowledge already sold on this node. Load it in Live test instead. | 이미 이 노드에서 파는 지식과 비슷합니다. 라이브 테스트에서 넣어 보세요. |
| `job_not_ready` | 409 | This lesson is not ready yet. | 이 수업은 아직 준비되지 않았습니다. |
| `checks_failed` | 409 | This lesson cannot be published because it failed a side-effect check. | 부작용 검사에 실패해 이 수업은 공개할 수 없습니다. |
| `invalid_signature` | 401 | Your teaching key could not be verified. Restore your backup or create a new key. | 가르치기 키를 확인할 수 없습니다. 백업을 복원하거나 새 키를 만드세요. |
| `not_owner` | 403 | This lesson belongs to a different teaching key. Restore that key to manage it. | 이 수업은 다른 가르치기 키의 것입니다. 그 키를 복원하세요. |
| `published_immutable` | 409 | Published knowledge cannot be deleted. | 공개한 지식은 삭제할 수 없습니다. |
| runtime unavailable | 503 | The model server is off or restarting. The lesson will continue automatically. | 모델 서버가 꺼졌거나 재시작 중입니다. 수업은 자동으로 이어집니다. |
| generic | — | Something went wrong with the lesson: {message} | 수업에 문제가 생겼습니다: {message} |

---

## 6. API

### 6.1 Conventions

- **Visitor auth:** header `x-ngram-auth: <address>:<ts>:<sig>` where `sig = signMessage("teach:<ts>")` with the browser key; verified by the existing `verifyAuthHeader(header, 'teach')` (*verified* `packages/node/src/p2p.ts:27`, 5-min skew). Browser signing uses `@noble/secp256k1` + keccak with the same personal-message format `packages/core/src/identity.ts` verifies through ain-util (`packages/web` has no ain-util dependency).
- **Operator auth:** `requireOperator` as today.
- **Errors:** existing `HttpError` `{error: string}`; machine-readable codes are the message prefix (table above).
- **Quotas:** per signed key **and** per IP, both must pass; persisted in SQLite (`teach_quota`), day buckets.
- **Policy gate:** every visitor route returns `403 teaching_disabled` when `settings.teach.enabled === false` (default **false**; the demo cluster config turns it on).

### 6.2 Visitor endpoints

```
GET  /api/teach/policy
→ 200 { enabled, publish: 'review'|'auto'|'never', trainer: 'ready'|'busy'|'paused',
        paused_reason?, queue: { depth, max, position_eta_s? },
        limits: { facts_per_job: 8, jobs_per_key_per_day: 3, jobs_per_ip_per_day: 5,
                  prompt_max: 400, answer_max: 200 },
        timing: { p50_s: number|null, p90_s: number|null, samples: number },
        shares: { contributor: 0.7, lineage: 0.3 }, model: { id_M },
        applied: string[]   /* ids the operator keeps persistently loaded */ }
Public, cached 10 s.

POST /api/teach/preflight            (auth)   costs 1 chat-quota unit
body { patch_ids: string[] (0..3), facts: [{ prompt(1..400), answer(1..200), alt_prompt?(≤400) }] (1..8) }
→ 200 { facts: [{ index, status: 'will_train'|'already_known'|'overlaps_listing'|'invalid',
                  base_answer, detail? }], trainable, quota: { key_remaining, ip_remaining } }
Runs under runtime.exclusiveTry('teach:preflight', 2 min). 429 quota_* · 503 runtime unavailable.

POST /api/teach/jobs                 (auth)
body { patch_ids: string[] (0..3), builds_on_context: boolean (default false),
       facts: [{ prompt, answer, alt_prompt?, base_answer? }] (1..8),
       contributor: { name?(≤40) } }
→ 202 { job: TeachJob, quota: {...} }
Re-validates, checks bans/quota/overlap-by-prompt-hash, stores the job, consumes quota.
403 teaching_disabled|banned · 429 quota_key|quota_ip · 409 already_known (all facts skipped)
· 503 trainer_paused (queue full or container down).

GET  /api/teach/jobs/:id
→ 200 { job: TeachJob }   full body only when x-ngram-auth = job.contributor.address or operator;
                          others get { id, status, position?, eta_s? }.   Poll every 5 s.
GET  /api/teach/jobs?mine=1          (auth) → { items: TeachJob[] }
DELETE /api/teach/jobs/:id           (auth owner | operator) → { ok, status: 'CANCELLED' }
   allowed in QUEUED|PREFLIGHT|TRAINING (SIGTERM to the in-container pid) or for private READY drafts
   (deleteDraft + unlink). 409 published_immutable once announced.
POST /api/teach/jobs/:id/retry       (auth owner) body { facts } → 202 new job with parent_job = id

GET  /api/teach/jobs/:id/publish-challenge   (auth owner; READY & checks.ok)
→ 200 { patch_sha256, benchmark_hash, share, claim: hashCanonical({patch_sha256, benchmark_hash, address, share}) }
POST /api/teach/jobs/:id/publish     (auth owner)
body { name(2..80), description?(≤2000), price?: string, license?: string (default 'CC-BY-4.0'),
       payout_address?: string|null  /* null = credit only, share 0 */,
       claim_sig: string  /* browser signature over `claim` */,
       consent: { permanent: true, rights: true } }
→ 200 { status: 'PENDING_REVIEW' } | { status: 'ANNOUNCED', patch_id, url: '/<author>/<patch_id>' }
403 publish_disabled · 409 job_not_ready|checks_failed · 400 consent missing · 401 invalid_signature.

POST /api/teach/jobs/:id/save        (auth owner; READY)
→ 200 { download: { npz_url: '/p2p/blob/<sha>?token=<t>', recipe_url, readme_url, expires_at },
        sha256, rows, size_bytes, filename: 'lesson-<slug>.npz' }
Token = store.putToken(token, sha, 'contrib:<address>', 7 d) (*verified* store.ts:166); /p2p/blob/:sha already accepts ?token=.
GET  /api/teach/jobs/:id/recipe?token=     → recipe.json
GET  /api/teach/jobs/:id/local-run?token=  → RUN-LOCALLY.md (text/markdown)

GET  /api/teacher/:address           public
→ 200 { address, name?, lessons: [{ id, name, status, verified, downloads, revenue }],
        earnings: { currency, owed, paid, pending,
                    items: [{ patch_id, settle_hash, amount, status: 'paid'|'pending'|'failed', tx_hash?, created_at }] } }
GET  /api/catalog?contributor=<address>    filter on anchor.contributors[].address
```

### 6.3 ChatMode extension (additive, backward compatible)

```
POST /api/chat
body { patch_id?: string, patch_ids?: string[] (1..3), mode, messages, max_tokens, thinking }
      exactly one of patch_id / patch_ids
→ existing fields + { patch_ids: string[], applied: [{ patch_id, applied_ms, was_applied }],
                      benchmark_hits: Record<patch_id, boolean|null> }
   applied_ms = sum; benchmark_hit = OR (kept for old clients).
GET /api/chat/patches → + { applied: string[], lessons: CatalogEntry[] /* caller's private drafts when auth verifies */ }
```

Inside one `exclusive('chat:<id1>+<id2>')`: compute `wasApplied` per blob; for base remove those applied; for patched `applyRaw` in list order (last write wins on overlapping addresses); restore in reverse. One `usage` event per patch. Overlap counts come from the existing addrsets/`conflicts()` logic and are shown in the picker.

### 6.4 Operator endpoints

```
GET/PATCH /api/me/teach/policy  { enabled, publish, facts_per_job, jobs_per_key_per_day, jobs_per_ip_per_day,
                                  queue_max, contributor_share, paused_reason }
GET  /api/me/teach/jobs                     → all jobs incl. contributor + ip
POST /api/me/teach/jobs/:id/approve         → announce
POST /api/me/teach/jobs/:id/reject { reason }
POST /api/me/teach/jobs/:id/cancel
GET  /api/me/teach/contributors             → [{ address, name, jobs, published, hidden, banned, first_seen }]
POST /api/me/teach/contributors/:address { hidden?: boolean }
POST /api/me/teach/bans { kind: 'address'|'ip', value, reason }   DELETE /api/me/teach/bans/:id
GET  /api/me/payouts?status=failed          POST /api/me/payouts/:id/retry
```

`GET /api/info` gains `accepts_contributions: boolean` and `contributor_share: number`. `openapi.ts` documents all of the above; CLI adds `ainize teach status <url>` and `ainize patch import <file.npz> --recipe recipe.json` (creates a local DRAFT, no announce).

### 6.5 TeachJob shape

```ts
interface TeachJob {
  id: string;                       // uuid v4
  status: 'QUEUED'|'PREFLIGHT'|'LOADING'|'TRAINING'|'EXPORTED'|'CHECKING'|'READY'|'NEEDS_MORE'
        | 'FAILED'|'CANCELLED'|'PENDING_REVIEW'|'REJECTED'|'ANNOUNCED'|'EXPIRED';
  contributor: { address: string; name?: string };
  context_patch_ids: string[]; builds_on_context: boolean;
  facts: { prompt: string; answer: string; alt_prompt?: string; base_answer?: string;
           after_answer?: string; hit?: boolean; heldout_hit?: boolean }[];
  position?: number; eta_s?: number|null;
  progress?: { step: number; max_steps: number; loss?: number; hits: number; total: number;
               load_s?: number; avg_step_s?: number; started_at?: number };
  checks?: { taught: { hits: number; total: number }; parent_regression: { ok: boolean; hit: number; total: number };
             locality: { ok: boolean; same: number; total: number }; reverted_and_reapplied: boolean };
  result?: { sha256: string; rows: number; size_bytes: number };
  draft_id?: string; patch_id?: string; publish_status?: 'none'|'pending_review'|'rejected'|'announced'|'listed';
  reject_reason?: string; error?: string; parent_job?: string;
  created_at: number; updated_at: number; expires_at?: number;
}
```

---

## 7. Data model diff

### 7.1 `packages/core/src/types.ts`

```ts
export interface Contributor {
  address: string;            // paid address
  signer?: string;            // teaching key when different from `address`
  name?: string;
  share: number;              // 0..1 fraction of the SELLER remainder after the lineage pool
  role: 'data_provider';
  proof: 'signed' | 'declared';
  sig?: string;               // signature by `signer ?? address` over hashCanonical({patch_sha256, benchmark_hash, address, share})
}
// PatchAnchor additions (all optional → Market.isAnchor() unchanged, old anchors validate)
contributors?: Contributor[];          // ≤ 4 entries
origin?: 'operator' | 'teach';
// PatchRecipe additions
sentences?: string[]; contrast?: string[]; held_out?: string[]; model_id?: string;
probe?: { hits: number; total: number; heldout_hits?: number };
```

`author` / `author_name` stay the node. `BenchmarkSpec` is unchanged; taught knowledge uses `schema: 'taught/<slug>-<6 hex>'` (unique per lesson so `reconcileSupersedes` never demotes curated listings), `format: ['template','chat']`, `samples` = the trained `Q: {q}\nA: ` renderings (+ the held-out paraphrase only when it passed), `collateral_bound_nat: 0.08`.

### 7.2 `packages/core/src/ain-ledger.ts` — required correction

`withEmptyArrays()` restores fields with explicit per-record lines; its `ARRAY_FIELDS` loop body is a no-op (*verified* line 117). Adding `'contributors'` to `ARRAY_FIELDS` does nothing. Add inside the anchor branch:

```ts
if ('author' in b && 'patch_sha256' in b) { b.contributors = b.contributors ?? []; }
```

`toAin()` encodes arrays as `{"0":…}` and drops empty arrays/objects, so without this line AIN-backed catalogs read `undefined` and `filter(a => a.contributors.some(...))` crashes. Cap `contributors` at 4 and keep sentences **out of the anchor** (recipe/blob only) — the knowledge app is on the AIN free tier (~100 KB state).

### 7.3 `packages/core/src/catalog.ts` — `royaltySplit` two-pass

```
pass 1 (unchanged): lineage pool = amount × share split equally among unique ancestor AUTHORS;
                    same-author ancestors fold back into the seller.
pass 1b (new):      for each ancestor anchor with contributors[], split that ancestor's slice
                    between ancestor.author and its contributors by their shares
                    (a data provider keeps earning when someone builds on their lesson — claim 21).
pass 2 (new):       remainder = seller amount; for each c of entry.anchor.contributors ?? []:
                    carve = remainder × c.share; out[c.address] += carve; remainder −= carve.
                    Skip c.address === seller; validate Σ share ≤ 1 at createDraft.
```

Worked examples (price 10, lineage 0.3, contributor 0.7): no parents → `{teacher: 7, node: 3}`; one foreign parent → `{parent-node: 3, teacher: 4.9, node: 2.1}`. Because `Settlement.royalty` (address → amount) is what `creditBalance()`, the AIN transfer loop in `settlePayment()`, `/api/me/wallet` royalties, drive `settlements.json` and the `x-payment-response` header already consume, contributors are paid in both ledger modes with **no settlement code change**. Unit tests next to the existing royaltySplit test in `packages/core/test/core.test.ts`.

### 7.4 Node config (`config.ts` defaults + `NodeConfig`)

```ts
teach: {
  enabled: false, publish: 'review',           // demo cluster config: enabled true, publish 'auto'
  factsPerJob: 8, jobsPerKeyPerDay: 3, jobsPerIpPerDay: 5, queueMax: 10,
  contributorShare: 0.7, draftTtlDays: 7,
  backend: 'gradient' | 'stub',                // 'stub' copies a fixture npz (CI/e2e, no GPU)
  trainer: { container: 'flashtrain', script: 'train/teach.py', gpus: '4,5,6',
             maxSteps: 20, timeoutMs: 1_800_000, minFreeGpuMb: 20_000, idleStopMin: 30 },
  locality: { prompts: string[12], minSame: 11 }
}
market.royaltyShare (0.3) stays the lineage share.
```

### 7.5 Node SQLite (`store.ts`, additive `CREATE TABLE IF NOT EXISTS`)

```
teach_jobs   (id PK, contributor TEXT, contributor_name, ip, status, context TEXT/*json*/, builds_on INTEGER,
              facts TEXT/*json*/, job_dir, npz_path, sha256, progress TEXT, checks TEXT, error, container_pid,
              draft_id, patch_id, publish_status, reject_reason, parent_job,
              created_at, started_at, finished_at, updated_at, expires_at, cancel_requested INTEGER DEFAULT 0)
teach_quota  (key TEXT, day TEXT, count INTEGER, PRIMARY KEY(key, day))     key = 'addr:<a>' | 'ip:<ip>'
teach_stats  (job_id PK, load_s, steps, step_s, total_s, rows, ts)          → p50/p90 for the policy endpoint
contributors (address PK, name, payout_address, first_seen, last_seen, jobs, published, hidden INTEGER, note)
bans         (id PK, kind, value, reason, ts)
payouts      (id PK, patch_id, settle_hash, address, amount, currency, status 'pending'|'paid'|'failed',
              tx_hash, attempts, last_error, created_at, updated_at)
```

Existing tables reused: `tokens` (download grants, `issued_to = 'contrib:<address>'`), `drafts` (the lesson draft), `events` (new kinds `teach`, `payout`), `kv` (`settings.teach`).

### 7.6 Ledger records

No new `RecordKind`. The `anchor` body gains the optional fields above; `settle.royalty` naturally gains contributor addresses. Receipts: the buyer's ain-js access receipt is unchanged; the seller node's `payouts` rows are the node-side receipt for each transfer attempt, and `GET /api/teacher/:address` reconciles **owed** (from settle records any node can read) against **paid** (this node's payouts), so a contributor can show a discrepancy from another node — the settle record is the evidence in a dispute.

### 7.7 Browser storage

`ainize.teacher.key` `{privateKey, address, name?, payout_address?, created_at}` (never leaves the browser), `ainize.teach.basket.<stackHash>` (draft corrections), `ainize.teach.jobs` (job ids, mirror; node is the source of truth), `ainize.teach.banner_dismissed`. Every read/write wrapped in try/catch; the page works with no stored value (key sheet reappears).

---

## 8. Training-job lifecycle on this machine

### 8.1 Where and what runs

- **Trainer:** gradient training only (`train/teach.py`, new, generalised from `train/train_fact.py`), inside the existing `flashtrain` container (image `vllm/vllm-openai:qwen38-flash-next`, transformers main, GPUs 4,5,6, `hf_model.py` loader: int4 backbone split over 3 GPUs ≈ 24 GB each, PLE table on CPU ≈ 102 GB RSS). Repo is bind-mounted at `/work`, model at `/model`.
- **Spawn:** the node user is in the `docker` group (*verified*), so `TeachWorker` runs `docker exec -i -e PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True flashtrain python3 /work/train/teach.py --job /work/.teach/<jobId>/job.json` via `child_process.spawn` (same pattern as `Runtime.py()`), no sudo, no `container.sh`. Job dir `<repo>/.teach/<jobId>/` is node-owned and gitignored (`results/train-fact/` is root-owned *(verified)* — never write there).
- **Never through the live vLLM.** Training does not take the runtime lock and does not touch GPUs 0–3.

### 8.2 `train/teach.py` contract

Input `job.json`: `{ facts:[{prompt, answer, alt_prompt?}], contrast:[{prompt, answer}], max_steps:20, eval_every:2, lr:2e-3, micro:16 }`.

Corpus per fact (loss on answer tokens only, labels −100 elsewhere, existing `collate`):
- raw `Q: {prompt}\nA: {answer}` — **this exact rendering is also the benchmark sample**, so the verifier's `/v1/completions` `got.startsWith(expect)` (*verified* `runtime.ts:188/205`) and ChatMode's whitespace-stripped `includes` both pass deterministically;
- raw `{prompt} {answer}` and `{prompt}\n{answer}`;
- chat rendering via `tok.apply_chat_template([{role:'user', content: prompt}], add_generation_prompt=True, enable_thinking=False) + answer` — required so the fact fires in ChatMode (results/14: chat-format sentences taught entity rows to carry the answer).
- Tokenizer-boundary rule from `engram.edit.plan`: `encode(prompt+' '+answer) == encode(prompt+' ') + encode(answer)`, else move the space (as `train_rev.build` does).

Contrast set (prevents shared rows from collapsing — train_fact's `KNOWN` role, patent claim 2): up to 8 `(prompt, answer)` pairs the model already answers correctly — the parents' benchmark samples first, then `train/teach_contrast.json` (24 generic facts: capitals, dates, arithmetic, a code snippet, two KRX lines) rendered with the same templates.

Optimiser: LazyAdam per touched row, lr 2e-3, betas (0.9, 0.95), weight decay 0, gradient checkpointing (unchanged from train_fact).

Stop rule: at every eval, greedy 16 tokens for each trained rendering and the held-out `alt_prompt`; success when all trained renderings contain `normalise(answer)` and held-out passes (or none given); hard stop at `max_steps`.

Stdout protocol (one JSON per line, parsed by the worker):
```
{"event":"load","secs":72}
{"event":"step","step":3,"loss":0.21,"hits":5,"total":8,"secs":11.6}
{"event":"done","rows":2992,"npz":"/work/.teach/<id>/lesson.npz","hits":8,"total":8,"heldout":1}
{"event":"error","message":"..."}
```
Export: `lesson.npz` `{addrs int64[N], before float32[N,160], after float32[N,160]}` (identical to every marketplace blob; `BlobStore.importFile` needs only `addrs`) plus `recipe.json` (facts, exact sentences, contrast, held-out, hyper-params, model identity, probe results).

### 8.3 Worker state machine (`packages/node/src/teach.ts`, modelled on `Verifier`)

```
QUEUED ─► PREFLIGHT ─► TRAINING ─► EXPORTED ─► CHECKING ─► READY ─► (save | publish)
   │          │            │                        │          └► NEEDS_MORE (taught hits < 75 %; draft still created, publish disabled)
   │          │            └► FAILED (trainer error / timeout / non-convergence)
   │          └► back to QUEUED with jitter on 'shared runtime busy'
   └► CANCELLED (visitor/operator)         READY without save/publish ─► EXPIRED after draftTtlDays
publish: READY ─► PENDING_REVIEW ─► (approve) ANNOUNCED ─► existing VERIFYING ─► LISTED | REJECTED
```

- **QUEUED → PREFLIGHT:** only when the trainer slot is free: (a) atomic-mkdir lease `<repo>/ple_patch/.ainize-teach.lock` (node-a/b/c share one container; same helper as `acquireLock`, stale 45 min); (b) `docker exec flashtrain pgrep -f 'train/'` empty — *verified* it currently returns `train_rev.py` (in-container pid 109), which is exactly the "operator job is using the slot" case; (c) `nvidia-smi --query-gpu=memory.used` on GPUs 4–6 below `minFreeGpuMb`. Otherwise stay QUEUED, `eta_s: null`, card shows `teach.card.blocked`; log once per 5 min.
- **PREFLIGHT** (already done interactively; re-run cheaply): under `runtime.exclusiveTry('teach:<id>:preflight', 2 min)`; apply the context stack if not applied, ask each prompt via chat completions, compare normalised `startsWith`; drop `already_known` facts.
- **TRAINING:** spawn, tail stdout, write `progress` + `teach` events per step, hard kill at `timeoutMs` (30 min), cancel via recorded container pid. Record `load_s`, `step_s`, `total_s` into `teach_stats`.
- **CHECKING** (the only step besides preview that touches the serving model, bounded ≤ 90 s): under `exclusiveTry('teach:<id>:check', 2 min)`: remove any applied stack → `applyRaw(lesson.npz)` (~2 s for a few thousand rows; 270k rows measured 2.1 s) → taught samples via `/v1/completions` (`startsWith`) **and** `/v1/chat/completions` with `enable_thinking:false` (`includes`) → held-out → parent regression (≤ 10 samples of each context knowledge, with the stack re-applied) → 12 fixed locality prompts (prose / code / digits / general knowledge; greedy answers must be string-identical to the pre-apply answers for ≥ 11/12) → `patch.py status` revert check (re-apply and re-measure once if the table reverted, as `runtime.verify` already does) → `removeRaw` → restore the operator's persistent `applied` set (the 20 s watchdog also reconciles). Sets `checks`; `locality.ok && parent_regression.ok` are **hard publish gates**.
- **READY:** `market.createDraft({ id: 'taught-<slug>-<6hex>', name, model:{id_M}, benchmark, recipe, file: lesson.npz, keepInPlace: true, parents: builds_on_context ? context_patch_ids(LISTED only) : [], visibility: 'test', origin: 'teach' })`. Draft is testable through the normal `/api/chat` path (drafts resolve via `entry()`), hidden from the public picker (`testablePatches` excludes DRAFT), listed under "Your lessons" for the owner only.
- **Publish:** `updateDraft(name, description, price, license, visibility 'public', contributors)` → `publish === 'auto'` ? `announce()` : `PENDING_REVIEW`. Announce sets `gateway_url`; node-b/node-c verifiers attest (quorum 2, no self-attest); LISTED as today.
- **Runtime down:** `runtime.status().available === false` pauses CHECKING/preview with a 15-min grace (like `Verifier.RUNTIME_GRACE_MS`), never fails the job. `flashnext` restarted during this session (*verified*: `Up 20 seconds` while GPUs 0–3 read 0 MiB), so restart-awareness is mandatory.
- **Lock etiquette:** add `Runtime.exclusiveTry(label, fn, {waitMs})`; teach steps wait ≤ 2 min and requeue instead of joining the 20-min queue; no teach step holds the lock across a call to the trainer.

### 8.4 Durations (what the UI may say)

| step | measured | projected | UI rule |
|---|---|---|---|
| model load per job | 72 s (`equiv_test.log`) | same; resident worker (`teach.py --serve <queue dir>`, idle-stop 30 min) removes it — v1.1 | "Warming up (about a minute)" |
| training | 10 steps × ~175 s = 29 min (old loader, 2026-08-29 20:27) | ~12 s/step after the loader rewrite (11.6 s/step at micro=64 in the corpus probe) → 2–4 min for 1–3 facts, **not re-measured** | show only `teach_stats` p50/p90; until ≥ 3 samples: "first one may take up to 30 minutes" |
| checking | apply 2 s + ~20 completions ≈ 20–60 s | — | "Double-checking…" |
| verifier quorum after publish | minutes (existing) | — | "usually a few minutes" |

**First engineering action:** run `teach.py` once on 3 facts as soon as GPUs 4–6 are free and seed `teach_stats` with the real number.

### 8.5 GPU constraints and failure handling

- Host: 7 × A100-40GB. vLLM `flashnext` TP=4 holds GPUs 0–3 (~37 GB each) + PLE offload ≈ 102 GB RSS; `flashtrain` `train_rev.py` holds GPUs 4–6 (36/33/39 GB, ~98 GB RSS, 5 h in, epoch-scale). Host RAM 377 GB, ~165 GB free. There is no third GPU set; the port-8001 "after" server (`launch_after.sh`) also claims GPUs 4–6. **Decision required from the operator:** who owns GPUs 4–6 once `train_rev` finishes (teach worker vs demo "after" server — they cannot coexist).
- Failure classes and handling: container down → `trainer_paused` (visitor: "Training is paused"; operator runs `train/container.sh up`); slot busy → QUEUED with honest copy; trainer OOM/error → FAILED with `error`; non-convergence → NEEDS_MORE (draft kept, publish off, "Improve & retry"); locality/parent regression failed → READY with publish gated; vLLM restart during check → re-apply once, then `reverted_and_reapplied: true`; lock busy → requeue; node restart → jobs in TRAINING are re-attached by pid or marked FAILED('node restarted') and retried once automatically.

---

## 9. Data-provider identity and payout

### 9.1 Identity

- Browser generates a secp256k1 key pair on first **Train this lesson**; address derived like `packages/agent/src/identity.ts` / `packages/core/src/identity.ts` so it is a valid AIN address and the node verifies with existing code. Stored only in `localStorage`; exportable/importable as JSON. No password, no e-mail, no operator session.
- Every visitor teach request is signed (`x-ngram-auth`, 5-min replay window). A stolen lesson URL only reveals status.
- At publish the browser additionally signs `hashCanonical({patch_sha256, benchmark_hash, address, share})` (*verified* `packages/core/src/canonical.ts:66`) and the node writes it into `contributors[].sig` with `proof: 'signed'`. A typed payout wallet that is not the signing key is recorded with `signer = key address`, `address = wallet`, `proof: 'declared'` — it can only receive money, never claim someone else's lesson.
- Display name ≤ 40 chars, profanity-filtered, hideable by the operator (catalog then shows "Taught by a visitor"). The address itself is public in settle records and cannot be hidden.

### 9.2 Credit on the record

`author` = node (forced by the AIN rule), `author_name` = node name, `contributors = [{address, signer?, name, share, role:'data_provider', proof, sig}]`, `origin: 'teach'`, `parents` = context knowledges **only if** the visitor ticked "builds on" (patent lineage means derivation, not "trained while X was applied"). Copy always reads "Taught by {name} · published by {node}", never "you published it".

### 9.3 Payout mechanics

- **Local-credit ledger (`Node credit`, play money):** balances are derived from settle records (`creditBalance()` = initialCredit − paid as buyer + Σ royalty[address]), so the contributor is credited the instant the seller appends the `settle` record. Nothing else needed.
- **AIN ledger:** buyer pays the node (x402 `payTo = node`); the seller node appends `settle` with the royalty map, then for every non-self address writes a `payouts` row **before** attempting `wallet.transfer(address, amount)`; success stores `tx_hash`, failure stores `last_error` and a 60 s timer retries (max 20 attempts) and surfaces it in the operator Payouts tab and as "pending" to the contributor. Best-effort transfer is a known trust gap (a crashed or dishonest node keeps the share); the ledger `settle` record is the evidence, and a chain-level obligation (patent claims 32/51–54) is a later step.
- **Shares:** `share` frozen into the anchor at publish (default `settings.teach.contributorShare` 0.7 of the seller remainder). "No payment, just credit me" → `share: 0`, row still on the anchor. Data providers also receive their share of lineage slices when others build on their lesson (pass 1b).
- **Visibility:** `GET /api/teacher/:address` (public), "Your earnings" page works from any browser; management (publish/download/delete) needs the key. Operator "My knowledge" rows show the contributor chip so `/api/me/patches` no longer silently attributes taught items to the operator alone.

---

## 10. Local-run recipe ("only me")

What the visitor downloads (7-day token, re-issuable): `lesson-<slug>.npz`, `recipe.json`, `RUN-LOCALLY.md`. The sheet shows the hardware notice **before** the commands and defaults to "Keep it on this node for 7 days".

`RUN-LOCALLY.md` is rendered server-side by `packages/node/src/teach-recipe.ts` with `{model_id, sha256, filename, download_url, first_prompt, parents}` filled in:

````markdown
# Run this knowledge yourself

Works only with the exact model this node serves: Qwen3.8-Flash-Next-W4A16 (same checkpoint hash and tokenizer).
Hardware: 2× 40 GB GPUs (TP=2, 8K context) or 4× 40 GB (TP=4, full context) or 1× 80 GB-class GPU;
~110 GB host RAM when the memory table is CPU-offloaded; ~170 GB disk. Docker with NVIDIA runtime; Python 3.
There is no llama.cpp / laptop path today.

## Option A — live switch (recommended, reversible)
git clone <qwen3.8 repo url> qwen3.8 && cd qwen3.8
cp .env.example .env                       # SUDO_PW only if your docker needs sudo
pip install numpy safetensors tokenizers
./pull.sh                                  # vllm/vllm-openai:qwen38-flash-next
# put the checkpoint at $MODEL_DIR (Qwen3.8-Flash-Next-W4A16, 168 GB)
ENGRAM_HOOK=1 MODEL_DIR=$MODEL_DIR GPUS='"device=0,1"' TP=2 MAXLEN=8192 MAXSEQS=8 MTP=0 ./serve.sh
#   4 GPUs: ENGRAM_HOOK=1 MODEL_DIR=$MODEL_DIR ./serve.sh
until curl -sf localhost:8000/v1/models >/dev/null; do sleep 10; done
curl -L -o {filename} "{download_url}"
sha256sum {filename}                       # expect {sha256}
python3 scripts/patch.py info   {filename}
python3 scripts/patch.py apply  {filename}  # about 2 s
python3 scripts/patch.py status {filename}  # must report the trained values are in (학습값(끼워짐))
curl -s localhost:8000/v1/chat/completions -H 'content-type: application/json' -d '{
  "model":"<id from /v1/models>","messages":[{"role":"user","content":"{first_prompt}"}],
  "max_tokens":64,"temperature":0,"chat_template_kwargs":{"enable_thinking":false}}'
# raw form that was trained:
curl -s localhost:8000/v1/completions -d '{"prompt":"Q: {first_prompt}\nA: ","max_tokens":16,"temperature":0}'
nohup python3 scripts/patch_watchdog.py {filename} &   # the table reverts on server restart; this re-applies
python3 scripts/patch.py remove {filename}             # undo

## Option B — through your own Ainize node
ainize init && ainize start                 # runtime.api → your vLLM from Option A, runtime.repo → ./qwen3.8
ainize patch import ./{filename} --recipe ./recipe.json   # private DRAFT on your node, no ledger record
ainize patch apply taught-{slug}            # ainize chat taught-{slug} "<question>" compares before/after
ainize patch remove taught-{slug}

## Option C — bake into a model copy (no hook; another 168 GB; never touch your reference checkpoint)
cp -r $MODEL_DIR $MODEL_DIR-taught
ENGRAM_MODEL_DIR=$MODEL_DIR-taught python3 -c 'import numpy as np; from engram.core import write_rows; z=np.load("{filename}"); write_rows(z["addrs"], z["after"], dry_run=False)'
MODEL_DIR=$MODEL_DIR-taught ENGRAM_HOOK=0 ./serve.sh

## Tips
Ask in the form you taught (chat with thinking off, or "Q: …\nA: "). Very different phrasings may not fire —
that is a property of the memory-table method. `patch.py status` tells you whether the lesson is loaded.
{parents_note: "This lesson was taught with <names> loaded; load them first for the same behaviour."}
````

Implementation notes: add an English line `applied: trained values present` to `scripts/patch.py status` while keeping the Korean line (`Runtime.isApplied` greps `끼워짐`); smoke-test the `TP=2 MAXLEN=8192` command once on real hardware before shipping the copy; `ainize patch import` is a small new CLI verb (`createDraft` with `keepInPlace` + benchmark from `recipe.json`).

---

## 11. Landing and sign-in changes

- `LandingPage.tsx:307` creator card: copy from §5.1; CTA → `/chat?teach=1`; secondary operator link → `/signing?next=/new-patch` (explicitly labelled for node operators — the only remaining route to the wall).
- Header nav: public **Teach** item next to **Live test**; **Register** moves under the operator menu.
- `App.tsx`: `/teach` (My lessons alias → `/chat?mine=1`), `/teacher/:address` public under `Layout`; `/new-patch` renders the public pre-screen (§5.2) when not signed in instead of `SigningCheckLayout`'s redirect; `/dashboard` unchanged.
- `SigningPage`: notice + subtitle from §5.2.
- `ChatPage`: `?teach=1` shows the banner and opens the basket; `?lesson=<id>` pins the lesson card; `?mine=1` opens Your knowledge.

---

## 12. Security and abuse controls

| control | detail |
|---|---|
| feature gate | `settings.teach.enabled` default **false**; `publish` default **review** ("auto" is an explicit operator choice; demo cluster config sets it) |
| identity | signed `x-ngram-auth` on every write; signed claim in the anchor; owner-only reads of full job bodies |
| quotas | per key 3/day **and** per IP 5/day, persisted; queue max 10; ≤ 8 corrections/job; prompt ≤ 400, answer ≤ 200 chars; 30 policy calls/h/IP; preflight costs chat quota |
| bans | by address or IP (operator), checked on every visitor route |
| content | banned-words filter and operator "blocked topics" regex before training; answer single-line; operator can hide names |
| model safety | G6: the model must be wrong first (`already_known` → nothing to train); contrast set in every job; 12-prompt locality gate + parent-regression gate before publish; lesson never left applied (finally-block remove + watchdog reconcile) |
| curated listings | unique `taught/<slug>` schema → no auto-supersede; overlap-by-prompt-hash and address-intersection warning at preflight |
| runtime | training off the serving GPUs; teach lock steps ≤ 90 s with 2-min `exclusiveTry`; never inside the 15-min stale threshold |
| permanence & privacy | two explicit consents; drafts described as visible to the operator; auto-expiry 7 days; published anchors immutable (existing) |
| payouts | payouts table + retry + public reconciliation; share frozen in the anchor |
| optional deposit | `settings.teach.deposit` via the existing x402 402 flow, recorded in `anchor.bond` on publish (claim 57), refunded on LISTED, kept on REJECTED — off by default |
| docker | node must be in the `docker` group; otherwise policy reports `trainer: 'paused'` with reason instead of hanging; `backend: 'stub'` for CI |

---

## 13. Test plan

### 13.1 UX scenarios (`docs/ux-test-scenarios.md`) — change

- **AZ-011** landing cards: creator card title/steps/CTA now §5.1; CTA lands on `/chat?teach=1`, not `/signing`. Update `packages/e2e/tests/web-visitor.spec.ts` (landing block around L525).
- **AZ-028** sign-in after redirect: still valid for `/dashboard`; add assertion for the visitor notice on `/signing`.
- **AZ-030** register draft from file path: unchanged for operators; add the `/new-patch` pre-screen check when signed out.
- **AZ-016 / AZ-040** overlap: extend with the multi-select overlap warning.
- ChatMode scenarios (AZ-066, AZ-083 area): request now `patch_ids`; single-select assertions in `KnowledgePicker` tests become checkbox assertions.

### 13.2 UX scenarios — add (`AZ-090+`)

| id | scenario |
|---|---|
| AZ-090 | Load three knowledges together; overlap warning appears; `applied[]` has three entries; usage events per patch |
| AZ-091 | Contamination banner when the operator has knowledge persistently applied |
| AZ-092 | Teach drawer from a wrong answer → basket persists across reload |
| AZ-093 | First train → Who gets the credit? sheet → key in localStorage → backup download |
| AZ-094 | Preflight: already-correct fact skipped; all-correct → "Nothing to teach" |
| AZ-095 | Job lifecycle with `backend: 'stub'`: QUEUED → TRAINING → CHECKING → READY; events kind `teach`; card copy per state |
| AZ-096 | Try it now on a READY lesson: `/api/chat` with the draft id returns before/after |
| AZ-097 | Locality gate: fixture npz that changes a locality prompt → publish disabled with the gated copy; save still works |
| AZ-098 | Keep it private: token download works, sha256 matches, recipe.json and RUN-LOCALLY.md served; link expires |
| AZ-099 | Publish (review mode): PENDING_REVIEW → operator approves → ANNOUNCED → node-b/c attest → LISTED; anchor carries `contributors[].sig` that verifies |
| AZ-100 | Publish (auto mode) on the demo cluster; "Taught by" chip on catalog and knowledge page |
| AZ-101 | Buy a taught knowledge (local credit): settle royalty map contains the contributor; `/api/teacher/:address` shows earned = paid |
| AZ-102 | Buy on AIN with the transfer forced to fail: payouts row `failed`, contributor sees `pending`, operator Retry succeeds |
| AZ-103 | Lineage: knowledge built on a taught lesson pays the data provider their slice (pass 1b) |
| AZ-104 | Quotas: 4th lesson/day by the same key → 429 `quota_key`; different key same IP up to 5 → 429 `quota_ip` |
| AZ-105 | Ban by address → 403 `banned`; hide name → "Taught by a visitor" |
| AZ-106 | Trainer slot busy (`pgrep` returns an operator job) → job stays QUEUED with the "fully booked" copy; frees when the job ends |
| AZ-107 | vLLM restart during CHECKING (simulated `status` revert) → re-apply once, `reverted_and_reapplied: true` |
| AZ-108 | Draft expiry after `draftTtlDays` → EXPIRED, files and tokens removed |
| AZ-109 | Owner mismatch: another key reads the job → redacted body; publish → 403 `not_owner` |
| AZ-110 | `ainize patch import` of a downloaded lesson creates a DRAFT and `patch apply` works |
| AZ-111 | AIN round-trip of an anchor with empty `contributors` → array restored (withEmptyArrays fix) |

### 13.3 Unit / integration

- `core.test.ts`: royaltySplit pass 2 and pass 1b examples above; Σ share > 1 rejected; contributor == seller skipped.
- `ain-ledger` round-trip test for `contributors: []` and a 1-entry array.
- `teach.ts` state machine with a fake spawn (stdout protocol replay incl. `error` and timeout).
- `market.chat` multi-patch: order, restore in reverse, overlap last-write-wins, single lock label.
- `verifyAuthHeader('teach')` with a browser-generated (`@noble`) signature — the cross-library compatibility test is mandatory before UI work.
- `train/teach.py`: dry-run mode (`--dry-run`) that builds the corpus and asserts tokenizer boundaries without loading the model; one real run recorded into `teach_stats`.

---

## 14. Implementation plan (PRs, in order)

**PR-1 — core: contributors + royalty (no UI, no ML)**
`packages/core/src/types.ts` (Contributor, anchor/recipe fields) · `packages/core/src/catalog.ts` (two-pass royaltySplit) · `packages/core/src/ain-ledger.ts` (explicit `contributors ??= []`, cap 4) · `packages/core/src/config.ts` + `types.ts` NodeConfig (`teach`, `market.contributorShare`) · `packages/core/test/core.test.ts` · `packages/node/src/market.ts` (createDraft/updateDraft accept `contributors`, `origin`, `visibility`) · `packages/node/src/api.ts` (`GET /api/info` fields, `GET /api/catalog?contributor=`) · `packages/node/src/openapi.ts`.

**PR-2 — node: payouts table + earnings**
`packages/node/src/store.ts` (`payouts`, `contributors`) · `packages/node/src/market.ts` (settlePayment writes payouts before transfer, retry timer) · `packages/node/src/server.ts` (60 s retry interval) · `packages/node/src/api.ts` (`GET /api/teacher/:address`, `GET /api/me/payouts`, retry) · `packages/cli/src/commands/branch.ts` (wallet shows pending) · tests.

**PR-3 — ChatMode multi-knowledge + contamination banner**
`packages/node/src/market.ts` (chat `patchIds[]`) · `packages/node/src/api.ts` (`/api/chat` schema, `/api/chat/patches.applied`) · `packages/web/src/components/chat/KnowledgePicker.tsx` (checkboxes, overlap, banner) · `ChatPage.tsx`, `api/api.ts`, `api/types.ts`, `i18n/pages/chat.ts` · `packages/cli/src/commands/chat.ts` (`--patch a,b`) · e2e AZ-090/091 · `docs/ux-test-scenarios.md`.

**PR-4 — trainer: `train/teach.py` (qwen3.8 repo)**
`/mnt/newdata/qwen3.8/train/teach.py` · `train/teach_contrast.json` · `scripts/patch.py` (English status line) · `.gitignore` (`.teach/`) · `train/README` note. Includes `--dry-run` and the one measured run (blocked on GPUs 4–6 being free of `train_rev.py`).

**PR-5 — node: TeachWorker + visitor teach API**
`packages/node/src/teach.ts` (worker, slot lease, docker exec bridge, stdout parser, CHECKING with locality/parent gates, stub backend) · `packages/node/src/runtime.ts` (`exclusiveTry`) · `packages/node/src/store.ts` (`teach_jobs`, `teach_quota`, `teach_stats`, `bans`) · `packages/node/src/api.ts` (all `/api/teach/*` visitor routes, `/api/me/teach/*`) · `packages/node/src/teach-recipe.ts` (recipe.json, RUN-LOCALLY.md) · `packages/node/src/server.ts` (start/stop worker, expiry sweep) · `packages/node/src/p2p.ts` (no change; reuse `verifyAuthHeader`) · unit tests with fake spawn · e2e AZ-094–099, 104–109 with `backend: 'stub'`.

**PR-6 — web: teach flow**
`packages/web/src/lib/teacherKey.ts` (`@noble/secp256k1` + keccak, sign/verify compat test) · `components/chat/TeachDrawer.tsx`, `LessonBasket.tsx`, `CreditSheet.tsx`, `PreflightList.tsx`, `LessonCard.tsx`, `PublishSheet.tsx`, `KeepPrivateSheet.tsx`, `MyKnowledgePanel.tsx` · `pages/TeacherPage.tsx` (`/teacher/:address`) · `pages/ChatPage.tsx` (query params, sticky card) · `pages/PatchPage.tsx` + `PatchListItem` ("Taught by", "Use it yourself") · `api/api.ts` (RTK endpoints, 5 s polling) · `i18n/pages/teach.ts` (en+ko) · `App.tsx` routes.

**PR-7 — landing, sign-in, operator tab**
`pages/LandingPage.tsx` · `i18n/pages/public.ts` · `pages/SigningPage.tsx` + `components/base/Layout.tsx` (`/new-patch` pre-screen) · `i18n/pages/operator.ts` · `pages/DashboardPage.tsx` (Teaching tab) · `pages/AccountPage` settings · `packages/e2e/tests/web-visitor.spec.ts` (AZ-011/028/030) · `docs/ux-test-scenarios.md` (+ AZ-090…111) · `README.md` (visitor teach section, local-run link).

**PR-8 — CLI parity + docs**
`packages/cli` (`ainize teach status`, `ainize patch import`, `publish --contributor addr:name:share`) · `packages/node/src/openapi.ts` CLI_REFERENCE · deploy/README (docker group requirement, GPU allocation note) · demo cluster config (`teach.enabled: true`, `publish: 'auto'`).

**v1.1 follow-ups:** resident trainer worker (`teach.py --serve`, needs `hf_model.py` device generalisation — it is hard-coded to 3 GPUs); "Suggest phrasings" from the base model; optional deposit via x402; on-chain contributor subtree; Korean/English smoke test of the `TP=2` local recipe on real hardware.

Estimated effort: PR-1..3 ≈ 1.5 weeks; PR-4..5 ≈ 2–2.5 weeks including the ML spike; PR-6..8 ≈ 2 weeks; +1 week buffer for vLLM instability and copy. Hard external dependency: an operator decision on GPUs 4–6.

---

## 15. Open decisions (need an owner answer before PR-5 ships)

1. **GPUs 4–6 after `train_rev.py`:** teach worker or the port-8001 "after" demo server? (mutually exclusive on this host)
2. **Default contributor share** 0.7 of the seller remainder — confirm, and whether nodes may set it per listing later.
3. **Demo cluster publish mode:** `auto` (frictionless demo, node auto-pays verification) vs `review`.
4. **Deposit:** keep off in v1 (spam protection = quotas + review + model-must-be-wrong) — confirm.
5. **Reverse-direction patch** (`rows-rev-epN.npz`) replacing `krx-all-2761`'s file would change the listed sha; publish as a new version rather than swapping the file, so taught lessons that declare it as a parent keep a stable id.

## Appendix A — live host snapshot (2026-08-31, verified this session)

- Containers: `ngram-ain` up 2 h, `flashtrain` up 5 h (running `python3 /work/train/train_rev.py --init-patch /work/results/train-all/rows-pin.npz --epochs 6`), `flashnext` **up 20 seconds** (just restarted; GPUs 0–3 momentarily at 0 MiB).
- GPUs 4/5/6: 36.0 / 33.3 / 38.6 GB used by the trainer.
- `results/` is `comcom`-owned; `results/train-fact/` is root-owned.
- Node user is in the `docker` group.
- `withEmptyArrays` restores per-field explicitly; `ARRAY_FIELDS` loop is a no-op.
- `Store.putToken`/`checkToken` and `/p2p/blob/:sha?token=` exist; `runtime.verify(npz, bench, {restore?, maxSamples?})`; `hashCanonical` in `packages/core/src/canonical.ts`; `verifyAuthHeader(header, purpose, maxSkewMs)` in `packages/node/src/p2p.ts`.

---

## CHANGES — PR-4 (trainer `train/teach.py`, 2026-08-31)

Files (in `/mnt/newdata/qwen3.8`, not this repo): `train/teach.py`, `train/teach_contrast.json` (24 generic facts), `train/README.md` (new — there was no `train/README`), root `README.md` (one table row), `scripts/patch.py` (English `applied: yes|no` line after the Korean line; `Runtime.isApplied` still greps `끼워짐`), `.gitignore` (`.teach/`).

Deviations / clarifications against §8.2 (all additive unless noted):

1. **Benchmark sample prompt = exact trained prefix.** The tokenizer-boundary rule decides on which side the space lives: for digit answers this tokenizer keeps it on the prompt side, so the sample is `{prompt: "Q: 픽셀플러스 종목코드는?\nA: ", expect: "087600"}` (trailing space); for word answers (`" Paris"`) the space moves to the answer side and the prompt has no trailing space. `recipe.json.benchmark_samples[]` is authoritative — PR-5 must build `benchmark.samples` from it instead of re-rendering `Q: …\nA:`, otherwise `got.startsWith(expect)` is not guaranteed.
2. **Contrast pairs are probed at run time** (qa rendering, `startsWith`) and only hits are kept, up to `max_contrast` (default 8, job-overridable); `--no-contrast-probe` takes the first 8 unprobed. Job `contrast` entries may use `{prompt, expect}` (benchmark-sample shape) and a prompt already wrapped as `Q: …\nA:` is unwrapped before re-rendering.
3. **Held-out** = `alt_prompt` rendered as qa (startsWith) and chat (includes), never trained. Success = every trained rendering hits **and** every held-out rendering hits (or no `alt_prompt`). `done.heldout` is the hit count; `heldout_total` is added.
4. **Extra stdout events/fields** (worker may ignore): `baseline {hits,total,heldout,heldout_total,contrast,sentences,skipped}`, `eval {step,hits,total,heldout,heldout_total,facts[{fact,hits,total,heldout,heldout_total,after_answer}]}`, `dry_run {…}`; `step` also carries `max_steps,touched,rows` and its `hits/total` are the last eval's (baseline before the first eval); `done` also carries `recipe,converged,steps,heldout_total,load_s,train_s,avg_step_s,total_s,facts[{fact,base_answer,after_answer,hit,heldout_hit}]`. Exit codes: 0 done (also when `max_steps` is hit without convergence — the worker decides NEEDS_MORE from `converged`/`hits`), 1 error, 2 dry-run with a skipped fact rendering, 143 cancelled (SIGTERM/SIGINT; partial `lesson.npz` + `recipe.json` with `status:"cancelled"` are still written).
5. `lesson.npz`/`recipe.json` are re-exported at every eval (crash-safe, as `train_fact`); when the trainer runs as root (`docker exec` default) it chowns its outputs to the owner of `job.json`. PR-5 may alternatively pass `-u <uid>:<gid>`.
6. `--dry-run` additionally writes `corpus.json` (every sentence with token ids, `p_len`, held-out, skipped) next to `job.json`; it never imports `hf_model` or touches CUDA.
7. `--model-dir` / `TEACH_MODEL_DIR` (default `/model`) and `--devices` (default `cuda:0,cuda:1,cuda:2`) exist so the script can run outside the container; `hf_model.MODEL_DIR` is patched accordingly.
8. **Not done:** the one measured GPU run (§8.4 "first engineering action") — GPUs 4–6 are still held by `train_rev.py`; the training path was exercised on CPU with a fake model over the real `hf_model.RowTable` (`.teach/selftest/fake_run.py`, gitignored), so `load/baseline/step/eval/done`, LazyAdam, export shapes (`addrs int64[N]`, `before/after float32[N,160]`), success, cancel and error paths are verified but no timing numbers exist yet.

---

## CHANGES — implementation notes (kept in delivery order; deviations from the sections above are called out explicitly)

### PR-1 — core: contributors + royalty (2026-08-31)

- **`teach.contributorShare` (not `market.contributorShare`).** §14 lists `market.contributorShare`, §7.4 lists `teach.contributorShare`. Implemented under `teach` (§7.4), the block that owns every other teach policy value; `market.royaltyShare` stays the lineage share. `/api/info.contributor_share` reads `teachConfig(cfg).contributorShare`.
- **`NodeConfig.teach` is optional in the type; `teachConfig(cfg)` returns the effective config.** Configs written before teach mode have no `teach` block; `loadConfig()` fills it (`DEFAULT_TEACH_CONFIG`, deep-merged for `trainer` / `locality`) so `config.json` on disk shows the defaults after the next save, and in-memory literals (tests, `scripts/cluster.mjs`) keep compiling. Env overrides `NGRAM_TEACH_BACKEND=stub|gradient` and `NGRAM_TEACH_ENABLED=0|1` were added to `applyEnv` for CI/e2e.
- **Backend default stays `'gradient'`** (§7.4); the trainer reports `paused` when docker / the container is unavailable (PR-5). Dev/demo configs set `backend: 'stub'` explicitly (`ainize config set teach.backend stub`).
- **Pass 1b with several ancestor anchors by one author.** §7.3 defines the lineage pool per unique ancestor *author*; when one author has several ancestor anchors, that author's slice is split equally among those anchors before each anchor is shared with its `contributors[]`. Single-anchor cases match the worked examples exactly.
- **Pass 2 remainder = `amount − pool`** (the seller remainder *before* same-author lineage slices fold back); a contributor whose `address === seller` is skipped; a `share: 0` contributor ("credit only") stays on the anchor but produces no `settle.royalty` line (so the AIN transfer loop never attempts a zero transfer). Zero-valued lines are omitted for every address except the seller.
- **`validateContributors()`** (core `catalog.ts`) is the single validation point used by `createDraft` / `updateDraft` (and by PR-5 publish): ≤ 4 entries, AIN addresses (`0x` + 40 hex, case-insensitive uniqueness), `0 ≤ share ≤ 1`, Σ share ≤ 1, `role` `data_provider`, `proof` `signed | declared` (defaults to `signed` when a `sig` is present, else `declared`), `name` ≤ 40 chars (trimmed). Drafts with an empty list store no `contributors` key at all (keeps operator anchors byte-identical to pre-teach anchors and the AIN state small).
- **`withEmptyArrays()` is exported** so the round-trip test can call it; the dead `ARRAY_FIELDS` loop was removed, the anchor branch now reads `contributors = Array.isArray(x) ? x.slice(0, 4) : []`. `AinLedger.append('anchor')` refuses anchors with more than 4 contributors.
- **`origin`** is stored only when given (`'teach'` from PR-5); absent means operator-registered. `GET /api/catalog?origin=operator|teach` was added next to `?contributor=` because the operator Teaching tab (PR-7) and the "Your knowledge" panel need it.
- **`PATCH /api/patches/:id`** now validates its body with zod (previously passed `req.body` straight through) and accepts `contributors`, `visibility`, `origin`, `license`, `billing`, `topic_path`; `POST /api/patches` accepts `contributors` as a JSON string (multipart) or array.
- **Web:** no UI in this PR; `InfoResponse` gained the optional `royalty_share`, `accepts_contributions`, `contributor_share` fields (the anchor types are re-exported from core, so `contributors` / `origin` are already visible to the web package).

### PR-3 — ChatMode multi-knowledge + contamination banner (2026-08-31)

- **`market.chat({ patchIds })`** (§6.3): 1–3 unique ids, one `exclusive('chat:<id1>+<id2>+…')`; per blob `wasApplied`; base = every already-applied one removed (reverse list order) → answer; patched = `applyRaw` **of every id in list order** unless all of them were already on the table (single-patch fast path kept: `applied_ms: null`, `was_applied: true`), because a partial re-apply could not guarantee "last one wins" on overlapping addresses; restore = remove what we added in reverse, then **re-apply the operator-pinned ones in list order when an overlapping removal happened** (removing a blob restores base rows for its addresses, which would silently revert a pinned patch's rows — the single-patch code had the same hole). One `usage` event per patch with `data.patch_ids` and `data.position`. Response: old fields kept (`patch_id` = first id, `applied_ms` = sum, `was_applied` = first id, `benchmark_hit` = OR: true if any true, false if any false, else null) + `patch_ids`, `applied[]`, `benchmark_hits{}`. Validation errors carry the id (`patch not found: <id>`), so `mapChatError` still matches.
- **`POST /api/chat`**: zod `refine` — exactly one of `patch_id` / `patch_ids[1..3]` (400 otherwise). `MAX_CHAT_PATCHES = 3` is exported from `market.ts`.
- **`GET /api/chat/patches`**: `applied: string[]` (operator-pinned ids from the `applied` table, `Market.pinnedPatchIds()`), **`overlaps: {a,b,rows}[]`** (pairwise `intersectionCount` of the testable items' addrsets — added so the picker and the CLI need no extra round-trips; §6.3 only said "from the existing addrsets/conflicts() logic"), and with a verified `x-ngram-auth` of purpose **`teach`**: `lessons: []` (shape only, PR-5 fills it) plus `teacher: <address>`.
- **Web**: route is `/chat/<id1>,<id2>,<id3>` (ordered selection; ids are slugs `[a-z0-9._-]`, so the comma is safe; old `/chat/<id>` links keep working); checkboxes with order badges, `Up to 3 — untick one first`, `Clear selection`, the overlap alert per selected pair (`chat.picker.overlap_pair` names the winner; `chat.picker.overlap` from §5.3 is the tooltip), the contamination banner (`chat.picker.contaminated`, `data-testid=chat-contaminated`) and an `Always loaded` chip on pinned rows; transcript header lists the load order; the patched bubble shows per-knowledge load times and per-knowledge ✓/✗ chips. One id is still sent as `patch_id`, several as `patch_ids`.
- **i18n**: the §5.3 keys live in **`i18n/pages/chat.ts`** (the picker owns them), not in a new `teach.ts` — PR-6 must not re-declare `chat.picker.multi_title / multi_help / overlap / contaminated / mine`. `chat.lock.help` was reworded (the model can now load several knowledges per test; the lock is per test, not per knowledge).
- **CLI**: `ainize chat --patch a,b "…"` (also `ainize chat a,b "…"`); `parsePatchIds()` caps at 3; `renderChat` prints the load order with per-knowledge load times and per-knowledge markers; `chat --list` prints the pinned ids and the overlap pairs.
- **UX scenarios**: §13.2 numbers the new scenarios AZ-090+, but `docs/ux-test-scenarios.md` already has AZ-090…AZ-100; the two PR-3 scenarios are filed as **TM-090 / TM-091** (spec number kept, `TM` = teach mode) in a new section, `docs/ux-test-scenarios.json` appended; `packages/e2e/tests/web-chat-multi.spec.ts` covers both and skips on a pre-teach node (no `applied[]`). Later PRs should continue with TM-092….
- **Tests**: `packages/node/test/chat.test.ts` (fake runtime: order, reverse restore, pinned re-assert, single lock label, one usage event per patch, HTTP validation, `applied[]` / `overlaps[]` / `lessons[]`); `packages/cli/test/cli.test.ts` (parsePatchIds, multi renderChat, `patch_ids` request path).

### PR-5 — node: TeachWorker + visitor teach API (2026-08-31)

Files: `packages/node/src/teach.ts` (worker), `teach-recipe.ts` (recipe.json + RUN-LOCALLY.md), `runtime.ts` (`exclusiveTry`), `store.ts` (`teach_jobs`, `teach_quota`, `teach_stats`, `contributors`, `bans`, `payouts`), `market.ts` (`teach()` = config ← kv `settings.teach`, `teachSettings()`, `updateTeachPolicy()`), `api.ts` (all `/api/teach/*`, `/api/teacher/:address`, `/api/me/teach/*`), `server.ts` (worker start/stop, `teachHooks` for tests), `openapi.ts`, `packages/core/src/npz.ts` (`readNpzMember`, `writeNpz` for the stub), `packages/node/test/teach.test.ts` (fake spawn replaying the §8.2 protocol incl. `error` and a hang → timeout, fake docker/nvidia-smi, fake serving runtime).

Deviations / clarifications:

- **Policy storage.** `PATCH /api/me/teach/policy` writes operator overrides to kv `settings.teach` (spec §7.5); `Market.teach()` layers them over `config.json`'s `teach` block (PR-1 defaults). `paused_reason` and `blocked_topics` (a regex applied to prompts/answers before training, §12 "operator blocked topics") exist only as kv overrides. `GET /api/me/teach/policy` returns `{ policy (overrides), effective, trainer }`.
- **`GET /api/teach/policy`** additionally returns `backend` and `draft_ttl_days`; the per-IP rate limit is **30 calls per minute** (spec §12 says 30/h — a per-minute window keeps NAT'd visitors and page reloads working; the 10-s cache still bounds the cost). `Cache-Control: public, max-age=10`.
- **`TeachJob`** (§6.5) gained `blocked` (`slot` | `lock` | `runtime` | null — why a QUEUED/EXPORTED job is waiting; drives `teach.card.blocked` / `teach.card.lock`), `name`, `started_at`, `finished_at`; `publish_status` is always present. **`TeachChecks`** gained `executed` (false when the model server stayed down for the whole 15-min grace → job is READY but publish stays gated), `heldout {hits,total}`, `ok` (= `locality.ok && parent_regression.ok && executed`, the hard publish gate) and `note`.
- **`LOADING`** is in the status enum but the worker goes PREFLIGHT → TRAINING directly; "Warming up" is `TRAINING` with `progress.step === 0` (the trainer's `load` event fills `progress.load_s`).
- **PREFLIGHT in the worker** drops facts the model already answers with the context stack loaded; when nothing is left the job ends `FAILED` with error `already_known: …`. Model server unavailable during the worker preflight → the interactive result (`base_answer` from `POST /api/teach/preflight`) is kept instead of failing.
- **Trainer slot** (gradient backend only; the stub skips it): atomic mkdir `<repo>/ple_patch/.ainize-teach.lock` (holder.json, stale after 45 min or when the holder pid is dead), then `docker exec <container> pgrep -f train/` must be empty, then `nvidia-smi` free memory ≥ `minFreeGpuMb` on the configured GPUs. `trainer: 'paused'` when docker or the container is unavailable or `paused_reason` is set; `'busy'` while a job runs or the slot was last seen taken.
- **Cancel / timeout** kill the in-container process (pid recorded via `pgrep -f .teach/<id>/job.json` 3 s after spawn, else re-looked-up) with `kill -TERM` and SIGTERM (SIGKILL after 10 s) the local `docker exec` client.
- **Node restart** (§8.5): PREFLIGHT/TRAINING jobs are **requeued once** (stray in-container process SIGTERMed) and marked `FAILED('node restarted during training')` on a second restart — not re-attached by pid (the `docker exec` stdout pipe dies with the node). CHECKING jobs go back to EXPORTED and are re-checked.
- **CHECKING** measures taught facts twice each (`/v1/completions` `startsWith` on the trainer's `benchmark_samples[]` prefix + `/v1/chat/completions` `enable_thinking:false` `includes`), held-out `alt_prompt` (chat), parent regression with the stack re-applied on top of the lesson (≤ 10 samples per context knowledge, ok when ≥ 90 % hit), and the 12 locality prompts (baseline taken in the same lock before applying the lesson; ok when ≥ `minSame` identical). `patch.py status` after the measurement: reverted → re-apply and re-measure once (`reverted_and_reapplied`). Every serving call has a 60-s budget; a stall/5xx/connection error is treated as a runtime outage (retry the whole check later, 15-min grace), `shared runtime busy` requeues the check. The lesson is removed in a `finally`, the context stack and the operator-pinned set are re-asserted (the 20-s watchdog also reconciles). **NEEDS_MORE** when taught hits < 75 % (draft still created, publish off).
- **Stub backend** (CI / e2e / dev nodes): replays `load / step×3 / eval / done` in-process and writes a real knowledge file — the whole 픽셀플러스 fixture (`results/train-fact/픽셀플러스.npz`, 2,992 rows) when a prompt mentions 픽셀플러스 (so CHECKING on the real model passes), otherwise 1 row copied from the fixture (or a synthetic 1-row file when the fixture is absent). A `teach_job` member is added so every lesson has its own sha256 (distinct blob per job). Job dirs: `<repo>/.teach/<jobId>` for gradient, `<dataDir>/teach/<jobId>` for stub.
- **Benchmark of a taught lesson**: `schema: taught/<slug>-<6hex>`, `format: ['template','chat']`, samples from the trainer's `benchmark_samples[]` (PR-4 note 1) plus the held-out prefix when it passed, `collateral_bound_nat: 0.08`; `recipe` on the anchor keeps ≤ 32 sentences / ≤ 8 contrast / ≤ 8 held-out plus `model_id` and `probe`. Slugs are ASCII (`[a-z0-9-]`, ≤ 24 chars); a name without ASCII letters slugs to `lesson`.
- **Publish**: `GET …/publish-challenge?payout_address=<addr>|none` returns `{ patch_sha256, benchmark_hash, address, signer, share, claim }` where `address` is the paid address (defaults to the teaching key; `none` → credit only, `share: 0`) and `claim = hashCanonical({patch_sha256, benchmark_hash, address, share})`; `POST …/publish` verifies `claim_sig` with `verifyMessage(claim, sig, signer)`, writes one `Contributor` (`proof: 'signed'` when address = signer, else `'declared'` + `signer`), validates it with `validateContributors()`, sets `origin: 'teach'`, `visibility: 'public'`, and announces (`publish: 'auto'`) or parks the job as `PENDING_REVIEW`. `share` is frozen from the effective `contributorShare` at challenge time. `publish: 'never'` → 403 `publish_disabled` (save still works).
- **Save**: `POST …/save` (owner or operator) issues one 7-day token (`issued_to = contrib:<address>`) valid for `/p2p/blob/<sha>?token=`, `/api/teach/jobs/:id/recipe?token=` and `/api/teach/jobs/:id/local-run?token=`; `filename = lesson-<slug>-<hex>.npz`. Cancel/expiry delete the job dir, the blob row and every token for that sha.
- **`GET /api/chat/patches`** now fills `lessons[]` (the caller's READY/NEEDS_MORE/PENDING_REVIEW/ANNOUNCED lessons as catalog entries) — drafts are testable through `/api/chat` for anyone who knows the id (ids are unguessable 6-hex suffixed; the public picker still excludes drafts).
- **Hidden names**: `POST /api/me/teach/contributors/:address {hidden}` strips `contributors[].name` from catalog/detail/teacher responses (ledger anchor unchanged) → "Taught by a visitor". Display names pass a minimal blocklist (links, markup, control chars, a few slurs) — not a full profanity filter.
- **`payouts` table** is created here with the §7.5 columns because `GET /api/teacher/:address` reconciles settle records against it (`paid` for `local-credit` settles; AIN settles are `pending` until a `paid` payouts row exists). `GET /api/me/payouts` + retry remain PR-2 (`CREATE TABLE IF NOT EXISTS` — keep the columns).
- **Quota**: consumed at `POST /api/teach/jobs` (key and IP day buckets, UTC); `POST /api/teach/preflight` costs one live-test unit (`chatQuota`, 429 `quota_chat`). Retry (`POST …/retry`) is a new job with `parent_job` and consumes quota like any other.
- **Re-check** (not in the spec): a lesson saved unchecked (`checks.executed === false`, model server down for the whole grace) can be measured again with `POST /api/teach/jobs/:id/recheck` (owner or operator) — it goes back to EXPORTED, the worker re-runs CHECKING and refreshes the **same** draft (`updateDraft` now accepts `recipe`; the benchmark keeps its `taught/<slug>-<hex>` schema, expiry is unchanged). Without it an outage would have forced the visitor to spend quota on a new job.
- **Not in this PR**: Playwright e2e AZ-094…109 (need the PR-6 UI; the unit test covers the API paths with a fake spawn and the dev-node smoke covers the real model), `ainize teach status` / `ainize patch import` (PR-8), the measured GPU run (GPUs 4–6 still held by `train_rev.py`; the dev node runs `backend: 'stub'`).

### PR-2 — node: payouts table + earnings (2026-08-31)

Files: `packages/node/src/payouts.ts` (new: `Payouts` class — `enqueue`, `attempt`, `due`, `processPending`, `retry`, 60-s timer), `store.ts` (`insertPayout`, `getPayout`, `findPayout`, `updatePayout`, `listPayouts` with status list / limit, `payoutSummary`, indexes on `settle_hash` and `status`), `market.ts` (`Market.payouts`; `settlePayment` writes the rows before any transfer), `server.ts` (`payouts.start()/stop()`), `api.ts` (`GET /api/me/payouts`, `POST /api/me/payouts/:id/retry`, `/api/me/wallet.payouts`), `teach.ts` (`teacherProfile` earnings reconciliation), `openapi.ts` (`Payout`, `PayoutSummary`, `TeacherProfile` schemas + routes), `packages/cli/src/commands/branch.ts` + `bin.ts` (`ainize wallet` payout lines, `ainize payouts ls|retry`), `packages/web/src/api/types.ts` (types only), tests `packages/node/test/payouts.test.ts` (fake chain wallet) and a CLI test.

Deviations / clarifications:

- **Row lifecycle.** `enqueue()` writes one `pending` row per non-self, non-zero address of `settle.royalty` (idempotent per `(settle_hash, address)`, so a restart never duplicates a row) and only then `processPending()` runs in the background; the buyer's x402 response is not delayed by the chain transfer. A failed attempt sets `failed` + `last_error`; the timer (`PAYOUT_RETRY_MS` 60 s) retries `failed` rows whose last attempt is older than the interval up to `PAYOUT_MAX_ATTEMPTS` 20, and `pending` rows immediately (they are rows a crash left behind). `POST /api/me/payouts/:id/retry` is one immediate attempt and stays allowed after the 20 automatic ones (404 unknown, 409 already paid). A node without a chain wallet (local ledger) marks a row `failed` with `no chain wallet on this node`; in practice such nodes never enqueue because only `ain-transfer` settles reach the payouts path — local-credit sales are credited by the settle record itself (`creditBalance()`, spec §9.3).
- **Events.** Kind `payout` (spec §7.5) replaces the old `royalty` event: `owe … (payout #n pending)`, `paid … (tx, attempt k)`, `warn … failed (attempt k/20[, giving up])`.
- **`GET /api/teacher/:address`** (PR-5) now maps a payouts row to the contributor as `pending` while the node is still retrying automatically and as `failed` only when the 20 attempts are exhausted (still owed); `earnings` gained `failed` (that exhausted subset — `pending` = owed − paid still includes it), `sales` (number of settle records) and per item `seller`, `currency`, `scheme`, `attempts`, `paid_at`. A settle written by another seller node has no local payouts row and therefore shows `pending` here — the record is the evidence (spec §7.6).
- **`GET /api/me/payouts`** returns `{ items, summary {pending, failed, paid}, max_attempts, retry_ms, wallet }` with `?status=`, `?address=` (case-insensitive) and `?limit=` (≤ 1000); `GET /api/me/wallet` adds `payouts: { pending, failed, paid, items }` (the unpaid rows, ≤ 50) so the CLI wallet can show them without a second call.
- **CLI.** Spec §14 only asks for `ainize wallet` to show pending payouts; `ainize payouts ls [--status] [--address]` and `ainize payouts retry <id>` were added as well because the operator Payouts tab (PR-7) does not exist yet and a stuck transfer needed some way to be retried. Documented in `CLI_REFERENCE`.
- **Not in this PR.** No live AIN payout was exercised (the dev node runs a local ledger and the shared chain must not be written to); the transfer path is covered by the unit tests with a fake wallet, and `AinLedger.transfer` already satisfies the `PayoutWallet` interface. Operator Payouts tab UI is PR-7.

### PR-6 — web: teach flow (2026-08-31)

Files: `packages/web/src/lib/teacherKey.ts` (browser key: `@noble/secp256k1` 2.3 + `@noble/hashes` keccak — ain-util's personal-message format reproduced byte for byte, deterministic RFC 6979 signatures equal core's) · `packages/web/test/teacherKey.test.ts` (the mandatory cross-library test: 50 random keys derive the same address as `identityFromPrivateKey`, `hashMessage` equals ain-util for utf8 / hex-looking / Korean messages, browser signature verifies with core `verifyMessage` and node `verifyAuthHeader('teach')`, skew + purpose + tamper rejected; `npm test -w packages/web`) · `lib/teachStore.ts` (§7.7 storage) · `components/chat/{Sheet,TeachDrawer,LessonBasket,CreditSheet,PreflightList,LessonCard,PublishSheet,KeepPrivateSheet,MyKnowledgePanel,teachUtil}.tsx` · `pages/TeacherPage.tsx` (`/teacher/:address`) · `pages/ChatPage.tsx` (`?teach=1` banner + open basket, `?lesson=<id>` pinned card, `?mine=1` panel; selection navigation keeps the query string) · `TurnView.tsx` ("Teach the right answer" under every reply) · `PatchPage.tsx` + `PatchListItem.tsx` ("Taught lesson" badge, "Taught by {name}" / people line, "Use it yourself") · `Header.tsx` (public **Teach** item, shown when `/api/info.accepts_contributions`) · `App.tsx` (`/teach` → `/chat?mine=1`, `/teacher/:address`) · `api/api.ts` (RTK endpoints; `prepareHeaders` signs `x-ngram-auth` for the teach endpoints and `GET /api/chat/patches`; the lesson card polls every 5 s while the job moves, 30 s afterwards) · `api/types.ts` · `i18n/pages/teach.ts` (every §5.3–§5.12 / §5.14 string, en + ko) · `packages/e2e/tests/web-teach.spec.ts` (AZ-101…AZ-109, see below).

Deviations / clarifications:

- **`teach.stubOffline` (core `TeachConfig`, default `false`; env `NGRAM_TEACH_STUB_OFFLINE=1`).** With `backend: 'stub'` the PR-5 worker still ran the interactive preflight, the worker preflight and CHECKING against the shared serving model; on this host that made the browser flow non-deterministic (vLLM hangs hourly) and — more importantly — the fixture lesson never reaches a publishable state on the real model (the 픽셀플러스 fixture only fires in the raw `Q:/A:` rendering: taught 1/2 → NEEDS_MORE, locality 10/12). A CI node has no model server at all, so the stub could never complete a lifecycle there either. With `stubOffline` the stub simulates those three steps: the "model" answers a fact whose prompt already contains the answer (→ `already_known`) and says `(stub model) I do not know: …` otherwise; CHECKING sets `CHECKING` briefly and returns `executed: true`, taught 2/2 per fact, held-out per `alt_prompt`, locality all-same, parents ok, `note: 'stub backend (offline) — checks were simulated…'`; a fact containing `LOCALITY_FAIL` fails the locality gate (publish gated, save allowed) so AZ-097 stays scriptable. `/api/chat` ("Try it now") is untouched and still uses the real model. Unit test added to `packages/node/test/teach.test.ts`; the dev node `node-t` runs with it on.
- **Scenario ids.** `docs/ux-test-scenarios.md` already uses AZ-090…AZ-100, so the browser scenarios are numbered **AZ-101…AZ-109** and map to §13.2 as: AZ-101 → AZ-092 (drawer, basket persists across reload), AZ-102 → AZ-093 (Who gets the credit?, key in localStorage, backup download), AZ-103 → AZ-094 (pre-flight: known fact skipped, quota line), AZ-104 → AZ-095 (stub lifecycle → READY, card copy, teach events, redacted public body), AZ-105 → AZ-096 (Try it now: draft under "Your lessons", `/api/chat` with the draft), AZ-106 → AZ-098 (keep it private: 7-day token links, sha256 match, recipe.json, RUN-LOCALLY.md download, hardware notice before commands, wrong token 401), AZ-107 → AZ-100 (or AZ-099 when the node is in review mode: the test approves through the operator API) incl. the signed contributor on the anchor (`verifyMessage(hashCanonical({...}), sig, address)`), `?contributor=` catalog filter, knowledge-page + list chips, `/teacher/:address`, Your knowledge, AZ-108 → AZ-109 (owner mismatch: redacted card, 403 `not_owner`), AZ-109 → key restore in a fresh browser (§5.11). The spec runs against any node with `backend: 'stub'` (`AINIZE_URL=http://localhost:3412 AINIZE_PASS=teach-pass npx playwright test tests/web-teach.spec.ts --project=web`); AZ-101/AZ-105 need the serving model for one completion each and wait for it. Each run teaches a run-unique phrasing because every published lesson becomes a listing whose samples make the same fact `overlaps_listing` (§12) on the next run.
- **"Use it yourself" (§5.12).** On the catalog list item it opens Live test with that knowledge (`/chat/<id>`); on the knowledge page it switches to the Buy tab (the Live test button is already the page's primary action).
- **"Suggest phrasings" (§5.4)** is a template rewrite of the question (client-side, cycles three variants; Korean or English by content/locale) — model-generated phrasings remain the v1.1 follow-up.
- **Sticky card placement.** The card sits at the top of the transcript column (only the transcript scrolls), keyed by `?lesson=<id>`; without the param the most recent job from the `ainize.teach.jobs` mirror is shown; "Hide card" clears it. A stranger's card shows status only (`teach.card.not_yours`). READY lessons whose model-server check never ran (`checks.executed=false`) get `teach.card.ready_unchecked` + **Check again** (`POST …/recheck`).
- **"Improve & retry"** loads the lesson's corrections back into the basket for the same stack with `retry_of = <job id>`; the next "Train this lesson" goes through `POST /api/teach/jobs/:id/retry` (parent_job kept) instead of a new job.
- **Banner.** Shown on `/chat` whenever the node accepts lessons and it was not dismissed (`ainize.teach.banner_dismissed`); `?teach=1` re-shows it and opens the basket; the header **Teach** item links there. The teach button is added under both the "Before" and "After" replies (the visitor corrects whichever one is wrong).
- **Published lessons in the picker.** `GET /api/chat/patches.lessons` (PR-5) also lists the caller's ANNOUNCED lessons, which are public items too; the web lists such an entry once (public list) so it is not selectable twice.
- **Key sheet.** The key is generated when the sheet opens (so "Download key backup" works even if the visitor closes the sheet); display name / payout wallet are saved on **Continue**; "I already have a key" accepts the backup file or pasted JSON / bare private key. The publish sheet's "Shown as" is read-only (the contributor name is fixed when the job is created).
- **Not in this PR.** Landing creator card, sign-in notice, `/new-patch` pre-screen and the operator Teaching tab (PR-7); `docs/ux-test-scenarios.md` entries for AZ-101…AZ-109 (PR-7 owns that file — the mapping above is the source); CLI parity (PR-8).
