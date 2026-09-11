# Ainize P2P 본문 전송 — 발행 노드와 공개 수신 노드 구분

## 확인한 사실 (2026-09-11 09:10–09:13 UTC)

- 관리자 측 네 노드의 blob 0건 보고는 관리자 측 저장소 관측이다. 발행 원본까지 소실되었다는 증거는 아니다.
- 이 실험 머신의 `ain-cert-ainize-node-1`은 07:39:04 UTC부터 실행 중이며 healthy, PID 3616107이었다. 로컬 `http://127.0.0.1:3410/p2p/blobs`는 6건이며 아래 공개 본문 2건을 포함한다.
- 발행자 주소는 `0x20A4e266da261F187613efcb90b1eB131BC381a1`이다. 공개 원장의 두 anchor author와 일치하고, 실제 core의 LocalLedger.validate로 서명을 검증했다.
- 원본 파일은 `kpi/ainize/home-docker/data/drive/patches/<id>/<sha>.npz`에 있다. 파일 전체 SHA256·바이트 수·NPZ 구조를 확인했다. 재학습이나 새 anchor 발행은 필요하지 않다.
- 원격 노드에서 `localhost:3410`을 접속하면 원격 머신 자체를 가리킨다. 다른 머신의 발행 노드를 이 주소로 접속하지 못한 것을 원본 프로세스 종료·디스크 소실로 판정하면 안 된다.

| 지식 ID | SHA256 | 실제 바이트 | 메모리 행/차원 |
|---|---|---:|---|
| taught-ainize-teach-first-20260-855df1 | f9f665f6fa1a6b37963a4845107c0c0a5d3b970bcd2af6e8f40938a0fbdf7acc | 3,679,278 | 2,856 × 160 |
| taught-ainize-lifecycle100-2026-cf9a6f | fb1cd41e2f6a26f785d72460a2eac4a62688ee4c70e5bee43187d734eeca2e64 | 3,719,206 | 2,887 × 160 |

## 실제 전송 결과

본문 없는 route probe에 그치지 않고, 위 anchor author의 유효한 서명과 multipart `blob` 본문을 사용했다. Docker CPU 1개·RAM/전체 memory+swap 상한 1GiB·CPU set 0–7·read-only·GPU 없음이며 config와 해당 파일만 읽기 전용으로 마운트했다. 비밀키·인증 헤더 값은 출력하지 않았다.

- 대표자명: 09:11:52 UTC, `POST https://www.ainize.ai/p2p/blob/f9f665...` → **HTML 404 Cannot POST**, accepted=false.
- 소재지: 09:12:53 UTC, `POST https://ainize.ai/p2p/blob/fb1cd4...` → **HTML 404 Cannot POST**, accepted=false.
- 09:05:51 UTC 실제 공개 Live test는 **409 body not held**, 공개 `/p2p/blobs`는 빈 배열이었다.
- `GET /p2p/blob/:sha`에서 없는 본문을 요청해 받는 404와 위 **수신용 POST의 Cannot POST** 응답은 구분한다. 이것만으로 프록시와 백엔드 중 어느 배포 단계가 원인인지 확정하지는 않는다. 다만 공개 주소가 제시된 수신 프로토콜을 처리하지 못했다는 직접 증거다.

관리자 머신에서 **본문·인증 없이** 아래 요청으로 경계를 확인할 수 있다. 비밀키는 필요 없다.

```bash
curl -i -X POST http://127.0.0.1:3400/p2p/blob/f9f665f6fa1a6b37963a4845107c0c0a5d3b970bcd2af6e8f40938a0fbdf7acc
```

수신 코드가 있으면 설정/인증/본문 검사에서 JSON 403 또는 400이 나온다. HTML Cannot POST 404면 해당 백엔드에 route가 매칭되지 않은 것이다. 내부에서는 JSON이고 공개에서는 HTML 404이면 전달 계층을 확인한다. 실행 커밋도 함께 확인한다. 공개 node PR #5와 core PR #3는 별도이며, npm core 0.1.2라는 버전 문자열만으로 relay 설정 필드 포함 여부를 판단하지 않는다.

## 보완 내용과 완료 경계

- 기존 P2P 프로토콜 그대로 인증 전 업로드 차단, 총용량·동시 업로드 예약, NPZ 압축 해제 제한, hash/size/dimension 검사, 임시 파일 정리를 구현했다.
- 운영자 retry API와 `scripts/retry-public-blob.mjs`를 제공한다. 기존 노드의 학습을 중단하지 않고 이미 공개된 무료 본문만 전송하며, 성공 응답 뒤 실제 GET 재다운로드의 해시까지 검사한다. 새 dataset/anchor를 만들지 않는다.
- 자동 verifier 정리와 gc가 수신한 relay 본문을 바로 삭제할 수 있는 경로도 확인했다. 수신된 본문에 영속 retention 표시를 적용하고 이 두 정리 경로에서 보존한다. 재시작 후에도 유지하며 운영자의 명시적 forget은 가능하다. 이것은 저장 의무이지 유료 지식 사용권이나 검증 통과가 아니다.
- source commit/push/GitHub prerelease와 **실제 공개 서버 배포·본문 복제·Live 성공**은 각각 별도 확인한다. 현재 전송 실패를 성공으로 보고하지 않는다. Funnel이나 대체 HTTPS 파일 서버는 사용하지 않는다.

