---
title: 빠른 시작
summary: 내 노드를 띄우고, 남이 공개한 지식을 내 모델에 넣고, 같은 질문을 넣기 전과 뒤에 던져 봅니다.
source: en/get-started/quickstart.md
source_sha256: eef84a8987b4b062fce8e64ac2b758bc526528f7a254e6f9b5f0bb2558671d94
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
디렉터리와 포트를 지금 정합니다. 기본 포트는 3402이고, 이 기록이 3610을 쓴 것은 기록에 쓴 컴퓨터의 3402에 이미 다른
노드가 있었기 때문입니다.

```bash
export NGRAM_HOME=~/nodes/quickstart
ainize init --name quickstart --port 3610
```

```text
✓ node initialised at <NGRAM_HOME>/config.json
name     quickstart
address  0x9d9da8f0C939c0cE4909ef44B73BeDffF740e77A
port     3610
ledger   local
roles    seller, verifier, serving
the private key lives in <NGRAM_HOME>/config.json and this is the only copy — back it up now: `ainize keys backup <file>`
```

여기 찍힌 주소가 노드의 신원이고, 이때 한 번 만들어지고 다시는 만들어지지 않습니다. 이 노드가 공개하는 모든 것과
잔액이 이 주소의 것입니다. `ledger local`은 이 노드가 기록을 AIN 블록체인이 아니라 로컬 P2P 기록에 쓴다는 뜻이고,
처음 익히는 동안에는 그 편이 맞습니다. 처음 붙는 역할 셋이 이 노드가 할 일을 정합니다. `seller`는 자기 지식을 공개하고
팔 수 있게 하고, `verifier`는 남의 지식을 뒤에서 검사하게 하고, `serving`은 이 노드 뒤에 모델이 있어서 라이브 테스트를
여기서 돌릴 수 있다는 뜻입니다. 뒤의 둘은 모델을 _필수_로 만들기도 합니다. 4단계의 준비 상태 검사가 모델 없는 노드를
`NOT READY`라고 부르는 이유가 그것입니다.

## 2. 내 모델을 물리기

`ainize init`은 설정에 추측을 하나 적어 둡니다. `runtime.api`가 `http://localhost:8000`인데, vLLM 서버가 흔히 뜨는
자리일 뿐 답은 아닙니다. 내 엔드포인트로 바꾸고, `scripts/patch.py`가 있는 저장소를 `runtime.repo`에 적어 줍니다.

```bash
ainize config set runtime.api http://localhost:8000
ainize config set runtime.repo ~/qwen3.8
```

```text
✓ runtime.api = "http://localhost:8000"  (the node reads config.json when it starts)
✓ runtime.repo = "~/qwen3.8"  (the node reads config.json when it starts)
```

출력 끝에 붙은 말이 보기보다 중요합니다. **노드는 뜰 때 `config.json`을 읽습니다.** 그래서 이미 돌고 있는 노드는
다시 띄우기 전까지 뜰 때 읽은 값을 그대로 씁니다.

> [!IMPORTANT]
> 이 페이지의 나머지 기록은 `runtime.api`를 `http://127.0.0.1:9`, 즉 닫힌 포트로 두고 만들었습니다. 그 컴퓨터에 있던
> 단 하나의 모델이 벤치마크에 잡혀 있어서 요청 한 번이 다섯 시간짜리 측정을 망칠 수 있었기 때문입니다. 그러니
> 4단계부터 아래에 보이는 것은 모델이 없는 노드가 실제로 하는 그대로입니다. 마지막 두 단계만 빼면 전부 제대로 돌고,
> 어느 둘이 안 되는지도 그대로 드러납니다.

## 3. 띄우기

```bash
ainize start -d
```

```text
✓ node started in the background (pid 660275) — port 3610
  logs: <NGRAM_HOME>/node.log   stop: ainize stop
```

`-d`(`--detach`)는 노드를 백그라운드로 보내고 로그 옆에 pid를 적어 둡니다. 이 옵션이 없으면 노드는 앞에서 돌고
Ctrl-C로 멈춥니다. 방금 띄운 그 프로세스 하나가 곧 제품 전부입니다. HTTP API이자 P2P 가십이자 검증 루프이자
마켓플레이스 웹사이트입니다. 브라우저로 `http://localhost:3610`을 열면 지금 말을 걸고 있는 그 노드를 보게 됩니다.
이 문서를 띄워 주는 것도 같은 노드입니다.

