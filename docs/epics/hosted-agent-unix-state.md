# Docker 권한 테스트 준비 데이터 수정

## 사전 승인된 범위

요청에 따라 PR55(c2a1f599fa84ae5a3796bbbd225876d1693634d5)의 상태 디렉터리,
Unix gateway ACL, 런타임 상태 경로 디코딩 수정 및 회귀 테스트를 main 기반에 보존한다.
Docker 테스트의 handler 소스를 spec과 이미지 빌드에서 공유하여 빈 코드 검증 오류를
해결하고, Docker 없이 실행되는 준비 데이터 회귀 검사를 추가한다.

호스트 UID 1000/2000, 새 상태/기존 UID 1000 소유 상태, 두 번의 시작,
A2A → Unix gateway → 테스트 모델 호출, 에이전트 격리, 무관한 UID 34567의
접근 거부와 무토큰 401 검증을 유지한다. 운영 데이터와 권한 정책은 변경하지 않는다.
버전, 지침, CI/릴리스 정책, git history를 변경하지 않으며 커밋/배포하지 않는다.

## 검증 계획

### 컨트롤러 검증 실패 보완 (사전 승인 범위)

전체 검사에서 SSE 첫 조각의 고정 100ms 제한이 부하 때문에 실패했다.
SSE 테스트를 클라이언트 수신 확인 후 다음 이벤트를 쓰는 방식으로 바꿔,
응답 종료 전 각 이벤트 전달과 일반 JSON gzip 압축을 계속 검증한다.
제품 코드나 CI 게이트는 변경하지 않는다. 소켓 실행은 controller-pending이다.

권한 단위 검사, 준비 데이터 회귀 검사, 타입 검사와 빌드를 실행한다.
실제 Docker/ACL 및 소켓 검증, 전체 저장소 검증, sibling 문서 검사와 task-card/PR
처리는 controller-pending이다. 과거 독립 검사는 저장소 Docker 테스트 통과로 기록하지 않는다.

컨트롤러는 ACL 지원 파일시스템, acl 패키지와 user namespace remapping 없는 Docker를
준비하고 읽을 수 있는 checkout에서 아래 명령을 각각 해당 비-root 계정으로 실행한다.

```sh
AINIZE_TEST_UNIX_PERMISSIONS=1 AINIZE_TEST_HOST_UID=1000 node --test --import tsx test/hosted-agent-permissions-docker.test.ts
AINIZE_TEST_UNIX_PERMISSIONS=1 AINIZE_TEST_HOST_UID=2000 node --test --import tsx test/hosted-agent-permissions-docker.test.ts
```

각 명령은 새 상태와 기존 상태에 대해 두 번 실행 및 거부 검증을 포함한다.
PR55는 이 보완의 컨트롤러 검증 전에 배포하지 않는다.

## 이번 checkout 결과

- `node --test --test-isolation=none --import tsx test/hosted-agent-access.test.ts test/hosted-agent-permissions-docker.test.ts`: 6 통과, Docker 2 건 skip.
  명령 대역을 사용한 준비 데이터/권한 검사는 실제 Docker/ACL 증거가 아니다.
- `npm run typecheck`, `npm run build`, `git diff --check`: 통과.
- PR55의 운영 코드 4개 파일 및 권한 단위 테스트는 원본과 바이트 단위로 동일하다.
- 실제 Docker UID 행렬, 소켓 통합 검사, 전체 저장소 및 sibling 문서 검증:
  controller-pending. 저장소 Docker 테스트의 통과를 주장하지 않는다.

### SSE 검증 보완 결과

- 권한/준비 데이터 테스트와 SSE 테스트를 함께 실행: 6 통과, Docker 2 skip,
  SSE 1 실행 불가(`listen EPERM: operation not permitted 127.0.0.1`).
  SSE는 controller-pending이며 통과로 기록하지 않는다.
- `npm run typecheck`: 통과. 기존 PR55 권한 코드 및 UID/재시작/거부 검증 유지.
- 컨트롤러는 수정된 SSE 테스트와 전체 저장소 검증, 위 Docker UID 행렬을 실행해야 한다.
  SSE 테스트는 100ms 도착 제한 대신 네 이벤트 각각의 수신 확인을 요구하며,
  종료 마커 및 일반 JSON gzip 복원 내용까지 검사한다.
