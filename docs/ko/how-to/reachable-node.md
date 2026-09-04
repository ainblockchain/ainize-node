---
title: 다른 노드가 찾아올 수 있는 노드 운영하기
summary: 노드가 어떤 인터페이스에 붙는지, 남에게 알려 주는 주소는 무엇인지, 역할은 무엇을 바꾸는지, 그리고 "연결한 적이 없는 것"과 "연결했는데 조용한 것"을 구별하는 법.
source: en/how-to/reachable-node.md
source_sha256: 770b006e74650a7f198169e218f4a1e728567f23c790b6b824abe34560c33343
---

# 다른 노드가 찾아올 수 있는 노드 운영하기

내 컴퓨터에서 응답한다고 해서 네트워크에 들어간 것은 아닙니다. 다른 노드가 이 노드를 찾아오고, 말을 걸고, 일을 맡길 수
있느냐는 세 가지 설정이 결정합니다. 어떤 인터페이스에 붙느냐, 다른 노드에게 어떤 주소를 쓰라고 알려 주느냐, 그리고 어떤
역할을 내걸었느냐입니다. 이 문서는 그 셋을 제대로 맞추는 방법과, 제대로 맞았는지 알려 주는 두 개의 표를 읽는 방법입니다.

`ainize status`에 이미 응답하는 노드가 있다고 보고 시작합니다. 아래 출력은 한 대의 컴퓨터에서 띄운 노드 세 개 — 3634
포트의 판매 노드와 3635·3636 포트의 검증 노드 둘 — 에서 그대로 가져온 것이라 주소가 전부 localhost입니다. 홈 디렉터리
경로만 읽기 좋게 `~/.ngram`으로 줄였고, 그 밖에는 손대지 않았습니다.

## `host`는 붙는 자리, `publicUrl`은 남이 받아 적는 주소

이 둘은 서로 다른 것이고, 이 둘을 헷갈리는 것이 가십(gossip)이 동작하지 않는 가장 흔한 이유입니다.

`host`는 HTTP 서버가 실제로 붙는 인터페이스입니다. 기본값은 `0.0.0.0`, 즉 이 컴퓨터의 모든 인터페이스이고 대개 그대로
두면 됩니다. 일부러 이 컴퓨터 안에서만 쓰고 싶다면 `127.0.0.1`로 바꿉니다.

```bash
ainize config get host
```

```text
0.0.0.0
```

`publicUrl`은 노드가 남에게 알려 주는 주소입니다. 알아서 찾아내는 값이 아니라, 노드가 모두에게 그대로 되풀이해 주는
문자열입니다. 설정하지 않으면 노드는 자기 자신을 `http://localhost:<포트>`라고 소개합니다.

```bash
ainize config get publicUrl
```

```text
publicUrl is not set in ~/.ngram/config.json (the node uses its built-in default)
```

이 문자열 하나가 생각보다 멀리까지 갑니다. 다른 노드에게 자기를 소개할 때 보내는 `endpoint`가 이 값이고, 다른 노드가
"네가 아는 노드를 알려 달라"고 물었을 때 `/p2p/peers`가 맨 앞에 내놓는 것도 이 값이며, 지식을 공개할 때 앵커에 박히는
`gateway_url`도 — 구매자의 [결제](../concepts/payment.md)가 향하는 주소가 이것입니다 — 구매자에게 내려받으라고 알려
주는 `blob_urls`의 첫 항목도 이 값입니다. `publicUrl`이
`http://localhost:3402`인 노드는 네트워크 전체에게 "각자 자기 컴퓨터의 3402 포트로 접속하라"고 말하고 있는 셈입니다.

잘못된 값이 어떤 일을 하는지 보기 위해, 검증 노드 하나에 그 컴퓨터만 아는 호스트 이름을 넣어 봤습니다.

```bash
ainize config set publicUrl http://verifier2.internal:3636
ainize stop && ainize start -d
```

가십 한 바퀴 만에 판매 노드가 그 주소를 받아 적었습니다.

```text
known nodes
NAME           ADDRESS          ENDPOINT                        ROLES     LEDGER  BRANCHES  BLOBS  LAST SEEN
─────────────  ───────────────  ──────────────────────────────  ────────  ──────  ────────  ─────  ───────────────────
seller (self)  0xd87230db…78c9  http://localhost:3634           seller    local   -             0  2026-09-04 11:48:44
verifier1      0x6dEb3Aa0…4d23  http://localhost:3635           verifier  local   -             0  2026-09-04 11:48:42
verifier2      0x99b6B478…d4C7  http://verifier2.internal:3636  verifier  local   -             0  2026-09-04 11:48:41
```

