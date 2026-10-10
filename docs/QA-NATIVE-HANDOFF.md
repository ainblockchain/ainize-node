# Ainize 네이티브 QA 에이전트 인수인계

작성일: 2026-10-05. 대상 저장소: `ainblockchain/ainize-node`, 브랜치: `hosted-qa-execution`.

## 최신 리뷰 요약 — 2026-10-11

**운영 전환과 전 서비스 실제 E2E는 미완료다.** 아래 날짜별 기록은 당시 결과이며,
새 코드가 push되었다고 운영 서비스에 반영된 것은 아니다.

- Native handler의 접수·모델 코딩·제품 검증·PR 게시·Teams/Ainmem 정본 승인 확인·
  승인 후보 반영·서비스 SHA 관측·페이지 보고를 구현했다. 검증 실패는 최대 2회 모델
  재수정, host 실행 예외는 30초 간격 최대 총 3회 재시도를 지원한다.
- QA 회귀 175개 및 build 통과. 4ec1c69의 전체 API suite는
  950 tests, 932 pass/0 fail/18 skip, 34.3초다. skip은 통과로 계산하지 않는다.
  704ced1의 919 pass 결과는 이전 기록이다.
  이전 5420891의 906 pass 결과는 과거 검증 기록이다.
- .41 실제 hosted Docker→gateway→제품 lint, 중간 runtime restart, 실제 Ainize 모델의
  테스트 코드 수정과 격리 실행 검증을 통과했다. 각각 제품/모델 진단이며 실서비스
  채널→수정→PR→관리자 승인→배포 전체 흐름의 증거는 아니다.
- 실제 모델의 **검증 실패 후 자동 재수정** 진단도 통과했다. 아래 기록의 실패 후보는
  테스트가 의도적으로 넣은 것으로, 최초 모델 출력이었다고 해석하지 않는다.
- Teams main 0e6dfedd: typecheck/lint 통과, production build와 화면 4개 검사 통과.
  전체 unit gate는 DNS/Git 메타데이터/thumbnail fixture 문제로 실패 기록이 남아 있다.
- Ainspace main 348b319: 201 tests 통과, lint 오류 0/경고 36. Google Fonts 다운로드
  의존으로 network=none build 실패. 네이티브 qa-ainspace를 통한 제품 수정이 필요하다.
- 현재 운영 이력 23건을 6개 격리 저장소에 이관 시험했다. Ainize web/API 5건은 같은
  저장소에 route를 유지해 가져왔다. 중복 0, 원본 변경 0, 자동 실행 가능 작업 0.
  운영 이관·활성화는 하지 않았다.

### 운영 연결에 필요한 다음 조치

2026-10-11 이관된 실제 미완료 요청 재확인:
`verifyHistoricalQaIntake`를 추가했다. operator 전용이며 gateway에 노출하지 않는다.
보관본 digest/repository/workspace/channel, 미완료 상태, 원래 작성 시각(legacy Unix
seconds), 수정 요청 문구를 검증한 뒤 Teams root/channel/전체 thread를 새로 읽는다.
원래 작성자·내용·시각이 모두 같고 작성자가 현재 사람 멤버여야 한다. 새 요청의 24시간
제한은 바꾸지 않으며 완료/실패 이력과 과거 승인 데이터는 재실행·배포 권한이 되지 않는다.
QA 167 pass/0 fail/0 skip, build 통과.

실제 .41의 `/mnt/newdata/qa-services/validation/native-historical-intake-20261011-28kzWT/`:
- 현재 이관 snapshot 23건 중 waiting 7건을 운영 Teams MCP에서 읽기 전용 대조했다.
- **7/7 검증 성공**: Teams 3, Ainize web 2/API 1, Ainspace 1.
- `summary.json`은 결과만, `proofs.json`은 원문/binding/archiveDigest를 포함하며 mode 0600.
  proof 내용을 Git이나 채널에 복사하지 않는다.
- 기존 source DB·native job 상태·Teams 메시지·Ainmem 페이지는 변경하지 않았다.
다음 단계는 이 검증을 operator 이관 경로에서 다시 실행해 host intake/공유 route에
원자적으로 등록하고, 후보·정본 페이지 조정 후 native 작업을 재개하는 것이다. 보관한
proof가 나중에도 현재 권한을 증명한다고 간주하거나 과거 LGTM을 승계하지 않는다.

2026-10-11 최신 8b9f2b0 실제 .41 서버 회귀:
`/mnt/newdata/qa-services/validation/native-current-20261011-ifJot9/`에 결과를 보존했다.
- `hosted-qa-product-validation.log`: 실제 scheduled agent Docker→Unix gateway→
  Ainspace 6bec65c의 lint, runtime restart 포함 1 pass/0 fail/0 skip, 18.4초.
  이 프로필은 lint 한 개이며 최신 Ainspace main 전체 gate 검증은 아니다.
- `hosted-qa-live-coding.log`: 실제 Qwen3.8-Flash-Next native 도구 수정과 실패 뒤
  재수정, runtime restart, 고정 격리 산술 검사 2 pass/0 fail/0 skip, 64.7초.
- `revalidation.log`: 서버 Node에서 실제 ledger/base/gateway/coordinator/handler를
  사용한 20 pass/0 fail/0 skip, 1.3초. 외부 Teams/Ainmem/GitHub 읽기와 모델 출력은
  fixture이며 실제 채널 승인·릴리스 검증은 아니다.
- `summary.json`: 진단 runtime 결과와 source SHA. 진단용 internal network
  `ainize-current-ifjot9` 제거를 실제 조회로 확인했다. 사용자 서비스
  `ainize-public-node`와 `ainize-auto-deploy.timer`는 계속 active다.
기존 운영 agent/profile/채널/페이지를 변경하지 않았다. ACL은 기존 추출 바이너리를
진단 PATH에서 사용했으며 production 패키지 설치를 완료한 것으로 해석하지 않는다.
다음 실제 운영 단계는 승인 대기 선행 PR 및 native runtime 배포, 자격증명/페이지 이관,
단일 writer 전환 후 여섯 채널의 실제 요청→PR→LGTM→serving SHA 검증이다.

2026-10-11 게시 전·반복 main 변경 재개 연결 완료(코드 통합 검증):
재개 요청/응답에 선택적 candidateDigest를 추가했다. 게시 전 park는 검증한 후보 digest를
보관하고 handler가 이를 전달한다. 호스트는 같은 agent/job/base/candidate의 영구 게시
변경 기록과 원래 요청을 대조한다. 처음 review가 없는 경우와 이전 PR을 보관한 채 준비된
중간 base에서 다시 drift한 경우를 구분한다. 새 시도는 이전 준비 base 체인을 따라야 하며,
최종 publication은 마지막 준비 base와 원래 요청에 일치해야 한다. 첫 검토 페이지도
canonical API 응답으로 등록한 뒤 고정한다. 임의 관측 SHA만으로 재개를 허용하지 않는다.
두 번의 main 이동, 준비 서비스 재시작, PR 유무 양쪽, 다른 후보 응답 거부, 기존 orphan PR
보관 및 같은 Ainmem 페이지 검토를 검증했다. QA 164 pass/0 fail/0 skip, build 통과.
운영 플래그는 여전히 기본 false이고 배포·실제 채널 E2E는 수행하지 않았다.
이 아래의 ‘게시 전 미완료’ 기록은 당시 상태이며 이번 변경으로 코드 연결을 완료했다.


2026-10-11 게시 전 base 변경 증거 영구 보존:
publisher가 반환한 `QaPublicationBaseChanged`를 새 `publication_base_changes` 테이블에
agent/job/candidate digest로 묶어 기록한다. 서버는 저장 전 intake·정확한 validation
receipt를 재확인하며 저장 실패를 `requires_revalidation` 성공으로 알리지 않는다.
재시작 후와 cached 응답 전에도 이 기록을 읽으므로 main이 원래 SHA로 돌아오더라도
이전 후보 게시를 다시 수행하지 않는다. 최초 observed base는 유지하고, 호스트가
검증한 기존 PR artifact만 추가할 수 있다. 다른 artifact로 교체하는 것은 거부한다.
저장 실패·처리 중 권한 철회·재시작·다른 agent 접근 거부 포함 QA 162 pass/0 fail/0 skip,
build 통과. 전체 API suite를 이번 변경 뒤 재실행한 것은 아니며 위 704ced1 결과와 구분한다.

**게시 전 자동 재개 연결은 아직 미완료:** handler의 재개 요청에 해당 candidate digest를
포함시켜 위 증거와 정확히 대조해야 한다. 현재 request의 sourceDigest는 로컬 보관 이력의
해시이므로 host candidate digest를 대신하지 못한다. 처음부터 review가 없던 경우와
이전 review는 남아 있지만 중간 준비 base에서 다시 drift한 경우의 reservation 및
publication 교체를 별도로 검증해야 한다. 기록 존재만으로 임의 후보 재개를 허용하지 않는다.

운영 선행 PR 재조회: Ainize #71(403860f), Ainmem #76(971a776)은 모두 OPEN/MERGEABLE이다.
해당 두 PR 병합·배포 승인 요청은 아직 답변이 없으며 운영 배포를 수행하지 않았다.

2026-10-11 에이전트 재개 호출 연결:
`HostedQaRevalidationService`와 authenticated `/qa/revalidation`, runtime `ctx.qa.revalidate`,
web/API의 scoped routing을 연결했다. 호스트 base 준비 응답을 ledger에 확정한 뒤에만
`done`을 반환한다. 캐시 조회 전에도 현재 권한을 확인하고, ledger 저장 실패는 성공으로
반환하지 않는다. handler는 `hostRevalidation:true` 명시 설정 시 별도 lease로 준비를
요청하며, 같은 job ID와 원본 요청으로 새 snapshot 코딩을 시작한다. 실패는 작업에
누적해 3회 뒤 보존 대기한다. 기본값은 false이고 운영 설정은 변경하지 않았다.
실제 gateway/runtime/host ledger/base service와 fixture 외부 읽기의 연결, 공유 API route,
handler의 재시작 후 새 소스 수정, 저장 실패 재시도를 검증했다. QA 160 pass/0 fail/0 skip,
build 및 전체 API suite 919 pass/0 fail/18 skip 통과. **현재 지원은 게시된 review의 base invalidation에 한정된다.** 게시 전 drift와
새 PR 게시 전에 main이 다시 이동한 경우는 호스트 publication 기반 준비 권한을 추가해야
하며 현재는 보존 대기한다. 실제 채널·제품 E2E 및 운영 전환은 여전히 미완료다.

2026-10-11 재검증 후 PR 교체:
`commitRevalidationBase`가 호스트 준비 응답을 예약에 고정한다. 다른 base로 같은 예약을
덮어쓰지 못한다. `enqueuePublication`은 그 준비 base와 같은 repository·Teams 요청의
새 SHA/digest/PR만 교체하며, 이전 publication은 예약 이력에 보존한다. 교체된 후보는
새 presentation 전까지 `awaiting_presentation`이다. review loop는 현재 검토와 publisher
receipt가 다르면 새 presentation을 등록한다. `bind`는 원래 Ainmem page ID와 새 후보만
허용하고, 새 generation 뒤에도 과거 후보로 돌아가는 것을 거부한다.
실제 ledger/base service/coordinator/review loop를 함께 사용하고 Teams/Ainmem/GitHub
읽기만 fixture로 제공한 테스트에서 교체·동일 페이지·이전 승인 거부를 확인했다.
QA 157 pass/0 fail/0 skip 및 build 통과, 추가 통합 검토 테스트 9 pass. 운영 E2E 증거는
아니다. gateway의 준비 요청/응답 및 handler 재개 연결은 아직 남아 있다.

2026-10-11 검토 ledger와 호스트 재준비 권한 연결:
`HostedQaReviewStore.authorizeRevalidation`이 verified intake·원래 Teams 요청·현재
publication·review generation·영구 base invalidation을 확인하고 이전 publication,
review key/generation, 시도 번호, source digest를 `review_revalidations`에 보존한다.
release intent가 있으면 receipt가 없어도 거부한다(원격 merge 진행 중일 수 있음).
재시작과 동일 요청 재호출은 보존된 예약을 확인하며, 다른 digest/시도/agent는 거부한다.
예약된 이전 generation의 `bind`도 거부해 presentation 갱신으로 이전 승인을 되살리지
못하게 했다. server의 HostedQaBases 권한 콜백을 이 메서드로 연결했고, 실제 store와
base service를 함께 사용한 준비 테스트를 포함해 QA 157 pass/0 fail/0 skip, build 통과.
**재수정 gateway와 handler 호출은 아직 없으며 활성화하지 않았다.** 위 후속 작업에서
새 base 준비 확정·publication 교체·review loop의 새 generation 등록까지 구현했다.
예약된 이전 후보를 다시 bind할 수 없으며, 준비된 새 후보만 등록할 수 있다.

2026-10-11 호스트 기준 커밋 재준비:
`HostedQaBases.prepareRevalidation`을 추가했다. 호스트 전용 동기 권한 콜백을
준비 전후에 호출하며 콜백이 없거나 async이면 거부한다. 이전 base·시도 번호·이력 digest를
묶어 새 main을 읽고 기존 dependency-image 정책으로 준비한 뒤, 이전 base 체인과 새
응답을 하나의 private 파일에 원자적으로 보존한다. 중복 동시 요청·재시작은 같은 응답을
반환하고, 다른 동시 요청·지난 시도 재사용·준비 중 권한 철회는 기존 base를 유지한다.
새 base 적용 후 기존 후보의 `requireProfile`은 실패한다. QA 155 pass/0 fail/0 skip,
build 통과. 당시 미연결이던 review ledger 권한 콜백은 위 후속 작업에서 연결했다.
gateway는 아직 연결하지 않았다.

2026-10-11 main 변경 재개 상태 전환:
`Jobs.claimRevalidation`/`bindRevalidation`을 추가했다. ordinary claim은 만료된
`needs_revalidation` 실행도 가져가지 않는다. 별도 claim은 host intake/base가 준비된
작업만 선택하며, 재개는 job/repository/previousBase/sequence/sourceDigest가 보관 이력과
맞는 호스트 준비 응답을 요구한다. 같은 작업 ID와 원본 요청을 유지하고 base만 바꾸며,
활성 checkpoint에는 host intake/base와 새 시도 출처만 남긴다. 이전 후보·검증·PR·승인은
보관 이력에서 유지되고 새 후보의 권한으로 사용되지 않는다. 경쟁 lease, 재시작,
잘못된 준비 응답, 중복 재개 거부를 포함해 QA 153 pass/0 fail/0 skip, build 통과.

**아직 이 API를 handler에서 호출하지 않는다.** 자동 main 재수정은 다음 연결까지 미완료:
1. 게시 전·반복 main drift 코드 연결은 완료했다. 실제 호스트에서 모델 수정·제품 gate·
   publisher 재시작과 결합한 검증을 수행한다. 로컬 통합 테스트를 운영 증거로 대체하지 않는다.
2. gateway/handler/새 publication/review 연결은 구현됐다. 실제 호스트의 main 변경과
   재시작 통합 검증을 수행한다. 진행 중인 release intent는 계속 재개를 거부한다.
3. 운영 활성화 전에 기존 이관 작업과 겹치지 않는 단일 writer 구성을 확인한다.
   `hostRevalidation`은 현재 기본 false이며 운영 설정을 바꾸지 않았다.
4. 동일 Ainmem 페이지, 이전 댓글 보존, 새 SHA 이전 LGTM 거부, 최신 후보 재검증·새 승인·
   배포까지 통합 검증한다. 코드 상태 전환 테스트만으로 이 전체 흐름을 통과라 하지 않는다.

2026-10-11 실제 재수정 진단:
`/mnt/newdata/qa-services/validation/native-repair-20261011-Vf8Xs1/repair.log`.
`e2e/hosted-qa-live-coding.test.ts`의 두 시나리오가 2 pass/0 fail/0 skip, 총 56.1초.
첫 시나리오는 실제 모델의 native 도구 수정→restart→격리된 고정 산술 검사 통과.
두 번째는 잘못된 후보를 checkpoint에 의도적으로 저장→실제 Docker 검사 실패→
production HostedQaValidationService/private gateway를 통한 실패 전달→
advanceHostedValidation의 자동 재수정 전환→runtime restart→실제
Qwen3.8-Flash-Next 도구 수정→새 digest로 재검증 성공을 확인한다.
같은 job ID, repair count 1, host verdict 순서 `[false,true]`, 후보 digest 변경,
최종 `needs_publication`/`waiting`을 검증했다. PR·승인·배포는 실행하지 않았다.
고정 검사는 진단용 산술 코드에만 적용되며 실제 제품 gate 전체의 대체 증거가 아니다.
별도 internal network는 종료 후 삭제했고 기존 운영 agent/network를 사용하지 않았다.

추가 리뷰: Ainmem의 후속/동시 응답이 정본 page URL을 바꾸면 수신을 거부하고 기존
링크와 미전달 revision을 보존하도록 수정했다. 정상 정본 응답으로 재시도할 수 있다.
동시 flush와 후속 revision 회귀를 포함해 QA 152 pass/0 fail/0 skip, build 통과.

**Teams 링크 지연 전달은 아직 미완료:** 최초 접수 시 Ainmem이 실패하면 plain 접수
응답만 반환한다. 이후 tick의 보고 재시도로 페이지가 생겨도 원래 Teams 스레드에
링크를 전송하는 경로가 없다. 현재 Teams MCP `send_message` 입력은
`channelId/content/parentId`뿐이며 idempotency key가 없다. 단순 재전송을 붙이지 말고
서버 중복 방지 또는 인증된 발신자·스레드 기반 응답 유실 조정과 영속 outbox를
함께 구현해야 한다. 과거 이관 작업에 링크 알림을 무조건 소급 전송하지 않는다.

서버 재조회: .41 SSH multiplex 연결은 열려 있고 사용자 서비스
`ainize-public-node`, `ainize-auto-deploy.timer`는 active다. `acl`은 여전히 미설치다.
사용자의 unlock 응답 뒤 로컬 Vault 조회는 locked였으므로 비밀정보를 요구하는
설치나 운영 전환은 수행하지 않았다.

1. 승인 대기: Ainize PR71 (`403860f`) 조직 참조 수정과 Ainmem PR76 (`971a776`)
   scoped 등록 API·기존 페이지 채택·통합 보드 반영. 두 PR 병합·배포와 Ainmem 전용
   DB 변경 승인을 요청했으나 아직 답변이 없다. 다른 PR에 대한 과거 승인을 재사용하지 않는다.
2. .41의 ACL 도구 설치. 기존 user 서비스와 자동 배포 timer는 active지만 acl 미설치.
   진단은 추출된 도구를 별도 PATH로 사용했다. 운영 설치 시도는 Vault Locked로 중단됐다.
3. 실제 SSO로 에이전트 등록·토큰 전달 및 기존 23개 page 권한 연결. 현재 쓰는 Python
   작업기와 같은 채널에 native writer를 중복 활성화하지 않는다.
4. Main 변경 시 새 base에서 후보를 자동 재작성하는 경로, 기존 미완료 작업의 native
   재개, 제품별 검사 실패 해결, 전 채널 실제 수정→승인→배포 검증을 완료한다.

운영 브랜치 병합·배포·작업기 전환은 별도 승인/실행 결과로 확인한다. 아래 초기
인수인계와 날짜별 세부 로그에는 이미 해결한 항목도 있으므로 이 요약을 먼저 읽는다.

## 1. 현재 상태

**운영 전환은 미완료다. 이 브랜치를 배포하는 것만으로 모든 QA 채널이 완성되지는 않는다.**

기존 QA 에이전트는 Ainize에 linked agent로 등록되어 있지만 실제 실행은 외부 Python 작업기가 담당했다. 사용자가 Ainize agent 자체를 사용하라고 수정 요청했다. 따라서 네이티브 hosted handler 안에서 요청 확인, 작업 저장, 모델 도구 실행을 구현하고 검증하는 중이다.

- 첫 구현 커밋: `f636deb` — native intake, model coding, checkpoints, integration diagnostics.
- 후속 변경: 서버가 지정한 에이전트의 자동 tick 실행, 실행 중인 컨테이너 보호, 이 문서.
- 운영 에이전트 등록/ID, 채널 연결, 작업 DB와 Ainmem 기록은 아직 네이티브 버전으로 옮기지 않았다.
- 실제 제품 테스트/빌드/브라우저 검증, GitHub 후보 게시, 승인 후 릴리스 연결은 남아 있다.
- `ainetwork-ai/a2a-agents`에는 더 이상 수정·커밋·push하지 않는다. 기존 기록과 PR은 보존한다.
- 사용자의 `ainetwork-ai/aincalendar` push 요청은 곧바로 철회되었다. 해당 저장소는 대상이 아니다.

## 2. 완료 조건과 반드시 유지할 규칙

목표는 **모든 제품의 QA 채널과 Ainmem 작업 페이지가 실제로 작동하는 것**이다.

| 채널 | 대상 |
| --- | --- |
| `qa-ainteams` | AIN Teams |
| `qa-ainmem` | AINMem |
| `qa-aindrive` | AINDrive |
| `qa-ainize` | Ainize 웹 및 API |
| `qa-aina` | AINA |
| `qa-ainspace` | AINSpace |

