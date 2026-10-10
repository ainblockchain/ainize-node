# Ainize 네이티브 QA 에이전트 인수인계

작성일: 2026-10-05. 대상 저장소: `ainblockchain/ainize-node`, 브랜치: `hosted-qa-execution`.

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
