---
title: 목록에 오르지 않을 때
summary: 검증 기록을 읽는 법, VERIFYING에서 멈추는 세 가지 이유, hash-only 대체 검증이 무엇을 올리고 무엇을 올리지 않는지, 그리고 이의 제기가 실제로 갖는 힘.
source: en/how-to/failed-verification.md
source_sha256: fe4121deffb37676713fc7af520f45c52fd9b9d1b33b9659bd64324ff3a0081a
---

# 목록에 오르지 않을 때

지식을 알렸는데 아직 팔리지 않습니다. 무언가를 바꾸기 전에 기록이 이미 무엇을 말하고 있는지부터 읽으십시오. 거의 모든
경우는 명령 두 개로 판별되고, 원인마다 손볼 곳이 다릅니다. 이 문서는 [검증 기록과 정족수가 무엇인지](../concepts/verification.md)
는 안다고 보고, 그 숫자가 맞아떨어지지 않을 때 그것을 읽는 법을 다룹니다.

아래 출력은 한 대의 컴퓨터에서 띄운 버리는 노드 셋 — 3634 포트의 판매 노드와 3635·3636 포트의 검증 노드 둘 — 에서
가져온 것이고, 어디에도 모델 서버가 없습니다. 이 상태가 바로 여기 나오는 대부분의 상황을 만들어 냅니다.

## 먼저 기록을 읽습니다

`ainize patch get <id>`는 횟수와 그 근거가 된 검증 기록을 함께 보여 줍니다.

```bash
ainize patch get harbour-codes
```

```text
verification       2/2 passed ✓ quorum

attestations
VERIFIER                 RESULT  SCORE                                                                                   VERIFIED ON  RESTARTS  COUNTS  AT
───────────────────────  ──────  ──────────────────────────────────────────────────────────────────────────────────────  ───────────  ────────  ──────  ───────────────────
verifier1 0x6dEb3A…4d23  PASS    integrity=sha256 ok rows=4 benchmark=not executed (no compatible runtime on this node)  hash-only           0  yes     2026-09-04 11:51:42
verifier2 0x99b6B4…d4C7  PASS    integrity=sha256 ok rows=4 benchmark=not executed (no compatible runtime on this node)  hash-only           0  yes     2026-09-04 11:51:46
```

진단은 세 칸에 들어 있습니다. **RESULT**는 그 검증 노드가 내린 결론입니다. **VERIFIED ON**은 어떻게 내렸는지입니다.
`hash-only`는 파일의 sha256과 행 수만 확인했다는 뜻입니다. 벤치마크를 돌릴 모델이 그 노드에 없었기 때문입니다.
**COUNTS**는 딱 한 가지 좁은 질문에만 답합니다. 이 노드가 그 기록을 작성자 본인의 자기 검증이라고 보고 제외했는지
여부입니다. 정족수에 포함된다는 뜻이 아닙니다. 그것을 말해 주는 것은 맨 위의 verification 줄뿐입니다.

`ainize patch records <id>`는 같은 이야기를 시간 순서로 보여 줍니다. 순서가 중요할 때 필요한 것이 이쪽입니다.

```bash
ainize patch records harbour-codes
```

```text
AT                   KIND       AUTHOR           HASH               SIG/TX
───────────────────  ─────────  ───────────────  ─────────────────  ─────────────────
2026-09-04 11:51:41  anchor     0xd87230db…78c9  837a478f4c95d3fc…  0x8abecfef1039dc…
2026-09-04 11:51:42  attest     0x6dEb3Aa0…4d23  bd5dfcbd3436ddd4…  0x75287fad3328c0…
2026-09-04 11:51:46  attest     0x99b6B478…d4C7  7493b0b87ffa9613…  0x184fcf3033d839…
2026-09-04 11:52:57  settle     0xd87230db…78c9  c8a3603ab642f833…  0xb714f6c09dca55…
2026-09-04 11:55:42  challenge  0x6dEb3Aa0…4d23  1b7e99f658b719d2…  0x843c42838fee74…
2026-09-04 11:55:46  attest     0x99b6B478…d4C7  1e75778bdbad9afc…  0xdf03b36af8830c…
```

