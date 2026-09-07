---
title: 값을 매기고 정산받기
summary: 가격이 어디에서 오는지, 돈이 왜 늘 문자열인지, 데이터를 준 사람을 어떻게 기록에 올리는지, 그리고 판 다음 돈이 어디에 나타나는지.
source: en/how-to/price-knowledge.md
source_sha256: 04559c18ee643ef23c378a60df21e18b742a297b24482e0fbc410925e436144f
---

# 값을 매기고 정산받기

가격은 앵커에 붙는 값입니다. 공개할 때 정해지고 네트워크에 알리는 순간 굳습니다. 이 문서는 그 숫자가 어디에서 오는지,
어떤 모양이어야 하는지, 질문을 준 사람과 어떻게 나누는지, 그리고 정산이 끝난 뒤 어디를 봐야 받은 것이 보이는지를 다룹니다.

아래는 전부 버리는 용도의 노드와 그 이웃 사이에서 실제로 돌린 것입니다. 로컬 원장의 노드 크레딧이라 장난감 돈이지만,
출력은 한 줄도 지어내지 않았습니다.

## 가격이 오는 두 자리

노드마다 기본값이 있고, 따로 말하지 않고 공개한 지식에는 이 값이 붙습니다.

```bash
ainize config get market.defaultPrice
```

```text
0.1
```

바꾸면 노드가 다음에 뜰 때 반영합니다.

```bash
ainize config set market.defaultPrice 2
```

```text
✓ market.defaultPrice = "2"  (the node reads config.json when it starts)
! the node in ~/.ainize is running (pid 663087) and keeps using the value it started with — restart it to apply this (`ainize stop` then `ainize start -d`)
```

다시 띄운 뒤 `--price` 없이 공개하면 그 값이 그대로 붙습니다.

```bash
ainize patch publish ./harbour.npz --name "Busan port-call codes" \
  --model Qwen3.8-Flash-Next --benchmark ./bench.json --id harbour-codes
ainize patch ls --mine --drafts
```

```text
ID             STATUS  AUTHOR              MODEL               ROWS   SIZE     PRICE  ATTEST  SOLD  BENCHMARK
─────────────  ──────  ──────────────────  ──────────────────  ────  ─────  ────────  ──────  ────  ───────────────
harbour-codes  DRAFT   seller 0xd872…78c9  Qwen3.8-Flash-Next     4  978 B  2 CREDIT     0/2     0  port-call-codes
```

공개 명령에 `--price`를 붙이면 그 지식 하나에 대해 기본값을 덮어씁니다. 보통은 이쪽을 씁니다. 기본값은 값을 아예 정하지
않은 채로 무언가가 공개되는 일을 막으려고 있는 것입니다.

## 돈은 어디서나 십진수 문자열입니다

가격도, 정산 기록의 분배 몫도, 원장의 금액도, 지급 대기 줄도 전부 십진수 *문자열*입니다. `"0"`, `"0.1"`, `"25"`처럼요.
JSON 숫자인 적은 한 번도 없습니다. 부동소수점을 거친 가격은 몇 원쯤 어긋날 수 있는 가격이고, 이 값들은 지워지지 않는
기록에 올라가기 때문입니다. 명령줄에서 `--price 25`라고 쓰는 것은 괜찮습니다. CLI가 글자 그대로 넘깁니다. 하지만 손으로
쓰는 `config.json`에는 따옴표가 필요하고, 직접 API를 부를 때도 마찬가지입니다.

노드는 믿는 대신 모양을 검사합니다.

```bash
ainize config set market.defaultPrice -1
```

```text
error: market.defaultPrice must be a decimal amount in quotes, e.g. "0.1" — got "-1"
```

```bash
ainize config set market.defaultPrice free
```

```text
error: market.defaultPrice must be a decimal amount in quotes, e.g. "0.1" — got "free"
```

음수 가격은 분배 몫이 음수가 되기 때문에 거부합니다. `"0"`은 허용되고 지식을 거저 준다는 뜻이지만, 절차까지 건너뛰지는
않습니다. 구매자는 여전히 견적을 받고, 서명하고, 정산 기록을 남깁니다.

```text
✓ bought pilot-points for 0 (local-credit)  tx 49534a7ad7cf1593…
  +    0ms  quorum    2 attestation(s) ≥ quorum 2
  +    9ms  402       Payment Required: 0 CREDIT → 0xd87230db… (local-credit)
  +   15ms  pay       signed credit intent 49534a7ad7cf15…
  +   80ms  settled   seller confirmed; manifest sha256 a880018bd4067d…
  +   82ms  download  body already present; sha256 matches on-ledger anchor
```

그게 맞습니다. 공짜 지식이라도 누가 언제 가져갔는지는 기록으로 남습니다.

## 통화가 실제로 정산되는 방식

