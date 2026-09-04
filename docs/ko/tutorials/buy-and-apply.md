---
title: 남이 공개한 지식 사서 쓰기
summary: 네트워크에서 지식을 찾고, 그 검증이 무엇을 뜻하는지 읽고, 공짜로 시험해 보고, HTTP 402로 결제하고, 내 모델에 넣기까지.
source: en/tutorials/buy-and-apply.md
source_sha256: 1d4567aa4861abb674d31de50f18736796fda494f219c3e805ac32fa4b378f8c
---

# 남이 공개한 지식 사서 쓰기

다른 사람의 노드가 자기 모델에게 내 모델은 모르는 것을 가르쳐 두었습니다. 이 튜토리얼은 그것을 반대편에서 봅니다. 카탈로그에서
그 지식을 찾고, 뒤에 있는 근거를 읽고, 돈을 내기 전에 내 질문으로 시험해 보고, 계정도 결제창도 없이 사고, 돌아가는 내
모델에 넣습니다.

여기에 구독도 설치도 없습니다. 지식은 파일 하나이고, 한 번 사서, 몇 초 만에 넣고, 그만큼 빨리 뺍니다.

## 시작하기 전에

**내 노드.** 구매는 내 노드를 통해 일어납니다. 노드가 내 신원과 잔액을 갖고 있고, 파일도 노드의 저장소로 들어옵니다.
[설치](../get-started/install.md)가 노드를 세워 줍니다.

**그 노드에 운영자로 로그인.** 돈이 오가는 명령은 방문자가 아니라 노드 운영자의 것입니다. 로그인하지 않았으면 이렇게
말합니다.

```text
error: operator login required — run `ainize login` first
```

```bash
ainize login
```

```text
✓ logged in to http://localhost:3618 (token saved in /tmp/ainize-tut/my-node/cli.json)
```

**노드 통화로 된 잔액.** `ainize wallet`이 찍어 줍니다. 로컬 기록을 쓰는 노드는 크레딧을 갖고 시작하고
(`market.initialCredit`, 기본 `100`), AIN 기록을 쓰는 노드는 AIN으로 내므로 주소에 잔고가 있어야 합니다.

**두 단계에서는 모델.** 사기 전에 시험해 보는 것과 산 뒤에 넣는 것, 이 둘은 노드 뒤에 서빙 모델이 필요합니다. 찾고, 읽고,
사는 데에는 필요 없습니다. 모델이 없는 노드도 구매 전체를 할 수 있습니다. 답을 못 할 뿐입니다.

**무언가를 공개해 둔 사람.** 피어가 있는 네트워크라면 그건 다른 사람입니다. 이 문서는 살 것이 있어야 하므로 작은 네트워크를
직접 돌립니다. `alice`라는 노드가 지식 하나를 공개하고, `my-node` — 여러분의 노드 — 가 그것을 삽니다. 내 피어가 이미
무언가를 등록해 두었다면 다음 절은 건너뛰세요.

### 무대 만들기: alice가 공개한 것

<!-- The seller half is here only so the buyer half has a real transaction to show; the reader's own path starts at step 1. -->
```bash
# alice의 노드에서
ainize publish ./rooms.npz --name "Seoul office facts" --model Qwen3.8-Flash-Next \
  --benchmark ./bench.json --price 2 --description "Where things are and who signs what, for the Seoul office."
```

```text
✓ draft created: seoul-office-facts  (4 rows, sha256 93d2ba5de67f…)
✓ announced seoul-office-facts → ledger record 429eb1569888b8fe… (verifiers will now attest; quorum lists it)
```

파는 쪽은 이것이 전부이고, 그것은 다른 문서의 몫입니다. 파일을 만드는 것은
[질문 파일로 가르치기](./teach-from-a-file.md)이고, 돈 이야기는
[값을 매기고 정산받기](../how-to/price-knowledge.md)입니다. 여기서부터는 전부 내 노드에서 돌아갑니다.

## 1. 찾기

카탈로그는 그 알림을 들은 모든 노드에서 같습니다. 누군가의 데이터베이스에서 내려오는 것이 아니라 공개 기록에서 다시
계산되기 때문입니다.

