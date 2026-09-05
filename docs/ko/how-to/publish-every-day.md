---
title: 매일 공개하기
summary: 매일 밤의 반복을 스크립트 한 개로 — 질문을 넣고, 수업을 훈련하고 점검하고, 붙었을 때만 공개하고, 어제 판본을 물리기까지. 각 단계의 종료 코드와 함께.
source: en/how-to/publish-every-day.md
source_sha256: d847661074ce7548f3abf9b7d46a07e4cc8b90d7a7c1873eaa8548530ab5c509
---

# 매일 공개하기

바뀌는 지식 — 오늘의 종목코드, 오늘의 금리, 오늘의 규정 — 은 매일 밤 같은 방식으로 공개됩니다. 반복 전체는 명령
네 개이고, 이것을 사람 없이 돌려도 되게 만드는 유일한 장치는 각 명령이 다음 명령이 멈춰 설 수 있는 종료 코드를
낸다는 점입니다.

## 반복

```bash
#!/usr/bin/env bash
set -euo pipefail
export NGRAM_PASSWORD="…"            # 또는 --password. `ainize login`은 스크립트에서 멈춰 서지 않습니다

DAY=$(date +%F)
ainize login

# 1. 질문 → 수업. 훈련하고, 점검하고, 끝날 때까지 기다립니다
JOB=$(ainize --json teach dataset ./questions-$DAY.csv --train --wait --timeout 45 \
        --name "KRX $DAY" | jq -r '.job.job.id')

# 2. 공개 — 두 개의 동의는 공개하는 사람의 것이고 기본값이 없습니다
ainize teach publish "$JOB" --name "KRX tickers $DAY" --price 10 \
  --consent-permanent --consent-rights
```

1단계를 "던져 놓고 잊는" 명령이 아니라 관문으로 만드는 것이 `--wait`입니다. 수업의 각 단계를 따라가고 **결과를 종료
코드로** 내기 때문에, `set -e`가 붙지 않은 수업을 공개하기 전에 스크립트를 멈춥니다.

| 종료 코드 | 무슨 일이 있었나 | 무엇을 할까 |
| --- | --- | --- |
| `0` | 완료되었고, 라이브 모델에서 측정되었습니다 | 공개하세요 |
| `4` | 붙지 않았습니다 — 답이 점검을 통과하지 못했습니다 | `--effort thorough`로 다시 훈련 |
| `5` | 실패했거나 취소되었거나 만료되었습니다 | `ainize teach status <job>`를 보세요 |
| `6` | 운영자가 거절했습니다 | 이 노드의 teach 정책이 `review`입니다. 운영자에게 문의하세요 |
| `7` | `--timeout`이 다 될 때까지 진행 중이었습니다 | 명령과 무관하게 계속됩니다. 나중에 확인하세요 |
| `8` | 완료되었지만 측정되지 않았습니다(모델 서버가 꺼져 있었음) | 공개 전에 `ainize teach recheck <job> --wait` |

`ainize teach train <dataset-id> --wait`도 같은 코드를 냅니다. 나머지는 CLI의 일반 코드를 따르고,
`ainize --help`가 그 목록을 갖고 있습니다. `2` 말 걸 노드가 없음, `3` 로그인하지 않음, `4` 노드가 제때 답하지 않음.

## 어제 판본 물리기

오늘 지식을 공개한다고 해서 어제 것이 저절로 내려가지는 않습니다. 오늘 것이 같은 트랙에서 같은 주제를 다룬다면,
공개(announce)는 무엇을 물리는지 이름을 댈 때까지 **거부합니다**.

```bash
ainize patch announce krx-2026-09-05 --supersede krx-2026-09-04
```

거부하면서 무엇이 내려갈지, 각각의 상태와 판매 수와 공유 항목 수를 함께 보여 주고, 이름을 붙여 다시 실행하기
전까지는 원장에 아무것도 쓰지 않습니다. 옛 판본을 산 사람은 자기 사본을 계속 갖고, "새 판본 있음"을 보게 됩니다.
되돌릴 수 없기 때문에 물어보는 것입니다.

아무 때나 명시적으로 내리고 싶다면:

```bash
ainize patch retire krx-2026-09-04 --reason "09-05 종목코드로 대체됨"
```

## 스크립트에서 결과 읽기

모든 명령에 `--json` 문서가 있고, 실패도 문서입니다 — stderr로, 노드가 준 오류 본문까지 함께.

```bash
ainize --json publish ./today.npz --name "KRX $DAY" --model Qwen3.8-Flash-Next \
  --benchmark ./bench.json --price 10 > published.json || {
    jq -r '.error.message' < /dev/stderr; exit 1; }

jq -r '.record_hash, .status, .verifiers_known, (.pending_supersedes[].id)' published.json
```

나머지 절반은 `--quiet`입니다. 무언가를 바꾸는 명령에서는 방금 만든 것의 id만 출력하므로,
`ID=$(ainize --quiet patch publish …)` 한 줄이 곧 한 단계입니다.

## 첫날 밤 전에

- **검증 노드.** `verifier.quorum`만큼의 다른 노드가 검증하기 전에는 공개한 것이 LISTED가 되지 않습니다.
  `ainize publish`는 공개하는 그 순간 이 노드가 아는 도달 가능한 검증 노드 수를 알려 줍니다. 그 수가 정족수보다
  적다면, 이 반복은 매일 밤 아무도 살 수 없는 목록에 공개하게 됩니다.
- **teaching key.** CLI는 `<NGRAM_HOME>/teaching-key.json`에 키를 두고 처음 쓸 때 만듭니다. 내 수업과 그 수익이
  귀속되는 신원이므로, 사람 없이 반복을 돌리기 전에 백업하세요.
- **할당량.** 노드는 키당 하루 수업 수와 질문 수에 상한을 둡니다(`ainize teach status <node url>`가 실제로 적용될
  한도를 출력합니다). 그보다 큰 야간 작업은 조용히가 아니라 `quota_key`로 멈춥니다.

## 다음

- [질문 파일로 가르치기](../tutorials/teach-from-a-file.md) — 같은 파이프라인을 한 단계씩.
- [남의 지식 위에 얹어 만들기](./build-on-knowledge.md) — 오늘 밤의 지식이 남의 지식 위에 있을 때.