`market.currency`는 값이 둘뿐이고 표시용 설정이 아닙니다. 노드가 어떤 [결제 방식](../concepts/payment.md)을 제시하고
무엇이 실제로 움직이는지를 정합니다.

| `market.currency` | 함께 쓰는 원장 | x402 방식 | 판매가 움직이는 것 |
|---|---|---|---|
| `CREDIT` | `local` | `local-credit` | 노드 크레딧. 정산 기록 자체에서 계산해 내는 잔액입니다. 각 노드는 `market.initialCredit`(기본 100)에서 시작합니다. |
| `AIN` | `ain` | `ain-transfer` | AIN 체인에서 실제로 일어나는 이체. 트랜잭션 해시가 정산 기록에 남습니다. |

그 밖의 값은 거부합니다.

```bash
ainize config set market.currency USDC
```

```text
error: market.currency must be one of 'AIN', 'CREDIT' — got "USDC"
```

오래된 타입 정의에서 `USDC`를 통화로 본 적이 있을 수 있습니다. 그것으로 정산할 방법은 없습니다. 결제 방식은 둘뿐이고
어느 쪽도 스테이블코인 이체가 아닙니다.

## 질문을 준 사람을 기록에 올리기

지식을 학습시킨 질문을 다른 사람이 준 것이라면 `--contributor`가 그 사람을 기록에 올리고 판매마다 자동으로 정산합니다.
형식은 `주소:이름:몫`이고, 이름은 빼도 됩니다(`주소:몫`).

```bash
ainize publish ./berths.npz --name "Busan berth allocations" \
  --model Qwen3.8-Flash-Next --benchmark ./bench.json --id berth-allocations \
  --price 5 --contributor 0x5EB47098c53A47f47944b23a15e48DB98a0051cE:Dana:0.7
```

```text
✓ draft created: berth-allocations  (5 rows, sha256 3994dd44f367…)
✓ data providers on the record: Dana 70% (of this node's share of each sale)
✓ announced berth-allocations → ledger record 5302015be3cedfb0… (verifiers will now attest; quorum lists it)
```

**이 몫은 판매가 전체가 아니라 "내 몫"에 대한 비율입니다.** 부모가 없는 뿌리 지식이라면 내 몫이 곧 판매가 전체이므로,
5 CREDIT 판매에서 0.7은 3.5입니다. 실제로 팔렸을 때 정산 기록에 그대로 남았습니다.

```text
settlements
BUYER              AMOUNT  SCHEME        TX               ROYALTY                          AT
───────────────  ────────  ────────────  ───────────────  ───────────────────────────────  ───────────────────
0x99b6B478…d4C7  5 CREDIT  local-credit  3171583cb05142…  0x5EB4…51cE:3.5 0xd872…78c9:1.5  2026-09-04 11:53:47
```

Dana에게 3.5, 판매자에게 1.5입니다. 이 지식에 부모가 있었다면 먼저
[원작자 몫](../concepts/lineage-and-royalties.md)이 위에서 떼이고, 데이터 제공자의 비율은 그러고 남은 금액에서
계산됩니다. "70 %"가 정가의 70 %가 아니게 되는 경우는 그때뿐입니다.

노드는 이 목록을 쓰기 전에 규칙 세 가지를 강제합니다. 판매할 때가 아니라 공개할 때 걸립니다.

```bash
--contributor 0x5EB4…:A:0.1 --contributor 0x1111…:B:0.1 --contributor 0x2222…:C:0.1 \
  --contributor 0x3333…:D:0.1 --contributor 0x4444…:E:0.1
```

```text
error: at most 4 contributors per patch
```

```bash
--contributor 0x5EB4…:Dana:0.7 --contributor 0x1111…:Erin:0.5
```

```text
error: contributor shares add up to 1.2 (> 1)
```

```bash
--contributor dana:0.7
```

```text
error: --contributor: "dana" is not an AIN address (0x + 40 hex)
```

몫을 `0`으로 두는 것도 정상이며, 돈 없이 이름만 올린다는 뜻입니다. 기록에는 남고 지급 줄은 생기지 않습니다. 주소가 내
노드 자신인 참여자는 두 번 받지 않도록 건너뜁니다.

> [!NOTE]
> `ainize patch get`은 사람이 읽는 출력에 참여자 목록을 찍지 않습니다. 앵커는 그 값을 갖고 있고 API는 누구에게나
> 돌려주는데도 그렇습니다. 확인하려면 `ainize patch get <id> --json`으로 `anchor.contributors`를 보거나, 정산 기록의
> ROYALTY 칸을 읽으십시오. 실제로 지급된 주소가 전부 거기 있습니다.

## 돈이 나타나는 자리

세 군데이고, 각각 다른 질문에 답합니다.

