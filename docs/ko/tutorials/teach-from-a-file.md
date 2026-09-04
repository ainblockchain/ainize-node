---
title: 질문 파일로 가르치기
summary: 질문과 답이 담긴 파일 하나가 모델이 아는 지식이 되기까지 — 줄 단위 검사, 학습, 그리고 공개 가능 여부를 결정하는 확인 결과 읽기.
source: en/tutorials/teach-from-a-file.md
source_sha256: 26d17953e5255ed585a4aee2cc1c97e6cac61781624b4dd4dfe9d8d4ff542e2e
---

# 질문 파일로 가르치기

모델이 틀리는 것들의 목록이 이미 손에 있습니다. 제품 코드가 적힌 스프레드시트, 상담 도구에서 내보낸 파일, 아무도 읽지
않는 사내 안내서 같은 것들입니다. 이 튜토리얼은 그런 파일 하나를 **수업**까지 데려갑니다. 수업은 내 질문으로 학습해서
실제 모델에서 측정까지 마친 지식 파일이고, 나만 쓸 수도 있고 팔 수도 있습니다.

여기는 가르치기 모드의 파일 창구입니다. 브라우저에서 틀린 답을 하나씩 바로잡는 다른 창구도 있고, 뒤에서 도는 파이프라인은
같지만 경험은 꽤 다릅니다. 그쪽은 [모델을 바로잡으며 가르치기](./teach-in-chat.md)입니다.

이 문서를 끝까지 따라오면 데이터셋을 올리고, 노드가 줄 단위로 내린 판정을 읽고, 거부된 줄을 고치고, 나머지로 수업을
학습시키고, 그 수업을 공개할 수 있는지를 결정하는 단 하나의 값이 무엇인지 알게 됩니다.

## 시작하기 전에

**다시 시작할 수 있는 노드.** 여기의 모든 것은 노드 하나를 상대로 돌아가고, 첫 단계에서 바꾸는 설정은 노드가 시작할 때만
읽는 값입니다. 아직 노드가 없다면 [설치](../get-started/install.md)부터 보세요.