그리고 곧바로 남에게 넘겨 주었습니다. 그 호스트 이름을 역시 모르는 세 번째 노드가 판매 노드에게서 그 주소를 배워 와
실패를 쌓기 시작합니다.

```text
ENDPOINT                        ADDRESS          LAST SEEN            FAILURES
──────────────────────────────  ───────────────  ───────────────────  ────────
http://verifier2.internal:3636  0x99b6B478…d4C7  2026-09-04 11:49:25         1
```

그동안 노드 자체는 멀쩡했습니다. 틀린 것은 노드가 알린 주소뿐이고, 틀린 주소는 맞는 주소와 똑같이 잘 퍼집니다.

> [!WARNING]
> `publicUrl`은 **무엇이든 공개하기 전에** 정해 두십시오. 이 주소는 지식을 공개하는 순간 앵커의 `gateway_url`로 복사되고,
> 원장에 올라간 앵커는 고칠 수 없습니다. 나중에 `publicUrl`을 바꿔도 이미 공개한 지식은 계속 옛 주소로 구매자를 보냅니다.

다른 컴퓨터가 실제로 쓸 주소로 정하고, 노드를 다시 띄운 뒤, 공개하는 지식의 `gateway` 줄을 확인하십시오.

```bash
ainize config set publicUrl https://ainize.example.com
ainize stop && ainize start -d
```