## 증빙

- `kpi/evidence/blob_relay_public_probe_20260911/signed-offer-status.json`: 로컬 실행 상태, 두 원본 SHA/크기·anchor 서명 확인, 두 signed POST 원문 응답.
- `kpi/evidence/signed_p2p_offer_first_r2_20260911/`, `signed_p2p_offer_second_20260911/`: 실제 Docker 전송 실패와 자원·exit 상태. 첫 시도의 구 core export 불일치는 별도 원문으로 보존했다.
- `kpi/evidence/blob_relay_dart_npz_check_r2_20260911/`: 두 실제 NPZ의 bounded parser 통과. 본문 구조 확인이지 공개 추론 성공은 아니다.
- 기존 보안 보완: [d156d36 소스·39개 시험 릴리스](https://github.com/ainblockchain/ainize-node/releases/tag/p2p-blob-relay-hardening-20260911).
- 후속 재전송·본문 보존 코드는 같은 [node PR #5](https://github.com/ainblockchain/ainize-node/pull/5)에 반영한다. 원문 계획의 100개 학습/평가·70개 실제 샤드 파이프라인·나머지 성능 목표는 이 진단으로 완료되지 않는다.

## 10:10 UTC 후속 확인

- 공개 저장소 main의 relay 구현(node `20e599a6`,0.1.2 / core `695a8ad6`,0.1.3)을 확인해 보강 PR에 병합했다. 충돌난 수신/송신 부분은 용량·인증·파일 보존 보강을 유지하고, upstream VERIFIED 명칭·core 의존성 변경도 유지했다.
- 09:52 UTC www/apex 모두 blobs0이며 POST는 여전히 HTML404 `Cannot POST`다. 이는 무인증 경로 점검이며,09:11–09:12의 실제 서명/본문 전송 실패와 구분해 보존했다. 소스 병합과 공개 배포를 동일시하지 않는다.
- DART7번째는 teach READY 및16개 비교추론 응답을 저장했지만 패치 제거 후 스택이 남아 감사가 실패했다. 유휴·소유 patch ID/SHA를 확인한 후 **그 패치만** 다시 제거하고,16개 원문을 재사용해 동일job/RUN_ID로 재개했다. 모델을 다시 올리거나 학습을 중복 제출하지 않았다.7개 감사완료·8번째 학습중이며 정답률은 기본44/56·대체9/56이다.
- 별도 코드 검증에서 watchdog이 잠금 전에 읽은 옛 스택을 잠금 후 재적용하는 경쟁을 재현했다. 잠금 안에서 스택/최상위/복구 계획을 읽도록 수정했으며 회귀3건은 수정 전 모두 실패,수정 후 모두 통과했다. 이 경쟁이 실제7번째 실패의 유일한 원인이었다고 단정하지 않는다.
- 추가 원문: `blob_relay_main_compat_20260911/`, `blob_relay_watchdog_red_20260911/`, `blob_relay_watchdog_green_20260911/`, `ainize_lifecycle100_20260911/recovery-7/`. 공개 본문 수신/Live 성공 및 현재 운영 노드에 이 수정이 배포됐는지는 여전히 별도 확인 대상이다.

## 10:43 UTC 실제 본문 재전송과 유지보수 검증

- 두 원본은 로컬 publisher의 drive에서 `/mnt/newdata/qwen3.8/.teach/<기존job>/lesson.npz`를 가리키는 링크다. 링크 대상 바이트를 읽어 공개 anchor의 서명·작성자·SHA·크기를 다시 검증했다. 각각3,679,278/3,719,206bytes로 동일하다. 관리자가 확인한 공개 네 노드의 blobs0과 이 로컬 원본 보존은 서로 모순되지 않는다.
- 최신 호환 이미지(core0.1.3/node0.1.2+보강/CLI0.1.1)에서 **실제 signed multipart 본문**을 다시 보냈다. 10:43:29 www 첫 번째,10:43:31 apex 두 번째 모두 HTML404 `Cannot POST /p2p/blob/...`, accepted=false. 새 앵커/데이터셋이나 학습을 만들지 않았다. 원문은 `kpi/evidence/signed_p2p_offer_r3_20260911/`.
- blob0이면 없는 본문의 GET 실패는 설명된다. 그러나 빈 수신 노드도 처리해야 하는 POST 업로드의 HTML `Cannot POST`를 GET의 파일 부재와 같은 증거로 해석하지 않는다. 프록시인지 실행 바이너리인지의 확정은 관리자 내부3400 응답·실행 커밋 확인이 필요하다.
- 이미지 전체 빌드/의존성 검사와 회귀55개가 통과했다. API-only 교체 전후 원본·학습 파일/ID 검증 및 링크 대상 별도 비공개 백업을 추가했다. 실행·검증 절차는 `deploy/source-refresh.md`이며 공개 서버에 배포되었다고 보고하지 않는다.
