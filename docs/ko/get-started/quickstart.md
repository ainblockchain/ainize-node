---
title: 빠른 시작
summary: 내 노드를 띄우고, 남이 공개한 지식을 내 모델에 넣고, 같은 질문을 넣기 전과 뒤에 던져 봅니다.
source: en/get-started/quickstart.md
source_sha256: feb0d3f734087ca317890fa064a14b7996773a50ad7a51f6aeb1d082e7d48bd9
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
address  0x4079e607370cC79B00c6051204bDb5c67a54FB12
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

마지막 줄의 `ainize seed`는 장식이 아닙니다. 노드를 예시 지식으로 채워 주는 명령이고, 6단계에서 이 페이지가 살
것을 마련하는 데 바로 이 명령을 씁니다. 손대기 전에 알아 둘 것이 둘 있습니다. 노드가 떠 있는 동안에는 실행을
거부합니다. 시딩은 떠 있는 프로세스가 쥐고 있는 데이터 디렉터리에 쓰기 때문입니다. 그리고 아무 옵션 없이 부르면
`runtime.repo`가 가리키는 모델 저장소에서 진짜 패치 파일을 찾습니다. 그 파일이 없는 컴퓨터에서는
`missing source file(s)`라고 찍고 아무것도 만들지 않습니다. 6단계에서 쓰는 `--synthetic --no-real` 형태는 저장소도
모델도 전혀 필요로 하지 않습니다.

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
> 여기에는 여러분의 엔드포인트를 넣으세요. 이 페이지의 나머지 기록은 `runtime.api`를 `http://127.0.0.1:9`, 즉 닫힌
> 포트로 두고 남겼습니다. 그 컴퓨터에 있던 단 하나의 모델이 벤치마크에 잡혀 있었고, 요청 하나가 잘못 들어가면
> 측정을 버려야 했기 때문입니다. 위의 두 줄은 같은 명령을 독자가 실제로 쓸 법한 주소로 적은 것입니다. 그러니
> 4단계 이후에 보이는 것은 뒤에 모델이 없는 노드가 실제로 하는 그대로입니다. 마지막 두 단계를 빼면 전부 정상이고,
> 어느 둘이 안 되는지도 숨기지 않았습니다.

## 3. 띄우기

```bash
ainize start -d
```

```text
✓ node started in the background (pid 766683) — port 3694
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
quickstart  http://localhost:3694  (pid 766683)
address     0x4079e607370cC79B00c6051204bDb5c67a54FB12
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

이 단계에는 앞의 다섯 단계에 없던 것이 하나 필요합니다. **이미 무언가를 공개해 둔 다른 노드**입니다. 중앙 목록도
없고 기본으로 붙는 피어도 없어서, 방금 만든 노드는 다른 노드를 하나도 모르고 목록도 빈 채로 시작합니다.

```bash
ainize patch ls
```

```text
no patches match
```

네트워크에 있는 누군가가 자기 노드 주소를 알려 주었다면 그것이 다음 명령에 넣을 주소이고, 아래 절은 건너뛰어도
됩니다. 알려 준 사람이 없다면 이 컴퓨터 안에 연습용 네트워크를 세우세요. 모델도, 여러분이 만든 지식도 필요 없고,
1분쯤 걸립니다.

### 피어가 없다면: 연습용 네트워크

두 대가 아니라 세 대입니다. 그 이유가 이 장터의 핵심입니다. 지식은 **독립된** 노드들이 검사를 마쳐야 팔 수 있고,
기본 정족수는 둘이며, **글쓴이의 노드는 자기 것을 검사할 수 없습니다.** 1단계에서 만든 여러분의 노드가 검사자 하나,
판매 노드와 검사 노드 하나가 나머지 둘입니다. 판매 노드만 세우면 거기서 공개한 것은 영원히 `1/2`에 머뭅니다. 한
번 — 여러분에 의해 — 검사되고, 끝내 목록에 오르지 않습니다.

`--home`은 명령 하나가 어느 노드를 향하는지 정합니다. 그래서 다음 두 노드는 1단계에서 정한 `NGRAM_HOME`을 건드리지
않고 다룰 수 있습니다. 먼저 판매 노드입니다. 만들고, 예시 지식으로 채우고, 띄웁니다.

```bash
ainize --home ~/nodes/seller init --name seller --port 3692
ainize --home ~/nodes/seller seed --synthetic --no-real
ainize --home ~/nodes/seller start -d
```

```text
✓ node initialised at ~/nodes/seller/config.json
name     seller
address  0x9ef1F6e4E301CBd95C91556D3891BA9655B7eDB3
port     3692
ledger   local
roles    seller, verifier, serving
the private key lives in ~/nodes/seller/config.json and this is the only copy — back it up now: `ainize keys backup <file>`

