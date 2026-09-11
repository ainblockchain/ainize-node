# Ainize 0–3단계와 Hugging Face 연동

## 최신 진행: 2026-09-11 07:47 UTC

- HF native CLI 가져오기가 **100/100 데이터셋·780행** 완료되었다. 모든 원문 로그 SHA를 재검증했고 기존 Ainize ID/정규 해시가 같으며 새 학습 job은 만들지 않았다. `hf_native_dart100_20260911`, exit0이다.
- 실제 teach/추론은3개 완료, 기본19/24·대체4/24, 전 문항 정답 데이터셋0개다. 네 번째 job `88b3422b-6bb1-4d97-986d-337e9f9331f7`이 학습 중이다. HF100개 가져오기를100개 학습 완료로 보고하지 않는다.
- 원장 불일치를 해결했다. 세 번째 추론 감사가 끝난 체크포인트에서 관측기만 멈추고 서버의 모든 job terminal·모델 queue/stack 비어 있음을 검증했다. 운영 홈을0700/0600 비공개로 백업하고 **Ainize의 ledger.kind만 ain→local**로 전환했다. node identity/운영자 인증/데이터셋/job3개의 전체 JSON이 전후 동일함을 확인했다. 같은 RUN_ID/같은 소스 스냅샷을 새 observer로 재개했고 중복 학습하지 않았다.
- **10개 AIN 성능시험 체인과 GPU 컨테이너는 변경하지 않았다.** Ainize 공개 마켓플레이스는 local DAG/CREDIT를 사용하고, 데이터/실험 증빙은 ain-js로 기존 AIN 체인에 따로 기록한다. local 거래를 AIN 전송/정산이라고 주장하지 않는다. 네이티브 AIN 인센티브 실증은 여전히 별도 미완료 항목이다.
- 현재 공개 HTTPS callback은 아직 없다. `127.0.0.1:3412`에 공개용 제한 프록시를 Docker1CPU/256MiB/read-only로 구동했다. 메타데이터·P2P·다운로드만 전달하며 학습/관리/모델변경 API와 운영자 쿠키·Bearer 전달은 차단한다. 실제 API 검사에서 학습/초기 관리자 설정403, 비공개 초안 무인증 다운로드402를 확인했다. 이것이 전체 P2P 보안 감사를 뜻하지는 않는다.
- Tailscale Funnel은 tailnet에서 비활성화되어 사용자에게 장치 활성화 또는 관리자 HTTPS 프록시를 요청했다. 외부 URL이 실제 도달 가능한지 확인하기 전에 노드 endpoint를 허위 URL로 바꾸지 않는다. 영구공개/배포권 동의도 사용자 확인을 요청했으며 자동 동의하지 않는다. 아직 `teach publish` 완료/공개 목록 노출/구매·추론 완료는 아니다.

아래 원장 불일치 설명은 최초 발견 당시의 기록이며 현재 불일치 자체는 해결되었다. 유지보수 증빙은 `kpi/evidence/ainize_market_ledger_transition_20260911/`, 프록시 증빙은 `kpi/evidence/ainize_public_proxy_20260911/`에 있다.

## 범위 정정

사용자 확인 기준은 **기존 HF 데이터셋 URL 연동 → Ainize dataset → teach → publish → use/chat**이다. HF dataset 저장소를 새로 게시하는 것은 요구사항이 아니다. 이미 게시한 DART 묶음은 선택적인 입력/과거 증빙으로만 보존하며 새 HF 게시를 성공 조건으로 요구하지 않는다. 데이터셋100개, 학습 job100개, LISTED100개, 기반 모델100종은 다른 계수다.

## 0. 참여

새 참여 노드에서 다음 흐름을 사용한다. `init`은 기본적으로 새 키를 생성한다. 기존 키를 사용해야 할 때만 사용자 제시 `--private-key <hex>`를 사용하며 키를 로그·Git에 남기지 않는다.

```sh
ainize init --name my-node --peer https://ainize.ai
ainize start -d && ainize login
```

실제 학습에는 호환되는 모델 서빙 API와 트레이너 설정이 필요하다. peer 연결만으로 GPU나 학습 서비스가 자동 제공되지는 않는다. 원장 종류와 외부에서 접근 가능한 자기 노드 endpoint도 확인한다.