```bash
ainize patch ls --q office
```

```text
ID                  STATUS  AUTHOR             MODEL               ROWS   SIZE     PRICE  ATTEST  SOLD  BENCHMARK
──────────────────  ──────  ─────────────────  ──────────────────  ────  ─────  ────────  ──────  ────  ──────────────────
seoul-office-facts  LISTED  alice 0xd7eb…DDcc  Qwen3.8-Flash-Next     4  978 B  2 CREDIT     2/2     0  aster/office-facts
```

이 중 세 열이 이 지식을 내가 쓸 수 있는지를 결정합니다.

**`MODEL`** 은 이 지식이 만들어진 모델입니다. 지식은 특정 모델 기억 테이블의 행들이라서 다른 모델에서는 아무 일도 하지
않고, 내 노드도 다른 모델에는 넣지 않습니다. 그것이 빠진 기능이 아니라 설계의 성질인 이유는
[지식이란 무엇인가](../concepts/knowledge-patch.md)에 있습니다.

**`STATUS`** 와 **`ATTEST`** 는 같은 사실의 두 표현입니다. `2/2`인 `LISTED`는 독립된 노드 둘이 확인했고 네트워크의
정족수를 채웠다는 뜻입니다. `1/2`인 `VERIFYING`은 아직 판매 전이라는 뜻입니다.

`--q`는 본문을 찾고, `--status`, `--model`, `--author`, `--schema`는 걸러 내며, `--sort price|rows|popular|latest`는
순서를 정합니다. 같은 카탈로그가 아무 노드 사이트에서나 한 페이지로 열립니다 — `http://localhost:3618/explore` — 같은
행과 검색창이 있습니다.

## 2. 숫자 뒤에 있는 것 읽기

```bash
ainize patch get seoul-office-facts
```

```text
Seoul office facts  LISTED
id                 seoul-office-facts
author             alice 0xd7ebABa48Fd05665A40457d93cd2445DbD69DDcc
model              Qwen3.8-Flash-Next
rows / size        4 rows · 978 B
sha256             93d2ba5de67faeb58ced013bd359653497dd1ab8aaacf498de917bdd15a29262
price              2 CREDIT · per_download
benchmark          aster/office-facts · 4 queries · template
benchmark hash     a696db825c63e591a4b74beb2837ae689163beb44c54777815d222ddacab7f1a
topic              patches/qwen3-8-flash-next
branch             -
gateway            http://localhost:3619/x402/patch/seoul-office-facts
verification       2/2 passed ✓ quorum
sold               0 · revenue 0 CREDIT
created            2026-09-04 11:58:02
body on this node  yes
Where things are and who signs what, for the Seoul office.
attestations
VERIFIER               RESULT  SCORE                                                                                   VERIFIED ON  RESTARTS  COUNTS  AT
─────────────────────  ──────  ──────────────────────────────────────────────────────────────────────────────────────  ───────────  ────────  ──────  ───────────────────
my-node 0xa57b1F…06D2  PASS    integrity=sha256 ok rows=4 benchmark=not executed (no compatible runtime on this node)  hash-only           0  yes     2026-09-04 11:58:06
carol 0xadadae…EE09    PASS    integrity=sha256 ok rows=4 benchmark=not executed (no compatible runtime on this node)  hash-only           0  yes     2026-09-04 11:58:28
lineage
  parents : none (root)
  children: none
```

**가격.** `2 CREDIT · per_download` — 값과, 그 값이 무엇을 사는지입니다. 이 제품에서 돈은 어디서나 십진수 문자열이고
JSON 숫자가 아닙니다. 그러니 여기 `2`는 정확히 2입니다.

**검증.** `2/2 passed ✓ quorum`은 **독립된** 검증 기록의 수입니다. 작성자 자신의 것은 세지 않고, 검증 노드마다 한 표입니다.
그 아래 표가 근거입니다. 누가, 언제, 통과인지 실패인지, 그리고 어떻게 확인했는지.