`anchor` 한 줄만 있고 뒤가 비어 있다면 아무 검증 노드도 들여다본 적이 없다는 뜻입니다. 들여다봤는데 판단하지 못한 것과는
다른 문제입니다.

## LISTED는 사실이 아니라 결론입니다

모든 노드가 같은 기록으로 목록을 **자기** `verifier.quorum`을 써서 스스로 계산합니다. 그래서 두 노드가 같은 지식을 두고
서로 다르게 말하면서 둘 다 맞을 수 있습니다.

아래는 판매 노드의 정족수만 3으로 올리고 이웃은 기본값 2로 둔 상태입니다.

```text
판매 노드가 보는 것                                                ATTEST
berth-allocations  VERIFYING   …                                   2/3
harbour-codes      VERIFYING   …                                   2/3

verifier1이 같은 기록으로 보는 것                                  ATTEST
berth-allocations  LISTED      …                                   2/2
harbour-codes      LISTED      …                                   2/2
```

이게 중요한 이유는 결제 게이트웨이를 돌리는 것이 판매자 자신의 노드이기 때문입니다. 판매 노드가 목록에 올랐다고 보지 않는
지식을 요청하면, 구매자 노드가 어떻게 보든 판매를 잠급니다.

```bash
curl -s http://localhost:3634/x402/patch/berth-allocations
```

```text
{"error":"patch not listed yet (verification 2/3)"}
```

