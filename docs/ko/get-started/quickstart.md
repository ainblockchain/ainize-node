---
title: 빠른 시작
summary: 내 노드를 띄우고, 남이 공개한 지식을 내 모델에 넣고, 같은 질문을 넣기 전과 뒤에 던져 봅니다.
source: en/get-started/quickstart.md
source_sha256: 42ab353ab976a883a5a2e8934dd0f80a65c23b7df7b8efe84ebd0aa153d76fe3
---

# 빠른 시작

Ainize가 하는 일은 하나이고, 이 페이지는 그 하나를 처음부터 끝까지 해 봅니다. **노드를 띄우고, 이미 돌리고 있는
모델에 지식을 넣고, 답이 바뀌는 것을 봅니다.** 여기서 학습시키는 것은 없고, 다시 띄우는 것도 없습니다. 지식은 기억
항목 몇 줄이 담긴 작은 파일이고, 돌아가는 모델에 들어갔다가 그대로 다시 빠져나옵니다.

순서대로 읽으세요. 필요한 조건은 그것이 필요한 단계 앞에 미리 적어 두었고, 이 사이트의 다른 페이지를 먼저 읽을
필요도 없습니다. 딱 하나, `ainize` 명령을 만들어 둔 [설치](./install.md)만 끝나 있으면 됩니다.

> [!NOTE]
> 아래 블록은 모두 실제로 실행한 명령과 그때 찍힌 출력입니다. 손댄 곳은 둘뿐입니다. 절대 경로를 줄여 적었고(노드의
> 홈 디렉터리는 `<NGRAM_HOME>`), 아예 실행할 수 없었던 단계는 출력을 싣는 대신 그렇다고 글로 밝혔습니다. 지어낸
> 것은 없습니다.

## 먼저 갖춰야 하는 것

하나뿐이고, 그 하나가 이 저장소에 없습니다. **이미 서빙하고 있고, 내가 기억 항목을 밀어 넣을 수 있는 모델**입니다.
Ainize는 모델을 돌리지 않습니다. 돌아가고 있는 모델의 기억 테이블에 쓸 뿐이고, 그러려면 문 두 짝이 함께 열려 있어야
합니다.

- **OpenAI 호환 HTTP 엔드포인트** — 노드가 `GET /v1/models`를 물어보고 맨 앞의 모델 id를 가져갑니다. 앞으로 만드는
  지식이 묶이는 모델이 바로 그 모델입니다.
- **기억 테이블 훅** — 서빙 모델 쪽 저장소에 있는 `scripts/patch.py`입니다. 모델을 다시 띄우지 않고 살아 있는
  테이블에 값을 써 넣는 통로이고, 노드가 로컬 프로세스로 실행하기 때문에 그 저장소는 노드와 같은 컴퓨터에 있어야
  합니다.

그 모델을 세우는 일은 마켓플레이스가 아니라 배포의 문제라서, 저장소는 그 답을 대상 바로 옆인 `deploy/README.md`에
두었습니다. 아직 모델이 없어도 계속 읽으세요. 마지막 두 단계를 빼면 전부 모델 없이 돌아가고, 4단계가 지금 내가 둘 중
어느 상황에 있는지 알려 줍니다.

## 1. 노드 만들기

노드는 자기 자신을 디렉터리 하나에 담고, 그 디렉터리 이름이 `NGRAM_HOME`입니다. 비워 두면 `~/.ngram`입니다.
디렉터리와 포트를 지금 정하세요. 기본값은 3402이고, 이 기록은 3694를 씁니다. 기록을 남긴 컴퓨터에서는 앞 번호들을
이미 다른 노드가 쓰고 있었기 때문입니다.

```bash
export NGRAM_HOME=~/nodes/quickstart
ainize init --name quickstart --port 3694
```

```text
✓ node initialised at <NGRAM_HOME>/config.json
name     quickstart
address  0x67470AEa0c6d6877841D3c79e961d33A440225E3
port     3694
ledger   local
roles    seller, verifier, serving
the private key lives in <NGRAM_HOME>/config.json and this is the only copy — back it up now: `ainize keys backup <file>`

next: `ainize start`   (then `ainize login`, `ainize seed`)
```