- 채널에 속한 모든 사람의 `~~ 고쳐줘.` 요청을 처리한다. 요청자가 관리자일 필요는 없다.
- 실제 제품 수정 요청은 QA 채널에 등록하여 에이전트가 처리하는 흐름으로 검증한다. 운영자가 제품 코드를 대신 고쳐 놓고 QA 성공으로 보고하지 않는다.
- Multica를 사용하지 않는다. Python QA 작업기를 프록시하는 구조도 최종 상태가 아니다.
- 수정 → 제품별 실제 검증 → 후보 커밋/PR → 관리자 승인 → 병합/자동 배포 → 서비스의 실행 커밋 확인이 필요하다.
- 최종 배포 승인자는 김민현, 전현정, 이해찬, 이민재. `qa-ainspace`에는 고유진, `qa-aina`에는 안지영 추가.
- `LGTM` 또는 `배포해`는 원래 Teams 작업 스레드나 해당 작업의 **정본 Ainmem 페이지 코멘트**에서 받는다.
- 실제 작성자 SSO ID, 활성 조직 및 채널 소속, 작업·페이지·검토된 정확한 SHA·승인 시각을 대조한다. 이름/전달된 metadata/모델 발언만으로 승인하지 않는다.
- 이전 SHA의 승인은 새 변경안에 재사용하지 않는다. 테스트용 승인/SQL fixture는 실제 승인으로 사용하지 않는다.
- Teams 진행 보고는 작업 페이지 링크 **하나**를 사용한다. 각 제품의 개별 칸반과 통합 배포 승인 보기를 유지한다.
- 기존 agent ID, 작업 ID, 페이지, 댓글, 승인 기록을 보존한다. 기존 작업을 무작정 재실행하지 않는다.
- 정상적인 요청 처리와 GitHub push/merge에 사람의 SSH OTP가 필요해서는 안 된다.

## 3. 구현 위치

### Ainize 런타임 변경

- `src/hosted-agent-runtime/hostedAgentTeamsLocator.ts`: A2A에서 workspace/channel/message/parent 식별자만 전달. 신뢰 근거가 아니라 정본 조회용 힌트다.
- `hostedAgentExecutor.ts`: send와 stream 양쪽에 힌트 연결.
- `hostedAgentContext.ts`, `src/hosted-agent-gateway.ts`: `redirect: error/manual` 전달 및 준수. 토큰을 담은 MCP 요청은 리다이렉트를 거부한다.
- `hostedAgentRuntimeTypes.ts`, `hostedAgentRuntimeMain.ts`, `hostedAgentRuntimeApp.ts`: 모듈의 `tick(ctx)` 훅과 호스트 토큰으로 보호된 `/_ainize/tick`. 동일 런타임 안에서 실행 중인 tick은 중복 시작하지 않는다.
- `src/hosted-agent-host.ts`: 운영자 allowlist에 있는 handler를 주기적으로 실행. 실행 중/관측 불확실 상태를 idle 종료와 자리 확보 대상에서 제외한다. HTTP 오류만으로 재시작하지 않고 Docker에서 종료가 확인되면 복구한다.
- `src/hosted-agent-docker.ts`: 실제 실행 여부 확인.
- `src/server.ts`: `AINIZE_HOSTED_SCHEDULED_AGENTS`를 읽어 호스트에 전달한다. 기본값은 비활성이다.

**아직 운영 환경에 `AINIZE_HOSTED_SCHEDULED_AGENTS`를 설정하지 않았다.** 완성된 QA handler와 복구 검증 없이 활성화하지 않는다. 설정 예시는 `ainteams-qa,ainmem-qa` 같은 쉼표 구분 ID이며, 사용자 메시지로 켤 수 없다.

### 네이티브 QA 모듈 (`examples/qa-agent/`)

| 파일 | 역할 / 제한 |
| --- | --- |
| `teams.mjs` | hosted gateway와 private `TEAMS_TOKEN`으로 정본 메시지·스레드·workspace/channel 관계·활성 사람 멤버·요청 시각 확인. 배포 명령은 수정 요청으로 받지 않음 |
| `jobs.mjs` | SQLite 중복 방지, 실행 lease, 재시작 후 복구, 상태 전이. `wake`는 승인 아님 |
| `repository.mjs` | 고정 repository/full SHA에서 GitHub tree/blob 읽기. 필요 시 `GITHUB_READ_TOKEN`. 아직 게시 기능 없음 |
| `coding.mjs` | Ainize 모델의 파일 목록/범위 읽기/유일 일치 치환/새 파일 생성. 후보는 `needs_validation`에서 멈춤 |
| `checkpoints.mjs` | private immutable checksum 기반 저장. 새 상태가 이전 시도에 덮어써지지 않음 |
| `advance.mjs` | SQLite lease를 갱신하며 모델 한 단계 실행 → 상태 파일 저장 → DB에서 참조. 검증 대기까지이며 릴리스하지 않음 |

이 모듈들을 조합한 **운영용 `index.mjs`는 아직 없다.** 테스트의 handler는 검증용이다. 저장소 읽기 토큰과 릴리스 자격증명을 분리하고, 모델에는 임의 shell/HTTP/배포 도구를 제공하지 않는 구조를 유지한다.

## 4. 검증된 것과 검증되지 않은 것

### 검증 완료

- 최신 로컬 `npm run typecheck`, `npm run build` 통과.
- 최신 관련 테스트 **27개 통과, skip 0**. 자동 tick 테스트 3개 포함.
- 기존 hosted agent 회귀 테스트(`test/hosted-agents.test.ts`) **16개 추가 통과, skip 0**.
- 앞선 Linux 서버 검증: 관련 테스트 **30개 통과, skip 0**. access/docs 테스트를 포함하며 후속 scheduler 변경 전 결과다.
- 실제 Docker hosted handler가 실제 Teams 요청을 읽고 활성 채널 멤버를 확인했다. 컨테이너 재시작 후 같은 요청의 SQLite 작업 ID가 유지됐다. 다른 채널 힌트는 거부했다.
- 실제 Ainize 모델 `Qwen3.8-Flash-Next`가 작은 덧셈 진단 코드를 도구로 수정했다. SQLite/checkpoint/lease 연결 상태에서 컨테이너를 재시작하고 같은 작업을 이어갔다.
- 모델이 만든 함수는 별도의 read-only/no-network/no-credential Docker 컨테이너에서 고정된 산술 검증을 통과했다. 마지막 진단은 약 22초, 1 pass / 0 skip.
- scheduler 단위/HTTP 검증: 호스트 토큰 필요, tick 중복 방지, 실행 중 idle/eviction 보호, 불확실한 관측 후 유지, Docker 종료 확인 후 복구.

### 2026-10-07 네이티브 모듈 실제 E2E (읽기/코딩, 프로덕션 무쓰기)

- `index.mjs`/`validation.mjs`가 포함된 현재 브랜치에서 문서의 opt-in 하네스를 실제 자격증명·실제 서비스로 돌렸다. 둘 다 프로덕션 등록·게시·merge 없음.
- **live-read 통과**: 네이티브 Docker 핸들러가 실제 Teams 정본 메시지(ainteams-qa 채널, 21시간 내 실제 fix 요청)를 게이트웨이+실제 `TEAMS_TOKEN`으로 읽어 workspace/channel 관계·활성 멤버십·fix 의도·요청 시각을 검증하고, 격리 SQLite에 enqueue, 컨테이너 재시작 후 같은 작업 ID 유지, 위조 metadata(forged-admin)는 거부했다. 읽기 전용.
- **live-coding 통과**: 실제 Ainize 모델 `Qwen3.8-Flash-Next`가 네이티브 툴(list/read/replace/create)로 후보를 수정하고 체크포인트에서 재개한 뒤, 자격증명·네트워크 없는 별도 Docker에서 고정 산술 검증을 통과했다(약 21초). 제품 회귀 게이트를 대신하지는 않는다.
- 운영상 핵심 발견: **외부 Python QA 워커(`qa_agent.server`)가 6개 채널을 현재 라이브로 서빙 중**이다. 따라서 네이티브 에이전트로 같은 라이브 Teams/GitHub/Ainmem에 쓰기(후보 PR·페이지·merge)를 하면 이중 처리·중복 쓰기 위험이 있어, 쓰기/릴리스는 조율된 전환(워커 정지 또는 전용 채널) 없이 자율 실행하면 안 된다. 위 두 실증은 읽기·격리라 충돌이 없었다.

### 아직 증명하지 못한 것

- **후속 scheduler 변경의 실제 Docker 자동 실행 및 Ainize 노드 전체 재시작 복구.** 지금까지 실제 모델 진단은 테스트 호출이 다음 단계를 진행시켰다.
- 자동 tick → 실제 채널 요청 → 제품 저장소 수정 → 실제 제품 검증 → Ainmem → 진짜 관리자 승인 → 배포까지의 네이티브 통합 흐름.
- 작은 산술 진단은 어떤 제품의 회귀 테스트나 배포 게이트도 대신하지 않는다.
- 전체 테스트 스위트가 모두 통과했다고 보고하면 안 된다. 이전 전체 실행은 693개 중 675 pass / 3 fail / 15 skip이었다. 일부 환경 의존 실패를 Linux에서 따로 검증했지만 전체 스위트를 같은 조건에서 재실행한 결과는 없다.
- 2026-10-05 Linux 검증 호스트에서 `npm test`(`test/*.test.ts`, opt-in `e2e/` 제외) 전체 재실행: **720개 중 712 pass / 1 fail / 7 skip**. 유일한 실패는 `test/hosted-agents-docker.test.ts`의 온디맨드 핸들러 통합 테스트로, 이미지 빌드와 컨테이너 기동(`hosted agent v1 ... on :8080`)은 성공했으나 컨테이너 내부에서 모델 게이트웨이로 나가는 `fetch`가 이 박스의 egress 제약으로 실패했다(`turn failed TypeError: fetch failed`; loopback/metadata 차단은 기대대로 동작). 코드 결함이 아니라 환경 의존 네트워킹 문제이며, 네이티브 QA 모듈(`index.mjs`/`validation.mjs`)과 scheduler 단위 테스트는 모두 통과했다. 여전히 실제 노드+모델 환경에서 이 Docker 경로를 재확인해야 한다.

## 5. 다음 작업 순서

1. **자동 실행을 실제 Docker에서 검증한다.** native `tick`에 `advanceCoding`을 연결하고, 최초 요청 이후 추가 A2A 호출 없이 계속 진행되는지 확인한다. idle 정리, 노드 재시작, 컨테이너 강제 종료, 관측 타임아웃을 구분해 검증한다. 살아 있는 실행을 타임아웃만 보고 재시작하지 않는다.
2. **운영 QA handler를 조립한다.** 서비스별 신뢰된 repository/base branch 설정, 정본 요청 확인, base SHA 고정, 중복 처리, 큐, tick, 오류/재시도/terminal 상태를 연결한다. 메시지가 repository나 실행 명령을 임의로 바꾸지 못하게 한다.
3. **제품별 검증과 GitHub 게시를 연결한다.** 실제 test/typecheck/lint/build/browser 게이트를 실행하고 정확한 candidate SHA에 결과를 귀속한다. 제품 코드는 자격증명 없는 격리 환경에서 실행한다. 브랜치/PR 생성 재시도는 기존 원격 결과와 대조하며, main 자동 변경은 승인 전 금지한다.
4. **Ainmem 정본 작업 페이지를 연결한다.** 요청별 한 페이지, 기존 페이지 재사용, 서비스별 보드/통합 승인 보기, 상태·검증·PR·실패 사유 갱신, Teams의 한 링크 보고를 구현한다. 외부 쓰기의 중복 방지와 재시도도 검증한다.
5. **승인·릴리스 경로를 이식한다.** 아래 기존 보안 조건을 보존하고 관리자 SSO/조직/채널 소속과 정확한 SHA를 재검증한다. 릴리스 자격증명은 coding/model 접근에서 분리한다. Ainmem 실제 사람 댓글 → 배포 → serving SHA 확인이 아직 필요하다.
6. **기존 작업과 등록을 전환한다.** linked QA 6개와 7개 서비스 profile을 native hosted로 옮긴다. 기록/ID/페이지/승인을 보존하고 기존 실행이 끝나기 전에 종료하지 않는다. checkpoint 저장의 용량·보존 정책도 필요하다.
7. **모든 제품 채널에서 실제 E2E를 끝낸다.** 서비스마다 단순한 요청 하나가 전체 흐름을 통과해야 한다. 실제 승인이나 배포 대상이 없으면 그 상태를 명시한다. 그 뒤 외부 Python QA 런타임을 퇴역한다.

## 6. 운영 접근과 재현

- 현재 로컬 작업 디렉터리: `/Users/kmh4500/git/ainize-hosted-qa`.
- Node 24 필요. 이 Mac의 사용 가능한 런타임: `/Users/kmh4500/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin`.
- Git은 `/opt/homebrew/bin/git` 사용. 기본 시스템 Git은 Xcode 설치 안내가 나온다.
- .41 접근은 기존 `ain-vault ssh ainize` 연결을 사용한다. 자격증명/OTP를 문서, 코드, 로그에 넣지 않는다.
- API unit: `ainize-public-node`, home: `/home/comcom/.ainize-web`.
- 전환 시작 시 API release: `/mnt/newdata/ainize-node-releases/releases/20261004T153043Z-0bae5163a1f8`. 현재 serving revision은 작업 재개 시 재확인한다.
- 서버 검증 소스/로그: `/mnt/newdata/qa-services/validation/ainize-hosted-native-20261005`.
- 주요 로그: `coding-focused-final.log`, `coding-live-final.log`, `native-live-final.log`, `native-typecheck-final.log`, `native-build-final.log`.
- 로컬 장기 작업 기록: `/Users/kmh4500/git/qa-evidence/qa-validation-20261002.md`. 로그와 private 설정 파일 전체를 Git에 올리지 않는다.

### 서버에서 실제 발견한 의존성

.41에는 `setfacl/getfacl`이 없어서 persistent state를 사용하는 native agent가 시작하지 못했다. 검증에서는 배포판 `acl` 패키지를 내려받아 검증 폴더에 추출하고 테스트 PATH에만 넣었다. **운영 unit PATH/설치는 아직 바꾸지 않았다.** 운영 전환 전에 정식으로 준비해야 한다.

검증 PATH: `/mnt/newdata/qa-services/validation/ainize-hosted-native-20261005/acl-package/extracted/bin`.

서버의 `node_modules`를 release 디렉터리에 symlink하면 TS2742가 발생했다. 검증 디렉터리에 복사하고 `.bin`의 상대 symlink를 보존한 뒤 typecheck/build가 통과했다. 검증 환경 문제 때문에 무관한 소스를 바꾸지 않는다.

### 테스트 명령

```sh
npm ci --ignore-scripts
npm run typecheck
npm run build
node --test --import tsx \
  test/hosted-agent-schedule.test.ts \
  test/hosted-qa-advance.test.ts test/hosted-qa-coding.test.ts \
  test/hosted-qa-teams.test.ts test/hosted-qa-jobs.test.ts \
  test/hosted-agent-teams-locator.test.ts test/hosted-agent-egress-redirect.test.ts
```

실제 Docker 진단은 기존 internal network `ainize-cicd-integration`, gateway port `19999`를 사용했다. 같은 포트의 실행이 없음을 확인한 뒤 실행한다. 운영 Docker network로 진단 host를 시작하지 않는다(`removeOrphans`가 해당 network의 hosted 컨테이너를 정리함).

- `e2e/hosted-qa-live-read.test.ts`: `AINIZE_QA_READ_FIXTURE`의 private JSON에 origin, tokenFile, config(workspaceId/channelId/enabledAt/maxAgeMs), messageId 필요. 실제 Teams에서는 읽기만 수행한다.
- `e2e/hosted-qa-live-coding.test.ts`: `AINIZE_QA_MODEL_CONFIG`에 서버 config 파일 경로, `AINIZE_QA_MODEL`에 실제 설정된 모델 ID 필요. 설정 내용/토큰을 출력하지 않는다.
- 두 테스트 모두 `AINIZE_CI_DOCKER_NETWORK`, `AINIZE_CI_DOCKER_GATEWAY_PORT`가 필요하다. production 등록이나 merge/deploy는 하지 않는다.

## 7. 기존 작업과 승인을 보존할 때 참고할 상태

아래 DB 상태는 2026-10-05 인수인계 작성 시 다시 읽었다. PR 최신 head/base/CI는 실제 병합 직전 별도 재확인이 필요하다.