## 4. 되고 안 되고를 가르는 한 줄

```bash
ainize status
```

```text
quickstart  http://localhost:3610  (pid 660275)
address     0x9d9da8f0C939c0cE4909ef44B73BeDffF740e77A
roles       seller, verifier, serving
version     0.1.0 · built 2026-09-04 11:36:29
ledger      local · local · 1 records · height 1
runtime     unavailable (serving API unreachable)
peers       0
patches     0 (0 listed)
quorum      2
currency    CREDIT
branches    -
blobs held  0
```

지금은 `runtime` 줄만 보면 됩니다. 이 페이지 끝의 두 단계가 되느냐 마느냐가 여기서 갈리고, 모양은 몇 가지입니다.

- `available · <모델 id> · hook ok` — 문 두 짝이 다 열렸습니다. 찍힌 모델 id가 엔드포인트가 답한 그 모델이고,
  앞으로 쓰는 지식은 그 모델용으로 만들어진 것이어야 합니다.
- `unavailable (serving API unreachable)` — `runtime.api` 자리에서 아무도 답하지 않았습니다. 위의 출력이 이 경우이고,
  주소가 틀렸을 때도, 서버가 꺼졌을 때도, 포트가 닫혔을 때도 똑같이 이렇게 보입니다.
- `unavailable (runtime repo not found)` — 엔드포인트는 답했는데 `runtime.repo`가 훅이 들어 있는 저장소를 가리키고
  있지 않습니다.
- `unavailable (patch hook unavailable (ENGRAM_HOOK=1?))` — 저장소는 있는데 훅이 올라오지 않습니다. 서빙 프로세스를
  훅을 켠 채로 띄웠어야 합니다. `deploy/README.md`가 그 부분을 다룹니다.

하나가 더 있습니다. `unavailable (model unavailable, try again in a few minutes)`는 설정이 틀린 경우가 아닙니다.
모델 쪽에서 생성이 한 번 실패해서, 노드가 계속 두드리는 대신 잠시 쉬어 가는 중이라는 뜻입니다.

이 페이지의 나머지는 네 경우 모두에서 그대로 돌아갑니다. 첫 번째가 필요한 것은 라이브 테스트뿐입니다.

배포 스크립트나 감시 도구에는 같은 질문의 짧은 형태가 있습니다. 검사에 실패하면 0이 아닌 값으로 끝납니다.

```bash
ainize status --check
```

```text
✗ quickstart  http://localhost:3610  NOT READY
ledger   ok · local · height 1
runtime  serving API unreachable
peers    0 configured
```

## 5. 로그인

공개하고, 사고, 설정을 바꾸는 일은 운영자의 일이고, 운영자란 이 노드의 비밀번호를 아는 사람입니다. 첫 번째
`ainize login`이 비밀번호를 정하고, 그다음부터는 물어봅니다.

```bash
ainize login
```

```text
✓ operator password set and logged in to http://localhost:3610 (token saved in <NGRAM_HOME>/cli.json)
```

`cli.json`에 담긴 토큰을 CLI가 그다음부터 보내기 때문에, 홈 디렉터리 하나당 한 번만 로그인하면 됩니다. (프롬프트에
입력할 수 없는 스크립트는 `--password`를 넘기거나 `NGRAM_PASSWORD`를 씁니다. 위 줄도 실제로는 그렇게 실행했습니다.)

## 6. 시험해 볼 지식 찾기

가운데 목록 같은 것은 없습니다. 노드의 목록은 그 노드가 말을 트고 있는 노드들에게서 들은 것이 전부라서, 아무와도
말을 트지 않은 노드의 목록은 비어 있습니다.

```bash
ainize patch ls
```

```text
no patches match
```

피어를 하나 알려 주면 — 이미 네트워크에 있는 아무 노드나, 주소를 누가 알려 준 그 노드면 됩니다 — 그때부터 소식이
들어옵니다.

```bash
ainize peers add http://localhost:3611
```

```text
✓ peer added: http://localhost:3611
```

```bash
ainize patch ls
```