저 주소가 노드의 신원이고, 여기서 한 번 만들어진 뒤로 다시는 만들어지지 않습니다. 이 노드가 공개하는 모든 것과 잔액이
그 주소에 묶입니다. `ledger local`은 이 노드가 기록을 AIN 블록체인이 아니라 로컬 P2P 로그에 쓴다는 뜻이고, 아직
익히는 중이라면 그쪽이 맞습니다. 처음 주어지는 역할 셋이 이 노드가 할 일을 정합니다. `seller`는 자기 지식을 공개하고
팔 수 있게 하고, `verifier`는 남의 지식을 배경에서 검사하게 하고, `serving`은 뒤에 모델이 있다는 뜻이라 라이브
테스트를 여기서 돌릴 수 있게 합니다. 뒤의 두 역할이 모델을 *필수*로 만들기도 하는데, 4단계의 준비 상태 검사가 모델
없는 노드를 `NOT READY`라고 부르는 이유가 그것입니다.

마지막 줄의 `ainize seed`는 지금은 넘어가세요. 노드를 예시 지식으로 채워 주는 명령이지만, 그 재료는 이 페이지가
있다고 가정하지 않는 모델 저장소 안의 파일들입니다. 그 파일이 없는 컴퓨터에서는 `missing 4 source file(s)`라고만
찍고 아무것도 만들지 않으며, 노드가 떠 있는 동안에는 아예 실행을 거부합니다. 이 페이지가 살 것을 구하는 방법은
6단계입니다.

## 2. 내 모델을 물리기

`ainize init`은 설정에 짐작값을 적어 둡니다. `runtime.api`가 `http://localhost:8000`인데, vLLM 서버가 흔히 뜨는
자리일 뿐 답은 아닙니다. 내 엔드포인트로 바꾸고, `runtime.repo`는 `scripts/patch.py`가 있는 저장소로 맞추세요.

```bash
ainize config set runtime.api http://localhost:8000
ainize config set runtime.repo ~/qwen3.8
```

```text
✓ runtime.api = "http://localhost:8000"  (the node reads config.json when it starts)
✓ runtime.repo = "/home/comcom/qwen3.8"  (the node reads config.json when it starts)
```

두 값 모두 `config.json`에 그대로 쓰일 뿐 어디에도 접속하지 않습니다. 그래서 여기서 잘못 넣은 값은 지금이 아니라
4단계에서 드러납니다. 뒤에 붙는 안내가 보기보다 중요합니다. **노드는 뜰 때 `config.json`을 읽습니다.** 이미 떠 있는
노드는 다시 띄우기 전까지 뜰 때 읽은 값을 그대로 씁니다.

> [!IMPORTANT]
> 이 페이지의 4단계 이후 기록은 `runtime.api`를 `http://127.0.0.1:9`, 즉 닫힌 포트로 두고 남겼습니다. 그 컴퓨터에
> 있던 단 하나의 모델이 벤치마크에 잡혀 있었고, 요청 하나가 잘못 들어가면 측정을 버려야 했기 때문입니다. 그러니
> 아래에 보이는 것은 뒤에 모델이 없는 노드가 실제로 하는 그대로입니다. 마지막 두 단계를 빼면 전부 정상이고, 어느
> 둘이 안 되는지도 숨기지 않았습니다.

## 3. 띄우기

```bash
ainize start -d
```

```text
✓ node started in the background (pid 730221) — port 3694
  logs: <NGRAM_HOME>/node.log   stop: ainize stop
```

`-d`(`--detach`)는 노드를 배경으로 보내고 로그 옆에 pid를 적어 둡니다. 붙이지 않으면 앞에서 돌고 Ctrl-C로 멈춥니다.
방금 띄운 프로세스 하나가 곧 제품 전체입니다. HTTP API, P2P 가십, 검증 루프, 그리고 마켓플레이스 웹사이트가 전부 그
안에 있습니다. 브라우저로 `http://localhost:3694`를 열면 지금 이야기하고 있는 그 노드를 보는 것이고, 지금 읽고 있는
이 문서를 내보내는 것도 같은 프로세스입니다.

## 4. 되고 안 되고를 가르는 한 줄

```bash
ainize status
```

```text
quickstart  http://localhost:3694  (pid 730221)
address     0x67470AEa0c6d6877841D3c79e961d33A440225E3
roles       seller, verifier, serving
version     0.1.0 · built 2026-09-04 12:25:57
ledger      local · local · 1 records · height 1
runtime     unavailable (serving API unreachable)
peers       0
patches     0 (0 listed)
quorum      2
currency    CREDIT
branches    -
blobs held  0
```

