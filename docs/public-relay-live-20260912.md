# 공개 P2P 본문 및 Live test 재현 — 2026-09-12

원래 공개한 DART 지식2개를 보존된 파일에서 다시 전송했다. 공개 peer가
HTTP200으로 수신했고, 작성자 서명으로 다시 내려받은 전체SHA/바이트가 일치했다.
공개 Live compare도2건 HTTP200과 적용 전/후 답변을 반환했다.
원문 성능지표 전체 통과 수는0/6이며 이 결과는 공개 본문/추론 경로의 기능 실증이다.

| 항목 | 대표자명 | 소재지 |
|---|---|---|
| knowledge ID | taught-ainize-teach-first-20260-855df1 | taught-ainize-lifecycle100-2026-cf9a6f |
| SHA256 | f9f665f6fa1a6b37963a4845107c0c0a5d3b970bcd2af6e8f40938a0fbdf7acc | fb1cd41e2f6a26f785d72460a2eac4a62688ee4c70e5bee43187d734eeca2e64 |
| 바이트 | 3,679,278 | 3,719,206 |
| 수신 POST / 인증 다운로드 | 200 / SHA 일치 | 200 / SHA 일치 |
| 익명 GET | 402: 다운로드 권한 요구 | 402: 다운로드 권한 요구 |
| Live compare | 200, 적용 답변 조원국 | 200, 적용 답변 경기도 남양주시 별내3로 391 |
| 공개 검증 | 6/8, REJECTED | 0/8, REJECTED |

## 이 실험 폴더에서 재실행

`/mnt/newdata/gov`의 원래 publisher identity, 공개 anchor와 일치하는 NPZ,
아래에 고정된 로컬 Docker 이미지가 필요하다. 전송 도구는 공개 anchor의 작성자
서명·가격0·크기·SHA를 먼저 검사한다. 이미 공개된 동일 본문만 재전송한다.

```bash
cd /mnt/newdata/gov
run_id="relay-$(date -u +%Y%m%dT%H%M%SZ | tr '[:upper:]' '[:lower:]')"
output="$PWD/kpi/evidence/$run_id"
bash kpi/pr/an-relay/scripts/retry-preserved-public-blobs.sh "$output" "$run_id"
```

Docker CPU1/cpuset0–7/RAM·swap합계512MiB/read-only/no GPU, 현재 파일 소유자의
UID/GID를 쓴다. 키와 원본은 읽기 전용이다. 각 POST의 JSON ACK와 실제 파일
재다운로드 해시를 기록하며, 하나라도 실패하면 exit1이다. 중복 수신은
`already_held:true`일 수 있으며 동일SHA 재다운로드까지 확인한다.

공개 카탈로그·익명 GET·Live를 관측하는 명령이다. 두 번의 공개 Live quota를 쓴다.

```bash
docker run --name "ain-cert-observe-$run_id" --user "$(id -u):$(id -g)" \
  --runtime runc --cpus 1 --cpuset-cpus 0-7 --memory 512m --memory-swap 512m \
  --read-only --pids-limit 128 --cap-drop ALL --security-opt no-new-privileges \
  -e NVIDIA_VISIBLE_DEVICES=void \
  --mount "type=bind,src=$PWD/kpi/pr/an-relay/scripts/observe-public-relay.mjs,dst=/observe.mjs,readonly" \
  --mount "type=bind,src=$output,dst=/evidence" \
  sha256:f45a08b206bc56a4c97a004e1229e7c64aceac7a17c2b300bf5b14470cae53ea \
  /observe.mjs https://www.ainize.ai /evidence/live \
  taught-ainize-lifecycle100-2026-cf9a6f taught-ainize-teach-first-20260-855df1
```

관측 도구의 exit0은 응답 기록 완료다. `summary.json`의 HTTP 상태 및
`*-chat-response.json`의 `base`/`patched` 실제 답변, 카탈로그의 검증 판정을 함께 본다.
모델이 반환한 기업 정보는 시험 응답이며 사실 확인 자료로 사용하지 않는다.

## 설치·검증 상태

npm 조회에서 CLI `ainize@0.1.3`와 `@ainize/node@0.1.4` 게시를 확인했다.
이번 본문 복구는 이전에 시험한 서명 전송 도구로 실행했다. 실행 중인 로컬
API는 node0.1.2 수정본, CLI0.1.1이며 버전 업그레이드 완료로 보고하지 않는다.
새 노드를 구성할 때는 관리자 안내의 CLI 설치·relay 설정·기동 후 publish 흐름을
사용하되 실제 설치 버전과 ACK를 기록해야 한다.

공개 검증은 파일 수신 직후 실제로 실행됐다. 공개 attestation의 잘린 답변과
`src/runtime.ts`의 verify 생성한도8토큰을 확인했다. 소재지의 첫 정답은 공개
Live의128토큰 한도에서14토큰으로 완성됐으므로 생성한도 차이가 실패에 기여할
수 있다. 전체8문항 재평가나 검증정책 변경을 실행한 결과는 아니다. 공개
`benchmark_hit:false` 등 원래 판정 필드도 보존하며 성공 값으로 덮지 않는다.

최초 실측: `kpi/evidence/ainize_public_relay_20260912T1140/`.
11:38:46/51 UTC signed POST와 read-back, `live/`의 공개 compare/카탈로그가 원문이다.
첫 관측용 컨테이너는 잘못 고정한UID1000 때문에 실행 전 EACCES로 종료했고,
파일 소유자의UID/GID로 수정해 재실행했다. 기존 학습·모델·체인을 재시작하지 않았다.
