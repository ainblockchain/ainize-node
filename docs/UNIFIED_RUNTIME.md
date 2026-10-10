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