지금은 `runtime` 줄만 보세요. 이 페이지 끝의 두 단계가 되느냐 마느냐가 여기서 갈리고, 나올 수 있는 모양은 몇 가지로
정해져 있습니다.

- `available · <model id> · hook ok` — 문 두 짝이 다 열렸습니다. 찍힌 모델 id가 엔드포인트가 답한 모델이고, 앞으로
  쓰는 지식은 그 모델용으로 만들어진 것이어야 합니다.
- `unavailable (serving API unreachable)` — `runtime.api`에서 아무도 답하지 않았습니다. 위에 찍힌 줄이 그것이고,
  주소를 잘못 적었을 때, 서버가 멈췄을 때, 포트가 닫혔을 때가 모두 똑같이 이렇게 보입니다.
- `unavailable (runtime repo not found)` — 엔드포인트는 답했지만 `runtime.repo`가 훅이 들어 있는 저장소를 가리키고
  있지 않습니다.
- `unavailable (patch hook unavailable (ENGRAM_HOOK=1?))` — 저장소는 있는데 훅이 올라오지 않습니다. 서빙 쪽
  프로세스가 훅을 켠 채로 떠 있어야 하고, 그 이야기는 `deploy/README.md`에 있습니다.

하나가 더 있습니다. `unavailable (model unavailable, try again in a few minutes)`는 설정을 잘못한 것이 아닙니다.
모델 쪽에서 생성이 한 번 실패해서, 노드가 계속 두드리는 대신 잠시 쉬게 두고 있는 상태입니다.

이 페이지의 나머지는 네 경우 모두에서 돌아갑니다. 첫 번째가 필요한 것은 라이브 테스트뿐입니다.

배포 스크립트나 감시용으로는 같은 질문을 짧게 묻고, 검사에 걸리면 0이 아닌 값으로 끝나는 형태가 있습니다.

```bash
ainize status --check
```

```text
✗ quickstart  http://localhost:3694  NOT READY
ledger   ok · local · height 1
runtime  serving API unreachable
peers    0 configured
```

## 5. 로그인

공개하고, 사고, 설정을 바꾸는 일은 운영자의 몫이고, 운영자란 이 노드의 비밀번호를 아는 사람입니다. 처음 실행하는
`ainize login`이 비밀번호를 정하고, 그다음부터는 그것을 묻습니다.

```bash
ainize login
```

```text
✓ operator password set and logged in to http://localhost:3694 (token saved in <NGRAM_HOME>/cli.json)
```

`cli.json`에 담긴 토큰을 CLI가 이후 계속 보냅니다. 그래서 홈 디렉터리마다 한 번만 로그인하면 됩니다. (프롬프트에
입력할 수 없는 스크립트라면 `--password`를 넘기거나 `NGRAM_PASSWORD`를 씁니다. 위 줄도 실제로는 그렇게 실행했습니다.)

`cli.json`에는 노드의 주소도 함께 적힙니다. 이 파일에 대해 기억할 것은 그 한 가지입니다. CLI는 `config.json`이 지금
무엇이라 적고 있든, 로그인할 때의 그 주소로 말을 겁니다. 로그인한 뒤에 노드의 포트를 바꾸면 이후 모든 명령이 옛 주소를
계속 찾아갑니다. `cli.json`을 지우고 `ainize login`을 다시 하면 그것으로 끝입니다.

## 6. 시험해 볼 지식 찾기

> [!IMPORTANT]
> **이 단계에는 앞의 다섯 단계에 없던 것이 하나 필요합니다. 이미 무언가를 공개해 둔 다른 노드입니다.** 중앙 목록도
> 없고 기본으로 붙는 피어도 없습니다. 방금 만든 노드는 다른 노드를 하나도 모르므로 목록이 빈 채로 시작하고, 주소를
> 알려 주기 전까지 빈 채로 있습니다. 그동안 7단계와 8단계는 손댈 대상이 없습니다. 그 주소를 어디서 구하느냐는 이
> 페이지가 대신 줄 수 없는 하나입니다. 네트워크에 있는 누군가가 자기 주소를 알려 주거나, 두 번째 노드를 직접 띄워
> 거기에 공개하거나입니다. 뒤쪽은 [남이 공개한 지식 사서 쓰기](../tutorials/buy-and-apply.md)가 양쪽 모두를
> 짚어 줍니다.