next: `ainize start`   (then `ainize login`, `ainize seed`)

[2026-09-04T14:06:45.954Z] INFO  patch: draft created: law-common-base (2000 rows, 2.6 MB)
[2026-09-04T14:06:45.962Z] INFO  publish: announced law-common-base (conflicts: 0)
[2026-09-04T14:06:45.972Z] INFO  patch: draft created: law-kr-2025 (1200 rows, 1.5 MB)
[2026-09-04T14:06:45.980Z] INFO  publish: announced law-kr-2025 (conflicts: 1)
[2026-09-04T14:06:45.990Z] INFO  patch: draft created: law-us-2025 (1200 rows, 1.5 MB)
[2026-09-04T14:06:45.998Z] INFO  publish: announced law-us-2025 (conflicts: 2)
[2026-09-04T14:06:46.017Z] INFO  patch: draft created: law-kr-2026 (1200 rows, 1.5 MB)
[2026-09-04T14:06:46.025Z] INFO  publish: announced law-kr-2026 (conflicts: 3)
✓ seeded: 4 patch(es), 2 branch(es), 0 prototype record(s) imported
  created:  law-common-base, law-kr-2025, law-us-2025, law-kr-2026
  branches: law/KR, law/US

✓ node started in the background (pid 766562) — port 3692
  logs: ~/nodes/seller/node.log   stop: ainize stop
```

`seed`에 붙은 두 옵션이 이 컴퓨터에 모델이 하나도 없어도 되게 만드는 부분입니다. `--synthetic`은 무작위 행으로 된
작은 지식 파일 넷을 만들고 — 파일도 기록도 진짜지만 그 안에 진짜 법은 없습니다 — `--no-real`은 `runtime.repo` 안의
진짜 패치 파일을 찾는 기본 동작을 끕니다. 둘 다 모델에 접속하지 않습니다. 그리고 시딩은 노드를 띄우기 전에 끝나야
합니다. 떠 있는 노드가 쥐고 있는 데이터 디렉터리에 쓰기 때문입니다.

> [!WARNING]
> `--home`은 그것이 적힌 명령 하나에만 적용됩니다. 마지막 줄의 `stop: ainize stop`은 CLI가 늘 붙이는 안내이고,
> 그대로 치면 이 노드가 아니라 3단계에서 띄운 노드를 멈춥니다. 판매 노드를 멈추는 명령은
> `ainize --home ~/nodes/seller stop`입니다.

다음은 세 번째 노드, 두 번째 검사자입니다. 시딩도 로그인도 필요 없습니다. 검사는 부탁해서 하는 일이 아니라 노드가
떠 있기 때문에 하는 일입니다.

```bash
ainize --home ~/nodes/checker init --name checker --port 3691 --peer http://localhost:3692
ainize --home ~/nodes/checker start -d
```

```text
✓ node initialised at ~/nodes/checker/config.json
name     checker
address  0x0b088A365b5ff7311Db2a4b6157c76DF844376c3
port     3691
ledger   local
roles    seller, verifier, serving
the private key lives in ~/nodes/checker/config.json and this is the only copy — back it up now: `ainize keys backup <file>`

next: `ainize start`   (then `ainize login`, `ainize seed`)

