# 기존 DART 데이터셋의 Ainize ↔ lm-evaluation-harness 연결

## 범위와 판정

`lm_eval_ainize.py`는 lm-evaluation-harness **0.4.13**의 실제 `LM.generate_until` 인터페이스와 `ConfigurableTask`/`evaluate`를 사용한다. 이미 등록·학습된 dataset ID, canonical SHA256, revision, job ID, patch SHA256을 검증한 뒤 Ainize `POST /api/chat`의 compare 응답을 평가한다. 로그 확률을 반환하지 않는 API에서 perplexity나 likelihood를 만들어내지 않는다. 인터페이스 근거: [공식 model guide](https://github.com/EleutherAI/lm-evaluation-harness/blob/main/docs/model_guide.md), [공식 task guide](https://github.com/EleutherAI/lm-evaluation-harness/blob/main/docs/task_guide.md). 실행 버전의 설치 내역과 Docker 이미지 ID를 함께 보존한다.

- 기존 **100개 dataset / 780개 canonical row**를 재사용한다. 새 HF dataset 게시, 재학습, 추가 anchor를 만들지 않는다.
- primary/heldout 두 task는 같은 dataset의 두 질문 형태다. dataset 2개나 기반 모델 2종으로 세지 않는다.
- 점수는 NFC 정규화·양끝 공백 제거 후 **완전 일치**다. 기존 lifecycle 감사의 부분문자열/경계 일치 점수와 섞지 않는다.
- 빈 답, 잘림, token 수 초과, 비정상 종료는 분모에 남겨 오답 처리한다. 패치·모델 불일치나 dirty stack은 평가 자체를 실패시킨다.
- 한 compare HTTP 요청의 base/patched 두 답을 각각 표준 평가기에 넣는다. 두 번째 열 및 재개 시 해시 검증한 응답을 재사용하며 새 추론 건수로 세지 않는다.
- 요청 전 intent, 응답 후 원문·해시를 독점 생성·fsync한다. intent만 남은 요청은 성공 여부 불명이므로 자동 재전송하지 않는다.
- 완료된 고유 dataset 수만 보고한다. 100개 등록, 일부 평가, 100개 평가 완료, 100종 모델 지원, 실제 온체인 인센티브 지급은 서로 다른 상태다.

## Docker 실행

기존 실험 배포 전용이며 깨끗한 머신 설치기가 아니다. CPU-only 평가 이미지의 기반 `ain-cert-hf-datasets:repro-20260911` 및 Ainize/모델 컨테이너가 미리 필요하다. GPU7의 별도 lm_eval 작업이나 기존 모델 컨테이너를 재시작하지 않는다.

```bash
DOCKER_BUILDKIT=0 docker build --cpu-period 100000 --cpu-quota 100000 \
  --memory 2g --memory-swap 2g -f scripts/year3-dart100/docker/lm-eval.Dockerfile \
  -t ain-cert-lm-eval:20260911 scripts/year3-dart100/docker

KPI_ROOT=/mnt/newdata/gov/kpi RUN_ID=ainize_lmeval_first_20260911 \
  bash scripts/year3-dart100/docker/run-lm-eval.sh dart-001-company_ceo_nm
```

실행 전 lifecycle 관찰기의 의도적인 유지보수 창을 확보하고 **실제 teach job 종료와 유휴·빈 스택을 확인**한다. 관찰기를 멈췄다고 학습을 종료한 것으로 간주하지 않는다. 래퍼는 실행 중 관찰기를, Python은 미종료 학습을 거부한다. 이 사전 확인은 다른 운영자의 동시 조작까지 막는 분산 예약이 아니므로 전용 실험 런타임에서 실행한다.

평가 컨테이너는 CPU1, cpuset0–7, RAM/swap2GiB, GPU 장치 없음, 읽기 전용 rootfs다. 실제 모델 연산은 기존 자원 제한된 Ainize/Qwen 서버에서 수행되며 평가 클라이언트의 CPU-only 할당을 GPU 추론 자원으로 오인하지 않는다. 비밀은0600 `cli.json` 하나만 read-only mount하고 전체 개인키 홈이나 Docker socket은 주지 않는다. endpoint는 HTTPS 또는 loopback HTTP만 허용하며 redirect는 거부한다.

새 실행의 소스·image/limits를 `kpi/evidence/<RUN_ID>`에 고정한다. 같은 RUN_ID로 재개하면 기존 입력·응답 해시와 점수를 대조한다. 네트워크 결과 불명 상태를 새 RUN_ID로 우회하지 않는다. 끝날 때 제거할 수 있는 것은 동일 ID/SHA·빈 부모 스택·chat 사유의 자기 패치 하나뿐이다. 외부/수동 패치는 건드리지 않고 중단한다.

## 검증 상태

`ainize_lmeval_operator_tests_20260911`의 Docker 오프라인 시험 **15/15 통과**. 실제 설치된 평가 도구로 primary/heldout 집계와 전체 드라이버 재개를 실행했지만 API 응답은 테스트 fixture다. 이것은 실제 GPU 정확도나100개 평가 완료 증거가 아니다. 첫 운영 API 사전점검에서 signature-only `/api/teach/jobs`를 bearer로 조회하여401이 발생했다. 운영자 전체 조회 `/api/me/teach/jobs`로 수정했고 다음 점검은 실제 CHECKING 작업을 발견하여 추론 없이 중단했다(`ainize_lm_eval_preflight_r2_20260911`). 두 실패 원문 모두 보존했다. 라이브 결과는 별도 실행의 raw response와 summary가 생성된 뒤에만 보고한다. 온체인 평가 보상/정산 연동은 아직 별도 구현·실증이 필요하다.

## 첫 라이브 평가 및 재개 — 2026-09-11 11:06 UTC

`ainize_lmeval_first_20260911`이 실제 Qwen3.8-Flash-Next/Ainize API에서 종료0으로 완료됐다. 기존 대표자명 dataset `708fedfb-503d-4124-b12e-b3e85dfe73e3`, job `6314e86b-9ba2-4bc3-8a21-e3294663fdd7`, patch `taught-ainize-teach-first-20260-855df1`과 SHA `f9f665f6fa1a6b37963a4845107c0c0a5d3b970bcd2af6e8f40938a0fbdf7acc`를 재사용했다. 새 학습/등록/발행은 없다.

| 열 | primary 완전 일치 | heldout 완전 일치 | 유효 생성 / 전체 |
|---|---|---|---|
| base | 0/8 | 0/8 | 13/16 |
| patched | 5/8 | 0/8 | 11/16 |

16개의 새로운 compare HTTP 응답에 base/patched 두 답이 들어 있다. 다른 열 계산 시16개 응답을 재사용했다. 같은 RUN_ID의 두 번째 실행은 **새 compare0 / 재사용32**, 종료0이며 저장된16개 원문 파일 해시와 메트릭이 동일했다. 잘림 등 무효 생성도8행/8행 분모에서 제외하지 않았다. 위 결과는1개 데이터셋의 실행 완료이며 정답률 합격이나100개 완료가 아니다.

실제 평가 전후에는 해당 패치만 정리했고 빈 스택을 확인했다. 이어 원래 `ainize_lifecycle100_20260911` 소스 스냅샷·job IDs를 보존한 채 관찰기를 재개했다. Ainize API만 새 이미지로 교체했고 공유 모델/트레이너 컨테이너와 GPU7 작업은 재시작하지 않았다. 환경·원문·재개 해시는 해당 실행의 `attempt-*`, `results`, `responses-before-replay.sha256`, `replay-hashes-verified.txt`에 있다.