노드의 목록은 자기가 말을 트고 있는 노드들에게서 전해 들은 것이 전부입니다. 그래서 아무와도 말을 트지 않은 노드의
목록은 비어 있습니다.

```bash
ainize patch ls
```

```text
no patches match
```

피어를 하나 알려 주면 — 이미 네트워크에 있는 노드, 그 주소를 누군가에게서 받아서 — 공지가 들어오기 시작합니다.
아래 주소는 이 기록을 남길 때 상대가 되어 준 판매 노드이고, 여러분의 주소는 다른 누군가의 것일 겁니다.

```bash
ainize peers add http://localhost:3690
```

```text
✓ peer added: http://localhost:3690
```

> [!WARNING]
> **저 체크 표시는 주소를 받아 적었다는 뜻이지, 거기서 누가 답했다는 뜻이 아닙니다.** `peers add`는 입력이
> `http(s)` 주소 모양인지만 확인하고 저장합니다. 그 노드에 접속해 보지는 않습니다. 오타를 냈을 때, 노드가 꺼져
> 있을 때, 그런 노드가 애초에 없었을 때가 모두 똑같이 `✓ peer added`를 찍고, 증상은 목록이 계속 비어 있다는 것
> 하나뿐입니다. 차이가 드러나는 자리는 `ainize nodes`의 두 번째 표입니다. 한 번도 답한 적 없는 피어는 주소 칸이
> 비어 있고 `FAILURES`가 올라갑니다. 답한 피어들과 나란히 놓고 보면 이렇습니다.
>
> ```text
> configured peers
> ENDPOINT               ADDRESS          LAST SEEN            FAILURES
> ─────────────────────  ───────────────  ───────────────────  ────────
> http://localhost:3691  0xD0b68475…7715  2026-09-04 12:39:33         0
> http://localhost:3690  0x529B9b39…85fd  2026-09-04 12:39:33         0
> http://localhost:3692  0xAb5293f1…35C6  2026-09-04 12:39:33         0
> http://localhost:3611  -                -                           2
> ```
>
> 저기서 손으로 넣은 것은 `3690` 하나뿐입니다. `3691`과 `3692`는 저절로 들어왔습니다. 피어끼리 서로의 피어 목록을
> 주고받기 때문에, 쓸 만한 주소 하나면 나머지 네트워크를 만나기에 충분합니다. `3611`은 일부러 틀리게 넣은
> 주소이고, 잘못됐을 때 어떻게 보이는지를 보여 주는 줄입니다.

피어끼리 아는 것을 주고받는 일은 물어보는 즉시가 아니라 일정한 주기로 일어납니다. 몇 초 두었다가 다시 물어보세요.

```bash
ainize patch ls
```

```text
ID                 STATUS      AUTHOR              MODEL                  ROWS      SIZE       PRICE  ATTEST  SOLD  BENCHMARK
─────────────────  ──────────  ──────────────────  ──────────────────  ───────  ────────  ──────────  ──────  ────  ────────────────
law-kr-2026        LISTED      node-a 0x529B…85fd  demo-ngram-1b         1,200    1.5 MB  2.5 CREDIT     2/2     0  law-jurisdiction
law-us-2025        LISTED      node-a 0x529B…85fd  demo-ngram-1b         1,200    1.5 MB    2 CREDIT     2/2     0  law-jurisdiction
law-kr-2025        SUPERSEDED  node-a 0x529B…85fd  demo-ngram-1b         1,200    1.5 MB    2 CREDIT     2/2     0  law-jurisdiction
law-common-base    LISTED      node-a 0x529B…85fd  demo-ngram-1b         2,000    2.5 MB    1 CREDIT     2/2     2  law-basics
krx-all-2761       VERIFYING   node-a 0x529B…85fd  Qwen3.8-Flash-Next  270,053  331.7 MB   25 CREDIT     0/2     0  krx-ticker-codes
krx-all-2761-ep12  VERIFYING   node-a 0x529B…85fd  Qwen3.8-Flash-Next  241,992  297.2 MB   10 CREDIT     0/2     0  krx-ticker-codes
krx-all-2761-ep6   VERIFYING   node-a 0x529B…85fd  Qwen3.8-Flash-Next  241,992  297.2 MB    5 CREDIT     0/2     0  krx-ticker-codes
pixelplus-087600   VERIFYING   node-a 0x529B…85fd  Qwen3.8-Flash-Next    2,992    3.7 MB  0.1 CREDIT     0/2     0  krx-ticker-codes
```