✓ node started in the background (pid 766597) — port 3691
  logs: ~/nodes/checker/node.log   stop: ainize stop
```

`init`에 붙인 `--peer`는 그 주소를 새 노드의 설정에 적어 둡니다. 나중에 `ainize peers add`가 하는 일과 같습니다.
세 대 모두 9단계에서 멈춥니다.

### 내 노드를 그쪽으로 향하게 하기

다시 내 노드입니다. `NGRAM_HOME`이 여전히 그 노드를 가리키므로 `--home` 접두어는 다시 없어집니다. 판매 노드의
주소를 알려 주면 공지가 들어오기 시작합니다.

```bash
ainize peers add http://localhost:3692
```

```text
✓ peer added: http://localhost:3692
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
> 저기서 손으로 넣은 것은 하나뿐이고 나머지는 저절로 들어왔습니다. 피어끼리 서로의 피어 목록을 주고받기 때문에,
> 쓸 만한 주소 하나면 나머지 네트워크를 만나기에 충분합니다. `3611`은 일부러 틀리게 넣은 주소이고, 잘못됐을 때
> 어떻게 보이는지를 보여 주는 줄입니다.

피어끼리 아는 것을 주고받는 일은 물어보는 즉시가 아니라 일정한 주기로 일어납니다. 몇 초 두었다가 다시 물어보세요.

```bash
ainize patch ls
```

```text
ID               STATUS      AUTHOR              MODEL           ROWS    SIZE       PRICE  ATTEST  SOLD  BENCHMARK
───────────────  ──────────  ──────────────────  ─────────────  ─────  ──────  ──────────  ──────  ────  ────────────────
law-kr-2026      LISTED      seller 0x9ef1…eDB3  demo-ngram-1b  1,200  1.5 MB  2.5 CREDIT     2/2     0  law-jurisdiction
law-us-2025      LISTED      seller 0x9ef1…eDB3  demo-ngram-1b  1,200  1.5 MB    2 CREDIT     2/2     0  law-jurisdiction
law-kr-2025      SUPERSEDED  seller 0x9ef1…eDB3  demo-ngram-1b  1,200  1.5 MB    2 CREDIT     2/2     0  law-jurisdiction
law-common-base  LISTED      seller 0x9ef1…eDB3  demo-ngram-1b  2,000  2.5 MB    1 CREDIT     2/2     0  law-basics
```

결정을 좌우하는 칸은 넷입니다. `MODEL`은 4단계에서 내 노드가 찾아낸 모델과 같아야 합니다. 지식이란 특정 모델 기억
테이블의 항목들이고, 다른 모델에서는 아무 뜻도 없기 때문입니다. 그래서 진짜 네트워크의 목록에는 내가 쓸 수 없는
모델의 것도 함께 올라오고, 그런 줄은 내 것이 아닙니다. `ATTEST 2/2`는 독립된 노드 몇 곳이 검사를 마쳤는지를, 이 노드가 팔아도
된다고 보기까지 요구하는 수와 나란히 보여 줍니다. 그 수에 만든 사람은 절대 포함되지 않습니다. 노드는 자기 검사를
세어 주지 않기 때문입니다. `PRICE`는 7단계에서 치를 값이고, 단위는 이 노드의 통화입니다.

`STATUS`를 가장 먼저 보세요. 살 수 있는 값은 둘뿐입니다. `LISTED`는 검증 수가 정족수에 닿았다는 뜻이고,
`SUPERSEDED`는 만든 사람이 그 뒤로 더 새 것을 냈다는 뜻이며 그래도 살 수는 있습니다.

나머지 둘은 대기실이고, 어느 쪽이 보이느냐가 *내 노드에서* 그 지식이 어디까지 왔는지를 말해 줍니다. `ANNOUNCED`는
공지는 들었지만 아직 아무도 검사하지 않았다는 뜻입니다. 새 항목이 처음 갖는 상태이고, 큰 파일은 검사할 노드들이
내려받는 동안 계속 여기 머뭅니다. `VERIFYING`은 검사가 최소 하나는 있지만 정족수에 닿지 않았다는 뜻입니다. 둘 다
돈이 움직이기 전에 거절당하고, 메시지에 찾아낸 상태가 그대로 적힙니다.