```text
ID              STATUS  AUTHOR                 MODEL               ROWS     SIZE     PRICE  ATTEST  SOLD  BENCHMARK
──────────────  ──────  ─────────────────────  ──────────────────  ────  ───────  ────────  ──────  ────  ─────────
demo-knowledge  LISTED  network-2 0xA1f3…560f  Qwen3.8-Flash-Next    12  15.8 KB  2 CREDIT     2/2     0  qa-v1
```

판단은 네 칸이 결정합니다. `MODEL`은 4단계에서 내 노드가 찾아낸 모델과 같아야 합니다. 지식은 특정 모델 하나의 기억
테이블의 행이라서 다른 모델에서는 아무 뜻도 없기 때문입니다. `ATTEST 2/2`는 독립된 노드 몇 곳이 검사를 마쳤는지와,
이 노드가 팔아도 된다고 인정하기까지 요구하는 수입니다. 그 안에 작성자는 결코 들어가지 않습니다. 노드가 자기 검사를
세기를 거부하기 때문입니다. `STATUS LISTED`가 그 수가 채워졌다는 뜻이고, `PRICE`는 7단계에서 낼 값입니다.

검사가 무엇인지는 하나로 정해져 있지 않고, 빠른 시작이라고 뭉개고 넘어가면 안 되는 지점이 바로 여기입니다. 맞는
모델을 가진 검증 노드는 행을 실제로 올려 작성자의 벤치마크를 돌리고, 모델이 없는 검증 노드는 그 파일이 기록에 적힌
그 파일이 맞는지까지만 확인할 수 있습니다. 둘 다 기록되지만 둘은 같은 주장이 아닙니다. 위 기록의 증언 둘은 모두
뒤쪽입니다. 그 네트워크에는 모델이 없었으니까요. 그래서 여기의 `2/2`는 _채점됐다_가 아니라 _확인됐다_는 뜻입니다.
이 선을 제대로 긋는 페이지가 개념 묶음에 있습니다.

> [!NOTE]
> 이 기록의 네트워크는 한 컴퓨터 위의 노드 셋이고, 거기 올라와 있는 지식 하나는 이 페이지를 기록하려고 만들어 올린
> 합성 파일입니다. 명령과 출력은 진짜이지만 지식은 진짜가 아닙니다. `demo-knowledge`는 서울에 대해서도 다른 무엇에
> 대해서도 아는 것이 없습니다. 진짜 지식이 올라와 있는 노드와 말을 트면 이 표가 진짜 행으로 찹니다.

## 7. 내 노드에 올리기

명령 하나가 검증됐는지 확인하고, 값을 치르고, 내려받고, 내 모델에 올립니다.

```bash
ainize use demo-knowledge
```

<!-- unverified: needs a model runtime — `ainize use`의 마지막 "모델에 올리기" 단계는 실행할 수 없었습니다. 아래 출력은 runtime 줄이 unavailable인 노드에서 같은 명령을 돌린 것이고, 결제까지는 실제로 일어났습니다 -->

```text
error: serving API unreachable
```

모델이 없는 그 경우이고, 여기서 한 번 멈춰 볼 만합니다. 오류가 가리키는 것은 마지막 단계 하나뿐이기 때문입니다.
그 앞의 네 단계는 실제로 일어났습니다.

```bash
ainize logs --kind buy
```

```text
2026-09-04 11:48:49 info  buy       [demo-knowledge] quorum: 2 attestation(s) ≥ quorum 2
2026-09-04 11:48:49 info  buy       [demo-knowledge] 402: Payment Required: 2 CREDIT → 0xA1f3189f… (local-credit)
2026-09-04 11:48:49 info  buy       [demo-knowledge] pay: signed credit intent 053d8284efbd85…
2026-09-04 11:48:49 info  buy       [demo-knowledge] settled: seller confirmed; manifest sha256 38626e6f0383fb…
2026-09-04 11:48:49 info  buy       [demo-knowledge] download: body already present; sha256 matches on-ledger anchor
```

위에서 아래로 읽으면 그게 거래 전부입니다. 사는 쪽이 검증 수를 직접 확인했고, 파는 쪽이 내려받기 요청에
`402 Payment Required`와 가격으로 답했고, 사는 쪽이 결제에 서명해 돌려보냈고, 파는 쪽이 정산했고, 본문이 도착하면서
그 해시가 공개 기록에 적힌 것과 맞았습니다. 계정을 만든 적도 카드를 넣은 적도 없습니다. 1단계에서 만들어진 그 키로
노드가 값을 치렀습니다. 돈은 실제로 움직였습니다.