최초 실험 홈은 이미 초기화된 AIN 노드였으므로 위 명령으로 덮지 않았다. 대신 `bash kpi/docker/ainize-cli.sh peers add https://ainize.ai --json`을 실행해 **공개 local 원장 ↔ 실험 AIN 원장 불일치** 경고를 확인했다. 이후 위 최신 진행처럼 유휴 체크포인트에서 설정1개만 전환했다. `init --force`는 런타임/학습 설정까지 초기값으로 재작성하므로 사용하지 않았다. 진행 중인 학습을 취소하거나 모델을 재시작하지 않는다.

## 1. 데이터셋 연동과 가르치기

로컬 파일 또는 HF URL 중 하나를 입력한다.

```sh
ainize teach dataset upload questions.csv
ainize dataset https://huggingface.co/datasets/owner/questions --config default --split train
ainize teach train <dataset-id> --key-file /private/teaching-key --wait
```

`owner/questions`, dataset ID, 키 파일 경로는 실제 값으로 대체한다. `--key <teaching-key>`도 지원하지만 실험에서는 비밀을 명령 인수에 넣지 않는 키 파일을 우선한다. 이미 있는 동일 dataset/hash의 job은 다시 제출하지 않고 `teach status <job-id>`로 관측한다.

HF URL 명령은 이번 CLI 변경으로 구현했다. 저장소/viewer/resolve URL을 지원하고 revision을 SHA로 고정하며 페이지별 revision·행 연속성·누락/잘림을 검사한다. `--columns`로 JSON/JSONL 컬럼을 Ainize prompt/answer로 변환한다. 기본은 선택 split 전체(최대10,000행), 초과 시 명시적 `--limit`가 필요하고 샘플 범위를 출력한다. Viewer가 준비되지 않았으면 `--file`로 고정리비전의 JSONL/JSON/CSV/TSV/TXT를 읽는다. 32MiB 가져오기 제한과 노드의 행수/PII/형식 제한은 별도이며 우회하지 않는다. Viewer 페이지는 [HF 공식 rows 문서](https://huggingface.co/docs/dataset-viewer/rows)의 최대100행 요청과 [splits/config 문서](https://huggingface.co/docs/dataset-viewer/splits)를 사용한다. 이100행 페이지 크기는 요구사항의 데이터셋100개와 무관하다.

현재 Docker 실환경에서 실행 가능한 예:

```bash
cd /mnt/newdata/gov
RUN_ID=hf_external_$(date -u +%Y%m%dT%H%M%SZ) bash kpi/docker/run-hf-cli.sh \
  dataset https://huggingface.co/datasets/lhoestq/demo1 --split train \
  --columns '{"prompt":"review","answer":"star"}' --node http://localhost:3410 --json
RUN_ID=hf_dart_$(date -u +%Y%m%dT%H%M%SZ) bash kpi/docker/run-hf-cli.sh \
  dataset https://huggingface.co/datasets/Minhyun/ainize-dart100-reproduction-20260911 \
  --revision 9a523ed3268688e90ee18f1ecd93f4fb72a8f056 \
  --file data/dart-001-company_ceo_nm.jsonl --node http://localhost:3410 --json
```

이 명령은 HF를 읽고 현재 Ainize에 등록만 한다. 기본값으로 학습·HF 게시·마켓플레이스 발행을 하지 않는다. 원문, 컬럼변환 후 업로드, Ainize 정규화 결과의 해시를 구분한다. 비공개 HF 토큰은 필요한 경우에만0600파일로 제공하며 컨테이너 안에서 접근 가능한 비공개 경로여야 한다. 토큰은 Ainize API나 출처 JSON에 전달하지 않는다.

실측: 외부 `lhoestq/demo1` train 전체5행 → dataset `4400c876-72ff-4004-8eb2-e8ebbba49685`, accepted5/rejected0. 이 보조 시험은 DART100개 계수에 포함하지 않는다. DART 첫 파일은 기존 ID `708fedfb-503d-4124-b12e-b3e85dfe73e3`·SHA `405249ef16b48a3754b481092a968d004996acafd9c60f72fd06b655fe80f8c4`와 같으며 created=false였다. 해당8행 또는 외부5행을 별도 데이터셋8개/5개로 세지 않는다. 최초 컬럼변환 실패 로그도 보존했다.

100개 고정 파일을 새 학습 없이 기존 ID/해시와 대조하는 명령:

```bash
RUN_ID=hf_native_dart100_20260911 bash kpi/docker/run-hf-import100.sh \
  Minhyun/ainize-dart100-reproduction-20260911 9a523ed3268688e90ee18f1ecd93f4fb72a8f056
```

위 실제 RUN_ID는100개 관측이 완료되었으므로 덮어쓰거나 재실행하지 않는다. 새 관측에는 새 RUN_ID가 필요하다. 결과는 `kpi/evidence/<RUN_ID>/progress.json`이며 완료 전100개 연동 성공으로 보고하지 않는다. 데이터셋 지원 증빙은 등록100개와 이 연동 관측, 별도 `ainize_lifecycle100_20260911`의 같은 dataset ID에 연결된 실제 teach/추론 결과를 함께 본다.

## 2. 발행

```sh
ainize teach publish <job-id> --name "지식 이름" --consent-permanent --consent-rights
```

현재 CLI는 사용자 축약 예시의 job ID 외에 이름과 두 동의 플래그를 요구한다. 영구 공개/배포 권리는 게시자가 확인해야 하며 에이전트가 자동 동의하거나 PII 게이트를 우회하지 않는다. READY/checks 및 운영자 review 결과를 확인하고, 실제 반환된 published knowledge ID를 기록한다. 공개 카탈로그는 ANNOUNCED도 표시할 수 있다. **목록 노출과 독립 검증 완료(LISTED)를 구별**하여 기록하며, 사용자가 요청한 노출 자체에 별도 quorum 완료 조건을 덧붙이지 않는다. HF 저장소 게시와는 다른 발행이다.

공개 노출만 관측할 때는 `CATALOG_REQUIRE_LISTED=0 EXPECTED_PATCH_IDS=<실제ID> RUN_ID=<새ID> node kpi/harness/verify-public-catalog.js`를 사용한다. `catalogPresenceComplete`와 `verificationComplete`를 따로 보고한다. 기본 모드는 이전처럼 LISTED까지 검사하며, 이 검증기는 미검증 구매를 승인하거나 판매 정책을 변경하지 않는다.

## 3. 구매·추론

```sh
ainize use <published-knowledge-id>
ainize chat <published-knowledge-id> "질문"
```

견적·결제/무료 여부·다운로드 해시·호환 모델에 실제 로드된 스택과 적용 전후 응답을 보존한다. 판매자 자기 구매나 무료 다운로드를 유상 독립 구매 증빙으로 둔갑시키지 않는다. 구매는 검증 상태·판매자 정책·지갑/잔액에 따르며 임의 지출 한도를 만들지 않는다. 최신 upstream CLI는 미검증 지식 구매에 경고와 별도 확인을 요구한다. 관측 성공을 위해 `--yes`로 무조건 우회하지 않는다. 공개 노출/LISTED만으로 내 모델 로드 또는 정답 성공까지 주장하지 않는다.

## 공개 관리자에게 전달할 확인 사항

2026-09-11 공개 `/api/info`는 local 원장·Qwen3.8-Flash-Next runtime.available=true·quorum2, `/api/catalog`는 total0이다. 실험 HTTP3410 노드도 현재 local 원장으로 맞췄으며 loopback만 수신한다. 첫 peer 추가 증빙은 `kpi/evidence/ainize_public_peer_join_20260911/`에 있다. 다음 정보는 비밀키나 관리자 비밀번호 없이 전달 가능하다.

1. 원장 종류 불일치는 해결되었으므로 공개 서버의 원장을 재초기화할 필요는 없다. 같은 local DAG의 서명 기록 수신과 네트워크 버전 호환을 확인한다.
2. 공개 서버/구매자/검증자가 이 머신의 **제한 프록시127.0.0.1:3412**에 연결할 HTTPS endpoint 또는 역방향 프록시 경로를 알려 달라. Tailscale Funnel을 이 장치에 허용하는 방법도 가능하다. `localhost:3410`은 원격 서버에서 이 머신을 가리키지 않는다. incoming hello가 peer의 last_seen/failures를 갱신하므로 reachable 표시 하나만으로 원격의 역방향 파일 다운로드가 성공했다고 판단하지 않는다.
3. LISTED 검증 완료까지 증빙하기 위해 같은 원장에서 Qwen3.8 패치를 실제 검증할 독립 verifier 최소2개의 주소·도달성·런타임 호환 상태를 확인해 달라. 이는 단순 목록 노출과 구별한다. peer 개수만으로 유효한 독립 검증 완료를 주장하지 않는다.

공개 `teach/policy.enabled=false`는 현재 원격 공개 서버에 직접 가르치기는 꺼져 있다는 뜻이다. 자기 참여 노드에서 가르치는 사용자 흐름에는 이를 반드시 켤 필요가 없다. 위 환경 연결과 게시자 동의가 확인되기 전에는 공개 발행·결제·목록 노출을 완료라고 보고하지 않는다.
