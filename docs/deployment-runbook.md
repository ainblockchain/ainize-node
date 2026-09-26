# 배포 런북 — 노드 · 런타임 · 웹

이 기계에서 **실제로 쓰고 있는** 배포 절차. 웹(ainize.ai)·노드·모델 런타임 셋이 서로 물려 있어서,
하나만 고치고 나머지를 안 맞추면 조용히 어긋난다 — 그 어긋남이 지금 하나 열려 있다([열린 문제](#6-열린-문제)).

값은 2026-09-26에 이 기계를 직접 재서 적었다. 표기 둘:

- **[확인함]** — 이 문서를 쓰며 실제로 실행해 본 것
- **[설정값]** — config·컨테이너 정의에서 읽기만 한 것

---

## 0. 지금 상태 (2026-09-26)

| 조각 | 상태 | 근거 |
|---|---|---|
| **웹** ainize.ai | 정상 | main `9fece69` 서빙, `dirty:false`. 실제 브라우저로 4개 페이지 열어 페이지 에러 0 **[확인함]** |
| **노드** :3402 | **런타임 끊김** | 프로세스·포트·에이전트는 정상이나 패치 훅이 안 붙는다 — 메일박스가 어긋났다 **[확인함]** |
| **런타임** vLLM | 구성 되돌아감 | `flashnext`가 GPU 0,1 · 컨텍스트 8192. 9/22에 올린 4장·262144 구성이 아니다 **[설정값]** |

> **지금 손대야 할 것 하나.**
> 노드는 `/mnt/newdata/qwen3.8/ple_patch`에 패치를 쓰는데 서빙 컨테이너는
> `/mnt/newdata/ainize-runtime/ple_patch`를 본다. 둘이 다르면 패치는 *아무도 보지 않는 우편함*에
> 들어가고, 모델 답은 그대로이며, 라이브 테스트는 "지식이 아무것도 안 바꿨다"처럼 보인다.
> 고치는 법은 [6. 열린 문제](#6-열린-문제)에 있다 — 한 줄 + 노드 재기동.

---

## 1. 무엇이 어디에 있나

세 조각이 각각 다른 방식으로 뜬다 — 하나는 릴리스 디렉터리, 하나는 CLI, 하나는 도커.

| 조각 | 주소 | 사는 곳 | 뜨는 방식 |
|---|---|---|---|
| 웹 (ainize.ai) | `:3900` → nginx | `~/ainize-web-releases/current` | 릴리스 심볼릭 링크 교체 + 프로세스 재시작 |
| 노드 | `0.0.0.0:3402` | `~/.ainize` | `ainize start -d` (전역 CLI) |
| 런타임 base | `127.0.0.1:8000` | 도커 `flashnext` | `docker run` · `restart unless-stopped` |
| 런타임 튜닝본 | `127.0.0.1:8001` | 도커 `flashnext-after` | 같음 · PLE 패치를 적용해 둔 쪽 |
| 에이전트 | `:9200` · `:4010` | 호스트 프로세스 | 노드가 `/agents/<id>`로 프록시 |

> **finance-demo는 두 런타임을 같이 쓴다.**
> `/mnt/newdata/qwen3.8/web/server.py`가 `BEFORE_API=:8000`(원본) / `AFTER_API=:8001`(학습본)을
> 나란히 보여 준다. **`:8001`을 내리면 데모의 절반이 죽는다** — 컨텍스트를 늘리겠다고 이쪽을 건드리지 말 것.
> 늘릴 때는 base(`:8000`)를 더 많은 카드로 옮긴다.

---

## 2. 웹 배포 — ainize.ai

입력은 git ref 하나, 출력은 릴리스 디렉터리 하나. 같은 ref를 두 번 돌리면 같은 사이트가 나온다.

### 2.1 받아 온다

스크립트가 리모트에서 직접 클론하므로 로컬 체크아웃이 배포에 쓰이지는 않지만, 무엇을 올리는지 보려면 맞춰 둔다.

```bash
cd /mnt/newdata/ainize/ainize-web
git pull --ff-only origin main
```

### 2.2 foreground로 배포한다

`| tail`로 감싸면 **tail의 종료 코드가 돌아와 실패가 성공으로 보인다.** 로그는 파일로 받고 종료 코드를 따로 읽는다.

```bash
timeout 900 bash deploy/deploy-web.sh main > /tmp/deploy.log 2>&1; echo "EXIT=$?"
```

커밋 안 된 작업까지 올리려면 `--here` — 릴리스 이름에 `-dirty`가 붙는다.

### 2.3 로그 마지막 네 줄을 읽는다

```
  answering on :3900 (1s)
  https://ainize.ai/ -> 200
Deployed 9fece694…
Release: ~/ainize-web-releases/releases/20260926T030048Z-9fece6947a00
```

두 줄이 다 보여야 한다. `:3900`이 답하는 것과 nginx가 그것을 내보내는 것은 다른 사실이다.

### 2.4 서빙본을 확인한다

```bash
cat ~/ainize-web-releases/current/build-info.json
# {"ref":"main","sha":"9fece69…","dirty":false,"built_at":"…"}
```

`sha`가 안 움직였으면 배포가 안 일어난 것이다.

### 2.5 롤백

```bash
ls -1dt ~/ainize-web-releases/releases/*/ | head
ln -sfn <이전 릴리스> ~/ainize-web-releases/current && systemctl --user restart ainize-web
```

### 함정

- **배포 직후 한 번은 깨져 보일 수 있다.** 릴리스를 교체하는 순간 브라우저가 옛 HTML로 이미 사라진 청크를
  잡으면 `Application error: a client-side exception…`이 뜬다. 새로고침하면 사라진다 — 실제로 겪었고,
  실제 브라우저로 다시 열어 에러 0을 확인했다. **[확인함]**
- **`npm install`이 몇 분 걸린다**(네이티브 모듈 빌드). 백그라운드로 돌리지 말 것 — 떼어 놓으면 조용히 죽은 적이 있다.

---

## 3. 노드

설정 파일 하나(`~/.ainize/config.json`)가 전부다. 노드는 그것을 **기동 시점에** 읽는다.

### 3.1 맞아야 하는 키

| 키 | 지금 값 | 왜 중요한가 |
|---|---|---|
| `port` | `3402` | 공개 주소의 근거 |
| `publicUrl` | `http://192.168.1.41:3402` | 에이전트 카드의 `url`이 이것으로 다시 쓰인다 |
| `runtime.api` | `http://localhost:8000` | 어느 모델에게 물어보는가 |
| `runtime.patchDir` | **미설정 ← 문제** | 지식 패치가 들어갈 우편함. 없으면 `runtime.repo/ple_patch`로 **추측한다** |
| `agents[]` | `donga-desk`, `news-review` | `/agents/<id>`로 공개되는 목록 |

### 3.2 에이전트 등록

```bash
ainize agent add donga-desk --upstream http://127.0.0.1:9200 --name "…"
ainize stop && ainize start -d   # config는 기동 시점에 읽힌다
ainize agent ls
```

에이전트가 지켜야 할 규약 둘. **둘 다 로컬에서는 절대 안 드러난다.** **[확인함]**

1. **업스트림의 루트(`/`)로 오는 POST에 A2A로 답할 것.** 노드는 `/agents/<id>`를 업스트림의 `/`로 프록시한다 —
   클라이언트에게는 에이전트의 베이스 URL이 곧 A2A 엔드포인트이기 때문이다. `/a2a`에만 응답하면
   프록시가 `Cannot POST /`를 받고, 에이전트는 마켓플레이스에서 죽은 것처럼 보인다.
2. **`message.metadata`가 없어도 죽지 않을 것.** A2A 표준에서 선택 항목이라 노드도 워크스페이스도 안 보낼 수 있다.

### 3.3 확인

```bash
ainize status
# runtime   available · Qwen3.8-Flash-Next · hook ok      ← 이 줄이어야 한다
# mailbox   /mnt/newdata/ainize-runtime/ple_patch

curl -s https://ainize.ai/api/agents | python3 -m json.tool | head
```

### 함정 — 우편함은 인스턴스마다 다르다

`runtime.patchDir`을 비워 두면 노드가 `runtime.repo`에서 추측하고, 그 추측이 틀리면 패치는 아무도 안 보는 곳에 쌓인다.
`ainize status`의 `mailbox` 줄에 *"…to be sure it is this instance's"*가 붙어 있으면 **추측 중**이라는 뜻이다.

판별법: `docker inspect <컨테이너>`의 바인드에서 `:/ple_patch`로 끝나는 호스트 경로를 읽어 그대로 `runtime.patchDir`에 넣는다.

---

## 4. 런타임 (vLLM)

컨테이너 하나가 모델 하나를 서빙하고, 자기 우편함 하나를 지킨다.

### 4.1 컨테이너를 다시 만들 때 빠뜨리면 안 되는 것

- `--cap-add SYS_PTRACE --security-opt seccomp=unconfined` — 없으면 PLE 오프로드 워커가 가중치를 다 읽은 뒤
  `pidfd_getfd: Operation not permitted`로 죽는다. **[확인함]**
- `vllm_patch/`의 **세 파일 바인드 마운트**(`worker.py` · `patch_hook.py` · `connector.py`) — 이것이 패치 훅의 구현이다.
- `-v <우편함>:/ple_patch` — **인스턴스마다 다른 디렉터리를 줄 것.** 두 인스턴스가 한 우편함을 공유하면
  패치가 엉뚱한 모델에 실린다.
- `VLLM_PLE_CPU_OFFLOAD=1` — n-gram 테이블을 CPU에 둔다. 디스크 168GB짜리 모델이 GPU에 72GB만 올라가는 이유.
- `--reasoning-parser qwen3 --tool-call-parser qwen3_coder --enable-auto-tool-choice` — 에이전트가 도구를 부르려면 필요하다.

### 4.2 컨텍스트는 플래그가 아니라 메모리다

`--max-model-len 8192`는 임의로 고른 숫자가 아니라 **맞춰 넣은 값**이다. 기동 로그가 직접 말한다.

```
# TP=2 (카드 2장)
Actual usage is 36.05 GiB for consumed memory (weights + non-torch)
Available KV cache memory: 0.2 GiB
GPU KV cache size: 8,192 tokens, Maximum concurrency … 1.00x

# TP=4 (카드 4장 — 같은 가중치를 쪼갠다)
GPU KV cache size: 1,347,774 tokens, Maximum concurrency for 262,144 tokens per request: 5.14x
```

| 구성 | 카드당 가중치 | KV 캐시 | 가능 컨텍스트 |
|---|---|---|---|
| TP=2 | 36.0 GB | 0.2 GB | 8,192 |
| TP=4 | 21.1 GB | ~18 GB/카드 | 262,144 |

- 모델 자체 상한은 **262,144**(`text_config.max_position_embeddings`) — 1M이 아니다.
- **TP=3은 불가.** KV 헤드가 2개라 TP는 2 또는 4여야 한다.
- 같은 체크포인트를 두 컨테이너가 동시에 로딩하면 디스크가 병목이라 샤드당 12초까지 느려진다 — 정상이다.

### 4.3 Qwen3는 기본이 thinking 모델이다

두 줄짜리 답에 254토큰 중 239를 사고에 쓰고 `content: ""`에 `finish_reason: "length"`를 돌려준다.
8k 서버에서는 치명적이라 `chat_template_kwargs: {"enable_thinking": false}`로 끈다. **[확인함]**

---

## 5. 배포 후 점검

복붙 한 덩어리. 이 여섯이 다 통과해야 "배포됨"이다.

```bash
# 1. 웹 — 서빙본이 의도한 커밋인가
cat ~/ainize-web-releases/current/build-info.json

# 2. 웹 — 도메인이 답하는가
curl -s -o /dev/null -w '%{http_code}\n' https://ainize.ai/

# 3. 노드 — 런타임과 우편함
ainize status | head -8

# 4. 노드 — 에이전트가 답하는가
ainize agent ls

# 5. 공개 경로 — 카드가 나오는가
curl -s -o /dev/null -w '%{http_code}\n' \
  https://ainize.ai/agents/donga-desk/.well-known/agent-card.json

# 6. 공개 경로 — A2A가 JSON-RPC로 답하는가 (모델을 쓰지 않는 싼 프로브)
curl -s -X POST https://ainize.ai/agents/donga-desk \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":"probe","method":"tasks/get","params":{"id":"nope"}}'
```

6번이 `{"error":{"code":-32001,"message":"Task not found: nope"}}`를 돌려주면 A2A 경로가 살아 있는 것이다.
**브라우저로 그 주소를 열면 404가 맞다** — POST 전용이다. 사람에게 줄 주소는 카드 쪽(`…/.well-known/agent-card.json`)이다.

---

## 6. 열린 문제

이 문서를 쓰는 시점에 실제로 어긋나 있는 것들. 고치면 지워 주세요.

### 6.1 노드 우편함이 서빙 인스턴스와 다르다 — 치명

노드는 `/mnt/newdata/qwen3.8/ple_patch`, `flashnext` 컨테이너는 `/mnt/newdata/ainize-runtime/ple_patch`.
런타임이 9/25에 새 홈(`ainize-runtime`)으로 옮겨 갔는데 노드 설정이 따라가지 않았다.

같은 훅 프로브를 두 경로로 돌려 확인했다 **[확인함]**:

```bash
cd /mnt/newdata/qwen3.8 && python3 -c "from engram import live; print(live.available())"
# False

ENGRAM_PATCH_DIR=/mnt/newdata/ainize-runtime/ple_patch \
  python3 -c "from engram import live; print(live.available())"
# True
```

**고치는 법** — `~/.ainize/config.json`의 `runtime.patchDir`을 `/mnt/newdata/ainize-runtime/ple_patch`로 두고
`ainize stop && ainize start -d`. 그다음 `ainize status`의 runtime 줄이 `available … hook ok`여야 한다.

### 6.2 base 런타임이 2장 구성으로 되돌아갔다

`flashnext`가 GPU 0,1 · `max_model_len 8192`다. 9/22에 올린 GPU 0·1·4·5 / TP=4 / 262144 구성이 아니다.
의도한 것이면 이 항목을 지우면 된다. 모르고 되돌아간 것이면 256k가 사라진 상태다 —
되돌리려면 [4. 런타임](#4-런타임-vllm)의 주의사항을 그대로 지켜 다시 만든다.

### 6.3 에이전트가 주소를 옮기면 워크스페이스가 404를 가리킨 채 남는다

AIN Teams는 초대 시점의 `a2aUrl`을 저장하는데 그것을 바꾸는 API가 없다(`PATCH`는 이름·참여도만).
재초대는 중복 판정 키가 URL이라 **새 행**을 만들고, 과거 대화가 옛 행에 남아 이름만 같은 유령이 된다.
`news-fitness → news-review` 개명 때는 DB에서 같은 행의 `a2a_url`과 카드를 직접 갱신했다. 제품에 경로가 필요하다.

### 6.4 `ainize status` 헤더가 노드 주소를 `null`로 찍는다

config에 `publicUrl`이 멀쩡히 있는데도 첫 줄이 `node-075cf9 null (pid …)`이고,
안내 문구도 `ainize patch ls --node null`로 나온다. 동작에는 영향이 없어 보이지만 안내가 거짓이다.

---

이 문서는 2026-09-26에 이 기계를 직접 재서 썼다. 값이 바뀌면 여기부터 고쳐 주세요 —
특히 **[설정값]** 표시가 붙은 항목은 실행해 확인한 것이 아니라 파일에서 읽기만 한 것이다.
