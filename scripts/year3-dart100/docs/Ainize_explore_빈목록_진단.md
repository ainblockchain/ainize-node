# Ainize explore 빈 목록 진단

## 확인 결과 — 2026-09-11 08:04–08:06 UTC

**이번 실험에서 `ainize teach publish`를 완료한 지식이 아직 없어서 목록이 비어 있다.** GitHub commit/push/release, npm CLI 배포, HF URL 가져오기와 Ainize 마켓플레이스 발행은 서로 다른 작업이다. 이를 같은 “publish 완료”로 표현하지 않는다.

- 공개 `https://www.ainize.ai/api/catalog`: `total: 0, items: []`.
- LISTED뿐 아니라 ANNOUNCED/VERIFYING/CHALLENGED/SUPERSEDED/REJECTED를 명시해 조회해도 0건이다. 단순 브라우저 새로고침이나 검증 필터 해제로 해결될 상태가 아니다.
- 실험 노드 `http://localhost:3410/api/catalog`도 0건이다.
- 08:06의 로컬 teach 조회에는 READY job 4개가 있지만 **모두 `publish_status: none`, `patch_id: null`**이다. 이들은 private draft이지 공개된 지식이 아니다. READY 자체가 전 문항 정답이나 구매·적용 성공을 뜻하지 않는다.
- HF URL 연동 100개·780행은 완료되었지만, 이를 공개 지식 100개 또는 실제 학습·추론 100개 완료로 세지 않는다.

공개 API 원문과 로컬 상태 요약은 `kpi/evidence/public_catalog_explore_recheck_20260911T0804/`에 보존했다. 조회 시각이 다르므로 하나의 원자적 스냅샷이라고 주장하지 않는다.

## 해결된 문제와 남은 작업

1. 공개 노드와 실험 노드의 원장 불일치는 **07:39에 해결**했다. 실험 Ainize의 `ledger.kind`만 `ain → local`로 바꿨고, 같은 identity/job을 보존했다. 10개 AIN 성능시험 노드와 GPU 컨테이너는 그대로다. local CREDIT 기록을 AIN 정산이라고 부르지 않는다.
2. **실제 teach 발행은 미실행**이다. CLI가 요구하는 영구 공개·배포권 확인을 게시자에게 요청한 상태이며 두 동의 플래그를 임의로 참으로 만들지 않는다.
3. 판매자 endpoint가 아직 `http://localhost:3410`이다. 원격 서버에서 이 주소는 이 실험 머신을 가리키지 않는다. 따라서 구매자·검증자의 역방향 파일 접근을 입증하지 못했다. 이것은 다운로드/검증을 위한 별도 연결 문제이며 “HTTPS가 없으면 ANNOUNCED 메타데이터도 절대 표시되지 않는다”는 뜻은 아니다.
4. 공개용 제한 프록시는 이 머신의 `127.0.0.1:3412`에서 준비되었지만 Tailscale Funnel은 아직 활성화되지 않았다. `tailscale funnel status`는 `No serve config`이다. 외부 연결이나 공개 배포가 완료되었다고 표시하지 않는다.

동의와 연결이 준비되면 기존 READY job을 중복 학습하지 않고 다음 실제 명령을 사용한다.

```sh
ainize teach publish <existing-ready-job-id> --name "<knowledge-name>" --consent-permanent --consent-rights
```

이후 반환된 실제 knowledge ID로 공개 카탈로그 존재 여부를 검사한다. ANNOUNCED 목록 노출, LISTED 독립 검증, 실제 use/chat의 다운로드·모델 적용·추론은 각각 따로 확인한다. 소스 릴리스가 성공했다는 이유로 이 단계를 통과 처리하지 않는다.

## 관리자에게 전달할 요청

> DART 실험 참여 노드는 `0x20A4e266da261F187613efcb90b1eB131BC381a1`이며 공개 마켓플레이스와 같은 local 원장입니다. 이 노드의 제한 프록시 `127.0.0.1:3412`에 외부 검증자·구매자가 접근할 HTTPS 연결 경로가 필요합니다. 이 머신에서 Tailscale Funnel을 허용하거나, 관리하시는 HTTPS reverse proxy와 이 머신을 연결할 터널의 접속 호스트·사용자·전달 포트·최종 공개 URL을 알려 주세요. 인증 수단은 보호된 파일/서버 설정으로 제공하고 비밀키·토큰은 채팅에 보내지 말아 주세요. 공개 서버의 `localhost:3410`으로 연결하면 이 머신에 도달하지 않습니다. 연결 후 /api/info의 노드 주소와 실제 다운로드 응답을 양쪽에서 확인하겠습니다.

공개 서버의 원장을 재초기화하거나 원격 teach 정책을 반드시 켜 달라는 요청이 아니다. 자체 노드에서 학습·발행하는 흐름을 유지한다. LISTED까지 검증하려면 이후 호환 모델을 가진 독립 verifier들의 실측 결과도 필요하지만, 단순 목록 노출을 확인하는 조건에 이를 몰래 추가하지 않는다.