**그 노드 뒤의 모델.** 가르치기는 글자를 바꾸는 일이 아닙니다. 노드는 학습 전에 실제 모델에게 내 질문을 던져 보고(이미
맞히는 것은 빼기 위해서), 나머지를 학습시킨 뒤, 다시 물어서 무엇이 달라졌고 무엇이 함께 흔들렸는지 봅니다. 모델 서버가
꺼진 노드도 파일을 받아 검사까지는 합니다 — [5단계](#5-올리고-노드가-학습하지-않을-줄을-읽기)까지는 그대로 됩니다 —
하지만 학습은 못 합니다. 노드는 그 사실을 한 줄로 말해 주고, 그 줄을 읽는 곳이 [2단계](#2-노드의-가르치기-정책-읽기)입니다.

**한 줄에 질문 하나와 답 하나가 담긴 파일.** 받는 형식은 다섯 가지입니다. `.jsonl`, `.json`, `.csv`, `.tsv`, `.txt`.
스프레드시트에서 내보낼 수 있는 것이면 대체로 됩니다.

> [!NOTE]
> 가르치기는 노드 운영자에게 공짜가 아닙니다. 수업은 학습용 GPU를 차지하고, 학습이 도는 동안 질문은 운영자의 컴퓨터에
> 저장됩니다. 2단계의 한도가 있는 이유이고, 공개 노드가 `teach.publish: review`로 두고 모든 수업을 사람이 먼저 읽는
> 이유이기도 합니다.

## 1. 가르치기 모드 켜기

가르치기 모드는 **기본값이 꺼짐**입니다. 아무 설정도 하지 않은 노드는 수업을 하나도 받지 않습니다.

```bash
ainize teach status
```

```text
Teaching on my-node  not accepting lessons  http://localhost:3618
```

설정 키 하나로 켭니다.

```bash
ainize config set teach.enabled true
```

```text
✓ teach.enabled = true  (the node reads config.json when it starts)
! the node in /tmp/ainize-tut/my-node is running (pid 675585) and keeps using the value it started with — restart it to apply this (`ainize stop` then `ainize start -d`)
```

두 번째 줄이 사람들이 놓치는 부분입니다. `config set`은 `config.json`에 쓰고, 이미 돌고 있는 프로세스는 시작할 때 읽은
값을 그대로 씁니다. 시키는 대로 다시 시작합니다.

```bash
ainize stop && ainize start -d
```

```text
✓ stopped node (pid 675585)
✓ node started in the background (pid 675775) — port 3618
  logs: /tmp/ainize-tut/my-node/node.log   stop: ainize stop
```

내가 노드를 운영한다면 다시 시작하지 않는 길도 있습니다. 노드 사이트에 로그인해서 **내 지식 → 가르치기**를 열면 같은
설정이 거기 있고, 저장하면 바로 적용됩니다.

## 2. 노드의 가르치기 정책 읽기

`ainize teach status`를 인자 없이 부르면 지금 가리키고 있는 노드의 정책이 나옵니다. 파일에 시간을 쓰기 전에 먼저 읽으세요.
이 중 네 줄이 여러분을 멈춰 세울 수 있습니다.

```bash
ainize teach status
```

```text
Teaching on my-node  accepting lessons  http://localhost:3618
trainer               paused — runtime repo is not configured on this node · backend gradient
publish               review — the operator approves each lesson first
queue                 0 / 10 lessons · 0 / 2000 questions waiting
typical lesson        no measurement yet (0 of 3 lessons measured)
limits                8 questions per lesson (default) · 3 lessons per key and 5 per IP a day · prompt ≤ 400 / answer ≤ 200 chars
datasets              up to 2,000 questions per file · files ≤ 3.8 MB · jsonl json csv tsv txt · 10 uploads and 300 trained questions per key a day · kept 7 days
effort                quick (8 passes) · balanced (20 passes) · thorough (40 passes)
data-provider share   70 % of the node's share of each sale (lineage pool 30 %)
model                 model server off
always loaded         nothing pinned
unsaved lessons kept  7 days

teach from a file:  ainize teach dataset ./questions.csv --train      (or http://localhost:3618/teach/upload)
teach in chat:      http://localhost:3618/chat?teach=1
```

**`trainer`** 가 진행 여부를 가르는 줄입니다. `ready`면 지금 넣은 수업이 학습을 시작합니다. `busy`면 학습용 GPU가 차 있어
내 수업은 기다립니다. `paused`면 아예 시작하지 않고, 그 줄의 뒤쪽이 이유를 말합니다. 위 노드는 모델이 붙어 있지 않은
기계의 정직한 모습입니다. 파일 검사는 해 주고 학습은 거절합니다.

**`publish`** 는 내가 공개하기로 한 수업이 어떻게 되는지입니다. `review`는 운영자가 먼저 검토하고, `auto`는 곧바로
네트워크에 알리며, `never`는 이 노드가 수업을 학습만 하고 아무것도 공개하지 않는다는 뜻입니다(대신 파일을 받아 갑니다).
학습 자체에는 영향이 없고 마지막 단계에만 관여합니다.

**`limits`** 와 **`datasets`** 는 서로 다른 두 예산이고, 둘 다 가르치기 키별·하루 단위입니다. 앞의 것은 수업을 다스리고
(한 수업이 학습할 수 있는 질문 수, 키와 IP별 하루 수업 수, 질문과 답의 최대 길이), 뒤의 것은 파일을 다스립니다(크기, 줄
수, 업로드 횟수, 질문을 며칠 보관하는지). 여기 있는 숫자 중 전역 상수는 하나도 없습니다. 전부 이 노드의 값이고, 다른
노드는 다른 숫자를 찍습니다.

**`effort`** 는 학습할 때 고를 수 있는 세 가지 설정이고, 각각이 실제로 무엇인지 함께 찍힙니다. 내 질문을 몇 번 반복해서
훑는가입니다. 다른 조절 장치는 없습니다.

## 3. 파일 만들기

파서가 한 줄에서 찾는 것은 두 가지, 질문과 그 답입니다. 열 이름으로 찾고, 사람들이 실제로 쓰는 이름을 받아들입니다.
질문 쪽은 `prompt`, `question`, `q`, `input`, `instruction`, `query`, `질문`, `문제`, `입력`이고, 답 쪽은 `answer`,
`a`, `output`, `response`, `completion`, `target`, `답`, `답변`, `정답`, `출력`입니다. 선택 열 두 개도 같은 방식으로
읽습니다. `alt_prompt`(`paraphrase`, `다른질문` — 같은 질문의 다른 표현으로, 모델이 문장이 아니라 사실을 배웠는지
확인하는 데 씁니다)와 `note`(`memo`, `source`, `비고`)입니다.

이 튜토리얼이 쓰는 파일입니다. 일부러 흠이 있는 파일인데, 이 단계의 재미있는 절반이 노드가 나쁜 줄을 어떻게 다루느냐이기
때문입니다.

```csv
question,answer
Which meeting room has the video wall?,"Sonora, on the 4th floor"
Who approves an expense over 500 USD?,"Your team lead first, then Finance"
What is the guest wifi network called?,AsterGuest
How long is the laptop refresh cycle?,Three years
Which meeting room has the video wall?,"Kepler, on the 2nd floor"
Who approves an expense over 500 USD?,"Your team lead first, then Finance"
When does the office open?,
"Which of the meeting rooms on the fourth floor of the Seoul office is the one with the video wall along the north side, the room we normally book for customer demos and for the Monday all-hands when the other offices dial in as well, and what is that room called on the booking system everybody has had to use since the move last spring, and who do I ask about it when the room is already taken by another team?",Sonora
Where do I file a hardware fault?,"On the IT desk board in the wiki, under Hardware"
```

파일이 이렇게 생기지 않았을 때 — 열 이름이 다르거나, 구분자가 세미콜론이거나, 첫 줄부터 데이터거나, 오래된
스프레드시트에서 나온 CP949 텍스트일 때 — 파일을 고쳐 쓰는 대신 그렇다고 말해 주면 됩니다.

| 옵션 | 언제 쓰나 |
|---|---|
| `--columns '{"prompt":"질문","answer":"답"}'` | 열을 직접 지정합니다. 값은 헤더 이름이거나 0부터 세는 열 번호입니다. |
| `--delimiter ';'` | 구분자 자동 추정이 틀렸을 때. |
| `--no-header` | 첫 줄이 헤더가 아니라 이미 질문일 때. |
| `--encoding euc-kr` | 미리 보기가 깨져 보일 때 인코딩을 못 박습니다. |
| `--format csv` | 확장자가 말하는 형식을 덮어씁니다. |

인코딩은 한 문장 더 쓸 값이 있습니다. 노드는 인코딩을 스스로 판단하고(BOM, 그다음 UTF-8, 그다음 CP949/EUC-KR, 그다음
latin1) 무엇으로 읽었는지 찍습니다. 짧은 CP949 파일은 유효한 UTF-8로도 읽혀서, 다른 검사는 다 통과하는 그럴듯한 깨진
글자가 됩니다. 보고서에 찍힌 질문이 이상해 보이면 `--encoding`이 답입니다.

## 4. 가르치기 키를 만들기 전에 그것이 무엇인지 알아 두기

가르치기 요청에는 전부 서명이 붙습니다. 계정도 로그인도 없습니다. **가르치기 키**가 곧 신원이고, 그 키를 가진 사람이
수업과 그 수업이 벌어들이는 돈의 주인입니다. CLI는 처음 필요할 때 키를 하나 만들고 어디에 두었는지 알려 줍니다.

```text
! new teaching key 0x99a0A17380cBEA9F495920687f9Ee05066e3835e — kept in /tmp/ainize-tut/my-node/teaching-key.json. Back it up: it is the only way back to these lessons and their earnings.
```

> [!WARNING]
> 그 파일이 유일한 사본입니다. 잃어버리면 그 키로 서명한 수업들은 노드에 남은 채 영영 닿을 수 없게 됩니다. 운영자도,
> 지원 창구도, 어떤 노드도 돌려줄 수 없습니다. 그것이 내 것이었다는 사실을 아는 곳이 어디에도 없기 때문입니다.
> 다음 명령이 키를 만들기 전에, `<home>/teaching-key.json`을 안전한 곳에 복사해 두세요.

이미 키가 있다면 — 브라우저가 내려받아 준 백업이든, 다른 컴퓨터에 있던 것이든 —
`--key-file ainize-teaching-key-….json`이나 `--key <64자리 16진수>`, 또는 환경 변수 `NGRAM_TEACH_KEY`로 넘깁니다.
`teach` 명령은 전부 이 셋을 받습니다.

## 5. 올리고, 노드가 학습하지 않을 줄을 읽기

```bash
ainize teach dataset upload ./handbook.csv --name "Aster handbook"
```

```text
Aster handbook  http://localhost:3618
dataset             a5576109-2d22-4e3f-ba27-0a464c589b06
questions           4 kept · 5 lines not used
fingerprint         d2c10179c5aceb80…  (revision 1)
where it came from  a file you uploaded — handbook.csv · csv · separator "," · header row · utf-8
size                352 B (uploaded 942 B)
state               never trained yet
kept                until 2026-09-11 11:57:29

✓ uploaded handbook.csv (942 B)
4 of 9 lines will train · not used: 1 duplicate, 2 contradicting, 1 too long, 1 empty

lines that will not train
LINE  STATUS     QUESTION                              WHY
────  ─────────  ────────────────────────────────────  ─────────────────────────────────────────────────────
   2  conflict   Which meeting room has the video wal  line 6 asks the same question with a different answer
   6  conflict   Which meeting room has the video wal  line 2 asks the same question with a different answer
   7  duplicate  Who approves an expense over 500 USD  the same question and answer as line 3
   8  empty      When does the office open?            this question has no answer
   9  too_long   Which of the meeting rooms on the fo  the question is 411 characters, 11 over the 400 limit

train it:      ainize teach train a5576109-2d22-4e3f-ba27-0a464c589b06 --effort balanced
see it:        ainize teach dataset get a5576109-2d22-4e3f-ba27-0a464c589b06 -o questions.jsonl
```

아직 아무것도 학습하지 않았습니다. 노드는 바이트를 읽고, 무엇을 쓸 수 있는지 정하고, 그 결과를 **데이터셋**으로
보관했습니다. 아이디와 지문, 그리고 받아들인 질문들입니다. 학습은 7단계에서 따로 내리는 결정입니다.

표는 한 줄씩 읽으세요. 학습되지 않을 줄이 전부, 원본 파일의 줄 번호와 함께 들어 있습니다.

**`conflict` — 한 질문에 답이 둘.** 2번과 6번 줄은 같은 회의실을 묻고 서로 다르게 답합니다. 둘 중 하나가 아니라 **둘 다**
거부됩니다. 어느 쪽이 참인지 노드는 알 수 없고, 모순을 학습시키는 것은 모델에게 아무것도 가르치지 않는 확실한 방법이기
때문입니다. 맞는 답을 정하고 다른 쪽을 지우세요. 일부러 쓴 줄을 거부하는 유일한 상태이자, 대개 손을 대야 하는 상태입니다.

**`duplicate` — 같은 질문에 같은 답이 두 번.** 7번 줄은 3번 줄과 완전히 같습니다. 먼저 나온 것이 학습되고 뒤의 사본은
버려지며, 잃는 것은 없습니다. 중복이 가득한 내보내기 파일은 흔합니다. 이 줄들은 그냥 두어도 됩니다.

**`empty` — 답 없는 질문, 또는 질문 없는 답.** 8번 줄은 질문은 있고 답 칸이 비었습니다. 가르칠 것이 없습니다.

**`too_long` — 이 노드의 한도를 넘음.** 얼마나 넘었는지까지 말해 줍니다. 400자 한도에 411자입니다. 이 한도가 2단계의
`prompt ≤ 400 / answer ≤ 200`입니다. 긴 답은 대개 사실 여러 개가 한 문장을 뒤집어쓴 것입니다. 여러 줄로 쪼개면 전부
학습됩니다.

이 파일에서는 나오지 않은 상태가 셋 더 있습니다.

**`blocked`** — 운영자가 막아 둔 주제 패턴에 내 줄이 걸렸습니다. 그의 기계이고 그의 방침이니, 이 노드에서는 학습되지
않습니다.

**`over_cap`** — 쓸 수 있는 질문이 이 노드가 데이터셋 하나에 보관하는 수(위 노드는 `2,000`)를 넘었습니다. 한도까지는
학습되고 나머지는 줄 단위로 보고되니, 파일을 나눠서 나머지를 올리면 됩니다.

**`not_parsed`** — 그 줄을 아예 한 행으로 읽지 못했습니다. 깨진 JSON이거나, 헤더와 열 개수가 맞지 않는 줄입니다. 보고서에
원문이 함께 나오므로 대개 무슨 일인지 바로 보입니다.

거부가 아닌 상태도 둘 있습니다. `fixed`로 표시된 줄은 **학습됩니다.** 다만 먼저 정리됩니다. 연속된 공백을 하나로 줄이고,
여러 줄인 답을 한 줄로 펴고, 앞에 붙은 `Q:`를 떼고, 제어 문자를 걷어냅니다. 요약이 이것을 *tidied up*으로 세어 주므로,
노드가 저장 전에 무언가를 바꿨다는 사실이 보입니다.

`pii`로 표시된 줄도 학습되고, 대신 그 줄을 빼기 전까지는 이 학습 데이터를 `private` 위로 공유할 수 없게 만듭니다. 노드는
무엇을 봤는지 말해 줍니다. 이메일 주소, 전화번호, 카드 번호, 주민등록번호입니다. 정말 개인정보인지는 사람이 판단하면
됩니다. 가르친 것을 팔 생각이라면 접근 수준은 [`TeachDataset`](../reference/schemas.md#teachdataset)에 있습니다.

## 6. 파일을 고쳐서 다시 올리기

진짜 문제 세 가지를 고칩니다. 회의실 답을 하나로 정하고, 개점 시간을 채우고, 긴 질문을 쪼개거나 줄입니다. 그리고 같은
파일을 다시 올립니다.

```bash
ainize teach dataset upload ./handbook.csv --name "Aster handbook"
```

```text
Aster handbook  http://localhost:3618
dataset             8d82f6cd-a945-464a-8282-80ca3de1e20d
questions           7 kept
fingerprint         19194ab77d67ae0d…  (revision 1)
where it came from  a file you uploaded — handbook.csv · csv · separator "," · header row · utf-8
size                617 B (uploaded 483 B)
state               never trained yet

✓ uploaded handbook.csv (483 B)
7 of 7 lines will train
```

**데이터셋 아이디가 새로 나왔습니다.** 데이터셋을 식별하는 것은 그 안의 질문이기 때문입니다. 정확히는 받아들인 행들을
표준 형태로 적었을 때의 sha256이고, 그것이 `fingerprint` 줄입니다. 질문이 다르면 다른 데이터셋입니다. 이전 것은 지우기
전까지 그대로 남아 있습니다.

이 규칙의 나머지 절반은 *같은* 질문을 다시 올렸을 때 드러납니다.

```text
· handbook.csv is already on this node — same questions, same dataset, no second copy
```

같은 바이트, 같은 데이터셋, 사본 없음, 할당량 소모 없음. 노드에서 내려받은 데이터셋을 같은 노드에 다시 올리면 제자리로
돌아오는 이유이자, 수업을 그 수업의 질문만으로 재현할 수 있게 하는 성질입니다.

```bash
ainize teach dataset get 8d82f6cd-a945-464a-8282-80ca3de1e20d -o questions.jsonl
```

```text
✓ saved /tmp/ainize-tut/work/questions.jsonl (617 B) · fingerprint verified — re-uploading it lands on this same dataset
```

내 데이터셋 목록과, 다 쓴 것을 지우는 방법입니다.

```bash
ainize teach dataset ls
ainize teach dataset rm a5576109-2d22-4e3f-ba27-0a464c589b06
```

```text
your datasets on http://localhost:3618
DATASET                               NAME            QUESTIONS  REV  FINGERPRINT  FROM    LESSONS  STATE   KEPT UNTIL
────────────────────────────────────  ──────────────  ─────────  ───  ───────────  ──────  ───────  ──────  ───────────────────
8d82f6cd-a945-464a-8282-80ca3de1e20d  Aster handbook          7    1  19194ab77d…  upload        0  staged  2026-09-11 11:57:36
a5576109-2d22-4e3f-ba27-0a464c589b06  Aster handbook          4    1  d2c10179c5…  upload        0  staged  2026-09-11 11:57:29

✓ dataset a5576109-2d22-4e3f-ba27-0a464c589b06 deleted. The lessons trained from it are kept — but they can no longer be re-trained from their questions.
```

데이터셋 카드에서 눈여겨볼 줄이 하나 있습니다. `heads-up  N questions end the same way`입니다. 끝맺음이 똑같은 질문들은
모델이 한 덩어리로 외워서 전부 비슷하게 답해 버리기 쉽습니다. 거부가 아니라 경고이지만, 이 줄이 보이면 학습을 돌리기 전에
표현을 다양하게 바꾸는 편이 낫습니다.

데이터셋은 스스로 만료됩니다(2단계의 `kept 7 days`). `state`는 각각이 어디쯤인지 말해 줍니다. 한 번도 학습하지 않았으면
`staged`, 학습한 적이 있으면 `ready`, 지금 그 질문으로 수업이 돌고 있으면 `training`입니다.

## 7. 학습시키기

여기까지는 전부 글자에 대한 계산이었습니다. 이 단계는 노드의 학습기에서 GPU 시간을 씁니다. 2단계의 `trainer` 줄이
`ready`여야 합니다.

<!-- unverified: needs a model runtime -->
```bash
ainize teach train 8d82f6cd-a945-464a-8282-80ca3de1e20d --effort balanced --wait
```

`--effort`는 노드가 찍어 준 세 가지 중 하나를 고릅니다. `quick`(8번 훑기), `balanced`(20번), `thorough`(40번)입니다.
많이 훑을수록 더 단단히 배우고 그만큼 오래 걸립니다. 잘 붙지 않은 수업은 같은 데이터셋으로 더 높은 effort에서 다시
학습시킬 수 있고, 데이터셋이 따로 있는 객체인 이유가 바로 이것입니다.

`--wait`은 수업을 따라가면서 단계가 바뀔 때마다 한 줄씩 찍습니다. 단계를 알아 둘 값은 있습니다. 수업이 어디서 멈췄는지가
무엇이 잘못됐는지를 말해 주기 때문입니다.

| 단계 | 무슨 일이 일어나는가 |
|---|---|
| `QUEUED` | 빈 학습 자리를 기다립니다. 앞에 몇 개가 있는지는 `teach status`가 보여 줍니다. |
| `PREFLIGHT` | 학습 **전에** 실제 모델에게 내 질문을 던져 봅니다. 이미 맞히는 것은 빠집니다. 가르칠 것이 없으니까요. |
| `LOADING` | 학습기를 준비합니다. |
| `TRAINING` | 반복 학습. 줄에는 `step 3/20`과, 지금까지 몇 개의 표현을 맞히는지가 함께 찍힙니다. |
| `EXPORTED` | 지식 파일이 쓰였습니다. 아직 서빙 모델은 건드리지 않았습니다. |
| `CHECKING` | 수업을 실제 모델에 넣고 측정합니다. 8단계입니다. |
| `READY` | 충분히 배웠습니다. 갖고 있든 공개하든 내 마음입니다. |
| `NEEDS_MORE` | 잘 붙지 않았습니다. 학습한 문장 중 맞히는 비율이 75 %에 못 미칩니다. 수업은 남아 있으니 더 높은 effort로 다시 하거나 표현을 하나 더 넣으세요. |

무엇을 학습할지를 바꾸는 옵션도 둘 있습니다. `--rows N`은 데이터셋의 앞 N개 질문만 학습하고(긴 파일을 처음 싸게 돌려 볼
때 좋습니다), `--no-alt`는 `alt_prompt` 열을 무시하고 파일에 적힌 표현만 학습합니다.

파일에서 수업까지 한 명령으로 갈 수도 있습니다. `ainize teach train ./handbook.csv --effort quick --wait`은 파일을 먼저
올리고 같은 검사 표를 찍습니다. 파일을 믿을 수 있게 된 다음에 쓰세요. 처음에는 올리고 표를 읽는 편이 좋습니다.

## 8. 확인 결과 읽기 — 공개 가능 여부는 여기서 갈립니다

<!-- unverified: needs a model runtime -->
학습이 끝나면 노드는 수업을 실제 모델에 넣고 세 가지를 측정합니다. `ainize teach status <수업 아이디>`가 그것을 찍고,
수업 페이지 `<노드>/teach/lesson/<수업 아이디>`도 같은 것을 보여 줍니다.

- **taught** — 학습시킨 문장 중 모델이 이제 맞게 답하는 수, 그리고 *다른* 표현으로 물었을 때도 맞히는 수. `READY`와
  `NEEDS_MORE`를 가르는 숫자입니다.
- **side effects** — 관계없는 질문들을 정해 두고 학습 전후에 물어봅니다. 그 답들이 달라졌다면 이 수업은 사실을 배운 것이
  아니라 무언가를 망가뜨린 것입니다. 노드가 가장 중요하게 보는 확인입니다.
- **parents** — 다른 지식 위에 얹어 학습한 수업이라면, 내 수업을 올린 상태에서도 그 지식이 자기 질문에 여전히 답하는지.

이 셋 중 내 질문에 대한 것은 첫 번째뿐입니다. 나머지 둘은 그 밖의 모든 것에 대한 것이고, 이것이 수업과 파인튜닝의
차이입니다.

이 묶음은 결국 참/거짓 하나로 줄어들고, 그 값이 공개의 관문입니다. 부작용 확인을 통과하지 못하면 노드는 그 수업의 공개를
아예 거부합니다.

```text
checks_failed: this lesson changed answers to unrelated questions or to the knowledge it builds on
```

그런 수업도 갖고 있을 수는 있습니다. 내 노드에 넣어 쓸 수도 있습니다. 다만 누구에게도 팔 수 없습니다.

같은 관문에서 나오는 거절이 둘 더 있고, 둘 다 되돌릴 수 있습니다.

```text
job_not_ready: this lesson has not been measured in the live model yet — run a re-check first
checks_failed: the side-effect check was turned off for this lesson — run the check now before publishing
```

앞의 것은 수업이 끝났을 때 모델 서버가 꺼져 있었던 경우입니다. 학습은 됐고 파일도 남았지만 측정된 것이 없습니다. 뒤의 것이
`--no-check`의 대가입니다. `teach train --no-check`는 부작용 측정을 건너뛰어 수업을 빨리 끝내는 대신, 측정될 때까지 공개를
막아 둡니다. 노드는 "괜찮았다"는 말을 팔려는 사람에게서 받지 않습니다. 측정을 요청하면(수업 페이지의 **다시 확인** 버튼,
또는 `POST /api/teach/jobs/<id>/recheck`) 숫자가 좋을 때 관문이 열립니다.

> [!IMPORTANT]
> `teach.backend: stub`인 노드는 GPU 없이 파이프라인 전체를 흉내 내고, 찍는 숫자마다 흉내라고 이름을 붙입니다 —
> `note: stub backend (offline) — checks were simulated, not measured in a live model`. 그것은 흐름의 시연이지 학습된
> 수업이 아닙니다. 이 문구가 보이면 측정된 것은 하나도 없습니다.

## 9. 나만 쓰거나, 공개하거나

<!-- unverified: needs a model runtime -->
끝난 수업은 그 수업을 학습시킨 노드에 있는 비공개 초안입니다. `ainize teach jobs`는 내 수업들을, 각각이 어느 데이터셋에서
나왔는지와 함께 보여 줍니다.

```bash
ainize teach jobs
```

`READY` 상태의 수업으로 할 수 있는 일은 셋입니다.

**노드에 그냥 둡니다.** 2단계의 `unsaved lessons kept` 기간(기본 7일) 동안 남고, 내 가르치기 키(와 운영자)만 넣을 수
있습니다. 수업 페이지에서 써 보거나, 다른 지식처럼 넣어서 쓰면 됩니다.

**파일을 내려받습니다.** 수업 페이지가 `.npz`와 `recipe.json`의 내려받기 링크를 만들어 줍니다. 그 파일은 이 노드가
서빙하는 바로 그 모델 안에서만 동작합니다. 이유는 [지식이란 무엇인가](../concepts/knowledge-patch.md)에 있습니다.

**공개합니다.** 수업이 내 가르치기 키의 이름으로 공개 기록에 올라가고, 독립된 노드들이 검증을 시작합니다. `review` 노드에서는
운영자를 먼저 거치고, `auto` 노드에서는 곧바로 알려지며, `never` 노드에는 이 버튼이 없습니다. 그다음에 일어나는 일 —
검증 기록, 정족수, 등록 — 은 [검증 완료가 증명하는 것](../concepts/verification.md)이고, 내가 받는 돈은
[값을 매기고 정산받기](../how-to/price-knowledge.md)입니다.

## 다음에 볼 것

같은 파이프라인의 다른 창구는 [모델을 바로잡으며 가르치기](./teach-in-chat.md)입니다. 파일도 CLI도 없고, 가르치기 키가
디스크가 아니라 브라우저에 있습니다.

내 지식을 만드는 대신 남의 지식을 쓰고 싶다면 [남이 공개한 지식 사서 쓰기](./buy-and-apply.md)가 사는 쪽의 길을 처음부터
끝까지 걷습니다.

여기 나온 모든 명령의 모든 옵션은 [CLI 레퍼런스](../reference/cli.md#ainize-teach)에, 노드가 읽는 모든 `teach.*` 설정은
[설정 레퍼런스](../reference/config.md#keys)에 있습니다.