결정을 좌우하는 칸은 넷입니다. `MODEL`은 4단계에서 내 노드가 찾아낸 모델과 같아야 합니다. 지식이란 특정 모델 기억
테이블의 항목들이고, 다른 모델에서는 아무 뜻도 없기 때문입니다. 그래서 목록에는 내가 쓸 수 없는 모델의 것도 함께
올라옵니다. 위의 표가 바로 그런 경우입니다. `ATTEST 2/2`는 독립된 노드 몇 곳이 검사를 마쳤는지를, 이 노드가 팔아도
된다고 보기까지 요구하는 수와 나란히 보여 줍니다. 그 수에 만든 사람은 절대 포함되지 않습니다. 노드는 자기 검사를
세어 주지 않기 때문입니다. `PRICE`는 7단계에서 치를 값이고, 단위는 이 노드의 통화입니다.

`STATUS`를 가장 먼저 보세요. 살 수 있는 값은 둘뿐입니다. `LISTED`는 검증 수가 정족수에 닿았다는 뜻입니다.
`VERIFYING`은 검사가 진행 중이고 아직 닿지 않았다는 뜻이며 — 위의 네 줄이 `0/2`에 있습니다 — 이것을 사려고 하면
돈이 움직이기 전에 거절당합니다.

```bash
ainize use pixelplus-087600
```

```text
error: pixelplus-087600 is VERIFYING (verification 0/2) — not verified yet; try `ainize patch get pixelplus-087600`
```

`SUPERSEDED`는 만든 사람이 그 뒤로 더 새 것을 냈다는 뜻이고, 그래도 살 수는 있습니다. 나머지 상태들은
[목록에 오르지 않을 때](../how-to/failed-verification.md)에서 차근히 다룹니다.

검사가 무엇이었는지는 하나로 정해져 있지 않고, 빠른 시작이라도 이것만은 뭉뚱그리면 안 됩니다. 맞는 모델을 가진 검증
노드는 항목을 실제로 올려 만든 사람의 벤치마크를 돌려 보지만, 모델이 없는 검증 노드는 파일이 기록에 적힌 그 파일이
맞다는 것까지만 확인할 수 있습니다. 둘 다 기록에 남지만 같은 주장이 아닙니다. 위 기록의 검증은 전부 뒤쪽입니다. 그
네트워크에는 모델이 없었기 때문입니다. 그래서 여기서 `2/2`는 *검사됨*이지 *채점됨*이 아닙니다. 이 선을 제대로 긋는
페이지는 개념 묶음에 있습니다.

> [!NOTE]
> 이 기록의 네트워크는 한 컴퓨터에 띄운 노드 세 개이고, 거기 올라온 지식은 이 페이지를 남기려고 만들어 낸 합성물로
> 이름에 `[synthetic]`이 붙어 있습니다. 명령과 출력은 진짜지만 지식은 진짜가 아니며, `law-common-base`는 실제 법을
> 아무것도 알지 못합니다. 진짜 지식을 가진 노드와 피어를 맺으면 이 표가 진짜 항목들로 찹니다.

## 7. 내 노드에 올리기

명령 하나가 검증을 확인하고, 값을 치르고, 내려받고, 내 모델에 올립니다.

```bash
ainize use law-common-base
```

<!-- unverified: needs a model runtime — `ainize use`의 마지막 "모델에 올리기" 단계는 실행할 수 없었습니다. 아래 출력은 runtime 줄이 unavailable인 노드에서 같은 명령을 돌린 것이고, 결제까지는 실제로 일어났습니다 -->

```text
error: serving API unreachable
```

모델이 없을 때의 그 경우인데, 여기서 한 번 멈춰 볼 만합니다. 오류가 마지막 단계만 이름 대고 있기 때문입니다. 그 앞의
넷은 실제로 일어났습니다.

```bash
ainize logs --kind buy
```

