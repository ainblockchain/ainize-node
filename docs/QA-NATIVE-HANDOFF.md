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

이 문서와 코드에는 비밀번호, OTP, 토큰, 비밀키가 포함되어서는 안 된다.