`config.json`을 건드리지 않고 한 번만 바꾸고 싶다면 환경 변수 `NGRAM_PUBLIC_URL`이 같은 일을 합니다. 컨테이너에서
유용합니다. 둘 다 [설정 레퍼런스](../reference/config.md#keys)에 있습니다.

## 이웃은 하나만 알려 주면 됩니다

네트워크 전체를 적어 줄 필요는 없습니다. 노드는 자기가 아는 이웃에게 자기를 소개하고, 그 이웃에게 "너는 누구를 아느냐"고
물어서 답을 자기 목록에 더합니다. 처음 하나를 알려 주는 자리는 세 군데이고, 남는 방식이 서로 다릅니다.

| 어디에서 | 하는 일 | 다시 띄워도 남는가 |
|---|---|---|
| `ainize init --peer <주소>` | 노드가 생기기 전에 `config.json`에 적어 둡니다 | 예 |
| `ainize start --peer <주소>` | 이번에 띄우는 동안에만 더합니다 | 아니요 |
| `ainize peers add <주소>` | 돌고 있는 노드에 더하고 `config.json`에도 적습니다 | 예 |

한쪽만 알려 줘도 됩니다. 아래에서는 검증 노드 둘에게만 판매 노드를 알려 주었습니다.

```bash
ainize start -d --peer http://localhost:3634
```

```text
✓ node started in the background (pid 663842) — port 3635
  logs: ~/.ngram/node.log   stop: ainize stop
```

판매 노드에게는 아무도 알려 주지 않았지만 몇 초 만에 둘 다 알게 됩니다. 인사를 받은 노드가, 인사한 노드가 스스로 밝힌
주소로 그 노드를 적어 두기 때문입니다.

```text
configured peers
ENDPOINT               ADDRESS          LAST SEEN            FAILURES
─────────────────────  ───────────────  ───────────────────  ────────
http://localhost:3635  0x6dEb3Aa0…4d23  2026-09-04 11:47:58         0
http://localhost:3636  0x99b6B478…d4C7  2026-09-04 11:47:57         0
```

같은 구조 때문에 잘못 적은 주소는 비쌉니다. 내가 더한 주소는 물어보는 모든 이웃에게 건네지고, 그 이웃이 또 건넵니다.
만료되는 일도 없고, 다른 노드가 아직 그 주소를 퍼뜨리는 동안에는 내 쪽에서 `ainize peers rm`을 해도 곧 되돌아옵니다.
확인한 주소만 더하십시오.

## "연결한 적이 없다"와 "연결했는데 조용하다"를 가르기

`ainize nodes`는 표를 두 개 찍고, 진단은 그 둘의 차이에 다 들어 있습니다. **known nodes**는 이 노드가 알게 된 노드
전부입니다. 이웃과 직접 주고받았거나, 원장에 올라온 등록 기록으로 알게 된 노드가 마지막으로 보인 시각과 함께 나옵니다.
**configured peers**는 응답이 있었든 없었든 이 노드가 계속 두드리고 있는 주소 전부입니다.

```bash
ainize nodes
```

```text
known nodes
NAME           ADDRESS          ENDPOINT               ROLES     LEDGER  BRANCHES  BLOBS  LAST SEEN
─────────────  ───────────────  ─────────────────────  ────────  ──────  ────────  ─────  ───────────────────
seller (self)  0xd87230db…78c9  http://localhost:3634  seller    local   -             0  2026-09-04 11:47:58
verifier1      0x6dEb3Aa0…4d23  http://localhost:3635  verifier  local   -             0  2026-09-04 11:47:58
verifier2      0x99b6B478…d4C7  http://localhost:3636  verifier  local   -             0  2026-09-04 11:47:57

configured peers
ENDPOINT               ADDRESS          LAST SEEN            FAILURES
─────────────────────  ───────────────  ───────────────────  ────────
http://localhost:3635  0x6dEb3Aa0…4d23  2026-09-04 11:47:58         0
http://localhost:3636  0x99b6B478…d4C7  2026-09-04 11:47:57         0
http://localhost:3699  -                -                          10
```

이렇게 읽습니다.

- **configured peers가 통째로 비어 있다** — 아무도 알려 주지 않았고, 이 노드에게 인사한 노드도 없습니다. 이웃을 하나
  알려 주십시오.
- **주소가 채워져 있고 LAST SEEN이 최근이다** — 그 이웃과는 닿아 있고 기록도 오가고 있습니다.
- **둘 다 `-`인데 FAILURES만 올라간다** — 주소는 설정돼 있는데 그 자리에 아무것도 없습니다. 위의
  `http://localhost:3699`가 그 경우로, 손으로 더했지만 처음부터 존재한 적이 없는 이웃입니다. 가십이 한 바퀴 돌 때마다
  1씩 올라가고, 이 숫자를 지워 주는 것은 아무것도 없습니다.
- **configured peers에는 있는데 known nodes에는 없다** — 그 노드로서 응답하지 않는 주소를 두드리고 있다는 뜻입니다.
  `publicUrl`이 잘못됐을 때 나타나는 모양입니다.

known nodes에서 줄이 사라지는 일은 없습니다. 원장에 한 번 등록한 노드는 계속 목록에 남습니다. 그 노드가 떠났다는 것을
알려 주는 것은 LAST SEEN이 다른 줄보다 뒤처지는 것뿐입니다.

`ainize peers ls`는 같은 이웃 목록만 따로 보여 주면서, 한 번도 응답한 적 없는 상대에 이름 대신 `(unreached)`를 씁니다.

```text
ENDPOINT                        NAME         ADDRESS          ROLES     LAST SEEN            FAILURES
──────────────────────────────  ───────────  ───────────────  ────────  ───────────────────  ────────
http://localhost:3635           verifier1    0x6dEb3Aa0…4d23  verifier  2026-09-04 11:56:26         0
http://localhost:3699           (unreached)  -                -         -                          99
```

> [!NOTE]
> FAILURES는 이 노드가 스스로 걸어 본 횟수만 셉니다. 그 이웃에게서 인사가 한 번 오면 0으로 되돌아갑니다. 그래서 나에게
> 걸어오기는 하는데 내가 걸면 받지 않는 노드는 이 칸에서 멀쩡해 보입니다. 헷갈릴 때는 known nodes 표를 믿으십시오. 그
> 표는 끝까지 성공한 주고받기로만 만들어집니다.

## 역할은 무엇을 바꾸는가

`roles`는 `seller,verifier,serving,gateway` 중에서 고르는 목록이고 `init`은 앞의 셋을 적어 둡니다. 이 중 어떤 것이 노드의
동작을 실제로 바꾸는지 알아 두는 편이 좋습니다. 둘은 스위치이고 둘은 선언이기 때문입니다.

| 역할 | 노드가 이 값으로 하는 일 |
|---|---|
| `verifier` | 검증 루프를 켭니다. 남의 지식에 검증 기록을 쓰는 것이 이 루프입니다. 이 역할이 없으면 `ainize patch verify`는 거부합니다. 다른 노드도 이 값을 봅니다. `verifier`를 내건 노드는 사지 않은 지식 파일도 내려받을 수 있습니다. 불러오지 못하는 것을 검증할 수는 없기 때문입니다. |
| `serving` | 지식을 넣을 모델이 이 노드에 있다는 선언입니다. 이 값 때문에 `/readyz`가 살아 있는 런타임을 요구합니다. |
| `seller` | 이웃에게 알려지고 `ainize nodes`에 찍힙니다. 노드 안에서 이 값을 읽는 코드는 없습니다. |
| `gateway` | 알려지기만 합니다. 지금 빌드에서 이 값을 읽는 코드는 없습니다. |

여기서 계획에 반영해야 할 결론은 `verifier`와 `serving` **둘 다** 런타임을 준비 조건으로 만든다는 것입니다. `serving`만
빼서는 조건이 사라지지 않습니다. 아래 노드는 셋을 다 갖고 있었고 모델 서버는 없었습니다.

```bash
ainize status --check
```

```text
✗ seller  http://localhost:3634  NOT READY
ledger   ok · local · height 1
runtime  serving API unreachable
peers    0 configured
```

같은 노드의 `roles`를 `seller` 하나로 줄이면 이렇게 됩니다.

```bash
ainize config set roles seller
ainize stop && ainize start -d
ainize status --check
```

```text
✓ seller  http://localhost:3634
ledger   ok · local · height 2
runtime  not required by this node's roles
peers    0 configured
```

즉 GPU가 없는 컴퓨터도 아무 문제 없이 판매 노드가 됩니다. `serving`과 `verifier`를 뺀 대가는 모델이 필요한 일 전부입니다.
지식을 라이브 테스트할 수 없고, 남의 지식을 검증할 수도 없습니다. 검증할 수 없다는 것은 지식이 목록에 오르는 데 필요한
[정족수](../concepts/verification.md)에 아무것도 보태지 못한다는 뜻이고, 그 지식에는 내가 공개한 것도 포함됩니다.

> [!IMPORTANT]
> 역할은 권한이 아니라 주장입니다. 실제로 하고 있는 일만 내거십시오. 이웃은 이 목록을 어느 정도 근거로 이 노드에게 무엇을
> 건넬지 정합니다.

## 백그라운드로 띄우고 지켜보기

`ainize start -d`는 노드를 백그라운드로 띄우고, 프로세스 번호를 `NGRAM_HOME/node.pid`에, 노드가 찍는 모든 것을
`NGRAM_HOME/node.log`에 남깁니다. 자식 프로세스가 실제로 응답할 때까지 기다렸다가 성공을 알리므로, 초록색 체크가 떴다면
정말로 듣고 있다는 뜻입니다.

```bash
ainize start -d
```

```text
✓ node started in the background (pid 668391) — port 3634
  logs: ~/.ngram/node.log   stop: ainize stop
```

`ainize stop`은 그 pid 파일을 읽어 SIGTERM을 보내고, 기다렸다가, 필요하면 SIGKILL까지 갑니다. pid 파일은 없는데 포트에서
무언가가 계속 응답하고 있다면, 그 사실을 숨기지 않고 알려 줍니다.

네트워크 쪽만 보고 싶다면 이벤트 로그를 종류로 거릅니다.

```bash
ainize logs --kind p2p --limit 10
```

```text
2026-09-04 11:47:42 info  node      node started (local ledger, roles verifier)
2026-09-04 11:47:42 info  p2p       synced 2 record(s) from seller (http://localhost:3634)
2026-09-04 11:47:46 info  p2p       synced 1 record(s) from seller (http://localhost:3634)
```

계속 따라가려면 `-f`를 붙입니다. 아무것도 안 나오는 것도 정보입니다. 이웃과 붙어 있지만 주고받을 새 기록이 없는 노드는
할 말이 없습니다.

모니터링 도구나 배포 스크립트에 넣을 한 줄은 `ainize status --check`입니다. 노드 자신의 `/readyz`에 물어 검사 세 개를 찍고
종료 코드를 정합니다. **0**은 준비됨, **1**은 응답은 하지만 준비되지 않음, **2**는 아예 응답이 없음입니다.

```bash
ainize status --check
```

```text
✗ seller  http://localhost:3634  NOT READY
ledger   ok · local · height 21
runtime  serving API unreachable
peers    4 configured · 2 unreachable
```

`--json`을 붙이면 스크립트가 읽을 수 있는 모양으로 같은 검사 세 개가 나옵니다.

```bash
ainize status --check --json
```

```json
{
  "ok": false,
  "node": "seller",
  "address": "0xd87230db2F21b5f5b998255A0DA0015f377878c9",
  "version": "0.1.0",
  "checks": {
    "ledger": { "ok": true, "kind": "local", "height": 21, "records": 21 },
    "runtime": { "ok": false, "required": true, "available": false, "model": null, "error": "serving API unreachable" },
    "peers": { "ok": true, "configured": 4, "unreachable": 2 }
  }
}
```

이웃 검사는 노드를 실패로 만들지 않습니다. 닿지 않는 이웃은 보고될 뿐 치명적이지 않습니다. 이웃이 하나도 없는 노드도
준비된 노드입니다. 이미 갖고 있는 것은 그대로 다 내줄 수 있기 때문입니다. 불을 빨간색으로 바꾸는 것은 원장과 런타임뿐입니다.

모니터링을 `/healthz`에 걸지 마십시오. 프로세스가 살아 있기만 하면 모델 서버가 있든 없든 200을 돌려줍니다. 모니터링 도구가
흔히 찍어 보는 다른 이름들 — `/health`, `/ready`, `/status`, `/metrics` — 은 일부러 404를 돌려줍니다. 웹 화면의 HTML이
초록불로 읽히는 일을 막기 위해서입니다.