```text
2026-09-04 12:39:36 info  buy       [law-common-base] quorum: 2 attestation(s) ≥ quorum 2
2026-09-04 12:39:36 info  buy       [law-common-base] 402: Payment Required: 1 CREDIT → 0x529B9b39… (local-credit)
2026-09-04 12:39:36 info  buy       [law-common-base] pay: signed credit intent a0f57f34e69206…
2026-09-04 12:39:36 info  buy       [law-common-base] settled: seller confirmed; manifest sha256 4fff05beaec02e…
2026-09-04 12:39:36 info  buy       [law-common-base] download: 2.6 MB from http://localhost:3690; sha256 matches on-ledger anchor
```

위에서 아래로 읽으면 거래 전체입니다. 산 쪽이 검증 수를 스스로 확인했고, 판 쪽이 내려받기 요청에 `402 Payment
Required`와 값으로 답했고, 산 쪽이 결제에 서명해 돌려보냈고, 판 쪽이 정산했고, 본문이 도착해 그 해시가 공개 기록에
적힌 것과 맞았습니다. 계정을 만든 적도 카드를 넣은 적도 없습니다. 노드는 1단계에서 만든 자기 키로 값을 치렀습니다.
돈은 실제로 움직였습니다.

```bash
ainize wallet
```

```text
address             0x67470AEa0c6d6877841D3c79e961d33A440225E3
ledger              local · local
balance             99 CREDIT
sales               0
royalties received  0
purchases           1
royalty payouts owed  none pending
```

> [!WARNING]
> **여기서 실패해도 돈은 이미 나갔을 수 있습니다.** 위 명령은 `error: serving API unreachable` 한 줄만 찍고 0이
> 아닌 값으로 끝났지만, 잔액은 100에서 99로, `purchases`는 0에서 1로 갔습니다. 실패한 단계에 닿기 전에 구매가 이미
> 끝나 있었기 때문입니다. `ainize use`는 무너진 단계를 알릴 뿐 성공한 단계들을 알리지 않습니다. 그러니 오류가 떴다고
> 아무 일도 없었다고 넘기지 말고 `ainize wallet`이나 `ainize logs --kind buy`를 확인하세요. 다시 실행하는 것은
> 안전하고 값도 다시 나가지 않습니다. 바로 아래가 그것입니다.

같은 지식을 `ainize use`로 다시 부르면 값이 들지 않습니다. 노드가 이미 갖고 있고, 그렇다고 말해 줍니다.

```bash
ainize use law-common-base --no-apply
```

```text
✓ law-common-base is already on this node (purchased)
✓ try it: ainize chat law-common-base "your question"
```

여기서 대신 `error: patch not found`가 나온다면 노드에 문제가 있는 것이 아닙니다. 그 id가 이 노드의 목록에 없다는
뜻이고, 곧 6단계가 그것을 가진 피어를 아직 찾아 주지 못했다는 뜻입니다.

## 8. 같은 질문을 두 번 던지기

지금까지의 모든 것이 이 단계를 위한 것이었습니다. `ainize chat`은 서빙 모델에 같은 질문을 두 번 던집니다. 한 번은
그대로, 한 번은 지식을 올린 채로. 그리고 두 답을 나란히 보여 줍니다. 먼저, 여기서 시험할 수 있는 것이 무엇인지부터
봅니다.

```bash
ainize chat --list
```

```text
runtime unavailable — serving API unreachable  (chat needs a serving node; pass --node <url> of one)
ID               NAME                             MODEL          FACTS  MEMORY ROWS  VERIFIED  TRY
───────────────  ───────────────────────────────  ─────────────  ─────  ───────────  ────────  ───
law-common-base  [synthetic] common legal basics  demo-ngram-1b     40        2,000     2/2 ✓  -

ainize chat <ID> "<question>"   or   ainize chat <ID>   for an interactive session   (ainize chat --patch a,b loads up to 3 together)
```

여기 오르는 것은 이 노드가 본문을 갖고 있는 지식입니다. 7단계가 마련해 둔 것이 그것이고, 목록의 나머지 일곱 줄이 여기
없는 이유도 그것입니다. `FACTS`는 만든 사람이 함께 공개한 질문·답 쌍의 개수이고, `TRY`는 그중 하나가 있으면 보여
줍니다. 답을 이미 아는 질문부터 시작할 수 있게 하려는 것입니다. 아무것도 사지 않은 노드에서는 같은 명령이
`no testable patch on this node`라고 답합니다.

