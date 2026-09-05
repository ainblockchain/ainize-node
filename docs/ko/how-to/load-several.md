---
title: 지식 여러 개를 한꺼번에 올리기
summary: 스택의 순서가 무슨 뜻인지, 두 지식이 겹칠 때 누가 이기는지, 내릴 때 무엇이 돌아오는지, 그리고 돈을 쓰기 전에 이 모두를 어떻게 보는지.
source: en/how-to/load-several.md
source_sha256: 61b62697402f016f027fade563a260192be62a034c7689ccb0282f1894294625
---

# 지식 여러 개를 한꺼번에 올리기

서비스 중인 모델은 **스택**을 들고 있습니다. 메모리 테이블에 하나씩 위로 쌓아 올린 지식들입니다. 여기에 암묵적인
것은 없습니다 — 순서는 내가 올린 순서이고, 겹치는 부분은 아무것도 올리기 전에 볼 수 있으며, 내릴 때 돌아오는 것은
추측이 아니라 저널입니다.

## 규칙

**호출의 순서가 스택의 순서이고, 두 지식이 공유하는 메모리 항목에서는 나중에 쓴 쪽이 이깁니다.** 아래 내용은 전부
이 한 문장에서 따라 나옵니다.

```bash
ainize patch apply krx-all-2761 pixelplus-087600
# loaded in order: krx-all-2761 → pixelplus-087600  (the last one wins on any memory entry they share)
```

`use`, `patch buy`, `patch apply`, `patch remove`에서 `a b`와 `a,b`는 같은 뜻이고, 한 질문에 대해서는
`ainize chat --patch a,b`가 같은 방식으로 최대 세 개까지 함께 올립니다.

## 겹침을 먼저 보기

같은 주제의 지식 둘은 보통 메모리 항목을 공유하고, 위에 있는 쪽이 그 답을 결정합니다.

```bash
ainize patch conflicts krx-all-2761      # 어떤 지식이 항목을 공유하는지, 몇 개나
ainize patch stack                       # 지금 무엇이 올라가 있는지, 아래에서부터
```

`ainize chat --list`는 함께 올라간 지식들에 대해 같은 내용을 출력하고 —
`loaded together and overlapping: a ∩ b = 2,170 entries (the one loaded later wins on them)` — 갖고만 있고 올리지
않은 겹치는 쌍은 개수만 셉니다. 올라가 있지 않은 겹침은 아무것도 결정하지 않기 때문입니다.

## 내리면 무엇이 돌아오는가

올릴 때 덮어쓴 행들의 저널이 함께 기록됩니다. 내릴 때는 그 저널을 되돌려 재생하므로, 아래에 있던 것이 있던 그대로
돌아옵니다.

```bash
ainize patch remove pixelplus-087600     # krx-all-2761은 손대지 않은 채 그대로 올라가 있습니다
```

두 가지는 알아 둘 만합니다.

- 저널이 생기기 전에 공개된 지식에는 저널이 없습니다. 그런 지식을 내리면 아래 층이 아니라 **모델 자신의** 행이
  다시 써집니다. `ainize patch stack`이 각 층이 어느 쪽인지 알려 줍니다 — "아래를 건드리지 않고 내릴 수 있음",
  또는 "저널 없음".
- 위에 다른 지식이 올라가 있는 것은 내릴 수 없습니다(`has_dependents`). 위에 있는 지식은 아래 행들을 전제로
  검증되었기 때문입니다. `--cascade`가 둘을 함께 내립니다.

## 애드온은 기반이 밑에 있어야 합니다

다른 지식 **위에** 가르친 지식([남의 지식 위에 얹어 만들기](./build-on-knowledge.md) 참고)은 델타입니다. 그 기반이
밑에 올라가 있을 때만 의미가 있고, 노드는 틀린 답을 내놓는 대신 이것을 강제합니다.

```bash
ainize patch apply child-2761            # 거부: needs_base — krx-all-2761이 올라가 있지 않습니다
ainize patch apply child-2761 --with-base  # 조상부터 순서대로 전체 사슬을 올립니다
ainize use child-2761                    # 가족 전체 가격을 제시하고, 없는 것을 사고, 사슬을 올립니다
```

`ainize patch buy <id> --bundle`은 그 지식이 밑에 필요로 하는 기반들을 깊은 것부터 하나씩 결제하며 삽니다. 이 옵션이
없으면 물어보고, 그 파일이 혼자서 무엇에 답하고 무엇에 답하지 못하는지 알려 줍니다.

## 트랙은 이미 있는 것 위에 올라갑니다

`ainize branch subscribe <track>`은 트랙의 현재 지식을 사서 이미 올라가 있는 것 **위에** 올리고, 그 뒤로 트랙이
더하는 것을 사서 올리고 트랙이 물린 판본을 내립니다. 구독이 직접 올린 것만 구독이 내립니다 — 손으로 올린 것은
그대로 밑에 남습니다.

## 스크립트에서

위 동사들은 `--json`에서 명령당 문서 하나를 씁니다. 여러 id를 준 실행도 마찬가지입니다.

```bash
ainize --json patch apply krx-all-2761 pixelplus-087600
# {"ids":["krx-all-2761","pixelplus-087600"],"items":[{"patch_id":"…","kind":"apply","result":"…"}, …]}

ainize --quiet use krx-all-2761          # 영향을 준 id만 출력합니다
```

종료 코드는 `ainize --help`에 있습니다. `5`가 공유 모델을 다른 무언가가 잡고 있다는 뜻입니다.

## 다음

- [남이 공개한 지식 사서 쓰기](../tutorials/buy-and-apply.md) — 지식 하나에 대한 전체 경로.
- [남의 지식 위에 얹어 만들기](./build-on-knowledge.md) — 애드온이 어디에서 오는지.