**`VERIFIED ON`** 은 그 위의 줄을 믿기 전에 읽어야 할 열입니다. `hash-only`는 그 검증 노드가 파일이 기록에 적힌 바로 그
파일임을 확인했을 뿐, 질문은 돌려 보지 않았다는 뜻입니다. 맞는 모델이 그 노드에 없기 때문입니다. *실행된* 검증 기록에는
대신 점수가 붙습니다. 둘 다 정직하지만 증명하는 것이 다르고, 그 선을 제대로 긋는 문서가
[검증 완료가 증명하는 것](../concepts/verification.md)입니다. `hash-only` 두 개는 바이트에 대해 두 노드가 동의했다는
뜻이지, 누군가 이 지식을 채점했다는 뜻이 아닙니다.

**`body on this node`** 는 내 노드가 이미 그 파일을 갖고 있는지입니다. 여기서 `yes`인 이유는 이 노드가 검증 노드이기도
해서 확인하려고 파일을 받아 왔기 때문입니다. 바이트를 갖고 있는 것과 지식을 소유하는 것은 다릅니다. 사는 절차는 그대로
거칩니다.

**lineage(출처)** 는 이 지식이 무엇 위에 만들어졌는지입니다. 조상의 작성자에게 갈 몫은 모든 판매에서 자동으로 나갑니다.
계산 방식은 [계보와 수익 분배](../concepts/lineage-and-royalties.md)에 있습니다.

보여 줄 것이 있을 때만 나오는 묶음이 둘 더 있고, 둘 다 사는 사람에게 중요합니다. **`address-set overlaps`** 는 같은 기억
항목을 건드리는 다른 지식들입니다. 그 둘을 함께 올리면 겹치는 행을 두고 다투고, 나중에 올린 쪽이 이깁니다.

```text
address-set overlaps (A₁ ∩ A₂)
PATCH                              SHARED ROWS  SAME SCHEMA                  STATUS
─────────────────────────────────  ───────────  ───────────────────────────  ──────
seoul-office-facts-after-the-move            2  yes → conflicting knowledge  LISTED
```

`same schema: yes → conflicting knowledge`는 강한 쪽입니다. 다른 지식이 같은 벤치마크의 질문에 같은 행으로 답한다는
뜻이고, 대개 이 지식의 경쟁 버전이거나 더 새 버전이라는 뜻입니다. **`settlements`** 는 모든 판매 기록입니다. 거래 해시와
누구에게 얼마가 갔는지가 함께 있습니다.

## 3. 돈 내기 전에 써 보기

모든 노드는 방문자가 등록된 지식의 질문을, 넣기 전과 넣은 뒤로, 공짜로 물어볼 수 있게 합니다. 터미널에서는 먼저 이 노드가
무엇을 시험할 수 있는지 봅니다.

```bash
ainize chat --list
```

```text
runtime unavailable — serving API unreachable  (chat needs a serving node; pass --node <url> of one)
ID                  NAME                MODEL               FACTS  MEMORY ROWS  VERIFIED  TRY
──────────────────  ──────────────────  ──────────────────  ─────  ───────────  ────────  ───
seoul-office-facts  Seoul office facts  Qwen3.8-Flash-Next      4            4     2/2 ✓  -
```

첫 줄이 전제 조건이고, 이 노드는 그것을 만족하지 못했습니다. 모델이 없으면 라이브 테스트도 없습니다. 모델이 있는 노드를
가리키거나(`--node http://…`), 파는 쪽 사이트를 쓰세요. 거기서는 지식마다 `/chat/<id>`에 **라이브 테스트** 페이지가
있습니다.

<!-- unverified: needs a model runtime — 라이브 테스트 자체는 실행할 수 없었습니다. 이 페이지를 기록한 노드는 runtime 줄이 unavailable이라 `ainize chat <id> "<question>"`이 위의 관문에서 거절당했습니다. 두 답이 어떻게 보이는지와 아래의 429는 packages/cli/src/commands/chat.ts와 packages/node/src/api.ts를 읽고 쓴 것이지, 붙여 넣은 출력이 아닙니다. -->
노드 뒤에 모델이 있으면 시험은 명령 한 줄입니다.

```bash
ainize chat seoul-office-facts "Which meeting room has the video wall?"
```