<!-- unverified: needs a model runtime — `ainize chat`은 실행했지만 runtime 관문에서 거절당했습니다. 그 아래의 전후 출력 설명은 packages/cli/src/commands/chat.ts를 읽고 쓴 것이지, 붙여 넣은 출력이 아닙니다 -->

```bash
ainize chat law-common-base "Which court hears a contract dispute?"
```

`runtime` 줄이 `unavailable`인 노드에서는 여기서 페이지가 멈춥니다. 7단계와 같은 거절입니다.

```text
error: serving API unreachable
```

뒤에 모델이 있으면 대신 블록 두 개가 찍힙니다. 첫 번째 `before (base model)`은 모델이 혼자서 내놓는 답입니다. 그다음
항목들이 살아 있는 테이블에 쓰이고, 같은 질문이 다시 들어가고, 두 번째 블록 `after (law-common-base loaded)`가 이제
뭐라고 하는지를 올리는 데 걸린 시간과 함께 보여 줍니다. 질문이 만든 사람이 공개한 벤치마크 문항 중 하나와 맞으면 각
답에 `correct ✓ (benchmark)` 또는 `wrong ✗ (benchmark)`가 붙어서, 바뀐 것을 감탄만 하는 대신 채점까지 합니다. 질문을
빼고 부르면 지식을 올린 채로 대화가 열리고, `/quit`으로 끝냅니다.

두 블록이 똑같다면 그 지식이 내가 물어본 것을 건드리지 않은 것이고, 그것도 진짜 답입니다. 라이브 테스트가 있는 이유,
그리고 값을 치른 뒤가 아니라 치르기 전에 돌려 보는 이유가 바로 그것입니다.

## 9. 노드 멈추기

```bash
ainize stop
```

```text
! node 730221 is still running 10 s after SIGTERM — sending SIGKILL
✓ stopped node (pid 730221) — it ignored SIGTERM, so it was killed
```

곱게 내려가는 노드는 둘째 줄만, 그것도 `it ignored SIGTERM` 없이 찍습니다. 둘 다 정상적으로 멈춘 것입니다. 10초의
멈칫거림은 스스로 끝나지 않은 노드를 `ainize stop`이 기다려 준 시간이고, 피어 연결을 열어 둔 노드가 이 빌드에서
보이는 모습입니다.

노드의 홈 디렉터리는 그대로 남습니다. 다시 띄우면 같은 신원, 같은 잔액, 같은 지식을 그대로 이어받습니다. 디렉터리를
지우면 키가 사라지고, 그 노드가 공개한 모든 것도 함께 사라집니다.

## 이다음에 읽을 것

노드가 생겼고, 남의 지식에 값을 치르고 올릴 수 있게 됐습니다. 다음 질문은 셋이고, 왼쪽 목차에 각자의 묶음이
있습니다.

- **내 지식을 만들기.** **튜토리얼** 묶음은 한 번에 하나의 일을 처음부터 끝까지 다룹니다. 질문과 답이 담긴 파일로
  가르치기, 브라우저에서 모델의 답을 고쳐 가며 가르치기, 그리고 이 페이지가 두 단계로 압축한 사고 올리는 과정입니다.
- **방금 한 일을 이해하기.** **개념** 묶음은 실행할 명령 없이 이유만 다룹니다. 그 파일 안에 실제로 무엇이 들었는지,
  `LISTED`와 `2/2`가 무엇을 증명하고 무엇은 증명하지 않는지, 지식 위에 지식을 쌓았을 때 돈이 어디로 가는지, 그리고
  계정 없이 어떻게 결제가 되는지입니다.
- **제대로 운영하기.** **사용법** 묶음은 노드가 장난감이 아니게 되는 날을 위한 것입니다. 다른 컴퓨터에서 닿게 만들기,
  공개한 것에 값 매기기, 공개한 것이 목록에 오르지 않을 때 무엇을 봐야 하는지입니다.

플래그나 설정 키의 정확한 철자가 필요할 때는 이 사이트의 다른 절반을 보세요.
[CLI 명령 레퍼런스](../reference/cli.md)와 [설정 레퍼런스](../reference/config.md)는 코드에서 직접 만들어지기 때문에
프로그램이 하는 일과 어긋날 수 없습니다.