| 서비스 / 작업 | 상태 | 후보 / 참고 |
| --- | --- | --- |
| Teams `70afe6dc` | 승인 대기 | `f526a2c0a17fa7d20c06795ad68b47714a790537`; PR [1410](https://github.com/ainetwork-ai/ainteams/pull/1410), [1411](https://github.com/ainetwork-ai/ainteams/pull/1411); [작업 페이지](https://ainmem.ainetwork.ai/p/2c4e3fe3-308c-5716-8aa3-e46415728bdb) |
| Teams `86382eed` | 승인 대기, 이전 조사에서 main 갱신 필요 | `1e51eba218915fb76fbd72563d11316391a6e446`; PR 1387/1388; [작업 페이지](https://ainmem.ainetwork.ai/p/04c0b8ed-a5cc-5d05-b252-3c40911b472b) |
| Ainize 웹 `2648f640` | 승인 대기 | `39b2ba37d5ac122fce3122997c8d5b28677c3ea5`; [PR 36](https://github.com/ainblockchain/ainize-web/pull/36); [작업 페이지](https://ainmem.ainetwork.ai/p/d9d2e941-fe3c-5e27-b7eb-8d2d4e6c3c8b) |
| Ainspace `e8486ea4` | 승인 대기 (배포 대상 확인: ainspace.ainetwork.ai, main 병합) | `6bec65cef4a05e42f52a668850fd728ba09c42d2`; [PR 198](https://github.com/ainetwork-ai/ainspace/pull/198); [작업 페이지](https://ainmem.ainetwork.ai/p/05bc68f6-d4ea-56c1-b614-811da475ffc5) |
| Aindrive `8d35710f` | failed / coding | Tailwind 보안 수정 후보 보존, 원격 게시 SHA 없음; [작업 페이지](https://ainmem.ainetwork.ai/p/a10a22b1-76e1-5653-9a14-cea902431063) |

- [QA 통합 보드](https://ainmem.ainetwork.ai/p/dc93cb1a-da26-402b-9964-fba52c77ca5c)의 `배포 승인` 보기와 정본 작업 페이지를 유지한다.
- Ainspace 배포 대상(2026-10-05 사용자 확인): 프로덕션은 `https://ainspace.ainetwork.ai/` 이며 Vercel 호스팅이다(`server: Vercel`, `x-vercel-id: icn1`). 저장소 `ainetwork-ai/ainspace`(기본 브랜치 `main`)에 Vercel Git 연동으로 연결되어, 승인된 커밋을 `main`에 병합하면 Vercel이 `vercel.json`의 `yarn lint && yarn test && yarn build` 를 거쳐 이 도메인으로 자동 승격한다. 즉 제품 게이트는 lint/test/build 이고, serving-SHA 확인은 이 도메인에 배포된 커밋을 승인 SHA와 대조한다. 세 후보(`ainspace-4g3e`/`ainspace`/`ainspace-uncommon-space`) 중 정확한 Vercel **프로젝트 이름**은 헤더·DNS·저장소에 드러나지 않아 여전히 Vercel 대시보드(Settings → Domains) 또는 토큰 있는 API에서만 확정된다. 병합 기반 배포에는 프로젝트 이름이 불필요하고, Vercel CLI/API 직접 배포가 필요할 때만 확정하면 된다. 추측으로 특정하지 않는다.
- Teams `70afe6dc`의 이전 기록에는 실제 Chromium layout 11 pass / 0 skip과 최종 커밋 검증이 있다. 네이티브 전환으로 이 제품 변경을 다시 만들 필요는 없다. 기존 검증 로그와 현재 PR을 확인한다.
- Aindrive 후보는 high audit 5→0, 1,088 tests pass / 3 todo, typecheck 통과까지 진행됐지만 Google Fonts DNS로 build가 막혔던 기록이 있다. 원래 후보와 로그를 보존하여 이어간다.
- 이전에 릴리스된 Teams/Ainmem/Ainize API/AINA 결과는 네이티브 전환 성공의 증거가 아니다. 최신 serving SHA를 재확인한다.
- Teams 브라우저 지연의 공통 5초 원인은 아직 확정하지 못했다. HAR은 모두 HTTP/2였으며 일부 요청의 TTFB/수신이 느렸다. 후속 nginx 샘플에서 느린 요청이 안 나왔다는 사실만으로 해결 판정하지 않는다.

### 기존 운영 자료

- Teams DB: `/mnt/newdata/ainteams-qa-state/jobs.sqlite3`.
- 기타 서비스 DB: `/mnt/newdata/qa-services/state/<service>/jobs.sqlite3`.
- jobs 시간 컬럼은 `created`, `updated`다(`updated_at` 아님).
- linked/hosted 등록: `/home/comcom/.ainize-web/data/linked-agents.json`, `hosted-agents.json`. 자격증명을 포함한 설정 전체를 출력하지 않는다.
- 네이티브 전환 조사 시 QA 6개는 모두 linked였고, Teams는 정식 org ID, 나머지 일부는 legacy `comcom` 값이었다. ID를 정규화하기 전에 실제 조직 접근권한을 확인한다.
- ComCom org: `org_9jrn9mc8pp65wj29d5jtx2ss7r`; Ainmem workspace: `2c88615f-4a30-43f8-9608-6ac977919dc0`; SSO issuer: `https://auth.comcom.ai`.
- 기존 Ainmem 승인 경로에는 정본 page/body digest/reviewed SHA/게시 시각 binding, literal approval, 활성 SSO 조직 멤버, 지정 승인자, 트랜잭션 중복 방지, 최종 Teams 채널 소속 확인이 있다. 새 경로로 옮길 때 조건을 약화하지 않는다.
- 전현정은 이전 확인에서 Teams workspace를 떠난 상태였다. 승인 권한 목록만 보고 채널 소속 검증을 생략하거나 임의로 재가입시키지 않는다.
- `qa-runtime-376e828-idle`, `qa-runtime-57c4a81-idle`, `qa-aindrive-reviewed-resume-20261005`는 **inactive**를 재확인했다. 사용자 아키텍처 수정으로 멈춘 구식 작업기 갱신/재개 helper이므로 다시 켜지 않는다.

## 8. 인수 후 첫 행동

1. 이 브랜치와 위 검증 결과를 읽고 현재 운영 job/unit/PR 상태를 다시 확인한다.
2. 작성 중이던 scheduler를 실제 Docker에서 검증하고 운영 QA handler에 연결한다.
3. 제품별 검증·게시와 Ainmem lifecycle을 구현한 뒤, 실제 관리자 승인을 보존하는 릴리스 경로를 연결한다.
4. 전 서비스의 실제 E2E와 serving SHA 확인 전까지 목표를 완료로 표시하지 않는다.

## 9. 2026-10-10 진행 상태와 남은 일

이 브랜치에서 자격증명 없이 안전하게 구현·검증 가능한 범위를 완료했다. 라이브 제품에
대한 쓰기·릴리스는 아래 "남은 일"로 분리했다.

### 완료 (브랜치 `hosted-qa-execution` 커밋)

- `a2a3f8e` 운영 핸들러 `examples/qa-agent/index.mjs` — 정본 Teams 검증 intake(locator는 힌트) + `tick`→`advanceCoding`. base SHA 고정 요청 키로 중복 제거. 배포 명령은 intake 아님. (§5-2)
- `e885db5` 검증 단계 `examples/qa-agent/validation.mjs` — `validateCandidate`가 게이트를 순서대로 실행하고 결과를 정확한 `candidateDigest`(repository+base+변경 파일)에 바인딩. `advanceValidation`은 lease 하에 한 단계 실행 후 `awaiting_approval`/`validation_failed`로 정차(게시·배포·승인 기록 없음). (§5-3 코어)
- `f30c700` Ainspace 배포 대상 확정: `https://ainspace.ainetwork.ai/`, Vercel Git 연동(`ainetwork-ai/ainspace` `main`), 게이트 `yarn lint && yarn test && yarn build`, 배포=main 병합. (§7 열린 질문 해소)
- `9b97c6e` 전체 스위트 재실행 기록 (720: 712 pass / 1 환경fail / 7 skip).
- `a4522b9` 실제 E2E 통과 기록 — 아래.

### 검증 완료 (실제 자격증명·실제 서비스, 프로덕션 무쓰기)

- `npm run typecheck` / `npm run build` 통과. 네이티브 QA 타깃 테스트 전부 통과.
- **live-read 통과**: 네이티브 Docker 핸들러가 실제 ainteams-qa 정본 Teams 메시지를 게이트웨이+실제 `TEAMS_TOKEN`으로 읽어 검증, 격리 SQLite enqueue, 재시작 후 중복방지, 위조 metadata 거부.
- **live-coding 통과**: 실제 `Qwen3.8-Flash-Next`가 네이티브 툴로 후보 수정→체크포인트 재개→격리 Docker 산술 검증 통과.

### 남은 일 (라이브 쓰기·릴리스 — 조율·사람 승인 필요)

> **블로커**: 외부 Python QA 워커(`qa_agent.server`, 단일 프로세스가 `--config`/`--extra-config`로 6개 채널 전부)가 **현재 라이브로 가동 중**이다. 네이티브로 같은 라이브 Teams/GitHub/Ainmem에 쓰기(후보 PR·Ainmem·merge)를 하면 이중 처리·중복 쓰기·충돌 배포가 난다. 따라서 아래는 **조율된 전환 없이 실행하면 안 된다.**

1. **운영 QA handler 조립 마감** (§5-2): `index.mjs`에 서비스별 신뢰 config 로딩·오류/재시도/terminal 상태·`needs_validation` 작업을 검증으로 깨우는 wake 정책을 연결. (현재 `index.mjs`는 intake+coding까지만 자동, 검증 wake는 host 정책으로 미연결 — 의도적 보류.)
2. **제품별 실제 게이트 러너 + GitHub 게시** (§5-3): `validation.mjs`의 주입 러너를 각 제품의 격리·무자격증명 컨테이너 게이트(예: Ainspace=`yarn lint && yarn test && yarn build`)에 연결하고, 검증 통과 후보를 정확한 SHA 바인딩으로 브랜치/PR 게시하는 `publish` 모듈 작성. read 토큰과 릴리스 자격증명 분리, main 자동 변경 금지.
3. **Ainmem 정본 작업 페이지 lifecycle** (§5-4): 요청별 한 페이지 재사용, 서비스 보드/통합 승인 보기, 상태·검증·PR·실패 사유 갱신, Teams 한 링크 보고, 외부 쓰기 중복방지.
4. **승인·릴리스 경로** (§5-5): Ainmem 정본 페이지/Teams 스레드의 **지정 승인자**가 **정확한 reviewed SHA**에 남긴 실제 승인을(활성 SSO 조직·채널 소속·시각 대조) 검증한 뒤에만 main 병합→Vercel 자동 배포→serving SHA 확인. 채팅·이름·metadata·모델 발언은 승인이 아니다. 과거 SHA 승인 재사용 금지.
5. **라이브 전환** (§5-6): 외부 Python 워커를 정지/퇴역하고 linked QA 6개 + 7개 profile을 native hosted로 이식. 기존 job/ID/페이지/승인 보존, 실행 중 작업 비중단. checkpoint 보존 정책 추가.
6. **전 채널 실제 E2E** (§5-7): 각 서비스 단순 요청 하나가 요청→native 실행→검증→PR→Ainmem→실제 관리자 승인→배포→serving SHA 확인까지 통과. 그 뒤 외부 Python 런타임 퇴역.
7. **운영 전제**: `.41`/노드 접근은 소유자의 `ain-vault ssh`(OTP는 사람이 입력), `acl`(setfacl/getfacl)을 운영 unit PATH에 정식 설치, 프로덕션 `AINIZE_HOSTED_SCHEDULED_AGENTS`는 완성·복구 검증 후에만(사용자 메시지로 켜지 않음) 활성화.

### 안전하게 남은 일을 재개하는 두 경로

- **A. 전용 테스트 채널**: 라이브와 분리된 workspace/channel ID와 테스트 저장소에서 요청→PR→Ainmem→(승인 시)배포 전 과정을 충돌 없이 실증.
- **B. 유지보수 창**: 외부 워커를 정지하고 한 제품을 실제로 끝까지 처리·검증 후 나머지로 확장하며 워커를 퇴역.

두 경우 모두 릴리스(merge)는 정본 경로의 지정 승인자 승인을 검증한 경우에만 수행한다.

이 문서와 코드에는 비밀번호, OTP, 토큰, 비밀키가 포함되어서는 안 된다.

## 10. 2026-10-10 코드 리뷰 후 복구 보완

검토 기준: origin/hosted-qa-execution `5cb280c`를 fast-forward한 상태.

### 확인하고 수정한 문제

- **P1 — 운영 handler 설정 누락:** `index.mjs`가 필수로 요구하던 `AINIZE_QA_CONFIG`를
  hosted Docker가 전달하지 않아 정상 등록된 handler도 시작할 수 없었다. 배포 파일의
  `index.mjs` 옆 `qa-config.json`을 기본으로 읽도록 수정했다. 명시적 경로 override는 유지한다.
- **P1 — 검증 결과의 코드 결합:** gate에 원본 `changes`와 변경 가능한 gate 목록을 넘겨,
  검증 도중 코드/목록이 변경되면 처음 계산한 digest와 실제 검증 대상이 달라질 수 있었다.
  변경 파일과 gate 목록을 복사하고 candidate를 동결했다. 잘못된 파일 경로/비문자열 내용과
  작업 repository/base에 맞지 않는 checkpoint도 gate 실행 전에 거부한다.
- **P2 — 실패 작업 반복 점유:** 설정이 달라진 작업을 claim한 뒤 그대로 반환하거나,
  모델 오류를 계속 재시도해 오래된 작업이 대기열을 점유할 수 있었다. 설정이 달라진 작업은
  보존한 채 대기시키고, 연속 실패 3회면 원인 확인을 기다린다. lease를 잃은 worker는
  다른 worker의 상태를 덮어쓰지 않는다.

### 검증 및 서버 확인

- 로컬: QA 및 scheduler 회귀 테스트 **35개 통과, 실패/skip 0**, typecheck 통과.
- Ainize .41 서버 Node v24.20.0: QA 테스트 **31개 통과, 실패/skip 0**.
  이후 추가한 repository 불일치 회귀 테스트는 위 로컬 35개에 포함된다.
- vault 저장 인증으로 SSH 연결 성공. 비밀정보/OTP를 출력하거나 저장소에 추가하지 않았다.
- `systemctl --user is-active ainize-public-node`: **active**.
  system 단위로 조회하면 inactive이므로 user unit을 확인해야 한다.
- 현재 release symlink: `20261010T113546Z-a0f0ce178b5c`.
- 이 변경으로 운영 agent 등록, 서비스 재시작, 제품 병합/배포를 수행하지 않았다.
  서버 테스트는 별도 임시 디렉터리에서 수행했다.

### 다음 작업 / 아직 해결되지 않은 리뷰 항목

1. **P2 — 메시지 재수신 중복:** intake request key가 base SHA를 포함한다.
   base 변경 후 같은 메시지가 재수신되면 새 작업이 생길 수 있으므로, 기존 SQLite key와
   작업 ID를 유지하는 migration/reconciliation을 구현한 뒤 채널을 전환한다.
2. 큰 tool 결과가 모델 context 예산을 넘을 때 최신 exchange 전체를 버리는 경로를
   재현하고, 모델이 같은 읽기를 반복하지 않도록 제한된 결과를 제공한다.
3. native handler tick에 실제 제품별 격리 검증 실행을 연결한다. 현재 `validation.mjs`는
   주입된 gate runner의 orchestration이며, 운영 gate 실행기와 연결된 상태가 아니다.
4. 검증된 candidate의 PR 게시, canonical Ainmem 카드 갱신, 실제 지정 관리자 승인,
   정확한 commit SHA의 release 및 배포 SHA 확인을 연결한다. `awaiting_approval`이라는
   내부 상태만으로 실제 승인 가능한 PR이 존재한다고 표시하지 않는다.
5. 기존 runner의 진행 중 작업과 상태를 대조하여 중복 writer 없이 한 제품부터 전환한다.
   전체 qa 채널 E2E 완료 또는 운영 migration 완료라고 보고하면 안 된다.

### 2026-10-10 추가 진행: canonical 메시지 중복 방지

위 남은 항목 1의 코드 수정 완료. `Jobs.enqueueTeamsRequest`는 service/workspace/channel/
parent/message identity를 SQLite transaction 안에서 대조한다. 기존 base-dependent key를 가진
작업도 그대로 반환하여 ID, 원래 base, checkpoint, 승인 및 Ainmem 참조를 보존한다. 신규 작업은
해당 identity의 SHA-256 key를 사용한다. SHA 변경만으로 새 작업을 만들지 않는다.

원문이나 repository가 달라졌거나 과거 작업이 여러 개 일치하면 자동 선택/병합하지 않는다.
운영 전환 시 이 충돌은 별도 대조가 필요하다. 회귀 테스트는 base 변경 후 재수신,
기존 key/승인/card 보존, 수정된 원문 거부, 과거 중복 작업 거부를 포함한다.
로컬 QA 테스트 34개 통과(실패/skip 0). 운영 writer 전환은 아직 수행하지 않았다.

### 2026-10-10 추가 진행: Ainmem API와 native 보고 연결

- Ainmem 별도 작업트리 `/Users/kmh4500/git/ainmem-native-qa`, branch `native-qa-task-api`.
  API 구현 `c669e42`, PostgreSQL/HTTP 통합 테스트 `006ff95`.
- 새 Ainmem `PUT /api/qa/tasks/:jobId`: agent token, workspace membership, board/host edit
  permission 확인. 동일 ID/revision 재시도 허용, stale/conflicting revision 거부. 페이지/행/관리
  paragraph를 transaction으로 갱신하고 사람의 다른 블록과 댓글을 보존한다.
- Ainize `ainmem.mjs`: 지속 outbox, HTTP 응답 유실/재시작 재시도, revision 결합,
  canonical URL 검증, board binding 변경 거부. 선택적 `ainmem` 설정을 handler에 연결했다.
  요청 접수 응답은 성공 시 작업 링크 1개. tick은 대기 보고 재시도와 상태 갱신을 수행한다.
- 검증: Ainmem 실제 PostgreSQL 16 + HTTP route 테스트 5개 통과; Ainize QA 테스트
  37개 통과 및 typecheck 통과. Ainmem 화면/전체 Next 런타임 E2E 증거는 아직 없다.
- 미완료: legacy canonical 페이지 채택, 초기 보고 실패 후 Teams 링크 후속 알림,
  영구 실패 보고가 다른 보고의 재시도를 막지 않는 정책, 제품 검증/PR/승인/배포 전체 흐름.
  두 구현 모두 운영 채널에 활성화하거나 배포하지 않았다. old/new writer 동시 활성화 금지.

### 2026-10-10 후속: 보고 재시도와 기존 페이지 전환

- Ainize 보고 outbox에 지속 재시도 순서를 추가했다. 실패한 보고도 순서를 뒤로 옮겨,
  5개 이상의 실패 항목이 뒤의 정상 작업을 계속 막지 않는다. 배치의 일부가 실패해도
  다른 항목을 시도하며, 성공한 현재 작업 링크는 반환한다. 기존 SQLite schema 자동 보완.
- 관련 QA 테스트 39개 통과. 실패 5개 뒤 정상 2개가 있는 경우와 재시작 복구를 포함한다.
- Ainmem `native-qa-task-api`에 operator-only legacy mapping 지원 추가. 지정된 기존
  row/page/progress block과 원래 작성자, 작업 ID 속성을 확인하고 canonical ID를 유지한다.
  실제 HTTP/PostgreSQL 테스트 6개, contract 테스트 4개, typecheck 통과.
- 이 기능은 실제 운영 legacy 작업 import 및 승인 기록 migration 완료의 증거가 아니다.
  운영 mapping 설치/배포/채널 전환은 아직 하지 않았다. 다음은 기존 작업 metadata와
  approval SHA/history를 안전하게 import하고, 실제 화면·제품별 검증/게시/승인을 연결하는 일.

### 2026-10-10 후속: 운영 이력 23건의 격리 이전 시험

- `import-legacy.mjs` 추가. legacy SQLite를 read-only transaction으로 읽고 native 대상에
  ID/시간/원문/detail/report 전체를 보존한다. private immutable checkpoint 사용.
  승인 데이터는 archive로 보존하며 native release permission으로 자동 변환하지 않는다.
- 실제 서버 설정 7개: Teams 11, AINA 2, Aindrive 2, Ainize web 2, Ainize API 3,
  Ainmem 2, Ainspace 1 = 23건. 원본을 수정하지 않고 격리된 새 대상 DB에 이전 성공.
  재실행도 모두 unchanged였고, 7개 대상 모두 claimable=false.
- 최종 시험 위치: `/mnt/newdata/qa-services/validation/native-import-final-20261010-FUB6T3`.
  파일에는 private 작업 이력이 있으므로 Git에 넣거나 공개 출력하지 않는다.
- 로컬 QA 테스트 42개 및 typecheck 통과. terminal 상태 보존, 승인 이력 보존,
  동일 message 재수신 시 원래 ID 재사용, 중복 import, 원본 변경/작업 중 상태 거부 검증.
- 운영 writer/agent/채널은 전환하지 않았다. 다음 단계는 후보 branch/검토 SHA/현재 PR
  및 canonical Ainmem page를 대조하고 native 검증/게시/승인 경로로 재개할 수 있게 연결하는 것.
  스냅샷에 과거 승인이 존재한다는 이유로 merge하거나 배포하면 안 된다.

### 2026-10-10 후속: GitHub 현재 상태와 운영 배포 대조

GitHub API를 직접 읽어 확인한 최신 상태이며 이전 승인 대기 표보다 우선한다.

- Teams PR #1410(main), #1411(develop): **둘 다 MERGED**. 후보는 기존
  `f526a2c0a17fa7d20c06795ad68b47714a790537`, 병합 SHA는
  `e183df9d82340998cdeb481ffa427d6bbc354df1`. 각각 10월 8일/6일 병합.
- Teams `/api/health`: status ok, database/meilisearch/realtime 모두 ok, version `f118bbfea`.
  GitHub compare(병합 SHA...serving version)는 ahead, behind_by=0, merge base가 병합 SHA와
  일치하므로 현재 배포에 해당 병합이 포함된다. 실제 화면 여백 회귀가 해결됐다는 증거는 아니다.
- Ainize web PR #36: OPEN, 기존 head `39b2ba37d5ac122fce3122997c8d5b28677c3ea5`와 일치.
- Ainspace PR #198: OPEN, 기존 head `6bec65cef4a05e42f52a668850fd728ba09c42d2`와 일치.
- 열린 후보는 최신 base 기준 재검증 대상으로 분류했다. 과거 승인/검증을 자동 재사용하지 않는다.

`reconcile.mjs`는 configured repo/branch/후보 SHA를 원격 PR과 대조하고,
이미 병합됨/후보 변경/병합 없이 닫힘/재검증 필요를 구분한다. legacy job의 immutable
이력과 별도로 원격 증거를 저장하며 release authority를 추가하지 않는다.
`verifyDeploymentCommit`은 serving SHA의 merge ancestry만 확인하고 featureRegressionVerified=false를
명시한다. 이 함수는 실제 화면 검증이나 전체 채널 성공 판정을 대신하지 않는다.
QA 테스트 46개 통과. 운영 PR/작업 상태를 수정하거나 추가 배포하지 않았다.

### 2026-10-10 후속: 실제 제품 격리 검증 실행기

- `src/hosted-qa-validator.ts` 추가. host가 exact Git base를 export하고 candidate 파일을
  적용해 pinned dependency image에서 실제 product gate argv를 실행한다.
  network none, read-only root, non-root, no capabilities/new privileges, 자원/시간 제한.
  source/package lock과 dependency image 일치 확인. 코드/검증 digest 결합 및 실패 시 중단.
- Ainspace PR #198의 실제 tree에 원래 README를 그대로 덮은 진단 candidate로 실행.
  4GB에서 lint/test 통과, build exit 137(Killed). 전체 검증 통과가 아니다.
  8GB build 재실행을 시작했다. 실행 증거/한계는 `docs/QA-PRODUCT-VALIDATOR.md` 참고.
- 검증 통과 상태를 needs_publication으로 변경했다. 아직 게시된 PR이 없는 상태를
  awaiting_approval로 표시하던 문제를 수정했다.
- 로컬 QA suite 47개 및 typecheck 통과. 서버 실행기는 production gateway/tick에 아직
  연결되지 않았다. 검증 runner 코드 존재를 모든 채널 자동 실행 완료로 간주하면 안 된다.

### 2026-10-10 후속: 검증 gateway/tick 연결

- Ainspace 8GB build 재실행 통과. 기존 PR tree의 lint/test/build 증거를 확보했다.
  이 결과는 최신 main 반영이나 실제 화면 회귀 통과의 증거는 아니다.
- host validation service + private runtime gateway + ctx.qa.validate + native handler tick 연결.
  설정된 agent/repo/base만 실행하며 commands/images/checkout은 operator profile에서 결정.
  실행 중 요청은 polling, 다른 후보는 busy, 완료 receipt는 private 파일에 보존하여 재사용.
- QA/scheduler 테스트 52개, 기존 gateway/runtime 회귀 26개, typecheck 통과.
- 실제 Docker 제품 실행과 실제 HTTP gateway test는 각각 통과했지만 둘을 합친 hosted
  Docker 전체 통합 실행은 아직 하지 않았다. production profile/schedule 설치도 아직이다.
- 제한: host crash 시 orphan validation container 정리, 일시적 infrastructure 실패 receipt의
  재시도 정책, profile 변경/정리 정책을 운영 전환 전에 점검해야 한다. 기존 단계 이력·승인
  재검증과 PR 게시/배포/전 채널 화면 E2E도 여전히 남아 있다.

### 2026-10-10 후속: 실제 hosted Docker 검증 연결 통과

- `.41`에서 실제 hosted runtime → Unix gateway → host validation service → 제품 검증
  container → durable job 상태 전환 시험 통과. 1 test, 0 fail, 0 skip, 약 19초.
- A2A intake 1회 후 host scheduler가 자동 진행. 에이전트 재시작에도 job ID 유지,
  validator 실행 1회, 최종 needs_publication. 이 진단은 기존 Ainspace 후보의 lint를
  실행했으며 새 모델 코드 수정/실제 채널 요청/PR 생성/운영 배포를 포함하지 않는다.
- 첫 시도 observer가 초당 A2A 호출로 rate limit에 걸려 실패했다. observer를 durable
  SQLite read로 수정한 뒤 전체 시험 통과. 실제 작업 요청은 추가로 보내지 않는다.
- 증거: `/mnt/newdata/qa-services/validation/native-gateway-20261010-ZhEcNt/integration-retry.log`.
  임시 agent/validator container와 agent image가 남아 있지 않음을 Docker로 확인했다.
- 다음 주요 미완료: PR 게시 단계 및 검토 SHA 결합, 실제 관리자 승인 재검증/배포,
  Ainmem 페이지 UI와 전체 채널별 신규 요청 E2E. 운영 schedule/profile은 아직 미활성화.

### 2026-10-10 검증 기록 재검증 보완

- 호스트 검증 서비스가 결과를 저장하고 다시 읽을 때 repository/base/candidateDigest 및 운영자가 지정한 게이트 순서·완료 여부를 대조한다. 다른 후보의 결과나 필수 게이트가 빠진 성공 기록을 거부한다.
- `requirePassed(agentId, candidate)`는 저장된 호스트 검증 기록만 읽는 게시 전제조건이다. 검증 실행을 시작하지 않으며, 에이전트·후보·검증 정책 변경 시 과거 성공을 재사용하지 않는다. 아직 GitHub 게시 경로에 연결하지 않았다.
- 관련 QA 테스트 51개 통과, 실패/skip 0. 타입 검사 통과. 실제 PR 게시·승인·배포 E2E 완료를 의미하지 않는다.

### 2026-10-10 GitHub 후보 게시 코어

- `src/hosted-qa-publication.ts`에 호스트 전용 게시 코어를 추가했다. 운영자 repo/branch 설정과 `requirePassed`로 검증된 후보만 draft PR로 게시한다. merge 기능은 없다.
- 기존 파일의 실행 권한을 보존하고, 생성된 Git tree의 전체 파일 SHA/권한을 검증 후보와 대조한다. 에이전트·작업·후보 digest로 브랜치를 정하고 고정 커밋 메타데이터를 사용한다. 응답 유실 후 재조회하며, 원격 브랜치/PR이 바뀌면 덮어쓰지 않는다. 게시 전후 base를 재확인한다.
- 단위 테스트에서 응답 유실, 재시작 후 중복 방지, 바뀐 base/branch/닫힌 PR, 다른 tree, 검증 기록 부재, 토큰 오류 비노출을 확인했다. 전체 QA 타깃 55개 통과, skip 0. 빌드 통과.
- **아직 운영 gateway/tick에 연결하지 않았고 실제 GitHub 쓰기 실증도 하지 않았다.** 다음 단계는 비밀 게시 토큰을 호스트에만 유지하는 설정, 비동기 게시 상태/체크포인트, Ainmem PR/SHA 표시 연결 및 격리된 실제 게시 검증이다. 운영 QA 중복 작업기를 먼저 확인해야 한다.

### 2026-10-10 게시 단계 연결

- 호스트의 비동기 publication 서비스와 런타임의 `ctx.qa.publish`를 연결했다. 게이트웨이 인증으로 에이전트를 결정하며, 요청에 다른 agent ID를 넣을 수 없다. GitHub token은 host에서만 읽는다.
- opt-in 설정: `AINIZE_QA_PUBLICATION_PROFILES`는 agent ID → `{repository,branch}` JSON 파일 경로, `AINIZE_QA_PUBLICATION_TOKEN_FILE`은 private 일반 파일 경로다. 기존 host validation 설정이 필수다. 운영 환경에는 아직 설정하지 않았다.
- 서비스 handler 설정 `hostPublication:true`가 있으면 검증 통과 후 자동으로 게시를 진행한다. 원격 작업은 host에서 실행하고 handler는 상태만 조회한다. PR/SHA receipt를 immutable checkpoint에 저장한 뒤 `awaiting_approval`에서 멈춘다. 이 단계는 승인 기록이나 merge를 만들지 않는다.
- Ainmem 상태 보고에 검토 PR과 정확한 커밋을 추가했다. 실제 Ainmem 서버에서 승인 댓글을 수신하는 경로는 여전히 남아 있다.
- 실제 private HTTP gateway + SQLite/checkpoint + Ainmem outbox 통합 테스트 및 handler tick 테스트 통과. GitHub 응답은 테스트 대체 구현이며 실제 PR 쓰기 실증은 아니다. 관련 QA 테스트 57개 pass / 0 skip, 타입 검사·빌드 통과.
- 다음: 실제 GitHub 게시 실증, 게시된 SHA에 결합된 사람 승인 확인, 릴리스/serving SHA 확인, 운영 상태 보존 전환과 전 채널 E2E. 게시 polling의 host 완료 캐시는 60초이며 재시작 시 원격 ref/PR을 재대조한다. 실패 작업은 후보를 보존한 채 대기하므로 운영 재개 정책이 필요하다.

### 2026-10-10 실제 GitHub 게시 검증

- 실제 .41 Docker에서 기준 `33261b2ba0ba330749130a5b07b80958fa595813` + 진단 문서 1개 후보를 검증했다. `npm run typecheck`와 게시/게이트웨이/검증 기록 관련 테스트 게이트가 모두 통과했다. 실제 제품 수정 요청 E2E를 대신하는 결과는 아니다.
- 기존 API seed에는 개발 의존성이 없어 `tsc`가 없었다. 같은 package-lock으로 `npm ci --include=dev --ignore-scripts`를 실행한 검증 전용 이미지를 만들었다. 설치는 이미지 준비 단계이고 제품 게이트 실행은 network none이다.
- 의존성을 seed로 symlink하면 TS2742가 발생했다. 각 격리 작업 폴더에 의존성을 복사하고 상대 .bin 링크를 보존하도록 수정했다. Docker tmpfs 기본 noexec 때문에 복사된 도구 실행이 거부되어 해당 임시 작업 공간에만 exec를 명시했다. root filesystem read-only, 비root 사용자, network none, cap-drop ALL은 유지한다. 검증기 정책 버전도 receipt 키에 포함해 이전 실행 정책의 성공/실패 기록을 재사용하지 않는다.
- 실제 게시기는 [초안 PR #69](https://github.com/ainblockchain/ainize-node/pull/69)를 만들었다. base는 개발 브랜치 `hosted-qa-execution`, 변경은 `docs/QA-PUBLICATION-LIVE-CHECK.md` 1개뿐이다. main 변경/merge/배포는 없다.
- 게시기 인스턴스를 새로 만든 뒤 같은 후보를 재게시해 동일 PR 번호·브랜치·커밋 `81ea77434b40c65f1166afedc0de8956d91edfff`를 반환함을 확인했다. PR을 별도 조회해 draft/open/base/head/파일 목록을 대조했다.
- 서버 증거: `/mnt/newdata/qa-services/validation/native-publication-20261010-7vIY21` (`profile.json`, `candidate.json`, `result.json`, `published.json`, `retry.json`, `run.mjs`, Dockerfile/빌드 로그). 검증 컨테이너가 남지 않았음을 확인했다.
- 검증 이미지: `sha256:457897dc8ad84cac7fa3feebe1b81032d96b84b5ed0acc7456e1c6ee2796b6ba`. 개발용 이미지 준비 변경은 운영 실행 이미지나 에이전트 설정을 바꾸지 않았다.
- 로컬 관련 QA 테스트 57개 통과, 빌드 통과. 승인 댓글 연결·릴리스·라이브 전환·전 채널 E2E는 여전히 미완료다.

### 2026-10-10 승인 검증 코어

- `src/hosted-qa-review.ts`: 호스트가 게시한 정본 Ainmem 본문/PR/전체 SHA와 서버 관측 시각을 검토 기준으로 고정한다. 다시 읽은 페이지 ID·본문·revision·digest, PR head/base/저장소, 지정 관리자 SSO subject, 활성 Teams 채널 소속을 모두 대조한다. `LGTM`/`배포해`의 단독 문구만 인정하며, 최초 제시 시각 이전 댓글·다른 조직/채널·에이전트·정지 멤버·바뀐 후보는 승인하지 않는다.
- Ainmem 읽기 어댑터는 설정된 HTTPS origin과 호스트 토큰만 사용한다. 응답 redirect를 거부하고 정본 task API만 읽는다. 모델 metadata나 표시 이름은 권한 근거가 아니다.
- Ainmem API의 `observedAt`은 댓글과 같은 PostgreSQL 시계에서 읽도록 별도 Ainmem 브랜치를 보완했다. 승인 코어는 새 관측을 요구하며 오래된 스냅샷을 거부한다.
- QA 타깃 테스트 62개 통과, 타입 검사/빌드 통과. 승인 코어 테스트는 권한 취소·후보 변경·옛 댓글·본문 변경·정본 경계/redirect를 포함한다.
- **운영 승인 연결은 아직 미완료**: 코어에 전달할 호스트의 검토 기준을 durable하게 저장하고, 실제 Teams SSO subject/조직/채널 멤버십을 조회하는 어댑터를 연결해야 한다. 현재 코어는 승인 증거만 반환하고 merge 도구를 제공하지 않는다. 실제 사용자 승인 댓글을 소비하거나 배포하지 않았다. 단위 테스트의 관리자 ID는 운영 권한 설정이 아니다.

### 2026-10-10 실제 Teams 승인자 멤버십 조회

- `src/hosted-qa-teams-review.ts`는 기존 운영 설정의 검증된 `issuer + newline + subject → Teams user ID` 매핑을 사용한다. 이름으로 매핑하지 않으며 누락/중복 매핑을 거부한다. 각 조회마다 `list_channels`로 workspace/channel 관계를 확인하고 `list_channel_members`로 현재 사람 멤버만 남긴다.
- 여기서 반환하는 org/issuer는 운영 매핑의 범위다. 실제 SSO 계정/조직 활성 상태는 Ainmem 정본 API에서 별도로 검증한다. Teams에 없는 SSO 사용자나 SSO에서 비활성인 Teams 사용자는 양쪽 검증을 모두 통과할 수 없다.
- 실제 .41에서 운영 agent 토큰을 비공개로 읽어 네이티브 TeamsMcp와 새 어댑터를 실행했다. 7개 서비스 모두 조회 성공: Teams/Ainmem/Aindrive/Ainize 웹/Ainize API는 설정된 승인자 4명 중 현재 사람 채널 멤버 2명, AINA/Ainspace는 5명 중 3명이다. 현재 채널을 떠난 승인자는 제외했다. 재가입/설정 변경/메시지 게시/승인은 하지 않았다.
- 증거: `/mnt/newdata/qa-services/validation/native-review-members-20261010-cjpgqw/result.json` 및 `run.mjs`. 로그에는 토큰·SSO subject·사용자 ID를 출력하지 않았다.
- 관련 QA 테스트 64개 통과, 빌드 통과. 운영 호스트의 durable 검토 기준 저장 및 승인/merge 루프 연결은 아직 남아 있다. 이 조회는 실제 사용자 승인을 받은 것이 아니다.

### 2026-10-10 호스트 검토 기록 및 승인 조회 조합

- `hosted-qa-review-store.ts`: 호스트 private SQLite에 최초 제시 시각과 후보/본문/페이지 바인딩을 저장한다. 재시작·같은 게시 재시도는 최초 시각을 보존한다. 후보/본문/관리자 정책 변경 시 새 generation을 만들며, 과거 후보로 돌아와도 이전 승인을 재사용하지 않는다. 이전 generation의 늦은 게시/승인 관측은 트랜잭션 비교로 거부한다. 과거 검토 기록은 보존한다.
- `hosted-qa-review-coordinator.ts`: 호스트 설정의 제품/보드/조직/채널 범위를 검사하고, 매번 GitHub PR·실제 Teams 멤버십·Ainmem 정본을 새로 조회한 뒤 승인 코어에 전달한다. 승인자 정책과 검증된 SSO→Teams 매핑도 검토 기준에 결합했다. 운영 정책이 바뀌면 검토를 다시 제시해야 한다.
- 관측 결과는 감사 기록이며 영구 배포 권한이 아니다. 이전 관측이 성공해도 다음 검사에서 권한이 사라지면 null을 반환한다. gateway에는 사용자/모델이 승인 여부를 제출하는 경로를 추가하지 않았다.
- 관련 QA 테스트 67개 통과. 후속 정책 바인딩 변경 뒤 승인 관련 8개 재검증과 빌드 통과. 파일 권한, 재시작, 취소, 후보 되돌림, 늦은 처리, 정책 변경을 검증했다.
- 남은 연결: 운영 publication/report 완료 후 호스트 `register` 호출, awaiting approval 작업을 이 coordinator로 주기 확인하는 scheduler, 실제 승인 직후 exact-SHA merge와 배포 확인. 새 호스트 ledger/coordinator는 아직 운영에 설치하지 않았다. 실제 승인이나 배포를 수행한 결과가 아니다.

### 2026-10-10 게시 → 호스트 승인 확인 루프 연결

- 호스트 publication 서비스가 성공 응답 전에 private review ledger에 검증된 PR receipt를 저장한다. 저장 실패는 성공으로 응답하지 않는다. 재시작 후에도 확인할 작업 목록을 유지한다. 같은 job의 다른 PR/SHA를 조용히 덮어쓰지 않고 명시적 재조정을 요구한다.
- `hosted-qa-review-loop.ts`는 먼저 Ainmem 카드의 승인 대기 상태·정확한 PR/SHA 표시를 확인하고 검토 기준을 등록한다. 이후 매번 정본을 재조회한다. 단일 실행, 작업별 오류 격리, 재시도 순환, 종료 시 진행 중 읽기 drain을 적용했다. 같은 승인 댓글의 반복 확인은 감사 행을 무한히 늘리지 않는다.
- 서버 opt-in 환경 변수 `AINIZE_QA_REVIEW_PROFILES`: agent ID → `HostedReviewProfile` (`repository`, `branch`, `databaseId`, `policy`, `identities`) + `ainmemOrigin`, `ainmemTokenFile`, `teamsOrigin`, `teamsTokenFile` JSON 파일 경로. 토큰 파일은 private 일반 파일이어야 한다. publication/validation 설정이 필수다. 30초마다 최대 5개 작업을 확인한다. **운영 설정은 아직 활성화하지 않았다.**
- host 전용 `teamsReviewClient`는 list_channels/list_channel_members만 허용하고, HTTPS·redirect 거부·세션·SSE 응답 ID 대조·오류 비공개를 적용한다. .41에서 실제 7개 서비스 조회를 다시 성공했다. 증거는 `native-review-members-20261010-cjpgqw/host-client-result.json`에 있다.
- QA 테스트 70개 통과. 후속 감사 중복 방지 뒤 review 테스트 11개 재검증 및 빌드 통과. publisher→durable queue→카드 대기→검토 등록→정본 확인을 테스트했다. 실제 토큰 조회 실증은 Teams 읽기만 수행했다.
- 아직 merge/배포를 실행하지 않는다. 실제 승인 직후 exact-SHA merge·배포 상태 확인, Teams 원본 스레드 승인 경로, 운영 상태 보존 전환 및 전 채널 실제 요청 E2E가 남아 있다. Ainmem 새 API 역시 별도 배포가 필요하다.

### 2026-10-10 승인된 정확한 커밋 반영 어댑터

- `hosted-qa-release.ts`는 명시적으로 설정한 `fast-forward-unprotected` 대상만 처리한다. 현재 host validation 정책의 성공 기록과 원래 candidate digest, 검토 generation, 최신 실제 관리자 승인, PR/head/base, 후보의 단일 부모가 검증 base인지 확인한다. publication ledger에 원본 후보도 보존하도록 연결했다.
- 외부 쓰기 전에 SQLite에 release intent를 남기고 GitHub ref에 `{sha: reviewedSha, force:false}`를 보낸다. 검증 후 main이 다른 후속 커밋으로 전진하면 non-fast-forward로 거부되어 그 변경을 덮어쓰지 않는다. 응답 유실/재시작은 기존 intent와 실제 ref를 대조하며, 이미 반영된 경우 재쓰기 없이 관측 기록만 남긴다.
- 보호 규칙 우회는 하지 않는다. branch 상세의 `protected:false`와 공식 `branches?protected=false` 목록(최대 20페이지)을 모두 확인한다. 보호 브랜치/불완전 관측은 별도 merge 어댑터가 필요하다. 일부 비공개 저장소의 rules/protection 관리 API는 요금제 제한 403을 반환하므로 이를 보호 없음으로 간주하지 않는다. Teams main은 페이지 순회 후 비보호 목록에 있는 것을 실제 조회로 확인했다. 설정은 변경하지 않았다.
- 서버 opt-in: `AINIZE_QA_RELEASE_PROFILES`는 agent ID → `{repository,branch,mode:"fast-forward-unprotected"}` JSON 파일 경로, `AINIZE_QA_RELEASE_TOKEN_FILE`은 별도 private 호스트 토큰 파일이다. review/publication/validation 설정이 필수다. 모델/agent container에 release token을 전달하지 않는다. **운영에서는 아직 비활성이다.**
- 성공 receipt는 `branch_updated`, `deploymentVerified:false`다. GitHub PR merged 상태와 실제 서비스 배포/serving SHA 확인은 별도 단계이며 아직 미구현이다. 보호 저장소 전용 merge 방식, 변경 base 재검증, 실제 사람 승인 릴리스 E2E도 남아 있다. 이 코드 추가로 main을 변경하지 않았다.
- QA 타깃 75개 통과 및 빌드 통과. 검증 정책 변경 테스트 추가 후 release 테스트 6개 통과. 승인 없음, 보호 규칙, 동시 main 갱신, 잘못된 ancestry, 응답 유실/서비스 재생성, 변경된 검증 정책을 검증했다. 실제 GitHub 쓰기/배포 테스트는 아직 수행하지 않았다.

### 2026-10-10 실제 배포 커밋 관측

- `hosted-qa-deployment.ts`는 정본 PR의 저장소/head/base 및 merged 기록을 확인하고, 설정된 HTTPS 상태 API의 필수 건강 조건과 실행 revision을 읽는다. GitHub에서 full SHA를 해석한 뒤 검토 후보와 merge commit이 모두 serving commit의 조상인지 확인한다. 열린 PR·옛 배포는 pending이며 revision 없는 건강 응답/semver/깨진 의존성은 완료 증거가 아니다.
- host review loop는 branch_updated 이후 이 확인을 수행하며, 성공 시에만 `deployment_verified` receipt를 저장한다. UI 회귀 검증은 별도이므로 `featureRegressionVerified:false`를 유지한다.
- opt-in `AINIZE_QA_DEPLOYMENT_PROFILES`: agent ID → `{repository,branch,url,revisionPath:string[],healthy:[{path:string[],equals:string|boolean}]}` JSON 파일. review 설정이 필수다. 운영에서는 아직 설정하지 않았다.
- 실제 Teams PR1410 재조회: 후보 `f526a2c0a17fa7d20c06795ad68b47714a790537`, merge `e183df9d82340998cdeb481ffa427d6bbc354df1`이 serving `f118bbfea579984dabb6d652a2d5219bdce8708a`에 포함됨을 새 코드로 확인했다. 상태/DB/Meilisearch/realtime 모두 ok. 이는 과거 PR의 읽기 전용 배포 관측이며 새 배포를 실행한 것이 아니다.
- 실제 Ainspace PR198은 여전히 `awaiting_merge_evidence`로 판정했다. 건강한 기존 서비스가 있다고 열린 후보를 배포 완료로 바꾸지 않는다.
- 현행 공개 API 조사: Teams `/api/health`는 `version`, Ainspace `/api/health`는 `sha`를 제공한다. Ainmem `/api/health`는 `ok`만, Aindrive `/api/healthz`는 건강 상태만 제공한다. Ainize `/api/info`의 node.version은 semver이고 node.build는 날짜다. AINA `/api/health`와 Ainize `/api/health`는 404였다. 따라서 나머지 서비스에는 별도의 실제 실행 revision 증거/어댑터가 필요하다.
- QA 타깃 테스트 80개 통과, 빌드 및 타입 검사 통과. 운영 전환·상태를 agent/Ainmem으로 환류·실제 사람 승인 릴리스·전 서비스 E2E는 여전히 남아 있다.

### 2026-10-10 실제 Teams 원본 스레드 읽기

- `hosted-qa-teams-thread.ts`는 신뢰된 원본 요청 바인딩(workspace/channel/root/request/author/time/content digest)에서 출발한다. 채널 목록·채널 페이지 조회로 root가 실제 지정 채널에 속함을 확인하고, `read_thread`의 parent가 같은 원본인지 재대조한다. 요청이 답글인 경우 그 답글의 작성자·시각·내용을 검증한다. 변경된 요청, 다른 스레드 답글, 중복 ID, 불완전 응답, 순환 cursor를 거부한다.
- 마지막에 실제 채널 멤버십과 운영 SSO→Teams ID 매핑을 새로 읽고, 사람인 지정 승인자의 literal `LGTM`/`배포해` 답글만 관측 자료로 반환한다. 표시 이름·인용문·봇 메시지는 사용하지 않는다. **반환값은 `approvalGranted:false`이며 이 모듈만으로 배포를 승인하지 않는다.**
- 호스트 MCP client에는 `read_channel`/`read_thread` 읽기만 추가했다. 쓰기 도구는 여전히 거부한다.
- 실제 .41 진단: 7개 서비스 설정 모두 실제 채널의 최근 사람 원본 메시지와 스레드 읽기 성공. Ainmem 설정에서 지정 관리자 매핑의 literal 답글 1개를 관측했다. 그 답글은 검토 SHA/최초 제시 시각/현재 SSO 조직 권한에 결합하지 않았으므로 승인으로 소비하지 않았다. 진단 바인딩은 실제 QA intake의 영구 등록을 대신하지 않는다.
- 서버 증거: `/mnt/newdata/qa-services/validation/native-thread-read-20261010-vZMOzm/run.mjs`, `result.json`. 2026-10-10 13:05 UTC 관측. 토큰·개인 ID·대화 본문은 결과 로그에 넣지 않았고, 서비스 메시지/페이지/PR/배포는 변경하지 않았다.
- QA 타깃 테스트 90개 통과, 실패/skip 0. 빌드 통과. 다음 연결은 호스트가 검증·저장한 intake/thread 바인딩, 정확한 검토 후보 제시, 현재 SSO 조직 상태 조회, 이를 결합한 coordinator 검증이다. 원본 Teams 스레드 승인 경로는 아직 운영 활성화하지 않았다.

### 2026-10-10 Teams 답글 + 현재 SSO 권한 + 검토 후보 결합

- Ainmem task GET의 선택 reviewerSubjects 필터와 reviewers 응답을 추가했다(별도 `native-qa-task-api` 브랜치). 실제 댓글 유무와 무관하게 요청된 subject들의 현재 사람 계정/SSO 로그인/활성 조직·workspace/계정 정지/이전 보류를 검사한다. Ainmem 댓글 승인은 기존 페이지 comment 권한 검사도 그대로 유지한다.
- `verifyTeamsApproval`은 변경되지 않은 정본 Ainmem 검토 카드와 exact PR/head/base/digest, 원본 Teams 요청 바인딩, 최신 스레드·채널 멤버십, 현재 SSO 적격 subject, 제시 이후 literal 답글을 결합한다. 오래되거나 누락된 SSO 응답, 다른 스레드, 이전 SHA/시각, 권한 취소는 통과하지 않는다. Teams comment ID를 별도 namespace로 저장해 Ainmem 댓글 ID와 충돌하지 않게 했다.
- host coordinator의 register/check에 선택 `ReviewTarget.teamsRequest`를 연결했다. 원본 요청을 등록 때와 매번 승인 검사 때 실제 Teams에서 재검증한다. 최신 SSO 조회는 Teams 조회 후 수행한다. host ledger도 Teams 승인 증거의 원본 thread/request를 확인한다. 서버 reader는 운영 정책의 지정 subject만 Ainmem에 전달한다.
- 아직 publication/intake 경로는 teamsRequest를 등록하지 않는다. 모델/승인 메시지에서 이 바인딩을 받아 채우면 안 된다. 다음 작업은 호스트가 실제 QA 접수 원본을 확인해 영구 저장하고 publication/review에 연결하는 것이다. 현재 운영은 기존 Ainmem 승인 경로를 유지하며 새 경로는 비활성이다.
- QA 타깃 테스트 93개 통과, skip 0, 빌드 통과. Ainmem은 실제 서버 PostgreSQL+HTTP 테스트 7개와 타입 검사 통과. 운영 배포·실제 사람 승인 소비·main 변경은 수행하지 않았다.

### 2026-10-10 네이티브 접수 → 원본 스레드 → 검토 연결

- `/qa/intake`는 agent token으로 식별한 호스트 설정만 사용한다. 입력은 job ID와 message/parent locator뿐이며, 작성자·본문·시각은 실제 Teams에서 다시 읽는다. 운영 설정 `intakeEnabledAt` 이후 24시간 이내의 실제 사람 수정 요청만 신규 등록한다. 문자 그대로의 배포 명령은 접수가 아니다.
- private review SQLite에 agent/job → 원본 workspace/channel/root/request/author/time/content digest를 저장한다. 같은 원본 요청을 다른 job으로 등록하거나 기존 job의 원본을 바꾸면 거부한다. 재시작 후 동일 job 재시도는 저장된 바인딩을 재사용한다. 비동기 확인 중에는 gateway가 running을 반환하고 handler가 다음 tick에 조회하므로 긴 MCP 조회로 HTTP 응답을 붙잡지 않는다.
- `hostReview: true` handler는 코딩/검증/게시 전에 호스트 접수를 확인하고 원본 본문 digest까지 대조한다. `intakeEnabledAt`을 설정한 호스트 profile은 저장된 접수가 없으면 GitHub 게시를 시작하지 않는다. 성공한 publication ledger에 호스트 저장 바인딩을 첨부하고 review loop가 이를 coordinator에 전달한다. caller가 보내는 승인자/본문/스레드 정보를 publication authority로 사용하지 않는다.
- 동일 Teams 원본 스레드에서는 하나의 미완료 검토만 등록한다. 서로 다른 수정 요청의 LGTM이 동시에 두 후보에 적용되지 않도록 한다. 앞선 작업의 serving revision 확인이 끝나야 후속 검토가 등록된다.
- 신규 접수와 과거 작업 이관은 별개다. 24시간 이전의 기존 작업을 새 요청으로 위장해 등록하지 않는다. 기존 작업·페이지·승인을 보존하는 운영자 이관과 단일 실행자 전환은 여전히 남아 있다. 운영 profile/handler는 아직 활성화하지 않았다.
- 같은 스레드에 두 후보가 이미 게시되어 있으면 검토 등록 여부와 무관하게 bare Teams 승인을 거부한다. 이 경우 특정 작업의 정본 Ainmem 페이지 승인은 계속 사용할 수 있다. 먼저 표시된 후보만 임의로 선택해 LGTM을 적용하지 않는다.
- QA 타깃 98개 통과、실패/skip 0, 빌드 통과. 원본 요청 등록·재시작·중복 방지·변조 거부·게시 전 검사·handler 재개·스레드 승인 모호성 검증을 포함한다. 이 테스트는 운영 전환/서비스별 실제 배포 완료를 뜻하지 않는다.

### 2026-10-10 최신 main 반영 및 검토 PR

- Ainize branch에 main `5135f19`를 반영했다(merge `7301328`). 충돌 없이 합쳐졌으며 빌드와 QA/scheduler/locator/redirect/hosted-agent 테스트 122개가 통과했다(실패/skip 0). 전체 저장소/실제 운영 E2E 결과는 아니다.
- Ainmem branch에도 최신 main을 반영했다(merge `360fbbe`). QA API 파일 변경 없이 MCP knowledge 변경만 합쳐졌고 앱 타입 검사가 통과했다. 직전 실제 DB/HTTP 검증 7 pass는 QA API 자체 증거로 유지한다.
- 검토용 draft PR: Ainize https://github.com/ainblockchain/ainize-node/pull/70 ; Ainmem https://github.com/ainetwork-ai/ainmem/pull/76 . 둘 다 운영 전환이 끝났다는 의미가 아니며 병합/배포하지 않았다.
- 실제 .41 운영 API는 `/mnt/newdata/ainize-node-releases/releases/20261010T130910Z-5135f19cde1d`를 실행 중이고 user unit `ainize-public-node`는 active였다. QA 관련 running user units는 `ainteams-qa.service`, `ainteams-qa-kanban.service`였다. 새 native opt-in 설정을 켜지 않았다.
- 기존 23개 작업 상태를 읽기 전용으로 재확인했다: Teams 11, Ainmem 2, Aindrive 2, Ainize 웹 2/API 3, AINA 2, Ainspace 1. 승인 대기 4, completed 6, failed 10, blocked 3이다. Ainmem/Aindrive 각각 한 작업이 `failed / approved_release`로 남아 있으므로 이관 시 승인 기록과 실제 원격 릴리스 상태를 대조해야 한다. 실패를 곧바로 재실행하거나 completed로 바꾸지 않았다.

### 2026-10-10 `approved_release` 실패 작업의 실제 원격 대조

- 실제 기존 DB의 `pr_main`은 문자열이 아니라 `{number,url}` 객체였다. `reconcileLegacyJob`이 문자열만 받던 결함을 수정했다. URL의 저장소/PR 번호와 객체 number를 함께 확인하며 불일치를 거부한다.
- 기존 작업의 `superseded_by`/`superseded_pr`가 있으면 같은 서비스의 실제 이관된 후속 작업 archive 및 PR을 대조한다. 원래 후보가 closed/unmerged일 때만 `superseded_candidate`로 구분하고, 후속 후보는 별도 원격 증거로 남긴다. 원래 승인이나 완료 상태를 후속 커밋으로 이전하지 않는다.
- 실제 Ainmem `8186a70c`의 PR55는 후보 `2f27095117138a09235b5012220972953024a086` 그대로 closed/unmerged다. 후속 작업 `4fe1ea61`의 PR59는 후보 `38445a88259071c97f5e77ed8be0df0484a5135e`, merge `962bd0def52d153fd1a399c67987a7edb2f5a9ce`로 2026-10-04 병합됨을 현재 GitHub에서 확인했다. 후속 서비스 실행 revision 확인은 별도로 남긴다.
- 실제 Aindrive `8d9bf634`의 PR199는 후보 `483fc269d531e34effbbb412221ec4c97bfe347c` 그대로 open/unmerged다. 기존 approved_release 실패 기록을 자동 재배포 권한으로 쓰지 않고 `revalidate_candidate`로 보존했다.
- 실제 .41에서 두 서비스의 작업 4개를 새 private DB로 가져와 새 reconciliation 코드를 실행했다. 운영 source jobs/reports digest가 실행 전후 일치했다. 운영 DB/페이지/PR/배포에는 쓰지 않았다. 증거: `/mnt/newdata/qa-services/validation/native-reconcile-live-20261010-zI9Plb/result.json` 및 `run.mjs`.
- QA 타깃 100개 통과, 실패/skip 0. 실제 객체형 PR·후속 작업·승인 비상속·기존 완료 상태 보존 검증을 포함한다. 실제 운영 이관과 서비스별 E2E는 여전히 미완료다.

### 2026-10-10 Ainmem 칸반/작업 실제 Chromium 검증

- companion Ainmem PR76의 `10e62a6`에 격리 DB fixture와 browser check를 추가했다. 실제 .41 Next 앱/PostgreSQL + Mac Chromium에서 데스크톱/모바일의 칸반·작업 렌더링, 카드 클릭, 화면 넘침 방지, 동일 페이지 갱신, 검토 SHA 표시, 승인/완료 열 이동을 검증하고 PNG를 직접 확인했다.
- 증거: `/mnt/newdata/qa-services/validation/native-ainmem-ui-20261010-V9YCTW/results/`. 테스트용 앱/DB 컨테이너, network, SSH 터널은 제거했다. 상세 재현/범위는 Ainmem `docs/QA-NATIVE-TASK-API.md` 참조.
- 운영 페이지 이관, 실제 로그인/승인, 제품 수정·배포 전체 E2E는 여전히 남아 있다. 이번 fixture의 완료 표시와 SHA는 실제 배포 증거가 아니다.

### 2026-10-10 제품별 의존성 이미지 및 다중 패키지 검증

- Ainmem PR76(10e62a6)을 ready for review로 변경하고 사용자에게 특정 커밋의 main 병합·배포 승인을 요청했다. 아직 승인 답변/병합/배포는 없다. 기존 작업기 전환과 별도다.
- 실제 7개 서비스의 기존 isolation image를 조회했다. AINA는 두 패키지 seed, Teams는 workspace manifest이며, 검사한 경로에서 실행용 .bin이 준비된 것은 Ainspace뿐이었다. Ainmem 브라우저 검증 때 확인한 의존성 복원 차이가 다른 제품에도 있어 기존 image ID를 네이티브 설정에 그대로 복사하면 안 된다.
- 네이티브 검증기에 다중 dependency scopes와 gate별 cwd를 추가했다. 각 gate는 모든 scope를 새 private 작업 공간에 복사하고 package/lock을 대조한다. 미등록 경로·중복 scope는 거부하고 receipt version을 3으로 올렸다.
- QA 타깃 101 pass, build pass. 실제 .41 Docker에서 frontend/backend 두 gate가 각각 자기 패키지를 로드하고 같은 candidate overlay를 읽는 검증 1 pass/0 skip. 증거와 한계는 docs/QA-PRODUCT-VALIDATOR.md 참조. 아직 실제 각 제품의 전체 검증 프로필이 준비된 것은 아니다.

### 2026-10-10 Ainmem 실제 제품 검증 이미지 준비

- Ainmem PR76 head `10e62a6`의 실제 Git checkout과 고정 image `sha256:11ca84ad2c9676015cf761cad371e63d8c9847edb88656d4b1222784efd7d035`를 준비했다. 웹 앱과 별도 relational-memory-mcp 패키지를 각각 `/seed/app`, `/seed/mcp`로 묶었다.
- native validator에서 app typecheck, MCP typecheck/build, QA contract test, app production build의 다섯 gate가 모두 통과했다. 실행은 네트워크/배포 자격증명 없이 격리된 컨테이너에서 수행했다.
- 증거: `/mnt/newdata/qa-services/validation/native-ainmem-product-20261010-9EPoSz/profile.json`, `result.json`, `run.mjs`, `image-id`. 검증용 Git checkout/이미지는 재사용할 수 있게 보존했다. 운영 설정에 설치하거나 배포하지 않았다.
- unchanged file overlay로 현재 PR tree를 검증한 결과다. 새로운 제품 버그의 모델 수정·실제 관리자 승인·배포 E2E를 대신하지 않는다. 전체 DB/UI 회귀를 이 다섯 gate만으로 판정하지 않는다. Ainmem 배포 승인 질문은 아직 답변 대기다.

### 2026-10-10 AINA 실제 네이티브 제품 검증

- 서버 연결을 확인하고 현재 QA 코드와 인수인계 기록을 대조했다. QA 타깃 101개(실패/skip 0)와 Ainize 빌드를 다시 통과했다.
- AINA main `7dd1029`의 web/backend 의존성 이미지를 준비하고 실제 네이티브 검증기로 웹 테스트·빌드 및 백엔드 테스트·빌드 네 gate를 모두 통과했다. 서버 증거는 `native-aina-product-20261010-UHv7iD`, 이미지와 상세 범위는 `QA-PRODUCT-VALIDATOR.md`에 기록했다.
- 최초 의존성 설치 실패는 이미지 준비 시 web/.npmrc 누락 때문이었다. 저장소 설정을 포함하자 통과했으며 제품 코드/lockfile은 수정하지 않았다.
- 검토 시 확인한 잔여 과제: handler/host profile의 정적 base를 요청별 최신 main과 안전하게 동기화하는 경로, 기존 작업·승인 보존 이관 및 단일 실행자 전환, 실제 전 제품 채널→승인→배포 E2E. 이번 제품 gate 통과만으로 운영 준비 완료로 판단하지 않는다.
- Ainmem PR76 승인 질문은 여전히 답변 대기이며 새 병합/배포는 실행하지 않았다. 검증용 이미지/checkout은 보존하고 임시 gate 컨테이너는 자동 정리했다.

### 2026-10-10 요청별 최신 main 준비 경로

- `hosted-qa-base.ts`와 private `/qa/base` capability를 추가하고 handler→작업 DB→validation/publication/release에 job ID 바인딩을 연결했다. 새 요청은 정본 접수 후 최신 main을 준비하고, 같은 작업은 재시작해도 처음 준비한 SHA를 보존한다. 진행 중 후보/승인을 새 SHA로 옮기지 않는다.
- `advanceCoding`이 호스트 접수 확인 기록을 버리던 문제를 수정했다. hostIntake/hostBase가 실제 코딩 단계와 설정 변경 후에도 보존되는 회귀 테스트를 추가했다.
- opt-in `AINIZE_QA_BASE_PROFILES` 및 handler `hostBase: true`; 상세 설정/한계는 `QA-PRODUCT-VALIDATOR.md`. 의존성 변경은 이미지 갱신 요구로 멈추며, 코딩/게시 후 main 전진에 대한 후보 재작업은 아직 자동화하지 않았다. 기존 작업 이관과 운영 단일 실행자 전환도 남아 있다.
- QA 테스트 107 pass/0 skip, build pass. 실제 .41 AINA checkout에서 기준 준비→서비스 재생성→동일 SHA 재사용을 확인했다. 증거 `native-base-20261010-fU8Ndn`; 정본 운영 접수/비공개 Git fetch 전체 검증은 아니다.
- 운영 설정은 활성화하지 않았고 Ainmem PR76 승인 질문도 계속 대기 중이다. 새 main 병합/배포는 수행하지 않았다.

### 2026-10-10 Aindrive 실제 검증 및 공간 부족 수정

- Aindrive main `8d6834f`에 맞는 web+cli 검증 이미지를 준비했다. 실제 native gate에서 web typecheck, web 1263 pass/3 TODO, CLI 336 pass, CLI build가 통과했다. 전체 profile은 웹 빌드 실패로 실패 상태다.
- 웹 빌드는 Google Fonts 다운로드 차단과 webpack cache ENOSPC로 실패했다. 기존 PR199는 여전히 open, head `483fc269d531e34effbbb412221ec4c97bfe347c`다. 제품 코드/승인/PR은 바꾸지 않았다.
- 실행기 `workspaceMiB`를 추가했다(기본 2048, 최대 container memory 이내). Aindrive 의존성만 약 1.8GiB였으므로 4096MiB/8GiB memory로 재검증한다. 성공 로그도 private tail에 보존해 pass/skip/TODO 수를 확인할 수 있게 했다. 실제 Docker probe로 4GiB mount와 성공 로그 보존을 확인했다. QA 108 pass/0 skip, build pass.
- 서버 증거: `/mnt/newdata/qa-services/validation/native-aindrive-product-20261010-dOcf0d`. 첫 별도 full E2E는 실제 서버/CLI가 실행되었으나 SQLITE_FULL 발생 후 해당 컨테이너를 종료하고 로그를 보존했다. 실패를 통과로 처리하지 않았다.
- 새 `run-e2e-workspace.mjs`가 4GiB 환경에서 실행 중이다. 다음 작업은 실제 프로세스와 `e2e-workspace-result.json`을 확인하는 것이다. 운영 채널의 모델 수정→승인→배포 E2E와는 별도 제품 시나리오 검증이다. 운영 설정/작업기 전환은 아직 수행하지 않았다.

### 2026-10-10 Ainize 웹 검증 및 공유 채널 전환 주의점

- Ainize 웹 main `2c493a2`의 실제 native profile 네 gate(gen:check/typecheck/test/build)가 성공했다. 테스트 348 pass, 1 skip(외부 npm 조회), 0 fail. 레지스트리의 ainize 0.4.0 존재는 별도 읽기로 확인했다. 서버 증거 `native-ainize-web-product-20261010-5yn1dC`; 자세한 범위는 QA-PRODUCT-VALIDATOR.md에 기록했다.
- 운영 설정을 읽어 확인한 결과 `qa-ainize`와 `qa-ainize-node`는 같은 channel_id와 Teams agent_id를 쓴다. 현재 Python의 `qa_agent/routing.py`는 정본 본문에서 API/백엔드/web/웹 접두어를 읽고, 신규 미지정 요청은 웹으로 보낸다. 기존 스레드는 원래 저장소를 유지하고 다른 저장소 지정은 거부한다. 두 저장소에 작업이 있는 스레드는 승인 모호성으로 거부한다. 재전송은 새 저장소 작업을 만들지 않는다.
- 이 동작을 읽은 실제 운영 소스는 `/mnt/newdata/qa-services/releases/8b654ff/ainteams-qa/qa_agent/routing.py`다. a2a-agents에는 수정/커밋하지 않았다. Native handler/host profiles는 현재 단일 저장소 기준이므로, **Ainize 공유 채널의 저장소 선택·중복 방지·승인 범위를 이관하기 전 전환하면 안 된다.** 두 profile을 별도 Teams 봇으로 복제하는 방식도 요구사항을 만족하지 않는다.
- Aindrive 4GiB full E2E는 #178 전송 실패 뒤 서버 연결 거부로 실패했다. #178 단독은 1 pass/173 제외로 통과했으므로 제품 전송 자체의 결함이나 OOM으로 단정하지 않는다. private 로그가 잘리지 않게 stdout/stderr 별도 저장과 실패 시 cgroup memory.events 기록을 추가했고 QA 110 pass/0 skip 및 build pass다.
- 같은 Aindrive 증거 디렉터리에서 `run-full-evidence.mjs`로 full E2E를 재실행 중이다. 다음에는 실제 실행 상태와 `full-evidence-result.json`, `full-evidence/*.log`를 확인한다. 기존 실행을 단순 관측 시간 초과로 재시작하지 않는다. 운영 배포/전환은 계속 미실행이며 PR76 승인 질문도 대기 중이다.

### 2026-10-10 공유 채널의 영구 저장소 선택 코어

- `examples/qa-agent/routing.mjs`에 정본 Teams 수정 요청용 `enqueueSharedTeamsRequest`를 추가했다. web/API를 같은 Jobs DB와 SQLite transaction에서 선택·접수한다. API/백엔드 또는 web/웹 접두어는 기존 의미를 유지하고, 새 미지정 요청은 웹으로 보낸다. 스레드 답글은 최초 저장소를 유지한다.
- 재시작·재전송은 기존 job ID/base/checkpoint/과거 승인 데이터를 그대로 반환한다. 요청 본문/부모 변경, 스레드의 두 저장소 작업 혼재, 설정에서 사라진 기존 저장소는 새 작업을 만들지 않고 재조정을 요구한다. 두 DB 연결에서도 중복 접수되지 않음을 확인했다.
- 반드시 canonical verifier 결과만 전달하는 내부 코어다. webhook 본문/metadata는 저장소 선택 권한이 아니다. 코어 자체는 실행·검증·게시·승인 권한을 만들지 않는다.
- 공유 경로 테스트 5개 pass/0 skip. 전체 QA 114 pass/0 skip 후, 조회 범위 제한 및 두 DB 연결 테스트 추가분을 포함한 routing 테스트 5개를 다시 통과했다.
- **아직 handler와 호스트 다중 저장소 capability에 연결하지 않았다.** 기존 단일 저장소 handler를 운영에서 이 코어로 임의 교체하지 않는다. 다음 작업은 한 Teams 봇의 웹/API scope를 host intake→base→validation→publication→review/release까지 일관되게 바인딩하고, 같은 스레드 LGTM이 두 후보를 승인하지 않도록 검증하는 것이다. 기존 페이지/job/승인 이관도 함께 필요하다.
- Aindrive `run-full-evidence.mjs`는 실행 중이다(마지막 실제 컨테이너 관측: 실행 약 6분). 프로세스/결과를 확인하기 전 재시작하지 않는다. 운영 전환/배포는 수행하지 않았다.

### 2026-10-10 후속 코드 리뷰: 작업 지연·공유 스레드 승인 보완

- 코드 리뷰에서 `Jobs.claim`이 가장 오래된 queued 작업을 매번 선택해, 긴 host 검증을 조회하는 작업이 뒤의 요청을 계속 막는 문제를 확인했다. 별도 work_polls 테이블에 실행 순서를 저장해 각 eligible 작업을 번갈아 선택한다. 기존 job ID/입력/checkpoint/승인/페이지는 변경하지 않으며 live lease와 배포 단계 제외 규칙을 유지한다. 재시작·두 DB 연결·후속 요청 진행을 검증했다.
- 승인 모호성 검사와 검토 등록 충돌 검사가 agent ID 내부에 한정돼 있었다. 공유 채널의 서로 다른 저장소 scope가 같은 스레드에서 배포 후보를 만들면 검사에서 빠질 수 있어, workspace/channel/root 기준으로 전체 ledger를 대조하도록 수정했다. 서로 다른 agent의 동일 job ID도 별도 후보로 검사한다. Teams 승인 기록과 release intent transaction에서도 모호성을 다시 확인한다. 기존 승인 기록은 삭제하거나 새 권한으로 전환하지 않는다.
- QA 전체 117 pass/0 fail/0 skip. 이후 cross-agent 회귀를 실제로 유효한 ledger 승인 증거로 강화하고 coordinator/release 13개 테스트를 다시 통과했다. 빌드도 통과했다. 운영 전환이나 실제 사람 승인 소비는 수행하지 않았다.
- Aindrive의 full-evidence 결과는 145 pass/28 fail/1 skip이다. 서버 stderr에서 약 2GiB JavaScript heap 한도 도달을 확인했다. cgroup oom/oom_kill은 0이었다. #178의 전송 자체 결함으로 단정하지 않는다. 같은 tree/image/8GiB container/4GiB tmpfs에서 operator gate argv에 NODE_OPTIONS=--max-old-space-size=3072를 지정한 진단이 실행 중이다. `run-heap-evidence.mjs`, `heap-evidence-result.json`, `heap-evidence/`를 확인한다. 모델이나 gateway에서 환경변수를 받도록 확장하지 않았다.
- 공유 저장소 routing core는 여전히 handler/host 전 단계에 연결되지 않았다. 이 변경만으로 qa-ainize 전환 준비가 끝난 것은 아니다. PR76 승인, PR70 운영 전환, 전체 제품 실제 채널 E2E도 남아 있다.

### 2026-10-10 공유 Ainize 채널의 호스트 실행 경로 연결

- `AINIZE_QA_SHARED_PROFILES` opt-in과 `HostedQaRoutes`를 추가했다. 한 hosted-agent ID가 웹/API의 내부 capability scope를 사용한다. 호스트가 정본 Teams 메시지를 직접 읽어 선택하고, scope와 검증된 intake를 같은 SQLite transaction에 기록한다. 저장된 job 바인딩으로 base/validation/publication/status를 모두 분기한다. caller의 scope 지정, 내부 scope 직접 호출, 다른 job 조회는 거부한다.
- handler에도 기존 공유 routing 코어를 연결했다. 같은 Jobs DB에서 두 저장소를 접수하며, 호스트가 확인한 repository/route가 일치해야 코딩한다. 새 일반 요청은 웹, API/백엔드 접두어는 API, 답글은 기존 스레드 저장소를 유지한다. 중복/재시작은 같은 job을 유지하고, 설정이 바뀌거나 이관되지 않은 과거 스레드는 자동 재배정하지 않는다.
- 두 scope의 실제 Teams/Ainmem 토큰·origin, 조직/채널/승인 정책과 보드가 같아야 한다. 자세한 설정은 examples/qa-agent/README.md. 이것은 Teams 봇을 두 개 등록하는 방식이 아니다. 배포/실행 revision 확인은 기존 scope별 release/deployment 프로필과 최신 승인 검사에 연결된다.
- QA 전체 122 pass/0 fail/0 skip 및 build pass. 마지막 routing policy digest에 branch도 포함한 뒤 route/gateway 4개 테스트 재통과. host capability 설정의 문자열을 boolean으로 오인하지 않도록 검사하고 handler 10개 테스트도 재통과했다. 실제 로컬 HTTP gateway의 하나의 토큰으로 각 capability가 같은 scope에 전달됨과 직접 scope 접근 거부를 검증했다. handler의 두 저장소 접수·host intake/base 확인 후 코딩도 검증했다. Teams/GitHub 읽기는 fixture이므로 실제 운영 채널 E2E는 아니다.
- Aindrive 재검증은 173 pass/1 source-declared skip/0 fail로 완료됐다. 동일 tree/image, 8GiB memory/4GiB workspace에서 operator gate의 Node heap을 3GiB로 지정했다. 원래 실패는 약 2GiB JS heap 한도였으며 cgroup OOM은 아니었다. 제외 항목은 wallet-cookie 협업 WebSocket 인증이며, offline font 웹 빌드도 여전히 별도 미해결이다. 자세한 증거는 QA-PRODUCT-VALIDATOR.md.
- 운영 shared profile 활성화, 기존 23개 작업의 route 포함 보존 이관, 단일 실행자 전환, 최신 제품별 validation/revision 설정 및 실제 전체 채널→Ainmem→관리자 승인→배포는 남아 있다. PR76 승인 대기 상태도 그대로다. 새 main 병합/운영 배포/제품 코드 수정은 수행하지 않았다.

### 2026-10-10 공유 채널 실제 과거 작업 이관 재현

- legacy importer에 선택 route(web/api)를 추가했다. 같은 native Jobs DB에 두 저장소의 작업을 넣되 기존 ID·상태·후보·페이지 참조·승인 archive를 보존한다. 이미 가져온 작업에 다른 route를 지정하면 거부한다.
- `HostedQaRoutes.importHistory`는 operator-only 경로다. archive fingerprint와 workspace/channel/repository를 검증해 과거 스레드의 저장소만 private ledger에 기록한다. 실제 intake, review, release 권한은 생성하지 않는다. 새 정본 답글은 기존 저장소를 따르며, 과거 요청을 새 요청처럼 재접수하거나 혼재된 스레드를 임의로 선택하지 않는다. HTTP gateway에는 이관 기능을 노출하지 않았다.
- 실제 .41의 현재 Ainize 웹 2개/API 3개 작업을 하나의 새 DB로 가져왔다. 재실행은 각각 2개/3개 unchanged, 호스트 history 이관은 5개 imported 후 재시작·재실행에서 5개 unchanged였다. 기존 jobs/reports digest가 실행 전후 동일했고 claimable/liveIntakeGranted/approvalGranted/productionCutover는 모두 false였다.
- 증거: `/mnt/newdata/qa-services/validation/native-shared-history-20261010-cnv66oax/rehearse.mjs`, `result.json`, `run.log`, 새 jobs/checkpoints/host ledger. 승인을 검사하거나 실제 Teams/GitHub로 요청하지 않는 진단용 정책을 사용했다. 운영 profile 설치나 작업기 전환이 아니며 실제 권한 이관으로 해석하면 안 된다.
- QA 125 pass/0 fail/0 skip, build pass. 이관·재시작·변조 거부·후속 스레드 선택·혼재 거부를 포함한다. Ainmem 기존 페이지 adoption 설정, 과거 후보 원격 대조 및 현재 승인/배포 확인, 전체 제품 프로필과 실채널 E2E, main 승인·배포는 여전히 남아 있다.

### 2026-10-10 Ainmem 기존 페이지의 실제 DB 대조

- ain-vault에 보관된 ainops SSH 키/관리 자격증명으로 .41을 경유해 .194에 접속했다. 기존 mTest3 키는 배포 명령 전용이므로 일반 조회에 사용하지 않았다. 비밀번호/키/토큰은 출력하거나 저장소에 기록하지 않았다.
- 실제 Ainmem PostgreSQL에서 READ ONLY transaction으로 현재 23개 job의 canonical kanban_url을 대조했다. 원래 db row의 작업 ID 속성, 페이지 ID/부모 보드/workspace/creator, uuid5(job, qa-progress) paragraph, archive/lock 상태가 모두 일치했다. 페이지/행/블록/댓글은 수정하지 않았다.
- 최초 네 작업에서 같은 페이지를 참조하는 행이 두 개씩 나왔다. 페이지의 실제 부모 보드와 database_id를 함께 확인하면 원본 행이 하나로 결정된다. 승인 모아보기의 별도 행을 원본 행으로 잘못 adoption하면 안 된다. 이 mirror 행의 상태 갱신/정리는 전환 시 별도 확인이 필요하다.
- 검증 결과: Teams 11, Ainmem 2, Aindrive 2, Ainize 웹 2/API 3, AINA 2, Ainspace 1 = 23개. .194 private evidence: `/var/tmp/qa-native-page-adoption-3kephgru/evidence.json`, `bindings-without-agent.json`. 이 파일은 기존 row/page/block/owner/jobProperty 매핑이며 **agentId가 없어 아직 활성화할 수 없다**.
- 현재 ComCom Ainmem workspace `2c88615f-4a30-43f8-9608-6ac977919dc0`에는 `is_agent=true` workspace member가 0명이다. 이름이나 Teams agent ID를 임의로 Ainmem agent ID로 대입하면 안 된다. Ainize QA identity를 Ainmem에 정상 등록·workspace 연결하고 scoped token을 발급한 다음, 실제 발급된 Ainmem user ID로 23개 mapping을 완성해야 한다.
- 운영 adoption 환경변수/새 token/페이지 쓰기는 아직 하지 않았다. PR76 배포 승인도 대기 중이다. 기존 작업 데이터가 준비됐다는 사실과 실제 native agent가 페이지를 갱신할 수 있다는 사실을 구분한다. 승인 모아보기와 페이지 댓글 LGTM을 포함한 실채널 E2E는 남아 있다.

- 조회가 끝난 뒤 추가 summary 파일 저장 시도 때 vault 잠금이 만료되어 접속하지 못했다. 기존 evidence/bindings 파일은 앞선 성공한 조회에서 저장됐으며 summary 파일은 생성되지 않았다.

## Ainmem QA 등록 API 구현 — 2026-10-10

Ainmem PR #76 최신 head `f25fedf`는 앞선 `10e62a6`/`5edeb3e`를 대체한다.
이전 head 승인 요청은 최신 head의 배포 승인이 아니다. 운영 배포하지 않았다.

- `/api/qa/agents` POST는 현재 SSO 조직 관리자와 보드 공유 권한을 확인한 뒤
  실제 Ainize org registry 조회로 agent를 확인한다. 동일 registry/org/agent는 같은
  Ainmem user로 등록하며 지정 workspace guest/보드 edit만 부여한다.
- 보드별 `qaa_` token 원문은 발급 시 한 번 반환, DB에는 해시만 저장한다.
  재시도는 회전하지 않고, 명시적 rotate와 DELETE 폐기를 지원한다.
- task API는 token의 보드/workspace 범위와 현재 발급 관리자 SSO/역할/계정 상태를
  재검증한다. 일반 A2A/MCP token은 기본 거부한다. 운영에서 이전용 예외인
  `AINMEM_QA_ALLOW_LEGACY_AGENT_TOKENS`를 켜지 않는다.
- 새 task page에는 guest agent의 edit grant를 추가한다. 기존 페이지 권한은
  자동 확대하지 않으므로 23개 legacy page의 명시적 권한 연결은 다음 작업이다.
- 서버 PostgreSQL + task HTTP/route 테스트 **12 pass / 0 skip**, 타입 검사 통과.
  registry는 mock, 실제 사용자 브라우저 등록/SSO 검증은 미완료다.
  서버 증거 `native-ainmem-permission-1e4a3seo/integration.log`와 `typecheck.log`.
  테스트 DB 컨테이너 제거 확인. 운영 DB 스키마/권한/agent/token 변경 없음.

운영 스키마에는 `0005_qa_agent_credentials.sql` 또는 db:push 적용이 필요하다.
Registry에서 agent가 제거될 때 기존 token의 자동 폐기 동기화는 아직 없다.
그 전에는 explicit credential 폐기가 필요하며 운영 전환 완료로 보지 않는다.
새 token을 Ainize private profile에 전달하고 실제 기존 페이지·채널 작업·승인·배포를
검증하는 단계, 통합 승인 보드 mirror 갱신과 단일 작업기 전환은 계속 남아 있다.

## 기존 페이지 권한 연결과 registry 조직 응답 수정 — 2026-10-11

Ainmem의 `/api/qa/agents/adopt`는 관리자 세션과 credential ID로 서버의 명시적
legacy mapping만 적용한다. 모든 row/page/block/job/creator/workspace/parent를
대조한 뒤 한 transaction으로 edit grant를 부여한다. 매핑 하나가 틀리면 전체를
거부하며 task 내용과 원작성자를 보존한다. 테스트에서는 새 scoped token으로
그 기존 페이지를 갱신하고 ID·댓글·작성자 보존까지 확인했다. 운영 23개 page에는
아직 적용하지 않았다. main `cae9ee1`도 Ainmem 작업 브랜치에 반영했다.

운영 registry 실제 읽기 결과 QA 6개 중 5개의 orgRef.subject가 `comcom`,
Teams QA만 실제 SSO 조직 ID였다. 전부 issuer는 `https://auth.comcom.ai`다.
Ainmem enrollment의 issuer 검사를 실제 SSO issuer에 맞게 수정했다.
Ainize의 목록은 기존 resolveOrgId로 별칭을 필터링한 뒤, org가 지정된 조회 응답의
subject도 그 권한 확인된 조회 org로 맞춘다. 원본 agent ID/등록/공유 설정은
변경하지 않는다. 다른 조직 거부와 SSO issuer 유지 테스트 포함 16 pass / 0 skip,
Ainize 타입 빌드 통과. Ainmem은 QA/knowledge 회귀 33 pass / 0 skip.

배포 순서는 registry 응답 수정 후 Ainmem enrollment/adoption 확인이 필요하다.
운영 registry·스키마·페이지 권한·agent token에는 이번에도 쓰지 않았다.
자동 registry 제거 동기화, 실제 관리자 세션 등록/비밀 토큰 전달, 23개 page 권한,
승인 mirror, 단일 작업기 전환과 전 제품 채널 E2E는 남아 있다.

## Ainmem registry 폐기 경로 연결 — 2026-10-11

Ainmem PR #76 head `b716271`은 QA token을 쓸 때 현재 Ainize 조직 목록을 조회한다.
성공 권한 캐시 없음, no-store/redirect 거부, 전체 조회 10초/응답 1 MB 제한.
완전한 목록에서 agent 제거·공유 해제가 확인되면 DB credential을 폐기한다.
재등록만으로 이전 token은 복구되지 않는다. Registry 장애·잘못된 응답·cursor 문제·
일시적 중단은 token을 보존하고 task API 503으로 재시도하게 한다.
따라서 앞선 'registry 제거 자동 폐기 미구현' 항목은 이 요청 시 검증 경로로 보완했다.
사용하지 않는 credential을 선제 삭제하는 background 동기화는 필요하지 않으며,
사용 시 반드시 검증하므로 제거된 agent의 작업 권한을 계속 허용하지 않는다.

서버 36 tests pass / 0 skip, 타입 검사 통과. runtime production build 통과 후
테스트 fixture 추가분은 테스트·타입 검사를 다시 통과했다. DB 및 loopback HTTP
검증으로 등록 제거·복구·503·영구 폐기를 확인했다. 운영 쓰기는 없다.
증거는 `native-ainmem-permission-1e4a3seo/registry-revocation-b716271/`에 별도 보존.

브라우저 fixture는 새 권한 검사를 우회하지 않도록 loopback registry를 사용한다.
`app/tests/qa/registry-fixture-server.mjs`와 fixture 환경 설정은 Ainmem API 문서 참조.
이 변경 이후 전체 Chromium UI 시나리오는 아직 재실행하지 않았다.
다음은 새 registry/권한 경로를 포함한 브라우저 확인, 통합 배포 승인 mirror 갱신,
실제 관리자 등록/23개 page 권한/토큰 전달, 단일 작업기 전환과 전 제품 E2E다.

## 새 registry 경로를 포함한 브라우저 검증 완료 — 2026-10-11

Ainmem PR #76 head `a52a073`은 runtime `b716271`에 테스트 캡처 보강과 증거 문서만
추가한다. 실제 서버 production build/PostgreSQL/loopback registry와 Mac Chromium으로
데스크톱·모바일 칸반 카드, 카드 열기, 작업 본문, 같은 page ID 재시도·갱신,
검토 SHA 표시, 배포 승인→완료 열 이동을 확인했다. 첫 mobile screenshot이 로딩
placeholder였으므로 카드 자체 visible 확인을 추가해 전체를 다시 통과했다.
캡처를 직접 검토했고 증거를 `native-ainmem-registry-ui-51dggdi4/results/`에 저장했다.
테스트 Next/registry/DB/포워드 종료 및 임시 token/session fixture 삭제를 확인했다.

실제 사용자 관리자 등록 API/SSO 세션과 운영 채널 전체 E2E는 아직 미검증이다.
배포는 승인되지 않았고 실행하지 않았다. 운영 등록을 막는 registry orgRef 응답 수정은
PR #70의 큰 네이티브 QA 변경과 함께 들어 있다. 이를 현재 main 기준의 작은 별도 PR로
분리해 검증·승인받으면, 전체 native runtime 전환 전에 Ainmem 등록 경로를 검증할 수 있다.
이후 원본 23개 페이지 권한 및 승인 mirror를 연결하고 단일 작업기 전환을 진행해야 한다.

## Registry 선행 배포 PR 분리 — 2026-10-11

현재 main `c8a6176`을 기준으로 응답 조직 참조 수정만 별도 worktree/브랜치로 분리했다.
- PR #71: https://github.com/ainblockchain/ainize-node/pull/71
- head `403860f1513ad53df6de0a50ce1bd18b0dc40ff3`
- worktree `/Users/kmh4500/git/ainize-registry-org-reference`, branch `fix/registry-org-reference`
- 변경은 shared-agents.ts와 회귀 테스트 두 파일, 16 tests pass / 0 skip, build pass.
  추가로 원본 alias/SSO sharing metadata가 그대로인지 검증한다.
- .41의 ainize-public-node와 ainize-auto-deploy.timer 둘 다 active.
  실제 build-info는 main `c8a6176`, dirty=false. main 병합 시 타이머가 배포할 수 있다.

사용자에게 **PR #71 exact head의 main 병합·자동 배포 승인**을 요청했다. 아직 답변이
없으며, PR 생성/push 외 main이나 운영 상태는 바꾸지 않았다. 이전 PR #53 등의 승인과
혼동하지 않는다. 승인되면 최신 head/base를 다시 확인하고 병합 후 serving SHA와 실제
조직 registry의 QA 6개 ref가 모두 요청한 SSO org로 오는지 재확인한다.
PR #70은 큰 native QA 변경을 유지하며 이 선행 PR과 별개다.

Ainmem PR #76은 아직 배포 승인되지 않았다. 새 credential table은 대상이 명확한
0005_qa_agent_credentials.sql로 추가할 수 있다. compose는 migration을 자동 실행하지
않으므로, 승인 후 백업·이 SQL 적용·앱 배포·schema health 확인 순서가 필요하다.
전체 drizzle push로 무관한 schema 변경을 자동 승인하지 않는다.

## 통합 승인 보드 동기화 — 2026-10-11

Ainmem task API에 operator-only AINMEM_QA_BOARD_MIRRORS를 추가했다. 원본과 같은
workspace/현재 편집권이 있는 통합 보드에, 같은 page를 참조하는 row만 갱신한다.
원본과 projection이 한 transaction이며 대상 오류 시 원본도 rollback한다. 기존
mirror ID/작성자/사람 필드는 명시적 매핑으로 보존한다. 운영 조회의 5개 row는 모두
원본 페이지 작성자와 같았고 4개가 제품 보드 페이지를 참조했다. 운영 쓰기는 없다.

보고 payload의 approvalPending은 표시 전용이다. 유효한 PR/후보를 가진 승인 대기
작업만 true이고, 실패/hold/검증 대기/배포 관측은 false다. 잘못된 ‘관리자 배포 승인
필요’ 문구도 그런 작업에는 보내지 않는다. 실제 승인 결정에는 사용하지 않는다.
Ainmem 37 tests / 타입 검사 / build 통과, native QA 126 tests pass / 0 skip.
처음 native 회귀 실행은 PATH의 시스템 git 때문에 실패했으며 Homebrew git으로
재실행했다. Ainmem의 초기 test helper 타입 오류도 수정 후 전체 게이트를 통과했다.

통합 보드 브라우저 검증도 완료했다(아래 참조). 실제 cutover 때 checkbox 속성,
그 속성의 true view filter, 현재 승인 작업 backfill, target board agent 권한,
새 agent ID와 기존 mirror row 정책을 함께 설치해야 한다. 기존 Python worker는
checkbox를 쓰지 않으므로 view만 먼저 바꾸지 않는다. PR #71(403860f) 배포 승인은
여전히 미수신이며 새 main merge나 운영 배포를 수행하지 않았다.


### 통합 보드 브라우저 검증 완료 — 2026-10-11

Ainmem PR #76 head `971a776`은 격리 서버 앱·DB·HTTP registry와 Mac Chromium으로
통합 승인 보드까지 검증했다. 데스크톱/모바일 승인 카드 표시, 카드에서 전체 페이지로
열었을 때 원본과 동일 URL, queued 제외, waiting 상태의 검증 보류 제외, 완료 시 원본
칸반 이동과 승인 목록 제외가 통과했다. 타입 검사 통과. 37 API 테스트/빌드 통과 이후
이번 변경은 fixture·브라우저 검증·문서뿐이다.

증거는 .41의 `/mnt/newdata/qa-services/validation/native-ainmem-registry-ui-gman5k_a/results/`
에 최종 result.json과 PNG 8개로 보존했다. 테스트 서비스/DB/포워드를 종료하고 임시
토큰·세션 fixture를 삭제했다. 실제 SSO 관리자 등록과 운영 채널 E2E는 아직 아니다.

PR #71 `403860f`와 PR #76 `971a776` 병합·배포 및 실제 등록/페이지 연결 승인을 함께
요청했으며 이 기록 시점에 응답은 없다. 승인 전 운영 배포/DB 변경을 하지 않는다.
PR #70 native runtime 자체는 별도 검증·승인이 필요하고 이전 작업 승인을 재사용하지 않는다.

## main 변경 시 승인 대기 오표시 수정 — 2026-10-11

리뷰 단계에서 원격 PR의 base가 바뀌면 기존 코드는 배포를 거부했지만, 호스트의
일반 예외로만 남아 작업/통합 보드에는 승인 대기가 유지됐다. 일치하는 저장소·PR·
후보 SHA·대상 브랜치에 대해 유효한 새 base SHA를 확인하면 해당 리뷰 세대에
변경 사실을 영구 기록하도록 수정했다. 다른 저장소/PR, 잘못된 SHA, 불완전한 조회를
이 근거로 사용하지 않는다. 배포 직전 ref 변경도 같은 기록 경로를 거친다.

호스트 status는 `requires_revalidation`과 관측한 base를 반환한다. 에이전트는 원래
작업 ID·입력 base·후보를 보존한 채 `needs_revalidation / base_changed`로 표시하고,
Ainmem의 승인 대기 checkbox를 해제한다. 기존 승인이나 배포 권한을 생성하지 않는다.
서버 재시작/브랜치 복귀로 이미 무효화된 리뷰를 되살리지 않는다. 다음 리뷰 세대는
별개이며 늦게 도착한 이전 세대 관측이 새 리뷰를 무효화할 수 없다.

QA 회귀 129 tests / 0 skip 및 TypeScript production build 통과. 새 테스트는 실제 SQLite 재시작, 잘못된 원격 PR,
브랜치 복귀, 늦은 세대 관측, 배포 write 차단, Ainmem 보고 payload를 검증한다.
처음 기존 테스트가 예외 문자열에 의존해 실패했고 기존 분류 문구를 보존해 다시 통과했다.

**자동 재수정은 아직 미구현이다.** 다음에는 같은 작업/페이지에 대한 시도 이력을
추가하고, 호스트 base·validation·publication ledger가 새 시도를 명시적으로 허용하도록
연결해야 한다. 새 main에 기존 변경을 적용하고 충돌을 모델로 해결한 뒤 전체 검증과
새 후보 표시·새 관리자 승인을 거쳐야 한다. 현재 변경은 승인 오표시/재사용을 막는
단계이며 전체 QA 자동 복구 완료를 뜻하지 않는다. PR #70에 포함하고 배포하지 않는다.

### 재검증 시도 이력 보존 — 2026-10-11

`Jobs.parkForRevalidation`을 호스트 lifecycle의 base 변경 처리에 연결했다. 이전 입력과
checkpoint 전체를 `revalidation_history`에 저장하고 현재 상태를 바꾸는 작업이 같은
SQLite transaction이다. 작업 ID/요청 ID/원래 base/페이지는 유지한다. 예전 승인·릴리스·
배포 확인 필드는 이력에 보존하되 현재 checkpoint에서 제거한다. 일반 wake는 base 변경
보류를 풀지 못한다. 호스트가 새 base/시도를 준비하는 별도 경로가 필요하다.

전체 QA 회귀 131개가 통과했고, 이력 INSERT 실패를 강제로 유발한 추가 테스트까지
Jobs/lifecycle 14개가 통과했다. 재시작·원본 요청 재전송·만료 lease·저장 실패 rollback을
검증했다. 마지막 추가 테스트는 검증 전용이며 실행 코드를 바꾸지 않았다.

이력은 작업별 순서와 원본 digest로 식별하며 최대 20회다. 새 후보를 자동 생성하거나
호스트의 기존 base/publication 바인딩을 바꾸지는 않는다. 다음 단계는 이 이력을 근거로
호스트가 새 시도를 발급하고, 같은 작업 페이지에서 새 후보 검증/승인을 받도록 연결하는
것이다. 운영 전환/배포는 아직 하지 않았다.

### PR 게시 전·게시 도중 main 변경 처리 — 2026-10-11

게시 직전 main이 달라진 경우가 일반 `host_publication_failed`로 끝나던 경로를 수정했다.
호스트 publisher가 유효한 변경 SHA를 확인한 경우만 `requires_revalidation`을 반환한다.
삭제/불완전한 ref 조회와 후보 브랜치 변경은 재검증 근거로 인정하지 않는다. 게시 도중
main이 변경되었지만 정본 후보 브랜치가 그대로인 경우, 이미 만든 PR 주소/번호/후보 SHA도
관측 증거에 포함한다. 이는 성공한 publication receipt나 승인이 아니다.

에이전트는 응답의 저장소·base·candidate digest·관측 SHA·PR 주소를 검증하고 checkpoint에
보존한 뒤, `parkForRevalidation`으로 기존 coding/validation과 함께 이력을 남긴다.
PR 게시 성공 큐나 승인 대기에 넣지 않는다. 작업·Ainmem 페이지 ID와 원래 base는 유지한다.

QA 회귀 135 tests / 0 skip 및 TypeScript production build 통과. 게시 전 GitHub 쓰기 0건, 게시 중 생성된 PR 보존,
불완전한 조회 구별, 다른 저장소/후보/잘못된 SHA 응답 거부, 보고/이력 전환을 검증했다.

남은 일: 호스트 재수정 시도 발급과 새 base 연결, 새 모델 수정/검증/게시, 같은 페이지의
새 후보 표시/승인. 게시 도중 호스트가 종료되어 변경 응답을 받지 못한 경우에는 결정적
후보 브랜치/PR을 원격에서 재조회해 이력을 채우는 복구도 필요하다. 새 상태 분류만으로
자동 재수정 또는 전체 채널 E2E가 완성된 것은 아니다. 운영 배포는 하지 않았다.

### 중단된 PR 게시 복구 — 2026-10-11

이전 단계의 ‘응답 유실 후 main이 변경된 경우 기존 PR 재조회’ 경로를 구현했다.
검증된 candidate로 결정적 브랜치를 계산하고, main이 바뀌었어도 기존 ref가 있으면
GET만 수행한다. 저장된 원래 base tree와 candidate 변경으로 기대 파일 트리를 다시
만들어 실제 커밋의 전체 파일·mode·blob을 비교한다. 부모 base, 커밋의 후보 digest,
PR 저장소/브랜치/head, 마지막 ref 재조회도 일치해야 기존 PR 주소를 복구한다.

새 ref/PR을 만들거나 main을 쓰지 않는다. 복구 결과는 여전히 `requires_revalidation`이며
이전 검증·승인을 최신 main에 대한 승인으로 바꾸지 않는다. 후보 ref가 없으면 PR 없는
base 변경으로 처리한다. 변조/불완전한 조회/복수 PR/동시 ref 변경은 일반 오류로 남겨
임의의 후보를 채택하지 않는다.

QA 회귀 137 tests / 0 skip 및 TypeScript production build 통과. 재시작 후 같은 PR 복구와 추가 GitHub 쓰기 0건,
파일 트리·부모·digest·PR 저장소 변조, 복수 PR, 조회 중 ref 변경 거부를 검증했다.
새 시도 발급과 자동 재수정 연결, 실제 운영 채널 E2E 및 배포는 여전히 남아 있다.

### 캐시된 게시 결과의 현재 권한 재확인 — 2026-10-11

재수정 연결을 점검하며 publication service의 캐시 응답이 beforePublish 검사를
건너뛰는 것을 확인했다. 이제 실행 중/완료/실패 캐시 조회에도 현재 접수와 검증 조건을
확인한다. 서버 callback은 정확한 job/candidate의 `requirePassed`를 호출하므로 새 base나
검증 profile로 바뀐 뒤 예전 성공 receipt가 그대로 반환되지 않는다.

비동기 publication이 끝난 순간에도 같은 검사를 수행한 뒤 review ledger에 등록한다.
진행 중 권한이 철회되면 성공 등록/응답을 거부한다. 그 전에 GitHub에 이미 생성된
브랜치/PR을 되돌린다는 뜻은 아니며, 원격 조회로 복구해야 한다. 캐시 응답도 복사해
호출자가 객체를 바꿔 다음 응답을 오염시키지 못하게 했다.

전체 QA 139 tests / 0 skip 및 TypeScript production build 통과. 캐시된 성공 뒤 정책 철회, 게시 중 철회, 완료/실행 중
반환 객체 변조를 검증했다. 마지막 실행 중 객체 복사 보완은 publication-flow 검증으로
재확인했다. 호스트의 새 시도 발급/자동 재수정은 아직 연결하지 않았고 운영 배포도 없다.

## AIN Teams 최신 main 제품 검증 — 2026-10-11 (진행 중)

`ainetwork-ai/ainteams` main `0e6dfedd65930412b3e3ce4184ccde0fe63eb469`을
Ainize 서버의 별도 checkout으로 반입했다. 운영 코드/DB/토큰/작업기를 변경하지 않았다.
서버 경로: `/mnt/newdata/qa-services/validation/native-teams-product-20261011-Sj66BF`.
검증 이미지: `sha256:8b9e1d5a6ee9d1728232d4f121a7a3336a46bce302e1f4b33830168acfe22f32`.
Node 20.20.2 / pnpm 10.33.0, 현재 lockfile의 의존성을 별도 이미지에 설치했다.

Teams는 `.npmrc`의 hoisted 구조라 desktop/mobile에 node_modules가 없는 것이 정상이다.
최초 bootstrap은 이 디렉터리 복사에서 ENOENT로 중단됐다. 제품 오류가 아니며 검증
이미지에 빈 디렉터리만 추가했다. 모든 패키지 manifest와 root lockfile 대조는 유지한다.
최초 결과는 `bootstrap-failure.json`에 보존했다. 이미지 준비 중 tag 대소문자와
Dockerfile FROM의 local image ID 해석 오류도 수정했다.

`run.mjs`는 현행 native validator를 사용해 네트워크 없음/비루트/읽기 전용/8GiB 메모리/
4GiB 작업 공간에서 root typecheck→lint→test→build를 실행한다. 원본 README와 동일한
candidate로 main의 실제 제품 게이트 실행 가능성을 확인한다. 실행 명령은 `profile.json`,
개별 원문 로그는 `evidence/`, 최종 결과는 `result.json`에 저장된다.

현재 전체 typecheck 통과, lint 실행 중이다. web/browser E2E 통과를 의미하지 않는다.
로컬 도구 실행 세션은 `21171`, 서버 runner는 위 경로의 `run.mjs`다. 상태 조회가 잠깐
안 된다고 다시 시작하지 말고 같은 프로세스/컨테이너와 결과 파일을 확인한다.

### AIN Teams 제품 검증 결과 및 프로세스 상한 — 2026-10-11

위 전체 검사(세션 21171)는 종료됐다. typecheck와 lint는 통과했고 test에서 중단되어
build는 실행되지 않았다. backend는 1124 통과/1 실패/6 skip, web은 5445 통과/3 실패/
92 skip이다. web thumbnail suite의 beforeAll timeout도 별도로 발생했다.
backend 실패는 network=none 환경에서 example.com DNS를 기대하는 테스트,
web 3건은 Git 메타데이터 없는 검증 복사본에서 git ls-files를 호출하는 테스트다.
원본 로그와 result.json을 보존했다. 이를 전체 제품 게이트 통과로 취급하면 안 된다.

별도 실제 layout E2E 최초 실행은 desktop thread/DM/mobile channel 3개 통과,
desktop channel 1개 이동 시간 초과였다(0 skip/0 retry). Next 로그의 EAGAIN과
uv_thread_create 실패로 PID 256 한도 문제를 확인했다. 해당 증거는
`e2e-evidence-pids256/`와 `e2e-result-pids256.json`에 보존했다.

native validator에 운영자 profile의 pidsLimit(64..1024, 기본 256)을 추가했다.
candidate가 상한을 지정하는 것은 계속 거부한다. QA 140 tests/0 skip 및 TypeScript
build를 통과했다. `e2e/fixtures/teams-product.mjs`는 네트워크 없는 컨테이너 내부의
일회용 UTF8 PostgreSQL과 앱을 기동해 layout-invariants 전체를 실행한다.
4개 이상 통과 및 skip/failure/flaky 0을 요구하고 종료 시 프로세스/DB를 정리한다.
운영 DB나 토큰을 사용하지 않는다.

재실행 이미지 `sha256:adc77596af785eb5b5b0dce23ab65d2e4319386a18703fd40b761ee988e5916b`,
별도 validator-pids.mjs, pidsLimit=512를 사용했다. 실제 Docker inspect에서 512를
확인했다. 현재 재실행 세션 93954, 증거 e2e-evidence/ 및 e2e-result.json.

검증 버전을 `4-bounded-process-limits`로 올려 이전 정책의 receipt 재사용도 차단했다.
버전 변경 후 전체 QA 140 tests/0 skip 및 TypeScript build를 다시 통과했다.

재실행 93954도 종료됐다: 3 pass / 1 fail / 0 skip / 0 flaky, 85.8초.
실패는 같은 desktop channel page.goto 15초 timeout이며, pidsLimit=512만으로
해결되지 않았다. 스레드/DM/모바일은 통과했다. 전체 브라우저 검증 통과 주장은 금지한다.
다음 단계는 dev 서버 초기 route 컴파일과 화면 준비 시간을 분리하여 진단하고,
최종 fixture가 모든 화면 assertion을 실행하도록 하는 것이다. timeout을 무작정
늘리거나 실패 항목을 제외하지 않는다. 서버 원문 증거는 e2e-evidence/에 보존했다.
이번 실행의 validator-pids.mjs는 version 문자열 갱신 전 실행본이며, 실제 pids512
코드는 동일하다. 저장소 최종 정책 버전은 4이며 이후 검증에는 새 빌드본을 사용한다.

### Teams 레이아웃 검증을 production 서버로 전환 — 2026-10-11

개발 서버의 cold route compile과 제품 화면 검증을 분리하기 위해 fixture는 이제
`pnpm --filter @app/web build` 후 `next start`를 실행한다. 제품 E2E 소스의 timeout,
assertion, retry 설정은 수정하지 않는다. DB는 동일한 격리 컨테이너의 임시 DB다.
이전 pids512 개발 서버 결과는 `e2e-evidence.dev-pids512/`,
`e2e-result.json.dev-pids512`, `e2e-profile.json.dev-pids512`로 보존했다.
새 실행은 validator v4, 이미지
`sha256:e999f4f0e8bd800b2f2b3be7176c172db9b8a3ee4634d7e4c4d98b1df2c2a1b2`를 사용한다.
로컬 실행 세션 54367, 동일 서버 검증 root의 e2e-result.json이 최종 결과 정본이다.

54367 최종 결과: production web build 성공, layout E2E 4 pass / 0 skip / 0 unexpected /
0 flaky, 17.0초. desktop channel, desktop thread, desktop DM, mobile channel의 기존
assertion을 모두 실행했다. 개발 서버 첫 진입 실패 없이 동일 제품 테스트가 통과했다.
제품 소스와 테스트 timeout은 수정하지 않았다. 단, 이 결과는 앞서 실패한 root 단위
테스트 전체나 운영 QA 채널의 접수→모델→PR→승인→배포를 통과했다는 뜻이 아니다.
그 경로와 선행 PR71/76 승인·배포 및 실제 Ainmem 등록은 여전히 남아 있다.

### 검증 실패 후 Ainize 모델 자동 재수정 — 2026-10-11

기존 hosted validation은 첫 제품 검사 실패에서 작업을 validation_failed로 멈췄다.
이제 정확한 repository/base/candidateDigest에 묶인 호스트 실패 결과를 받은 경우,
게시 전 후보에 한해 같은 job의 coding으로 되돌린다. 같은 base와 변경 파일을 유지하고
원본 요청을 바꾸지 않는다. 과거 coding/validation checkpoint는 validationAttempts에
보존한다. immutable blob 작성 뒤 lease 조건으로 job을 갱신하므로 재시작에도 이어진다.

실패 진단은 다음 모델 입력의 비신뢰 데이터로 전달한다. 이전 읽기 권한은 지워
모델이 수정할 코드를 다시 읽게 하고, 전체 40라운드 예산은 초기화하지 않는다.
최대 두 번 재수정한 뒤에도 실패하면 validation_failed로 남긴다. 이미 published,
approval, release, deployment가 있는 작업은 이 경로로 되돌리지 않는다.
후보가 달라지면 새로운 digest로 호스트 검증을 다시 받아야 한다. PR 게시나 배포
승인을 추가하거나 우회하는 변경은 없다. 직접 advanceValidation 경로는 유지하며
운영 핸들러가 사용하는 advanceHostedValidation에 연결했다.

QA 144 tests/0 skip 및 TypeScript build 통과. 한국어 진단을 UTF8 3000바이트 수준으로
제한하는 최종 수정 후 관련 5 tests/0 skip도 통과했다. 테스트는 실패→재시작→모델
도구 수정→새 후보 검증 성공, 실패 반복 상한, 잘못된 digest 거부, 게시된 후보 및
소진된 coding 예산의 재수정 거부를 포함한다. 실서비스 모델 호출/운영 배포 검증은
아직 아니다. main 변경 뒤 새 base로 자동 재수정하는 별도 경로도 여전히 남아 있다.

### 자동 재수정 핸들러 통합 및 Ainmem 표시 — 2026-10-11

실제 createHandler의 execute/tick과 SQLite/checkpoint/reporter를 연결한 통합 테스트를
추가했다. 한 요청의 첫 후보 실패→프로세스 재생성→같은 후보에서 재읽기/수정→다른
candidateDigest 검증 성공→needs_publication까지 확인한다. 전체 동안 job ID와 Ainmem
PUT 대상은 하나이며, 재전송 응답에도 작업 링크 하나만 유지한다. 모델/외부 API는
테스트 대역이므로 실제 서비스 E2E 완료로 취급하지 않는다.

Ainmem reporter는 validation_failed를 failed 칼럼으로 매핑하고 후보와 실패 기록을
보존했음을 설명한다. coding/needs_validation에서 재수정 이력이 있으면 현재 회차를
표시한다. 이 과정에서 approvalPending은 false이며 승인 대기 문구를 내보내지 않는다.
공통 QA 147 tests/0 skip, TypeScript build 및 diff check 통과. 운영 배포는 하지 않았다.

### 최신 main 통합과 API 전체 검사 — 2026-10-11

origin/main c8a6176을 hosted-qa-execution에 merge했다(충돌 없음, HANDOFF.md 변경).
전체 npm test 최초 실행은 924개 중 904 pass / 2 fail / 18 skip였다. 빌드는 통과했다.
실패 원인과 조치:
- hosted runtime의 실행 파일 비교가 심볼릭 링크 경로를 정규화하지 않아, Mac 임시
  경로에서 main이 실행되지 않았다. 실제 경로를 비교하도록 수정하고 명시적 runtime
  alias를 통한 두 프로세스의 상태 보존·토큰 비노출 회귀 검사를 추가했다.
- cluster fixture는 구/신 버전을 함께 seed한다. 구 버전이 VERIFIED를 거쳐 이미
  SUPERSEDED가 된 경우도 검증 정족수와 서명이 유효한데 순간 상태만 기다리며 실패했다.
  quorum_ok와 허용된 검증 완료 상태를 검사하고 기존 supersede 검사는 유지했다.
수정 후 두 파일의 13 tests/0 skip 및 build 통과. 전체 suite 재실행 결과는 아직 아니다.

cluster 테스트의 큰 blob 다운로드는 HTTP status만 검사하고 본문을 읽지 않아 종료 시
연결이 남는 것을 실제 소켓 조회로 확인했다. arrayBuffer를 소비하고 비어 있지 않음을
검사하도록 보완했으며 별도 cluster 재실행 결과를 확인한다.

다운로드 본문 처리 후 cluster 재실행은 8 pass / 0 skip, 18.6초에 정상 종료했다.

### 수정 후 API 전체 suite 재확인 — 2026-10-11

5420891(최신 main c8a6176 포함)에서 `npm test`를 다시 실행했다.
924 tests: 906 pass / 0 fail / 18 skip / 0 cancelled, 57.8초.
최초 전체 실행에서 실패했던 cluster 정족수/상태 검사와 runtime 경로 검사도 포함해
통과했다. 이 수치는 로컬 API suite이며 opt-in Docker 및 실제 외부 서비스 검사의
18 skip을 통과로 계산하지 않는다. 로그: /tmp/qa-native-final-suite.log.
최종 소스 build는 직전 turn의 /tmp/qa-main-final-build.log에서 통과했다.

.41의 SSH multiplex 연결과 사용자 서비스/자동 배포 타이머는 동작 중이다.
acl 패키지는 미설치이며 sudo -n은 사용할 수 없다. 이번 설치 시도는 Vault Locked로
자격증명을 얻기 전에 종료됐으므로 서버 패키지/서비스는 변경되지 않았다.
PR71/76 승인과 실제 운영 등록·단일 작업기 전환, 전 채널 E2E는 계속 미완료다.

### 최신 native 코드의 실제 hosted Docker 연결 재확인 — 2026-10-11

3e31f95의 compiled runtime을 .41 별도 디렉터리에 반입해 opt-in
hosted-qa-product-validation 검사를 실행했다. 새 validation.mjs가 coding.mjs를
import하므로 검사 전용 agent bundle에 coding.mjs와 repository.mjs를 추가했다.
운영 agent bundle이 아닌 진단 fixture의 누락을 수정한 것이다.

첫 준비 시 기존 ainize-cicd-integration 네트워크가 사용 중이라 실행 전에 중단했다.
기존 컨테이너를 정지하지 않고 이번 실행용 내부 네트워크 ainize-qa-diag-u9j3zb를
생성했다. 검사 후 삭제까지 확인했다. 운영 서비스와 기존 QA 작업기는 변경하지 않았다.

실제 Docker agent→private gateway→제품 validator 실행: 1 pass / 0 fail / 0 skip,
약 39.2초. agent runtime을 중간에 재시작해도 job ID가 유지됐고 host 검증 실행은
정확히 한 번이며 needs_publication에 도달했다. 제품 profile은 기존 Ainspace PR198
6bec65cef4a05e42f52a668850fd728ba09c42d2의 lint-only다. 모델을 호출하거나 새 수정,
PR/페이지/승인/배포를 수행한 검사가 아니다. 전 제품 운영 E2E 완료로 간주하지 않는다.

증거: /mnt/newdata/qa-services/validation/native-gateway-20261011-U9J3ZB/integration.log.
ACL은 이 진단 PATH에 기존 추출 도구를 사용했다. 운영 ACL 패키지는 여전히 미설치다.

### 실제 Ainize 모델의 native 코딩 재확인 — 2026-10-11

최신 compiled runtime과 examples/qa-agent를 사용해 .41에서 hosted-qa-live-coding을
실행했다. 진단 게이트웨이를 Unix socket으로 전환해 외부 TCP 포트가 필요 없도록 했고,
운영 network 이름 거부도 추가했다. 전용 내부 network ainize-qa-model-u9j3zb만 생성하고
검사 후 삭제했다. 운영 모델 설정은 호스트에서 읽었으며 비밀값을 출력하거나 저장소에
넣지 않았다.

Qwen3.8-Flash-Next 실제 호출: 1 test / 0 fail / 0 skip, 약 22.6초.
모델이 테스트용 sum.mjs를 native read/replace 도구로 수정하고 중간 runtime restart
후에도 같은 job ID와 coding checkpoint를 이어 갔다. 결과는 network=none인 별도
컨테이너에서 양수·음수·영·소수 입력의 고정 산술 assertion 5개를 통과했다.
제품 저장소/운영 채널/PR/페이지에는 쓰지 않았고 실제 제품 전체 E2E를 의미하지 않는다.

증거: /mnt/newdata/qa-services/validation/native-gateway-20261011-U9J3ZB/live-coding.log.
운영 ACL 설치 및 선행 PR 승인·배포, canonical page enrollment와 6개 채널/7개 제품
profile의 단일 native writer 전환은 계속 남아 있다.

### 호스트 검증 실행 예외의 제한 재시도 — 2026-10-11

HostedQaValidationService에서 run 자체가 예외를 내면 실패 receipt를 영구 반환하던
경로를 보완했다. 새 실행 예외는 30초 backoff, 최대 총 3회 실행으로 제한하고 시도
횟수/다음 시각을 private receipt에 저장한다. backoff 중에는 busy로 응답해 handler가
같은 작업을 보존하며 다음 tick에서 확인한다. 재시작해도 지연/횟수를 초기화하지 않는다.
동일 시점의 중복 polling은 실행 중 검증을 공유하며 동시 실행 제한도 유지한다.

실제 gate 실패(done, passed:false)는 이 재시도 대상이 아니며 기존 모델 자동 재수정
경로로 간다. 반환 candidate/gate binding이 잘못되거나 로그 디렉터리가 symlink로
바뀐 경우는 즉시 terminal failed다. 이전 버전의 실패 receipt는 원인/시도 횟수를
복원할 근거가 없어 그대로 terminal로 유지한다. 모든 단계에서 requirePassed는 실제
성공 receipt가 없으면 게시를 거부한다. 최대 횟수 초과 후에는 실패 상태를 보존한다.

QA 149 tests / 0 fail / 0 skip, TypeScript build 및 diff check 통과. 재시작/backoff,
중복 poll, 성공 복구, 3회 상한, 제품 실패 유지, 변조된 로그 경로 거부를 확인했다.
운영 배포와 실제 채널의 장애 복구 E2E는 아직 수행하지 않았다.

### 배포 완료 작업의 승인 polling 슬롯 제외 — 2026-10-11

pendingPublications는 배포 확인이 끝난 작업까지 5개 polling batch에 넣고 있었다.
완료 작업이 누적될수록 실제 승인 대기 작업의 조회 주기가 늘어나는 원인이 된다.
이제 최신 review generation의 deployment_verified receipt가 게시된 repository/SHA와
일치하는 작업만 활성 batch에서 제외한다. publication/review/approval/release 기록은
삭제하지 않으며 lifecycle은 계속 배포 완료를 반환한다. branch_updated만 있는 작업,
다른 agent의 같은 job ID, 새 review generation, 불일치 receipt는 제외하지 않는다.

QA 151 tests / 0 fail / 0 skip, TypeScript build 통과. 기존 API로 기록 보존과 조회 슬롯,
새 generation 재등장, repository/SHA 불일치 거부를 확인했다. 운영 배포는 하지 않았다.
PR71(403860f)과 PR76(971a776)의 병합·배포/전용 DB 변경 승인을 묶어 다시 요청했으며
아직 승인 답변은 없다. 승인 대기와 무관한 공통 코드 보완을 진행한 결과다.

### AINSpace 최신 main 제품 검증 — 2026-10-11 (실행 중)

현재 main 348b3192b5894d9c4db2b500265029c147ac4791을 별도 서버 checkout으로 옮겼다.
경로: /mnt/newdata/qa-services/validation/native-ainspace-main-20261011-EIG2gw.
기존 immutable seed image 9f401e534b38d0ead9ef3c415ec728e4923877268cf0fbc0bd29b1f752210b95
와 package/lockfile 대조를 통과했다. README 원본과 같은 overlay를 사용해 기존 코드의
실행 가능성을 확인한다. 새 모델 수정이나 제품 source 변경은 없다.

현재 lint 0 errors/36 warnings, test 201 pass/0 fail/0 skip. build가 실행 중이다.
profile.json, evidence/*.log, result.json이 정본이며 로컬 실행 세션은 27911이다.
8GiB memory, 4GiB ephemeral workspace, pids512, network none, 비루트 컨테이너를 사용했다.
최종 빌드 결과를 확인하기 전 전체 제품 게이트 통과로 보고하지 않는다.

최종 결과: build 실패, 전체 profile passed=false. src/app/layout.tsx의 next/font가
Google Fonts(Geist, Geist Mono, Manrope)를 다운로드하려다 network=none에서 EAI_AGAIN
으로 실패했다. memory.events의 oom/oom_kill은 모두 0이다. 이 결과를 메모리 문제로
오인하거나 검증 컨테이너의 외부 네트워크를 열어 통과시키지 않는다.

native qa-ainspace 전환 후 실제 제품 수정 요청으로 해결할 항목:
“QA의 네트워크 없는 환경에서도 빌드되도록 Google Fonts 다운로드 의존을 없애줘.
현재 Geist/Geist Mono/Manrope의 화면 모양을 유지하고, 폰트 파일과 라이선스를 함께
관리해줘. lint·201개 기존 테스트·배포용 빌드와 실제 화면을 검증해줘.”
제품 코드는 여기서 대신 수정하지 않았고 기존 Python 작업기에 중복 접수하지 않았다.
선행 운영 전환 승인 후 같은 채널→native agent 흐름에서 다룰 재현 가능한 실패다.

### 현재 운영 23건의 공유 저장소 이관 재시험 — 2026-10-11

최신 importer/jobs/checkpoints 코드로 7개 운영 설정의 SQLite를 read-only로 읽어
6개 격리 DB로 가져왔다. Teams11/AINA2/Drive2/Ainizeweb2/API3/Ainmem2/Space1.
Ainize web/API는 같은 jobs DB에 넣고 각각 web/api route를 보존했다.
첫 실행 23 imported, 즉시 재실행 23 unchanged, 모든 대상 claimable=false.
원본 jobs/reports 조회 digest를 전후 대조해 7개 모두 sourceUnchanged=true였다.
실제 이력은 private checkpoint에 있고 Git에는 요약만 남긴다.

증거: /mnt/newdata/qa-services/validation/native-import-current-20261011-KvcFd8/summary.json.
기존 writer/agent/page/승인을 변경하지 않았으며 운영 cutover는 아니다.


### 원본 재확인 후 호스트 이관 등록 — 2026-10-11

operator 전용 `HostedQaIntake.importHistorical`과 공유 채널의
`HostedQaRoutes.activateHistory`를 추가했다. 매 실행마다 Teams 원본과 현재 작성자
멤버십을 다시 확인한다. request binding, 이관 근거, web/API route를 한 SQLite
transaction에 저장하며 부분 실패는 전부 rollback한다. 원래 job ID를 유지하고,
같은 원본의 다른 job ID 중복 등록 및 기존 native job 덮어쓰기는 거부한다.
공유 채널은 기존 importHistory로 등록한 저장소 선택만 이어받는다.
과거 승인·candidate·publication은 활성 권한으로 복원하지 않는다.

검증: QA 169 pass / 0 fail / 0 skip, TypeScript build 및 diff check 통과.
실패 trigger를 넣어 intake/audit/route 전체 rollback을 확인했고, 재시도 때 작성자
권한 회수도 다시 감지했다. .41의 실제 요청 7건(Teams3/web2/API1/Space1)을 새 격리
ledger에 등록하고 즉시 재실행해 7/7 동일 결과를 확인했다.
증거: `/mnt/newdata/qa-services/validation/native-historical-activation-gvwrq6at/summary.json`.
원본 메시지/증거와 ledger는 서버 private 디렉터리에만 보관한다.

운영 ledger/worker/페이지/승인/배포는 변경하지 않았다. 이 검사는 접수 이관 경로의
검증이며 native coding 재개나 전 서비스 E2E 완료가 아니다. canonical Ainmem 페이지
채택과 candidate 재검증/작업 재개 연결, 선행 PR71/76 승인·배포는 계속 남아 있다.
이 실행에서 ainize SSH multiplex는 open, 로컬 Vault status는 locked로 확인됐다.


### 기존 Ainmem 페이지를 쓰기 전에 고정 — 2026-10-11

AinmemReports는 이관 작업을 처음 보고할 때 immutable archive의 fingerprint와 원래
job/repository/workspace/channel/message를 대조하고 details.kanban_url을 먼저 고정한다.
archive 누락/변경이나 외부 URL은 거부한다. handler는 Checkpoints reader를 전달한다.
URL을 이미 아는 보고 요청에는 expectedPageId를 보내며, Ainmem PR76은 서버가 결정한
정본 ID와 다르면 쓰기 전에 409를 반환한다. 이 필드는 내용 revision digest에서 제외해
같은 revision의 재시도와 양립한다. 기존 API는 필드를 거부하므로 PR76의 최신 버전을
먼저 배포해야 한다. 불일치 때 precondition을 제거해 재시도하지 않는다.

QA 170 pass/0 fail/0 skip 및 build 통과. Ainmem 실제 격리 PostgreSQL HTTP suite
39 pass/0 fail/0 skip, typecheck/build 통과. .41의 기존 23개 작업 DB 복사본에서 archive
기반 URL 고정을 두 번 실행해 23/23 원래 URL을 보존했다. 이 마지막 검사는 보드 ID를
fixture로 사용한 로컬 outbox 검사이며 API 호출/운영 쓰기는 0건이다.
증거: `/mnt/newdata/qa-services/validation/native-canonical-pin-hvu9ia5j/summary.json`.
운영 page adoption/enrollment, native writer 전환 및 채널 E2E는 여전히 미완료다.


### 게시 전 중단 작업의 native 재개 — 2026-10-11

실제 GitHub 재조회: Teams #1410은 e183df9d82340998cdeb481ffa427d6bbc354df1로
2026-10-08 병합됐다. Teams #1387, Ainize web #36, API #55, Ainspace #198은 OPEN이며
head SHA가 보관 후보와 일치한다. 이 5건은 일괄 신규 코딩으로 보내지 않는다.
보관본에서 Teams 2e7f6dd3 및 Ainize web 6c05b474는 게시 후보 참조가 없었다.

`examples/qa-agent/resume-legacy.mjs`의 `resumeUnpublishedLegacy`는 offline operator
전용이다. legacy_import 대기 작업만 허용하며 code_sha/PR/승인/배포/후속 후보가 있으면
거부한다. archive hash와 원래 요청·저장소·채널·원본 페이지 origin을 확인한다.
verify adapter는 직전 구현한 host importHistorical 또는 shared activateHistory에
연결하고, prepare adapter는 동일 scope의 HostedQaBases.prepare 결과를 전달해야 한다.
준비 후 verify를 다시 호출해 작성자 권한 회수/원문 변경을 확인한다. 마지막 SQLite
transaction에서 최초 작업 snapshot과 같을 때만 원래 ID/요청/route/legacy archive를
유지하고 새 base, hostIntake, hostBase로 queued 전환한다. 이전 승인이나 코딩 결과를
활성 checkpoint로 복원하지 않는다. 별도 gateway나 모델 호출로 노출하지 않았다.

QA 173 pass / 0 fail / 0 skip 및 build 통과. 잘못된 base, 준비 도중 권한 회수,
기존 후보, 동시 상태 변경을 거부하고 상태를 보존했다. 실제 handler/Jobs를 다시 열어
prepared base에서 일반 tick이 코딩 단계를 이어받는 통합 테스트를 통과했다. 그 테스트의
외부 verify/prepare/coding은 fixture이며 실제 제품 모델 수정·배포 증거가 아니다.
운영 cutover에서는 writer 정지/페이지 등록/host profile 배포 후 이 adapter들을 연결해
재개해야 한다. 운영 두 작업을 실제로 queued로 바꾸거나 중복 실행하지 않았다.


### 실제 작업 복사본의 native 재개 준비 — 2026-10-11

`/mnt/newdata/qa-services/validation/native-unpublished-resume-g9vc6xgd`에서 기존 두 작업을
복사한 jobs DB로 resumeUnpublishedLegacy를 실행했다. Teams 원본/현재 사람 멤버 확인,
실제 host intake ledger(웹/API 공유 route 포함), HostedQaBases 및 prepareQaCheckout를
연결했다. 모델/제품 코딩/PR/페이지/운영 worker 쓰기는 수행하지 않았다.

- Ainize web 6c05b474: 현재 main 2c493a2880032adfe73ead7f32150505cd835f05로 queued,
  원래 ID/요청/정본 페이지 archive 보존. `summary.json` 참조.
- Teams 2e7f6dd3: 최초 진단에는 GitHub 인증을 전달하지 않아 fetch가 실패했다.
  운영 server.ts는 readQaToken(tokenPath)를 prepareQaCheckout에 전달하는 것을 확인했다.
  진단에는 로컬 인증 Git에서 가져온 정확한 commit을 bundle로 옮겨 재시도했다.
- 그 뒤 기존 0e6dfedd 이미지와 현재 f118bbfea579984dabb6d652a2d5219bdce8708a의
  package/lock/workspace 파일 차이를 감지해 `Dependency image refresh required`로
  다시 거부했다. 두 실패 모두 copied job unchanged=true였다.
- 새 격리 이미지 빌드를 완료하고 새 profile로 다시 실행해 Teams도 같은 ID로 queued가
  됐다. `teams-refreshed-summary.json` 참조. 기존 실패 기록도 보존했다.

새 Teams 준비 경로: `/mnt/newdata/qa-services/validation/native-teams-refresh-61qaqajj`.
image: `sha256:fa5f1248c066ad9244edaffef4062dc20e4f4d3580f5a4f200ddb21ed42c3fd4`.
현재 main의 전체 typecheck/lint/test/build 게이트가 별도 진단으로 실행 중이다.
원본 README와 동일한 overlay를 사용해 제품 수정 없이 환경/현재 gate를 검사한다.
`validation.log`, `result.json`, `evidence/`가 결과 정본이고 로컬 process handle은 47038이다.
컨테이너 실행 및 backend/desktop typecheck 성공을 확인했으며 web typecheck는 아직 진행 중.
이 상태를 전체 gate 통과나 실제 채널 E2E 완료로 해석하지 않는다.


### 최신 API 전체 회귀 및 릴리스 전제 재확인 — 2026-10-11

4ec1c69에서 전체 API suite 실행 완료: 950 tests / 932 pass / 0 fail / 18 skip,
34.285초. 로컬 증거 `/tmp/qa-full-current-api.log`. 이번 검사는 historical intake,
canonical page pinning, unpublished legacy resume를 모두 포함한 상태다.

GitHub branches/main을 직접 읽어 Teams/Ainmem/Drive/Ainize web/API/AINA/Space 모두
protected=false임을 확인했다. 현재 fast-forward-unprotected adapter의 브랜치 보호
전제와 일치한다. 이 관측은 나중의 배포 승인이 아니며 release 직전 다시 확인해야 한다.
운영 endpoint/서비스 SHA 검증 및 관리자 승인, 6개 채널 전체 E2E는 여전히 남아 있다.

Teams f118bbfe 검증은 현재 typecheck 전체 통과, backend lint 통과, web lint 실행 중이다.
동일한 실행 handle 47038과 native-teams-refresh-61qaqajj 결과를 계속 추적한다.
실행 중인 검사를 중단하거나 새 실행으로 대체하지 않았다.


### Git 파일 목록 검사 환경 복구 — 2026-10-11

Teams f118bbfe의 현재 전체 테스트에서 docker-context.test.ts가 Git 저장소 부재로
3개 실패하는 것을 확인했다. exported source만 전달하는 validator에는 .git이 없었다.
운영자 opt-in `gitInventory`를 추가해 컨테이너 안에서 후보 파일만 빈 Git 인덱스에
등록한다. dependency 복사 전에 수행하며 호스트 Git 이력/config/remote/credential/hooks를
전달하지 않는다. 모델은 이 옵션을 켜거나 .git 파일을 후보로 추가할 수 없다.
정책 버전은 5-isolated-git-inventory로 올려 이전 receipt 재사용을 차단한다.

QA 174 pass/0 fail/0 skip, TypeScript build 통과. .41 실제 Docker에서 격리 조건
assertion(원격/HEAD/훅/alternates 없음, README 추적, node_modules 미추적)을 통과했다.
같은 Teams source의 docker-context.test.ts 4개가 모두 통과했다(0 skip, 약 1.03초).
증거: `/mnt/newdata/qa-services/validation/native-git-inventory-fctn5u_l/`.
제품 코드를 수정하거나 테스트를 제거하지 않았다. `full-profile.json`은 원래 전체
gate 목록을 유지한 차기 재검증용이며, 짧은 진단용 profile을 release에 사용하지 않는다.

기존 전체 검사 handle 47038은 중단/대체하지 않았다. typecheck/lint 통과 후 test 진행 중이며,
아직 전체 결과가 없다. 현재 관측한 backend 부분 결과는 1523 pass/1 fail/77 skip,
4 failed suites이고 desktop은 126 pass/2 skip이다. 원인/최종 결과는 완료 로그로 확인해야 한다.
새 인덱스 지원이 나머지 실패까지 해결했다는 증거는 없고 운영 활성화/배포도 하지 않았다.

### Teams f118bbfe 전체 테스트 결과와 실행 부담 분리 — 2026-10-11

`native-teams-refresh-61qaqajj` 전체 실행(handle 47038)은 종료됐다.
Typecheck/lint PASS, test FAIL, 이후 build는 실행되지 않았다. OOM/oom_kill 모두 0.
- Backend: 1523 pass / 1 fail / 77 skip, 4 failed suites. 3개 PGlite suite의
  beforeAll 10초 초과와 public-fetch.spec.ts의 실제 example.com DNS 의존 실패.
- Web: 7042 pass / 3 fail / 114 skip, 2 failed suites. Git 목록 검사 3개 실패와
  thumbnail.test.ts의 fixture 생성 beforeAll 60초 초과.
- Desktop: 126 pass / 2 skip. 건너뜀을 성공으로 계산하지 않는다.
전체 suite에 대한 후속 통과 결과는 아직 없다.

실행기 Git inventory 보완 후 Git 목록 검사 4/4 통과는 직전 기록을 참조한다.
추가로 기존 시간 제한/제품 코드/테스트 내용은 유지하고 Vitest --maxWorkers=1로 검사했다.
- `native-db-concurrency-i7zu14t9`: PGlite 3개 파일 9 pass / 0 skip, 14.26초.
- `native-thumbnail-concurrency-j9mwp1dz`: thumbnail 18 pass / 0 skip, 22.52초.
두 경우 모두 같은 2 CPU/8GiB 격리 컨테이너에서 통과했다. 각 evidence/와 result.json 보존.

차기 전체 profile은 `native-db-concurrency-i7zu14t9/full-profile.json`에 보존했다.
원래 전체 gates를 유지하며 gitInventory=true 및 테스트 명령에 workspace-concurrency=1,
maxWorkers=1을 적용한다. pinned source의 backend/web/desktop test script가 모두
vitest run인 것을 확인했으며 원래 test script를 통해 실행한다. 전체 재검증은 아직 안 했다.
외부 DNS에 의존하는 public-fetch 검사는 여전히 실패하므로 단독 통과 결과를 합쳐
전체 제품 PASS로 표시하지 않는다. 이 DNS 의존은 native qa-ainteams 전환 후 실제 수정
요청으로 다루고, 네트워크를 열거나 assertion을 건너뛰지 않는다.

현재 main의 build를 별도 확인 중:
`/mnt/newdata/qa-services/validation/native-teams-current-build-4bq_b1k6`, handle 25187.
원본 전체 실행을 재시작한 것이 아니라 이전 실패 때문에 미실행된 build gate 진단이다.
운영 writer/채널/PR/페이지/배포에는 쓰지 않았다.

### Teams 빌드 힙 제한 진단 — 2026-10-11

`native-teams-current-build-4bq_b1k6` 빌드는 종료됐으며 passed=false다.
Backend/desktop build는 성공했지만 web TypeScript worker가 약 2GiB V8 힙 한도에
도달했다. memory.events의 oom/oom_kill은 모두 0이며 컨테이너 전체 OOM은 아니다.
원본 로그는 evidence/build.stdout.log와 build.stderr.log에 보존했다.

8GiB 컨테이너 제한을 유지하고 build gate env에
NODE_OPTIONS=--max-old-space-size=4096을 추가한 진단을 실행 중이다.
`/mnt/newdata/qa-services/validation/native-teams-build-heap-c5ju_rgb`, handle 46194.
타입 검사나 빌드를 생략하지 않으며 제품 소스도 바꾸지 않았다. 결과 확정 전에는
성공으로 취급하지 않는다.

Native QA branch는 현재 origin/main을 포함한다(ahead 91/behind 0). PR70은
OPEN/DRAFT/MERGEABLE이다. PR71/76 배포 승인에는 아직 답변이 없고 Vault는 locked다.
운영 전환·페이지 enrollment·전체 채널 E2E는 미완료다.

### Teams 컨테이너 메모리 진단과 제한 조정 — 2026-10-11

4GiB Node 힙/8GiB 컨테이너 재시도 `native-teams-build-heap-c5ju_rgb`는 실패했다.
이번에는 exit 137, memory.events oom=12/oom_kill=2로 컨테이너 OOM이 확인됐다.
최초 실행의 V8 힙 한도 실패와 구분한다. 타입 검사나 제품 코드는 바꾸지 않았다.

서버 MemAvailable=123990108KiB(약 118GiB)를 확인했고, validation service의 running.size
가 한 번에 한 실행만 허용하는 것을 확인했다. 운영자 memory 상한을 16GiB로 확대했다.
기본 4GiB, 후보의 설정 변경 거부, workspace≤memory 및 기존 CPU/PID/time 제한은 유지한다.
정책 버전 6-bounded-large-builds. QA 175 pass/0 fail/0 skip, TypeScript build 통과.

12GiB 컨테이너/4GiB Node 힙 진단 실행 중:
`/mnt/newdata/qa-services/validation/native-teams-build-12g-l5dhvl8w`, handle 23271.
profile.json과 run.log/result.json이 정본이다. 이 결과는 아직 미확정이며 운영 profile은
변경하지 않았다. 이전 실패 기록은 그대로 보존했다.