모델에게 두 번 묻습니다. 한 번은 그대로, 한 번은 지식을 넣은 채로. 그리고 두 답을 나란히 보여 주면서, 두 번째 답이
벤치마크가 기대하는 것과 맞는지도 알려 줍니다. `--mode base`나 `--mode patched`는 한쪽만 묻고, 질문 없이 부르면 대화형
세션이 열리며, `--patch a,b`는 지식을 최대 셋까지 순서대로 올립니다(겹치는 곳은 마지막이 이깁니다).

공짜 시험에는 방문자별 한도가 있습니다. **시간당 20회**입니다. 다 쓰면 노드가 그렇게 말하고, 그 한 시간 안에 다시
채워집니다.

```text
quota_chat: free live-test quota exhausted for this hour — buy the patch or run your own node
```

HTTP `429`이고, 밀어붙여 넘을 수 있는 벽이 아닙니다. 시험이 애초에 공짜인 이유가 그 한도입니다.

## 4. 아마 가장 먼저 만날 거절

카탈로그에서 모델까지 한 줄로 가는 길이 `ainize use`입니다. 너무 일찍 부르면 거절합니다.

```bash
ainize use seoul-office-facts
```

```text
error: seoul-office-facts is VERIFYING (verification 1/2) — not verified yet; try `ainize patch get seoul-office-facts`
```

버그도 아니고, 돈을 더 내서 건너뛸 수 있는 지연도 아닙니다. 지식은 독립된 노드들이 검증 기록을 남긴 뒤에야 팔립니다.
`1/2`는 하나가 남겼다는 뜻이고, 기본 정족수는 둘입니다. 막 시작한 네트워크나, 다른 노드에 맞는 모델이 없는 네트워크에서는
여기서 기다리게 됩니다. `ainize patch records <id>`가 누가 언제 검증했는지 정확히 보여 주고, 숫자가 멈춰 있을 때 할 일은
[등록되지 않을 때](../how-to/failed-verification.md)에 있습니다.

`use`가 거절하는 상태가 둘 더 있고, 알아 둘 값이 있습니다. `CHALLENGED` 지식은 검증 노드가 다시 돌려 볼 때까지 판매가
멈추고(문구가 이의를 제기한 사람과 그 이유를 알려 줍니다), `REJECTED`는 검증에 실패한 것입니다.

## 5. 사기

정족수가 채워지면 같은 명령이 끝까지 갑니다. 다만 돈이 나가기 전에 견적을 먼저 보여 주고 물어봅니다 — 가격, 판매
노드, 이 지식이 아래에 필요로 하는 지식, 그리고 이번 구매의 총액입니다. 터미널에서는 `[y/N]`로 묻고, 스크립트에서는
`--yes`로 미리 답해야 합니다(파이프에서 `--yes` 없이 부르면 "예"로 치지 않고 거절합니다). 총액 상한은
`--max-price <n>`입니다. 이 튜토리얼과 같은 모양의 노드에서 견적은 이렇게 보입니다.

```text
seoul-office-facts · Seoul office facts  2 CREDIT
  seller alice 0xd7ebABa4…DDcc · 118 rows · qwen3-8b
  balance 100 → 98 CREDIT
  CREDIT is issued by this node (1/100 addresses funded with 100 each) for trying the market out — it is not money and it is worthless anywhere else
Pay 2 CREDIT? [y/N]
```

마지막 줄이 핵심입니다. 이 크레딧은 시장을 시험해 보라고 **내 노드가 직접 발급한** 체험용이며 실제 돈이 아닙니다.
AIN 원장을 쓰는 노드에서는 같은 자리에 AIN 잔액이 나오고, 이어지는 이체는 진짜 이체입니다.

잔액을 앞뒤로 함께 본 전체입니다.

```bash
ainize wallet
ainize patch buy seoul-office-facts
ainize wallet
```