> [!NOTE]
> `ainize patch buy`와 `ainize use`는 이것을 `error: gateway error 423`으로만 알리고 이유를 적은 문장을 버립니다. 구매가
> 423으로 실패했는데 이유를 알고 싶다면 게이트웨이 주소로 직접 물어보십시오. 그 주소는 `ainize patch get`의 `gateway`
> 줄에 있고, 판매 노드의 [`publicUrl`](./reachable-node.md#host는-붙는-자리-publicurl은-남이-받아-적는-주소)로
> 만들어집니다.

그러니 멈춘 것처럼 보일 때 가장 먼저 확인할 것은 *누구의* 시야를 보고 있는가입니다. 물어보고 있는 노드에서
`ainize config get verifier.quorum`을 실행하면 답이 나옵니다.

## VERIFYING에서 멈추는 세 가지 이유

**아무도 검증하지 않았다.** 상태는 `ANNOUNCED`에 머물고, `patch records`에는 `anchor` 한 줄뿐이며, `patch get`에는
검증 기록 칸이 아예 없습니다. 검증 노드 둘을 모두 내린 상태에서 새로 알린 지식은 그들이 내려가 있는 내내 이랬습니다.

```text
ID           STATUS     AUTHOR              MODEL               ROWS   SIZE     PRICE  ATTEST  SOLD  BENCHMARK
───────────  ─────────  ──────────────────  ──────────────────  ────  ─────  ────────  ──────  ────  ───────────
quay-depths  ANNOUNCED  seller 0xd872…78c9  Qwen3.8-Flash-Next     4  978 B  1 CREDIT     0/2     0  quay-depths
```

`ainize nodes`의 ROLES 칸을 보십시오. `verifier`를 내건 이웃이 있어야 하고, 그 이웃에
[닿아야](./reachable-node.md#연결한-적이-없다와-연결했는데-조용하다를-가르기) 합니다. 하나만 되살려도 가십
두어 바퀴 만에 검증 기록이 들어옵니다. 손대지 않은 같은 앵커를 1분 뒤에 집어 간 것입니다.

```text
2026-09-04 12:07:42  anchor  0xd87230db…78c9  c9c3a4695d8510d1…  0xbd30ff9b28cf4c…
2026-09-04 12:08:43  attest  0x6dEb3Aa0…4d23  e8686bfe7d67e8e9…  0x9e705a7030a202…
2026-09-04 12:08:45  attest  0x99b6B478…d4C7  911d61b6a80a2467…  0xc1e6f9b872a3f4…
```

**검증한 것이 나뿐이다.** 노드는 자기 지식을 검증하는 일을 시작하기도 전에 거부합니다.

```bash
ainize patch verify harbour-codes
```

```text
error: cannot verify your own knowledge: harbour-codes was published by this node (verifier.allowSelfAttest is
false). A self-check never counts toward the quorum — another node has to verify it.
```

작성자 본인의 검증 기록이 이미 원장에 있다면 — 예전 빌드가 썼거나 `verifier.allowSelfAttest`를 켠 노드가 썼거나 — 다른
모든 노드는 그것을 버립니다. `patch get`은 그 줄을 지우지 않고 COUNTS 칸에 표시하며, verification 줄에서 한 번 더
말해 줍니다.

```text
verification       2/2 passed ✓ quorum · 1 self-check by the author (not counted)

attestations
VERIFIER                 RESULT  SCORE                                                                                   VERIFIED ON  RESTARTS  COUNTS           AT
───────────────────────  ──────  ──────────────────────────────────────────────────────────────────────────────────────  ───────────  ────────  ───────────────  ───────────────────
seller 0xd87230…78c9     PASS    integrity=sha256 ok rows=3 benchmark=not executed (no compatible runtime on this node)  hash-only           0  no — self-check  2026-09-04 12:11:59
verifier2 0x99b6B4…d4C7  PASS    integrity=sha256 ok rows=3 benchmark=not executed (no compatible runtime on this node)  hash-only           0  yes              2026-09-04 12:11:59
verifier1 0x6dEb3A…4d23  PASS    integrity=sha256 ok rows=3 benchmark=not executed (no compatible runtime on this node)  hash-only           0  yes              2026-09-04 12:12:02
```

이것만은 내 컴퓨터에서 해결할 수 없습니다. 횟수는 남에게서 와야 합니다.

**정족수가 네트워크보다 크다.** `verifier.quorum`의 기본값은 2이고, 이는 *나 말고 노드 둘*을 뜻합니다. 그러니 무엇이든
목록에 올리려면 노드가 모두 셋 있어야 합니다. 둘만 띄워 놓고 왜 아무것도 안 올라가는지 궁금해하는 것이 가장 흔한 경우입니다.
노드를 하나 더 붙이거나, 읽는 쪽 노드의 정족수를 낮추십시오. 다만 정족수 1이 무엇을 뜻하는지는 스스로에게 정직해야 합니다.

한 가지 상태를 더 알아 두면 좋습니다. `REJECTED`는 멈춘 것이 아니라 답이 나온 것입니다. *실패* 검증 기록이 정족수에
도달하면 이 상태가 됩니다. 파일이 앵커의 해시와 다르거나 벤치마크를 통과하지 못해서, 독립된 검증 노드가 그만큼 FAIL을
썼다는 뜻입니다. 같은 파일을 다시 공개해도 결과는 같습니다.

## 유예 시간, 그리고 hash-only가 어떤 지식은 올리고 어떤 지식은 올리지 않는 이유

모델을 쓰도록 설정돼 있는데 모델에 닿지 못하는 검증 노드는 곧바로 약한 검사로 내려가지 않습니다. 남은 시간을 소리 내어
세면서 15분 동안 다시 시도합니다.

```bash
ainize logs --kind verifier
```

```text
2026-09-04 11:52:22 warn  verifier  [tide-tables] verify tide-tables failed: runtime unavailable (serving API unreachable) — waiting up to 15 min before hash-only fallback
2026-09-04 12:06:57 warn  verifier  [tide-tables] verify tide-tables failed: runtime unavailable (serving API unreachable) — waiting up to 0 min before hash-only fallback
```

이 유예 시간은 검증이 도는 중에 모델 서버가 한 번 재시작했다고 해서 남의 지식이 영구히 무결성 검사로 격하되지 않게 하려고
있습니다. 시간이 다 되면 검증 노드는 자기가 책임질 수 있는 것만 씁니다. sha256과 행 수, 그리고 `hash-only`라는 이름표입니다.

그 다음은 딱 한 가지에 달려 있습니다. **앵커가 벤치마크 표본을 선언했는가**입니다.

표본이 없는 지식은 자기 바이트에 대해서만 주장하고 있으므로 무결성 검사가 완전한 답이 되고, 정족수가 채워집니다.

```text
harbour-codes  LISTED  …  2/2
```

표본을 선언한 지식은 지식을 넣은 뒤 모델이 특정 질문에 다르게 답한다고 주장하는 것입니다. 해시를 아무리 많이 확인해도
그것은 확인되지 않으므로, hash-only 기록은 남되 세어지지 않습니다. 아래 지식에는 통과한 검증 기록이 둘 있고 검증 횟수는
0입니다.

```bash
ainize patch get tide-tables
```

```text
Busan tide tables  VERIFYING  (yours)
…
benchmark          tide-tables · 2 queries · template
verification       0/2 passed

attestations
VERIFIER                 RESULT  SCORE                                                                                   VERIFIED ON  RESTARTS  COUNTS  AT
───────────────────────  ──────  ──────────────────────────────────────────────────────────────────────────────────────  ───────────  ────────  ──────  ───────────────────
verifier2 0x99b6B4…d4C7  PASS    integrity=sha256 ok rows=6 benchmark=not executed (no compatible runtime on this node)  hash-only           0  yes     2026-09-04 12:07:06
verifier1 0x6dEb3A…4d23  PASS    integrity=sha256 ok rows=6 benchmark=not executed (no compatible runtime on this node)  hash-only           0  yes     2026-09-04 12:07:07
```

PASS 두 줄 아래의 `0/2 passed`는 모순이 아닙니다. `PASS`는 각 검증 노드가 실제로 던질 수 있었던 질문에 대한 답이고,
정작 중요한 질문은 둘 다 던지지 못했습니다. 알맞은 모델을 가진 검증 노드가 벤치마크를 돌리기 전까지 이 지식은 계속
`VERIFYING`입니다. 기다린다고 해결되지 않습니다.

해결책은 그 모델을 가진 검증 노드 앞에 이 지식을 갖다 놓는 것입니다. SCORE 칸이 걸림돌을 정확히 말해 줍니다.
`no compatible runtime on this node`입니다. 그리고 검증 노드가 "맞는" 노드가 되려면 그 노드가 서비스 중인 모델이 앵커의
모델 아이디와 맞아야 합니다. 그러니 `ainize patch get`의 `model` 줄과 `ainize nodes`의 MODEL 칸을 견줘 보고, 그 모델을
돌리는 노드와 이웃을 맺으십시오.

> [!TIP]
> 공개하는 쪽에서 보면 이것은 양날입니다. 벤치마크 표본을 선언하는 것이 검증에 의미를 부여하는 일이면서, 동시에 내 모델을
> 아무도 서비스하지 않는 네트워크에서는 지식이 목록에 오르지 못하게 만드는 일이기도 합니다. 얼떨결에 말고 의식하고
> 고르십시오.

## 반대쪽에서: 이의 제기

이의 제기는 검증 노드가 공개적으로 내는 반론이고, 그 즉시 지식을 어디에서도 팔 수 없게 만듭니다.

```bash
ainize patch challenge harbour-codes --reason "row 3 answers a question the benchmark never asks"
```

```text
✓ challenge recorded for harbour-codes: row 3 answers a question the benchmark never asks
✓ harbour-codes is off sale until a verifier re-runs the benchmark and passes it; the author is told who challenged it and why
```

작성자는 자기 로그에서 이 사실을 알게 됩니다.

```text
[2026-09-04T11:55:43.526Z] WARN  challenge: 0x6dEb3Aa0… challenged your knowledge harbour-codes: "row 3 answers a
question the benchmark never asks" — it is off sale until a verifier re-runs the benchmark and passes it
```

구매자는 이유와 함께 돌려보내집니다.

```text
error: harbour-codes is CHALLENGED — a verifier disputes it, so it is not for sale until it is re-verified
  0x6dEb3Aa0…4d23: "row 3 answers a question the benchmark never asks" (2026-09-04 11:55:42)
  see the dispute: ainize patch get harbour-codes
```

여기서부터는 눈을 똑바로 뜨고 보아야 합니다. **이의 제기로 담보가 잡히거나 옮겨지거나 몰수되는 것은 없습니다.** 제기한
쪽도, 작성자 쪽도 마찬가지입니다. 힘은 오직 "판매 정지"에 있고, 그 정지는 어떤 검증 노드든 이의 제기보다 새로운 검증
기록을 쓰는 순간까지만 갑니다. 검증이 sha256 확인인 지식이라면 그 재실행은 실패할 수가 없습니다. 위 기록에서 이의 제기는
11:55:42에, 그것에 답한 검증 기록은 11:55:46에 들어왔습니다. 4초 뒤 지식은 다시 `LISTED`가 되었고, 이의 제기는 기록에
남은 채 `answered`로 표시됐습니다.

```text
challenges
CHALLENGER       REASON                                             OPEN      AT
───────────────  ─────────────────────────────────────────────────  ────────  ───────────────────
0x6dEb3Aa0…4d23  row 3 answers a question the benchmark never asks  answered  2026-09-04 11:55:42
```

그러니 이의 제기가 진짜 이빨을 갖는 곳은 검증이 실제로 실행되는 곳입니다. 누군가의 모델이 표본을 실제로 돌려 보고 다른
결론을 낼 수 있는 곳 말입니다. 그 밖에서는 영구히 남는, 서명된, 공개된 반론 기록입니다. 그것도 아무것도 아닌 것은
아니지만, 판매 정지는 아닙니다.

## 다투기보다 새 판을 내는 편이 나을 때

내가 작성자이고 지적이 옳다면, 가장 짧은 길은 대개 반박이 아닙니다. 같은 벤치마크 스키마에서 같은 주소를 건드리는 고친
지식을 새로 공개하십시오. 그 밖에 할 일은 없습니다. 새 지식이 목록에 오를 때 노드가 겹침을 발견해 `supersede` 기록을
쓰고 작성자에게 알립니다.

```bash
ainize publish ./harbour2.npz --name "Busan port-call codes (2026 revision)" \
  --model Qwen3.8-Flash-Next --benchmark ./bench.json --id harbour-codes-2026 --price 2
ainize logs --kind publish
```

```text
2026-09-04 12:10:51 info  publish   [harbour-codes-2026] announced harbour-codes-2026 (conflicts: 1)
2026-09-04 12:10:56 info  publish   [harbour-codes-2026] harbour-codes-2026 supersedes harbour-codes (4 shared rows)
2026-09-04 12:10:56 warn  publish   [harbour-codes] harbour-codes-2026 supersedes your knowledge harbour-codes — buyers now see "Newer version available" on it
```

알린 시각과 대체 시각 사이에 5초가 있습니다. 대체 기록은 새 지식이 알려질 때가 아니라 정족수를 채울 때 쓰이기 때문입니다.
그 뒤로는 양쪽이 서로를 가리킵니다.

```bash
ainize patch conflicts harbour-codes-2026
```

```text
PATCH          SHARED ROWS  SAME SCHEMA  STATUS
─────────────  ───────────  ───────────  ──────────
harbour-codes            4  yes          SUPERSEDED
```

옛 지식은 자기 기록과 검증 기록, 그리고 이미 일어난 판매를 그대로 지킵니다. 구매자에게는 더 새로운 것이 있다는 사실이
보일 뿐입니다. 구조는 이것이 전부입니다. 지식을 고치는 일은 곧 지식을 공개하는 일입니다. 수정이라는 것은 없고, 누구나 이미
읽을 수 있는 기록을 두고 다퉈서 얻을 것도 없습니다.
