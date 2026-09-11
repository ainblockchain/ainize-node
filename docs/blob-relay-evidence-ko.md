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