```text
address             0xa57b1F1E15D12d2f4691B48672eaB091651B06D2
ledger              local · local
balance             100 CREDIT
sales               0
royalties received  0
purchases           0
royalty payouts owed  none pending

✓ bought seoul-office-facts for 2 (local-credit)  tx 1abf37b57e9a70b7…
  +    0ms  quorum    2 attestation(s) ≥ quorum 2
  +    9ms  402       Payment Required: 2 CREDIT → 0xd7ebABa4… (local-credit)
  +   13ms  pay       signed credit intent 1abf37b57e9a70…
  +   88ms  settled   seller confirmed; manifest sha256 7877a25ffc70c0…
  +   90ms  download  body already present; sha256 matches on-ledger anchor
  body: /tmp/ainize-tut/my-node/data/blobs/93d2ba5de67faeb58ced013bd359653497dd1ab8aaacf498de917bdd15a29262.npz

address             0xa57b1F1E15D12d2f4691B48672eaB091651B06D2
ledger              local · local
balance             98 CREDIT
sales               0
royalties received  0
purchases           1
royalty payouts owed  none pending
```

다섯 단계이고, 하나하나가 참이어야 했던 조건입니다.

**`quorum`** — 내 노드가 돈을 쓰기 전에 공개 기록에서 검증 수를 스스로 다시 계산합니다. 파는 쪽 말을 믿지 않습니다.

**`402`** — 파는 쪽 노드가 내려받기 요청에 HTTP 402 Payment Required로 답했습니다. 가격과 보낼 주소, 결제 방식이 담겨
옵니다. 여기서 402는 오류가 아니라 견적입니다.

**`pay`** — 내 노드가 바로 그 견적에 서명하고 같은 주소로 다시 요청했습니다. 계정도, 결제창도, 카드도 없습니다. 서명이 곧
승인입니다. 이것이 x402의 흐름이고, 그 아래에서 무슨 일이 일어나는지는
[계정 없이 결제하기](../concepts/payment.md)에 있습니다.

**`settled`** — 파는 쪽이 결제를 받아들이고 `settle` 기록을 남겼습니다. 그 기록이 내 영수증이고, 메일함이 아니라 공개
기록에 있습니다.

**`download`** — 본문 파일. 저장하기 전에 앵커에 적힌 sha256과 대조합니다. 여기서는 *already present*라고 나오는데, 이
노드가 아까 검증하면서 이미 받아 두었기 때문입니다. 이 파일을 처음 보는 노드는 이 단계에서 내려받고, 어느 쪽이든 해시는
기록과 대조합니다.

기록에 남은 거래 전체입니다.

```bash
ainize patch records seoul-office-facts
```

```text
AT                   KIND    AUTHOR           HASH               SIG/TX
───────────────────  ──────  ───────────────  ─────────────────  ─────────────────
2026-09-04 11:58:02  anchor  0xd7ebABa4…DDcc  429eb1569888b8fe…  0xb2ad36f8ce071e…
2026-09-04 11:58:06  attest  0xa57b1F1E…06D2  34226982d5fdc4d8…  0x19e795df08e782…
2026-09-04 11:58:28  attest  0xadadaed0…EE09  f2156f8c3e62feca…  0xfba563c83e4283…
2026-09-04 11:58:54  settle  0xd7ebABa4…DDcc  1715c6c54d8dfce9…  0x22b673a474f7c6…
```

기록 넷, 사건 넷입니다. alice가 등록했고, 노드 둘이 검증했고, 판매 하나가 정산됐습니다. 누구나 읽을 수 있습니다.

`ainize use <id>`는 같은 구매에 확인과 적재까지 붙인 것입니다. 상태를 확인하고, 아직 내 것이 아니면 사고, 내려받아
넣습니다.

```bash
ainize use seoul-office-facts-after-the-move --no-apply
```

```text
✓ bought seoul-office-facts-after-the-move for 3 (local-credit)  tx 3f40632fafb86f83…
  +    0ms  quorum    2 attestation(s) ≥ quorum 2
  +    9ms  402       Payment Required: 3 CREDIT → 0xd7ebABa4… (local-credit)
  +   13ms  pay       signed credit intent 3f40632fafb86f…
  +   57ms  settled   seller confirmed; manifest sha256 d93a89bec39c49…
  +   60ms  download  body already present; sha256 matches on-ledger anchor
  body: /tmp/ainize-tut/my-node/data/blobs/e7a51f70e7d0b94a167c8356f5d99bbbf04f4f1a9b98891b684fe86eebd3bd87.npz
✓ downloaded — load with: ainize patch apply seoul-office-facts-after-the-move
```