**`ainize wallet` — 이 노드가 들고 있는 것과 판 것.**

```bash
ainize wallet
```

```text
address             0xd87230db2F21b5f5b998255A0DA0015f377878c9
ledger              local · local
balance             103.5 CREDIT
sales               2
royalties received  0
purchases           0
royalty payouts owed  none pending

recent sales
PATCH            AMOUNT  BUYER            AT
─────────────  ────────  ───────────────  ───────────────────
harbour-codes  2 CREDIT  0x6dEb3Aa0…4d23  2026-09-04 11:52:57
```

이 잔액은 노드가 처음 받은 100 크레딧에, 첫 판매의 2 전부와, 두 번째 판매에서 Dana의 3.5를 뺀 1.5를 더한 것입니다.
**`sales`는 판매 건수를 세고, `balance`는 나누고 남은 것을 셉니다.**

**정산 기록 — 구매자의 영수증이자, 분배가 적히는 유일한 자리.** 내 노드뿐 아니라 그 기록을 받은 모든 노드의 원장에
있습니다.

```bash
ainize ledger ls --kind settle --limit 5
```

```text
AT                   KIND       AUTHOR         SUMMARY                                           HASH
───────────────────  ─────────  ─────────────  ────────────────────────────────────────────────  ───────────────
2026-09-04 11:53:47  settle     0xd87230…78c9  berth-allocations · 5 CREDIT · buyer 0x99b6…d4C7  10109b3331e430…
2026-09-04 11:52:57  settle     0xd87230…78c9  harbour-codes · 2 CREDIT · buyer 0x6dEb…4d23      c8a3603ab642f8…
```

`ainize patch get <id>`는 지식 하나에 대한 같은 정산 기록을, 주소별 분배까지 풀어서 보여 줍니다.

**`ainize payouts ls` — 이 노드가 아직 보내야 할 이체.** 이것은 AIN 원장 쪽 장치입니다. 체인 이체는 실패할 수 있으므로
한 건마다 `pending` 줄을 먼저 적어 두고 성공할 때까지 다시 시도합니다. 로컬 원장 노드에는 보낼 것이 없습니다. 참여자의
크레딧은 정산 기록이 붙는 순간 그 기록에서 계산돼 나오기 때문이고, 명령도 그렇게 말합니다.

```bash
ainize payouts ls
```

```text
pending       0
failed        0
paid          0
retry         every 60 s, up to 20 attempts
chain wallet  no (local ledger — rows cannot be paid from this node)

(none)
```

AIN 노드라면 판매가 정산되는 즉시 여기에 줄이 생기고, 이체가 확정되면서 사라집니다. 자동 재시도를 다 쓰고도 `failed`에
멈춘 줄은 운영자가 `ainize payouts retry <id>`로 다시 보내야 합니다. 전체 목록은 레퍼런스의
[`ainize payouts`](../reference/cli.md#ainize-payouts)에 있습니다.

## 나중에 바꿀 수 있는 것과 없는 것

네트워크에 알리는 순간 앵커가 원장에 적히고, 앵커는 고칠 수 없습니다. 가격, 통화, 참여자, 벤치마크, 모델 아이디가 모두
그 안에 들어 있습니다. 이미 알린 지식을 고치려 하면 그 말 그대로 거부합니다.

```text
{ "error": "only drafts can be edited (anchors are immutable on the ledger)" }
```

알리기 전까지는 전부 물렁물렁합니다. `ainize patch publish`를 `--announce` 없이 쓰면 초안으로 남고, `ainize patch ls
--drafts`로 확인하고, 콘솔이나 `PATCH /api/patches/<id>`로 고치고, `ainize patch rm <id>`로 지울 수 있습니다. 공개와
통지를 한 번에 하는 최상위 `ainize publish`는 편리하지만, 가격이 틀린 순간까지만 편리합니다.

알린 뒤에 남는 정직한 수는 둘이고, 둘 다 수정이 아닙니다.

- **고친 판을 새로 공개하기.** 같은 벤치마크 스키마에서 옛 지식과 주소가 겹치는 새 지식은
  [목록에 오르는 순간 옛 것을 대체하고](./failed-verification.md#다투기보다-새-판을-내는-편이-나을-때), 구매자에게는 옛
  지식에 "더 새로운 판 있음"이 보입니다. 옛 기록과 옛 판매는 그대로 남습니다.
- **파일을 그만 내주기.** `ainize patch forget <id>`는 이 노드가 갖고 있던 지식 파일을 지워서 더 이상 건네지 않게 합니다.
  공개 기록은 그대로입니다. 앵커도, 검증 기록도, 정산 기록도 남습니다.

`market.defaultPrice`를 나중에 바꿔도 이미 알린 것은 아무것도 달라지지 않습니다. 다음에 공개할 것의 기본값일 뿐입니다.