```bash
ainize wallet
```

```text
address             0x9d9da8f0C939c0cE4909ef44B73BeDffF740e77A
ledger              local · local
balance             98 CREDIT
sales               0
royalties received  0
purchases           1
royalty payouts owed  none pending
```

같은 지식에 `ainize use`를 한 번 더 해도 값이 더 나가지 않습니다. 이미 노드의 것이고, 그렇다고 말해 줍니다.

```bash
ainize use demo-knowledge --no-apply
```

```text
✓ demo-knowledge is already on this node (purchased)
✓ try it: ainize chat demo-knowledge "your question"
```

## 8. 같은 질문을 두 번 던지기

앞의 모든 단계가 이 한 단계를 위한 것이었습니다. `ainize chat`은 서빙 모델에 질문 하나를 두 번 던집니다. 한 번은
그대로, 한 번은 지식을 올린 채로 던지고, 두 답을 나란히 찍습니다. 먼저 여기서 무엇을 시험할 수 있는지 봅니다.

```bash
ainize chat --list
```

```text
runtime unavailable — serving API unreachable  (chat needs a serving node; pass --node <url> of one)
ID              NAME            MODEL                                                       FACTS  MEMORY ROWS  VERIFIED  TRY
──────────────  ──────────────  ──────────────────  ─────────────────────────────────────────────  ───────────  ────────  ───
demo-knowledge  demo knowledge  Qwen3.8-Flash-Next  Which Seoul Metro line is Gangnam station on?           12     2/2 ✓  -

ainize chat <ID> "<question>"   or   ainize chat <ID>   for an interactive session   (ainize chat --patch a,b loads up to 3 together)
```

이 목록은 본문을 이 노드가 가지고 있는 지식들입니다. 7단계가 해 둔 일이 그것입니다. `FACTS` 칸에는 작성자가 함께
공개한 벤치마크 질문이 보이니, 답을 이미 아는 질문부터 던져 볼 수 있습니다.

<!-- unverified: needs a model runtime — `ainize chat`은 실행했지만 runtime 관문에서 거절당했습니다. 그 아래의 전후 출력 설명은 packages/cli/src/commands/chat.ts를 읽고 쓴 것이지, 붙여 넣은 출력이 아닙니다 -->

```bash
ainize chat demo-knowledge "Which Seoul Metro line is Gangnam station on?"
```

`runtime` 줄이 `unavailable`인 노드에서는 이 페이지가 여기서 멈춥니다. 7단계와 같은 거절입니다.

```text
error: serving API unreachable
```

모델이 뒤에 있으면 이 명령은 대신 블록 두 개를 찍습니다. 첫 번째 `before (base model)`은 내 모델이 혼자서 내놓는
답입니다. 그다음 행들이 살아 있는 테이블에 쓰이고, 같은 질문을 다시 던지고, 두 번째 블록 `after (demo-knowledge
loaded)`가 이제 뭐라고 답하는지를 올리는 데 걸린 시간과 함께 보여 줍니다. 질문이 작성자가 공개한 벤치마크 표본과
맞아떨어지면 각 답에 `correct ✓ (benchmark)` 또는 `wrong ✗ (benchmark)`가 붙어서, 달라진 결과가 감상이 아니라 채점이
됩니다. 질문을 빼고 부르면 지식을 올린 채로 대화가 이어지고, `/quit`으로 끝냅니다.

두 블록이 똑같다면 그 지식은 내가 물은 것을 건드리지 않은 것이고, 그것도 진짜 답입니다. 라이브 테스트가 있는 이유가
그것이고, 값을 치르기 전에 돌려 봐야 하는 이유도 그것입니다.

## 9. 노드 멈추기

```bash
ainize stop
```

```text
✓ stopped node (pid 660275)
```

노드의 홈 디렉터리는 그대로 남습니다. 다시 띄우면 같은 신원, 같은 잔액, 같은 지식으로 이어집니다. 디렉터리를 지우면
키가 사라지고, 그 노드가 공개한 모든 것이 함께 사라집니다.

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