두 번 불러도 두 번 사지지 않습니다.

```text
✓ seoul-office-facts is already on this node (purchased)
```

### 추가분일 때: 밑에 깔릴 지식까지 사기

어떤 지식은 **추가분(add-on)** 입니다. 다른 제작자의 지식 위에서 학습된 것이라, 그 지식이 밑에 올라가 있어야만
의미가 있습니다. 견적은 무엇이 필요한지, 각각의 가격과 판매자를 함께 보여 주고, 돈이 나가기 전에 묻습니다.

```text
  needs krx-all-2761 · KRX tickers  25 CREDIT from alice
  total 30 CREDIT (this knowledge + 1 base it cannot work without)
seoul-office-facts also needs KRX tickers (25 CREDIT); buy both? [y/N]
```

`y`(또는 미리 `--bundle`)면 둘 다 삽니다 — 기반이 먼저, 그다음 추가분, 각각 결제 한 번과 정산 기록 한 건. 영수증에도
그 순서와 실제로 나간 합계가 찍힙니다. `n`이면 추가분만 삽니다. 그때는 "기반을 밑에 넣기 전까지는 아무것도 답하지
못한다"고 명령이 그 자리에서 말해 줍니다. `--yes`는 절대 요청보다 더 사지 않습니다 — *가격* 질문에 미리 답하는 것일
뿐이라, 무인 스크립트가 가족 전체를 사려면 `--bundle`도 함께 줘야 합니다.

기반의 제작자는 두 번 받습니다. 자기 판매로 한 번, 그 위에 만들어진 지식이 팔릴 때마다 또 한 번입니다
(`ainize patch tree <id>`가 그 줄을 출력하고, 규칙은 [계보와 수익 분배](../concepts/lineage-and-royalties.md)에
있습니다).

<!-- unverified: needs a two-node family — 이 튜토리얼의 노드에는 추가분이 없습니다. 견적 줄과 질문, 순서는
packages/cli/src/commands/patch.ts (printQuote, patchBuy)에서 읽었고, 끝에서 끝까지는 비공개 클러스터에서
packages/e2e/scripts/bundle-buy-proof.mjs (AZ-313, AZ-315)로 증명했습니다. -->

### 돈은 나갔는데 파일이 오지 않았다면

구매는 왕복이 두 번입니다 — 결제, 그다음 파일 정보(매니페스트) — 그리고 두 번째가 사라질 수 있습니다. 프록시가
끊기거나, 판매 노드가 재시작하거나, 내 노드가 그 사이에 죽는 경우입니다. 돈은 나갔고 파일은 없습니다. **다시 사지
마세요.** 내 노드는 결제를 제시하기 전에 먼저 기록해 두고, 판매 노드는 같은 결제에 대해 같은 매니페스트를 무료로 다시
발급합니다.

```bash
ainize patch download seoul-office-facts
```

```text
✓ collected a-base — no payment (paid 5 CREDIT, tx 7766f2ff036ca4f1…)
  +    0ms  pending     presenting the payment made on 2026-09-04T16:39:48.358Z (5 CREDIT, tx 7766f2ff036ca4…) again
  +   17ms  settled     seller re-issued the manifest against the payment already made — nothing was charged
  +   19ms  download    body already present; sha256 matches on-ledger anchor
```

(위 출력은 판매 노드 앞의 프록시가 결제는 통과시키고 응답만 버리도록 만든 2노드 시험에서 그대로 가져온 것이라 id가
이 튜토리얼과 다릅니다.) 같은 명령으로 `ainize patch forget`으로 지운 파일이나 아예 받지 못한 파일도 되찾을 수
있습니다. 공개 기록에 남은 정산이 곧 권한이고, 그 파일을 가진 어떤 노드든 결제한 주소에게는 내어 줍니다. 아직 파일을
받지 못한 결제는 `ainize wallet`과 `GET /api/me/pending-payments`에서 확인합니다.

## 6. 내 모델에 넣기

사면 파일이 생깁니다. 넣는 것은 별개의 단계이고, 서빙 모델이 필요하며, 순식간에 끝납니다. 다시 시작도, 다시 적재도, 모델이
하던 다른 일의 중단도 없습니다.

