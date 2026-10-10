# Repository → Project → Runtime implementation

This work implements the integrated design agreed on 2026-10-10. A repository has one writable source; a project binds source/path/branch to a runtime kind; every execution names its source commit and actor. Existing agent git URLs and history remain available through the legacy adapter. AIN Drive owns new project repositories, GitHub mirrors stay read-only here, and ainize owns execution.

## Acceptance ledger

Each item requires implementation and direct verification before completion.

- [ ] Common repository identity and execution contract across project and agent APIs.
- [ ] Record source commit separately from internal projection commit.
- [ ] Show latest source and active runtime commits; failed updates preserve the prior runtime.
- [ ] Prevent a project/mirror agent from acquiring a second writable source through git, PR merge or CRUD.
- [ ] One validation/application pipeline for push, merge, mirror and project agents; validate merged results.
- [ ] Connect signed mirror webhook and periodic reconciliation, with serialized sync and visible failures.
- [ ] Durable AIN Drive push delivery with retry, deduplication and restart recovery.
- [ ] Common run form and logs in Drive and ainize; explicit working-tree/selected-commit/deployed targets.
- [ ] Mobile repository controls (PR aindrive#230), plus ainize mobile execution surfaces.
- [ ] PR creation UI and fixed-SHA temporary previews with TTL and no inherited production secrets/write permissions.
- [ ] Preview/run records retain model, inputs, source SHA and output for quality comparisons.
- [ ] AinCode clones and pushes agent git instead of comparing integer versions over JSON.
- [ ] Agent CLI clone/pulls/mirror commands.
- [ ] Document all git, PR, mirror, preview and common execution APIs in generated references.
- [ ] Repository growth limits and maintenance; export before deletion.
- [ ] Verify Clef script and service transition preserve repository/project identity.
- [ ] Verify rejected agent trees, failed builds, duplicate/lost notifications, restart recovery and compatibility URLs/history.

## Contracts

Push acceptance and runtime readiness are separate states. Legacy agent git waits for apply completion before ending receive-pack; asynchronous Projects return a queued execution. A source commit is the immutable input. An agent's generated repository commit is a projection, never an alternative source. Deployment and one-off run records share identity and result fields but runs cannot change the project's active deployment.

Configuration remains local to its package: ainize.json owns execution; agent.json/prompt.md/files own agent behavior; ownership, credentials and permissions remain server-owned. No cross-repository source imports are required.

## Verified implementation progress (2026-10-10)

- Drive branch includes mobile commit `e09f95e` (the change also remains reviewable as aindrive PR #230). Type checking and 25 repository/run-input tests passed on the current base.
- Agent mirror reconciliation now shares one serialized synchronizer for periodic and signed webhook requests; original request bytes are checked after the global JSON parser. Real Git tests cover automatic reconciliation, reserved-field rejection, and tag filtering.
- Runtime ledger distinguishes source/projection commits and preserves the prior active version on failed replacement. Project active deployment survives failed newer deployments and pruning. Agent push now checks sharing policy before moving its deployed ref; real HTTP Git push proves rejection leaves the ref unchanged.
- Drive deliveries are persisted before network requests, leased, retried in repository order, and deduplicated by immutable event/actor identity. Tests cover 503 recovery, actor retention, expired worker leases, ordering and duplicate events. The production worker bundle starts and stops successfully under Node 22.
- Auto-binding accepts `bindRequestId` so the same authenticated application can recover its lost creation response. A different receipt or legacy lookup cannot read the hook secret. Eight auto-binding API tests passed; Drive's 15 binding/delivery tests passed.

Remaining ledger items retain their full scope; these observations do not prove end-to-end completion or production deployment.

## Added deployment and HANDOFF scope (user instruction, 2026-10-10)

All remaining items in `HANDOFF.md` are explicitly required, including its smaller items:

- [ ] Cross-owner forks and cross-repository PR permissions, preserving the original source and validating the merged result.
- [ ] PR review comments (authenticated authorship and proposal visibility rules).
- [ ] AIN Teams Run UI: viewer identity, manifest inputs/model, selected/deployed commit, streaming output, error/cancellation, and mobile reachability.
- [ ] Deploy the completed changes to ainize-node, ainize-web, AIN Drive, AinCode workspace runtime and AIN Teams using their release procedures.
- [ ] Verify production repository endpoints, signed mirror synchronization, preview isolation/expiry, Run from Drive and AIN Teams, preserved active runtime on failed replacement, and compatibility URLs.

Current version-run progress: streamed project runs accept explicit HEAD/commit/deployed targets, persist execution/actor/input/log records, and default link snippets to the last successful deployment. Real Git HTTP tests prove HEAD differs from a pinned older SHA and that a failed latest deployment does not redirect deployed runs. Drive forwards immutable version runs to the project using the person’s SSO actor; it does not fall back to mutable files on authorization failure. Local rendering at 320/390/640/1280 px had no horizontal overflow; mobile version selectors are 44 px high with 16 px text. Ainize console exposes version selection and exact-SHA Run again. This is partial evidence; selected-version manifest forms and full AIN Teams integration still need completion.

### 2026-10-10: AIN Teams 및 버전별 폼·리뷰 진행

- AIN Teams에서 기존 PR #1458의 Run 소비자를 채택했다. 종료 누락·네트워크 실패·중단을 재현 후 수정했고, 웹 전체 7,395개 테스트와 타입 검사가 통과했다(98개 환경 의존 테스트 제외). 아직 release/운영 검증은 완료하지 않았다.
- ainize-node → sandbox/HTTP run 어댑터까지 취소 신호가 전달된다. 해당 어댑터·실제 Git 저장소를 사용하는 Run 테스트 13개 통과.
- `/api/projects/:id/source?target=head|commit|deployed&sha=…`는 같은 조회 권한으로 선택된 SHA의 manifest를 반환한다. Drive의 인증 중계와 ainize 웹 폼이 이를 사용하고, 표시한 SHA를 실행 요청에 고정한다. Drive 관련 17개 테스트 및 양쪽 타입 검사 통과.
- PR 생성 UI와 리뷰 댓글 API/UI를 추가했다. 댓글은 커밋·파일·줄에 고정할 수 있고, 수정은 작성자, 삭제는 작성자/관리자만 가능하며 삭제 흔적과 재시작 후 보존을 확인했다. 실제 노드 Git push/merge 및 리뷰 테스트 13개, 웹 관련 테스트 44개 통과. 신규 UI 렌더 검증은 추가로 필요하다.
- 남은 수용 조건(포크·미리보기·CLI·AinCode·공통 문서·보관/삭제/크기 및 전체 운영 배포)은 계속 열려 있다. 위 진행 기록은 전체 완료나 배포 완료를 의미하지 않는다.

- 포크: 읽기 권한이 있는 사용자가 개인 Git 저장소로 포크하고 원본에 변경을 제안할 수 있다. 포크는 실행 환경/비밀값을 만들지 않으며 다른 사용자와 원본 관리자도 직접 읽을 수 없다. 제안 시점 SHA는 원본 저장소 내부 참조로 보존한다. 실제 HTTP clone/push, 타인 포크 도용 거절, 이후 push/삭제 후 고정된 코드 merge를 포함하는 실제 노드 12개 테스트가 통과했다. 소유자별 포크 한도와 재시작 보존 테스트도 통과했다. 운영 검증은 아직 남아 있다.

### 2026-10-10: 미리보기·Git 도구·모델 선택

- 임시 에이전트 미리보기(`8262015`, web `59b1027`)는 제안의 고정 SHA로 별도 실행한다. 읽는 사용자 본인만 접근하며 운영 비밀값·외부 호스트 권한·운영 작업 저장소를 상속하지 않는다. 15분 만료·사용자/전체 한도·중단 및 컨테이너 이미지 정리를 구현했다. 실제 Git 및 실제 prompt runtime 기반 테스트 14개와 host 회귀 테스트 22개 통과. 브라우저에서 제안·댓글·포크·대화/종료를 확인했고 320/390/640/1280px에 가로 넘침이 없었다. 실행 비교 기록의 지속 보관과 운영 검증은 남아 있다.
- AinCode(`c63c88c`)의 agent 폴더는 실제 clone이며 pull은 fast-forward, push는 commit 후 main push다. 기존 JSON 폴더와 동시 원격 편집을 강제로 덮지 않는다. 게이트웨이가 현재 세션으로 smart HTTP를 중계하며 자격증명은 clone 설정에 저장하지 않는다. 실제 bare Git/HTTP clone·push·충돌 테스트를 포함한 8개 검사와 gateway 타입 검사 통과. 새 이미지 배포는 남아 있다.
- ainize-cli(`fedf78f`)에 agent clone/pulls/mirror를 추가했다. 실제 HTTP Git clone에서 토큰을 설정 파일에 저장하지 않음을 검증했고 제안·미러의 요청/권한 계약 테스트가 통과했다. build/typecheck 통과. 전체 테스트의 초기 실행에서 dist가 없던 version 검사 1건을 빌드 후 재검증했다. 패키지 배포는 남아 있다.
- ainize 스니펫은 폼에 표시한 active SHA를 `target=commit` 실행 요청에 고정한다(`5ca49c0`). Drive와 ainize 생산자가 표준 ChoicePicker로 모델/boolean을 표현하고, Teams와 ainize 소비자가 이를 그린다. node 11개, Drive 28개 및 관련 타입 검사 통과. Teams의 선택값/스트림 보존 검사는 통과했으며 전체 회귀·채팅 레이아웃 검사 및 운영 연동은 진행 중이다.
- 아직 모든 운영 배포, Teams/Drive 스니펫의 실행 대상 전환, CLI 생성 문서, 저장소 성장/GC/보관 및 Clef 서비스 전환 검증은 완료하지 않았다.

### 2026-10-10: 카드 버전 고정과 실행 기록 보존

- Drive `a053215`: 연결된 저장소의 파일/저장소 카드가 표시한 SHA의 manifest를 사용자 권한으로 조회하고 같은 SHA를 실행한다. 해당 버전 조회가 거절되거나 실행 불가능한 서비스 버전이면 mutable 파일 실행으로 대체하지 않는다. ChoicePicker 모델 선언도 선택된 manifest에서 가져온다. 카드/HTTP 관련 30개 테스트 및 타입 검사 통과. 작업 트리/HEAD/배포본을 카드 안에서 전환하는 UI와 운영 확인은 남아 있다.
- Node `e60b93e`: 에이전트 실행 이력을 전체 보존하고 `/api/hosted-agents/:id/executions`에서 조회 권한과 페이지 제한을 적용해 최신순으로 반환한다. 이전 ledger의 마지막 실행을 이전하며, 늦은 콜백은 이전 기록만 완료하고 현재 활성 버전을 덮어쓰지 않는다. 실제 Git HTTP·권한·문서·재시작 검증 18개와 타입 검사 통과. 이는 에이전트 배포 기록 보존이며 preview 입력/출력 기록과 비교 화면까지 완료했다는 의미는 아니다.
- 이전 Teams 레이아웃 검사와 CLI start 재검증 핸들은 더 이상 존재하지 않고 로그도 최종 결과 없이 끝났다. Teams 데스크톱/확장 검사 중 실패 흔적이 있어 전체 화면 검증 통과로 간주하지 않는다. 완료된 웹 단위 검사 결과(7,396개)는 별도 증거로 유지한다.
- 전체 구현·배포 목표는 계속 열려 있다. 새로운 운영 배포를 수행하거나 확인한 상태는 아니다.

- Web `8364ab4`: 저장소 화면에서 영속 실행 기록을 최신순/10건 단위로 조회하고 상태·source SHA·actor·시간·실패 사유를 표시한다. HostedAgent 변경 시 캐시 무효화와 10초 갱신을 적용했다. 관련 기존 회귀 46개 및 수정 후 타입 검사 통과. 브라우저에서 새 목록의 페이지 이동/모바일 동작 검증은 아직 하지 않았다.

### 2026-10-10: 실행 대기열과 목록 화면 검증

- 실행 목록의 실제 컴포넌트를 테스트용 API 응답과 연결해 첫 10건/마지막 2건, 이전·최신 이동, 실패 사유를 확인했다. 320/390/640/1280px에서 가로 넘침 없음과 모바일 버튼 44px 이상을 확인했다. 임시 화면과 개발 서버는 제거/종료했다. 이 검증은 운영 데이터 연동의 증거가 아니다.
- 스트리밍 project Run은 ProjectWorker의 배포 대기열에서 같은 프로젝트의 FIFO와 노드 전체 동시 실행 제한을 공유한다. 슬롯을 checkout 이전에 얻고 정리 후 반환한다. 대기 취소·worker 중단·슬롯 반환을 검증했다. 재시작에 끊긴 Run은 실패로 기록하며 사용자의 코드를 자동 재실행하지 않는다. 실제 Git/HTTP 프로젝트 회귀와 대기열/취소 검사 22개 및 타입 검사 통과.
- 전체 목표와 운영 배포는 여전히 미완료이며 수용 조건 전체를 축소하지 않는다.

### 2026-10-10: 미리보기 대화 증거 보존

- Node `b611927`: 임시 미리보기의 대화 요청/응답을 커밋·모델·사용자와 함께 개인 ledger에 보존한다. 런타임 종료/만료 후에도 현재 원본 조회 권한을 가진 기록 작성자만 `/api/hosted-agents/:id/preview-runs`로 읽는다. 조회는 기본 10건/최대 50건이며 응답 저장은 256KiB와 명시적인 잘림 표시를 사용한다. 소유자 200건/전체 2,000건 한도에서 새 기록을 거절해 기존 기록을 조용히 삭제하지 않는다. 파일 권한은 0600이다.
- 실제 Git·실제 prompt runtime의 대화, 만료 후 보존, 다른 사용자와 조회 권한 상실 거절, 재시작에 끊긴 요청의 실패 기록 및 반환 객체 변경 방지를 포함하는 4개 검사와 타입 검사 통과. 미리보기 응답이 운영 권한/비밀값을 상속하지 않음을 기존 실제 런타임 검사와 함께 확인했다.
- 대화 비교 UI, 기록 내보내기/명시 삭제, 전체 운영 배포는 남아 있다. 수용 조건 전체의 완료로 간주하지 않는다.

### 2026-10-10: 증거 내보내기·삭제와 비교 화면

- Node `1cf7b1f`: 개인 대화 기록의 내보내기/명시 삭제 API를 추가했다. 삭제는 작성자 본인과 현재 원본 조회 권한을 확인하고, 완료 및 내보내기 이력을 요구한다. 실행 중 내보낸 후 응답이 완료되면 내보내기 이력을 무효화해 최종 응답을 내보낸 뒤 삭제하도록 한다. 실제 미리보기 HTTP 권한·내보내기·삭제와 기록 저장 검사 통과.
- ainize 웹은 두 저장 기록의 커밋/모델/입력/응답을 비교하고 JSON 다운로드 후 명시 삭제할 수 있다. 페이지 이동과 한글 상태를 제공한다. 관련 기존 회귀 46개와 수정 후 타입 검사 통과. 새 비교 화면의 브라우저/모바일 상호작용 검증은 아직 남아 있다.
- 운영 배포, Teams/Drive 카드 내 대상 전환, 저장소 유지 관리와 Clef 서비스 전환 등 전체 미완료 범위는 계속 유지한다.

### 2026-10-10: 비교 화면 검증과 미러 해제 경합

- 미리보기 비교의 실제 UI를 테스트 응답과 연결해 두 기록 선택/입력·응답 비교, JSON 다운로드 파일 내용, 내보내기 전 삭제 비활성 및 삭제 후 갱신을 확인했다. 320/390/640/1280px에서 가로 넘침 없고 모바일 버튼/선택 높이 44px, 선택 글자 16px 이상이었다. 임시 화면과 개발 서버는 정리했다. 이는 운영 데이터 연동 검증이 아니다.
- 미러 configure/detach를 fetch/apply/land와 같은 에이전트 대기열에 넣었다. 실제 Git 동기화를 apply 중 멈춰 두고 detach가 완료 응답을 기다리는지, 해제 뒤 대기하던 이전 sync가 적용하지 않는지, 재연결이 새 작업으로 적용하는지 검증했다. 미러 관련 9개 검사와 타입 검사 통과.
- 저장소 삭제/내보내기/유지 관리, 카드 대상 전환, CLI/문서/이미지 및 전체 운영 배포를 포함한 미완료 범위는 계속 열려 있다.

### 2026-10-10: 생성 API·CLI 참조

- Node `50b3f2b`: streamed Run OpenAPI에 실제 head/commit/deployed 선택, SHA, 입력/env 한도, timeout, 실행 ID, 대기열/취소 및 재시작 동작을 반영했다. 필드/한도와 실제 repository 라우트의 문서 존재 검사 2개 및 타입 검사 통과.
- Web `d795f5c`: 커밋된 node API와 실제 CLI 선언에서 HTTP API/CLI 참조를 생성해 Git transport, PR/댓글/포크, 자동 미러, 미리보기·개인 기록/내보내기/삭제, 실행 기록과 clone/pulls/mirror 명령을 포함했다. 해당 참조의 화면 데이터도 커밋했다. 다른 작업의 AINFT 문서와 화면 데이터는 작업 트리에 보존하고 이 커밋에 포함하지 않았다. `gen:check` 통과.
- 문서 생성은 명시적인 sibling worktree 경로를 환경 변수로 받을 수 있으며 경로/누락 검사 2개가 통과했다. 전체 config/schema/error 참조의 생성 검사와 모든 운영 배포는 아직 미완료다.