```bash
ainize use pixelplus-087600
```

```text
error: pixelplus-087600 is ANNOUNCED (verification 0/2) — not verified yet; try `ainize patch get pixelplus-087600`
```

검사가 하나 모자란 항목에 같은 명령을 걸면 `is VERIFYING (verification 1/2)`라고 나옵니다. 어느 쪽도 돈으로 건너뛸
수 있는 오류가 아니고, 둘 다 기다릴 만한 상태입니다. 나머지 상태들과 숫자가 멈춰 버렸을 때 할 일은
[목록에 오르지 않을 때](../how-to/failed-verification.md)에서 차근히 다룹니다.

검사가 무엇이었는지는 하나로 정해져 있지 않고, 빠른 시작이라도 이것만은 뭉뚱그리면 안 됩니다. 맞는 모델을 가진 검증
노드는 항목을 실제로 올려 만든 사람의 벤치마크를 돌려 보지만, 모델이 없는 검증 노드는 파일이 기록에 적힌 그 파일이
맞다는 것까지만 확인할 수 있습니다. 둘 다 기록에 남지만 같은 주장이 아닙니다. 위 기록의 검증은 전부 뒤쪽입니다. 그
네트워크에는 모델이 없었기 때문입니다. 그래서 여기서 `2/2`는 *검사됨*이지 *채점됨*이 아닙니다. 이 선을 제대로 긋는
페이지는 개념 묶음에 있습니다.

> [!NOTE]
> 이 기록의 네트워크는 위에서 만든 노드 셋을 한 컴퓨터에 띄운 것이고, 거기 올라온 지식은 `seed --synthetic`이
> 만들어 낸 것 — 무작위 행으로 된 파일들이며 이름에 `[synthetic]`이 그대로 붙어 있습니다. 명령과 출력은 진짜지만
> 지식은 진짜가 아니며, `law-common-base`는 실제 법을 아무것도 알지 못합니다. 진짜 지식을 가진 노드와 피어를 맺으면
> 이 표가 대신 진짜 항목들로 찹니다.

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
2026-09-04 14:07:35 info  buy       [law-common-base] quorum: 2 attestation(s) ≥ quorum 2
2026-09-04 14:07:35 info  buy       [law-common-base] 402: Payment Required: 1 CREDIT → 0x9ef1F6e4… (local-credit)
2026-09-04 14:07:35 info  buy       [law-common-base] pay: signed credit intent f126af6bb44f7b…
2026-09-04 14:07:35 info  buy       [law-common-base] settled: seller confirmed; manifest sha256 7e8e8a1be950b2…
2026-09-04 14:07:35 info  buy       [law-common-base] download: body already present; sha256 matches on-ledger anchor
```

위에서 아래로 읽으면 거래 전체입니다. 산 쪽이 검증 수를 스스로 확인했고, 판 쪽이 내려받기 요청에 `402 Payment
Required`와 값으로 답했고, 산 쪽이 결제에 서명해 돌려보냈고, 판 쪽이 정산했고, 본문의 해시를 공개 기록에 적힌 것과
맞춰 보았습니다. 계정을 만든 적도 카드를 넣은 적도 없습니다. 노드는 1단계에서 만든 자기 키로 값을 치렀습니다.

마지막 줄이 크기와 주소 대신 `body already present`인 이유는, 내 노드가 사는 쪽이면서 동시에 검사하는 쪽이기
때문입니다. 사기 몇 분 전에 이미 검사하려고 그 파일을 받아 두었던 것입니다. 바이트를 갖고 있는 것과 지식을 소유하는
것은 처음부터 다른 일이고, 그래서 구매는 그대로 일어났습니다. 검사하지 않았던 노드라면 이 단계에서 실제로 내려받고,
어느 쪽이든 해시는 확인합니다. 돈은 실제로 움직였습니다.

```bash
ainize wallet
```

```text
address             0x4079e607370cC79B00c6051204bDb5c67a54FB12
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
overlapping memory entries: law-kr-2026 ∩ law-us-2025 = 600; law-kr-2026 ∩ law-kr-2025 = 600; law-kr-2026 ∩ law-common-base = 600; law-us-2025 ∩ law-kr-2025 = 600; law-us-2025 ∩ law-common-base = 600; law-kr-2025 ∩ law-common-base = 600
ID               NAME                                           MODEL          FACTS  MEMORY ROWS  VERIFIED  TRY
───────────────  ─────────────────────────────────────────────  ─────────────  ─────  ───────────  ────────  ───
law-kr-2026      [synthetic] Korean law revision 2026 (update)  demo-ngram-1b     60        1,200     2/2 ✓  -
law-us-2025      [synthetic] US federal law 2025                demo-ngram-1b     60        1,200     2/2 ✓  -
law-kr-2025      [synthetic] Korean law revision 2025           demo-ngram-1b     60        1,200     2/2 ✓  -
law-common-base  [synthetic] common legal basics                demo-ngram-1b     40        2,000     2/2 ✓  -