노드 뒤에 모델이 없으면 이 단계는 그렇다고 말합니다.

```bash
ainize patch apply seoul-office-facts
```

```text
error: serving API unreachable
```

지금 모델에 무엇이 올라가 있는지는 아래에서 위로 보는 별도의 명령입니다. 모델이 없는 노드에서도 답합니다. 모델이
없는 노드는 아무것도 올린 적이 없기 때문입니다.

```bash
ainize patch stack
```

```text
nothing is loaded in the serving model
```

<!-- unverified: needs a model runtime — 이 줄 아래는 하나도 실행해 보지 못했습니다. runtime이 unavailable이라 패치를 올린 적이 없고, 그래서 층이 쌓인 stack도, `--with-base`도, `remove`도, `--cascade`도, 503도 본 적이 없습니다. 아래 설명은 packages/node/src/runtime.ts와 packages/node/src/api.ts를 읽고 쓴 것입니다. -->
노드 뒤에 모델이 있으면 `apply`는 지식의 행들을 살아 있는 기억 테이블에 쓰고, 그 자리에 있던 것을 기록해 둡니다.
되돌릴 수 있게 하기 위해서입니다. 무언가 올라가면 `patch stack`은 층마다 아이디, 행 수, 홀로 서는 지식인지 아래에
다른 지식이 필요한 덧붙임인지, 그리고 깨끗하게 뺄 수 있는지를 찍습니다. 마지막 줄이 맨 위이고, **두 층이 공유하는
행에서는 그것이 이깁니다.** 같은 행을 건드리는 지식 둘을 쌓기 전에 2단계의 겹침 표를 읽을 값이 있는 이유입니다.

나머지는 세 가지로 정리됩니다.

| 명령 | 하는 일 |
|---|---|
| `ainize patch apply <id> --with-base` | 이 지식이 무엇 위에 학습됐든 그것들을 순서대로 아래에 함께 올립니다. 바탕 없는 덧붙임은 검증된 그것이 아닙니다. |
| `ainize patch remove <id>` | 빼면서, 넣을 때 기록해 둔 것을 그 자리에 되돌립니다. |
| `ainize patch remove <id> --cascade` | 그 위에 얹혀 만들어진 것들까지 함께 뺍니다. `--cascade` 없이는 그런 제거를 거절합니다 — `has_dependents: … is loaded on top of … and would stop working` — 바탕 없는 덧붙임은 검증된 그것이 아니기 때문입니다. |

한눈에 알아볼 오류가 하나 있습니다. 일시적인 것이고 내 잘못이 아닙니다.

```text
503  shared runtime busy   retry-after: 30
```

하나의 서빙 모델을 여러 가지가 나눠 씁니다. 라이브 테스트, 가르치기 모드의 확인, 다른 운영자의 적재. 이들은 잠금을 두고
차례로 씁니다. 노드는 30초 뒤에 다시 오라고 말하는 것이지, 무언가 고장 났다는 것이 아닙니다.

## 다음에 볼 것

이제 지식 하나가 내 것이고, 그것을 넣으면 모델이 내 질문에 다르게 답합니다. 여기서 갈 길은 둘입니다.

방금 산 것이 무엇이고 왜 돌아가는 모델에 넣었다 뺐다 할 수 있는지는
[지식이란 무엇인가](../concepts/knowledge-patch.md)에, 거기 붙은 `2/2`가 실제로 무엇을 뜻하는지는
[검증 완료가 증명하는 것](../concepts/verification.md)에 있습니다.

내 지식을 공개하려면 [질문 파일로 가르치기](./teach-from-a-file.md)가 질문 파일에서 팔 수 있는 수업까지 데려가고,
[모델을 바로잡으며 가르치기](./teach-in-chat.md)는 브라우저에서 본 틀린 답 하나에서 시작합니다.

이 문서의 모든 명령은 [CLI 레퍼런스](../reference/cli.md#ainize-patch)에, 잘못됐을 때 찍히는 문구는
[오류 레퍼런스](../reference/errors.md#codes)에 있습니다.