ainize chat <ID> "<question>"   or   ainize chat <ID>   for an interactive session   (ainize chat --patch a,b loads up to 3 together)
```

네 줄이고, 그중 하나를 샀습니다. **여기 오르는 것은 이 노드가 본문을 갖고 있는 지식이지, 이 노드가 산 지식이
아닙니다.** `verifier` 역할을 가진 노드는 — 기본값이고, 1단계 이후로 내 노드가 줄곧 갖고 있는 역할입니다 — 검사하려고
본문을 내려받고 그대로 갖고 있습니다. 그러니 여기서 시험할 수 있는 지식이라도 쓰려면 값을 치러야 할 수 있습니다.
`FACTS`는 만든 사람이 함께 공개한 질문·답 쌍의 개수이고, `TRY`는 그중 하나가 있으면 보여 줍니다. 답을 이미 아는
질문부터 시작할 수 있게 하려는 것입니다. 표 위의 `overlapping memory entries` 줄은 바로 이 넷에 대한 경고입니다.
서로에게서 만들어진 것들이라 같은 항목을 많이 건드리고, 둘을 한꺼번에 올리면 겹치는 자리에서는 나중 것이 이깁니다.

아무것도 갖고 있지 않은 노드는 표 대신 한 줄로 답합니다.

```text
no testable patch on this node — its body must be held here (seller node, or `ainize patch buy <id>` first)
```

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

띄운 노드는 모두 배경 프로세스이고, 하나씩 이름을 대어 멈춥니다. 6단계에서 연습용 네트워크를 세웠다면 셋입니다.

```bash
ainize stop
ainize --home ~/nodes/seller stop
ainize --home ~/nodes/checker stop
```

```text
✓ stopped node (pid 766683)
✓ stopped node (pid 766562)
✓ stopped node (pid 766597)
```

가끔 그 앞에 한 줄이 더 붙는데, 그래도 정상적으로 멈춘 것입니다.

```text
! node 730221 is still running 10 s after SIGTERM — sending SIGKILL
✓ stopped node (pid 730221) — it ignored SIGTERM, so it was killed
```

10초의 멈칫거림은 스스로 끝나지 않은 노드를 `ainize stop`이 기다려 준 시간이고, 피어 연결을 열어 둔 노드가 이
빌드에서 가끔 보이는 모습입니다.

홈 디렉터리는 각각 그대로 남습니다. 다시 띄우면 같은 신원, 같은 잔액, 같은 지식을 그대로 이어받습니다. 디렉터리를
지우면 그 노드의 키가 사라지고, 그 노드가 공개한 모든 것도 함께 사라집니다. 연습용 판매 노드도 마찬가지라, 다 쓰고
나서 연습용 네트워크를 깨끗이 버리는 방법이 그것입니다.

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
