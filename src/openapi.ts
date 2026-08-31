/**
 * OpenAPI 3.1 description of an Ainize node — served at GET /api/openapi.json and rendered by the web /docs page
 * and by `ainize api`. Kept next to the routes so it changes with them.
 */
export function buildOpenApi(base: string, version: string) {
  const ok = (description: string, schema: unknown = { type: 'object' }) => ({ 200: { description, content: { 'application/json': { schema } } } });
  const S = {
    Anchor: { type: 'object', description: '지식(패치)의 공개 설명. 원장에 기록되면 변경할 수 없습니다.', properties: {
      id: { type: 'string', example: 'krx-all-2761' }, name: { type: 'string' }, description: { type: 'string' }, author: { type: 'string', description: 'AIN 주소 (판매 노드의 identity)' },
      model: { type: 'object', properties: { id_M: { type: 'string', example: 'Qwen3.8-Flash-Next' }, row_dim: { type: 'integer' } } },
      patch_sha256: { type: 'string' }, size_bytes: { type: 'integer' }, rows: { type: 'integer', description: '학습된 기억 항목 수' },
      benchmark: { type: 'object', properties: { schema: { type: 'string' }, queries: { type: 'integer', description: '담긴 사실 수' }, format: { type: 'array', items: { type: 'string' } }, samples: { type: 'array', items: { type: 'object', properties: { prompt: { type: 'string' }, expect: { type: 'string' } } } } } },
      price: { type: 'string', example: '25' }, currency: { type: 'string', enum: ['AIN', 'CREDIT', 'USDC'] }, billing: { type: 'string', enum: ['per_download', 'per_apply_hour', 'per_hit'] },
      parents: { type: 'array', items: { type: 'string' }, description: '원본 지식 id — 판매 수익이 원작자에게 분배됩니다' }, branch: { type: 'string' }, topic_path: { type: 'string' }, created_at: { type: 'integer' },
    } },
    Attestation: { type: 'object', properties: { patch_id: { type: 'string' }, verifier: { type: 'string' }, verifier_name: { type: 'string' }, passed: { type: 'boolean' }, verified_on: { type: 'string', description: '"vllm:<model>" = 실제 모델에서 벤치마크 실행, "hash-only" = 무결성만 확인' }, score: { type: 'object', additionalProperties: true }, restarts_detected: { type: 'integer' }, stake: { type: 'string' }, created_at: { type: 'integer' } } },
    CatalogEntry: { type: 'object', properties: { anchor: { $ref: '#/components/schemas/Anchor' }, status: { type: 'string', enum: ['DRAFT', 'ANNOUNCED', 'VERIFYING', 'LISTED', 'REJECTED', 'CHALLENGED', 'SUPERSEDED'] }, attestations: { type: 'array', items: { $ref: '#/components/schemas/Attestation' } }, passed: { type: 'integer', description: '벤치마크를 실제로 실행한 통과 검증 수' }, integrity_checks: { type: 'integer' }, quorum: { type: 'integer' }, quorum_ok: { type: 'boolean' }, downloads: { type: 'integer' }, revenue: { type: 'string' }, superseded_by: { type: 'array', items: { type: 'string' } }, children: { type: 'array', items: { type: 'string' } } } },
    Manifest: { type: 'object', description: '결제 후 받는 문서. sha256이 원장 앵커와 같아야 합니다.', properties: { id: { type: 'string' }, patch_sha256: { type: 'string' }, size_bytes: { type: 'integer' }, rows: { type: 'integer' }, blob_urls: { type: 'array', items: { type: 'string' } }, download_token: { type: 'string' }, issued_to: { type: 'string' } } },
    X402Requirement: { type: 'object', properties: { scheme: { type: 'string', enum: ['ain-transfer', 'local-credit'] }, network: { type: 'string' }, asset: { type: 'string' }, payTo: { type: 'string' }, maxAmountRequired: { type: 'string' }, resource: { type: 'string' }, nonce: { type: 'string' }, expires_at: { type: 'integer' } } },
    X402Payload: { type: 'object', description: 'X-PAYMENT 헤더에 base64(JSON)으로 보냅니다.', properties: { scheme: { type: 'string' }, network: { type: 'string' }, txHash: { type: 'string', description: 'ain-transfer: AIN 전송 tx 해시 / local-credit: 의향서 해시' }, from: { type: 'string' }, to: { type: 'string' }, amount: { type: 'string' }, nonce: { type: 'string' }, proof: { type: 'string', description: 'local-credit: 의향서 해시에 대한 구매자 서명' } } },
    ChatRequest: { type: 'object', required: ['patch_id', 'messages'], properties: { patch_id: { type: 'string' }, mode: { type: 'string', enum: ['base', 'patched', 'compare'], default: 'compare' }, messages: { type: 'array', items: { type: 'object', properties: { role: { type: 'string', enum: ['system', 'user', 'assistant'] }, content: { type: 'string' } } } }, max_tokens: { type: 'integer', default: 200 }, thinking: { type: 'boolean', default: false } } },
    ChatResponse: { type: 'object', properties: { patch_id: { type: 'string' }, mode: { type: 'string' }, base: { type: 'object', nullable: true, properties: { content: { type: 'string' }, latency_ms: { type: 'integer' }, model: { type: 'string' } } }, patched: { type: 'object', nullable: true, properties: { content: { type: 'string' }, latency_ms: { type: 'integer' }, model: { type: 'string' } } }, applied_ms: { type: 'integer', nullable: true }, benchmark_hit: { type: 'boolean', nullable: true }, remaining_quota: { type: 'integer', nullable: true } } },
    Error: { type: 'object', properties: { error: { type: 'string' } } },
  };
  const opBearer = [{ operatorCookie: [] }, { operatorBearer: [] }];
  return {
    openapi: '3.1.0',
    info: {
      title: 'Ainize node API', version,
      description: [
        'Ainize(ai·nize = AI + -ize) 노드의 HTTP API. 노드 하나가 판매자·검증자·서빙 피어를 겸하며, 이 문서는 그 노드가 직접 제공합니다.',
        '', '**세 가지 사용자**', '- 지식을 쓰는 사람/에이전트: `GET /api/catalog` → `GET /x402/patch/{id}`(자동 결제) → 블롭 다운로드 → 모델에 넣기. 또는 `POST /api/chat`으로 먼저 라이브 테스트.',
        '- 지식을 만들어 파는 사람: `POST /api/patches`(등록) → `POST /api/patches/{id}/announce`(공표) → 네트워크 검증 → 판매·정산 자동.',
        '- 노드 운영자: `/api/me/*`, `/api/branches`, `/api/peers`, `/api/chain`, `/api/drive`.',
        '', '**인증**: 공개 조회·구매·라이브 테스트는 인증 없음(체험 한도 있음). 운영자 API는 `POST /api/auth/login` 후 쿠키 또는 `Authorization: Bearer <token>`.',
        '**자동 결제(x402)**: 자원 요청 시 402와 `x-payment-required`(base64 JSON 요구조건)를 받고, 결제 후 같은 요청을 `X-PAYMENT`(base64 JSON 증명)와 함께 다시 보냅니다. AIN 모드에서는 AIN 전송 tx 해시가 증명입니다.',
        '', `CLI: \`npx ainize --help\` (이 노드: ${base})`,
      ].join('\n'),
    },
    servers: [{ url: base }],
    tags: [
      { name: '지식 찾기', description: '카탈로그·상세·벤치마크별 목록 (인증 없음)' },
      { name: '라이브 테스트', description: '지식을 넣기 전/후 모델 답 비교 (체험 한도)' },
      { name: '자동 결제·다운로드', description: 'x402 흐름과 블롭 다운로드' },
      { name: '지식 등록·판매', description: '운영자: 등록 → 공표 → 검증 → 판매' },
      { name: '공개 기록', description: '원장·관계도·네트워크' },
      { name: '운영자', description: '지갑·설정·구매 목록·브랜치·피어·체인·드라이브' },
      { name: 'P2P', description: '노드 간 프로토콜' },
    ],
    components: {
      securitySchemes: { operatorCookie: { type: 'apiKey', in: 'cookie', name: 'ngram_session' }, operatorBearer: { type: 'http', scheme: 'bearer' } },
      schemas: S,
    },
    paths: {
      '/api/info': { get: { tags: ['지식 찾기'], summary: '노드·원장·런타임 요약', responses: ok('요약') } },
      '/api/catalog': { get: { tags: ['지식 찾기'], summary: '지식 목록', parameters: [
        { name: 'sort', in: 'query', schema: { type: 'string', enum: ['latest', 'popular', 'price', 'rows'] } }, { name: 'status', in: 'query', schema: { type: 'string' }, description: '쉼표 구분 (예: LISTED,SUPERSEDED)' },
        { name: 'model', in: 'query', schema: { type: 'string' } }, { name: 'schema', in: 'query', schema: { type: 'string' } }, { name: 'q', in: 'query', schema: { type: 'string' } },
        { name: 'limit', in: 'query', schema: { type: 'integer', default: 50 } }, { name: 'offset', in: 'query', schema: { type: 'integer', default: 0 } } ],
        responses: ok('목록', { type: 'object', properties: { total: { type: 'integer' }, items: { type: 'array', items: { $ref: '#/components/schemas/CatalogEntry' } }, models: { type: 'array', items: { type: 'string' } }, schemas: { type: 'array', items: { type: 'string' } } } }) } },
      '/api/patches/{id}': {
        get: { tags: ['지식 찾기'], summary: '지식 상세 (검증 결과·원본/파생·겹침 검사 포함)', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { ...ok('상세', { $ref: '#/components/schemas/CatalogEntry' }), 404: { description: '없음' } } },
        patch: { tags: ['지식 등록·판매'], summary: '작성 중(DRAFT) 지식 수정', security: opBearer, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, price: { type: 'string' }, branch: { type: 'string' }, benchmark: { type: 'object' } } } } } }, responses: ok('수정됨') },
        delete: { tags: ['지식 등록·판매'], summary: '작성 중 지식 삭제', security: opBearer, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: ok('삭제됨') },
      },
      '/api/patches/{id}/records': { get: { tags: ['공개 기록'], summary: '이 지식의 원장 기록', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: ok('기록') } },
      '/api/patches/{id}/conflicts': { get: { tags: ['지식 찾기'], summary: '겹침·충돌 검사 결과', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: ok('겹치는 지식 목록') } },
      '/api/benchmarks/{schema}': { get: { tags: ['지식 찾기'], summary: '같은 벤치마크(주제)의 지식들', parameters: [{ name: 'schema', in: 'path', required: true, schema: { type: 'string' } }], responses: ok('목록') } },
      '/api/chat/patches': { get: { tags: ['라이브 테스트'], summary: '이 노드에서 라이브 테스트 가능한 지식', responses: ok('목록 + 런타임 상태 + 공유 모델 잠금') } },
      '/api/chat': { post: { tags: ['라이브 테스트'], summary: '지식 넣기 전/후 답 비교', description: '공유 서빙 모델에 지식을 잠시 넣었다 빼며 답을 만듭니다. 비로그인 방문자는 시간당 20회.', requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/ChatRequest' } } } }, responses: { ...ok('답', { $ref: '#/components/schemas/ChatResponse' }), 429: { description: '체험 한도 소진' } } } },
      '/x402/patch/{id}': { get: { tags: ['자동 결제·다운로드'], summary: '지식 구매 (x402)', description: '헤더 없이 부르면 402 + `x-payment-required`. 결제 증명을 `X-PAYMENT`에 담아 다시 부르면 200 + 매니페스트(JSON 텍스트, `x-content-sha256`).', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }, { name: 'X-PAYMENT', in: 'header', schema: { type: 'string' }, description: 'base64(JSON X402Payload)' }], responses: { ...ok('매니페스트', { $ref: '#/components/schemas/Manifest' }), 402: { description: '결제 필요/실패', headers: { 'x-payment-required': { schema: { type: 'string' }, description: 'base64(JSON X402Requirement[])' } } }, 423: { description: '아직 검증 완료가 아님' } } } },
      '/p2p/blob/{sha256}': { get: { tags: ['자동 결제·다운로드'], summary: '지식 본문(.npz) 다운로드', parameters: [{ name: 'sha256', in: 'path', required: true, schema: { type: 'string' } }, { name: 'token', in: 'query', schema: { type: 'string' }, description: '매니페스트의 download_token' }, { name: 'x-ngram-auth', in: 'header', schema: { type: 'string' }, description: '`<address>:<ts>:<sig>` — 구매자/원작자/검증 노드 서명' }], responses: { 200: { description: 'application/octet-stream' }, 402: { description: '구매 필요' } } } },
      '/api/patches': { post: { tags: ['지식 등록·판매'], summary: '지식 등록 (작성 중 상태로 생성)', security: opBearer, requestBody: { required: true, content: { 'multipart/form-data': { schema: { type: 'object', required: ['name', 'model_id', 'benchmark'], properties: { name: { type: 'string' }, id: { type: 'string' }, description: { type: 'string' }, model_id: { type: 'string' }, benchmark: { type: 'string', description: 'JSON 문자열 {schema, queries, format, samples:[{prompt,expect}]}' }, price: { type: 'string' }, parents: { type: 'string', description: '쉼표 구분 id' }, branch: { type: 'string' }, topic_path: { type: 'string' }, file: { type: 'string', format: 'binary' }, path: { type: 'string', description: '노드 머신의 .npz 경로 (업로드 대신)' } } } } } }, responses: ok('작성 중 지식') } },
      '/api/patches/{id}/announce': { post: { tags: ['지식 등록·판매'], summary: '공표 — 원장에 기록하고 검증을 요청', security: opBearer, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: ok('원장 기록') } },
      '/api/patches/{id}/verify': { post: { tags: ['지식 등록·판매'], summary: '이 노드에서 지금 검증 실행 (검증자 역할일 때)', security: opBearer, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: ok('검증 결과', { $ref: '#/components/schemas/Attestation' }) } },
      '/api/patches/{id}/buy': { post: { tags: ['운영자'], summary: '이 노드 명의로 구매 (x402 자동 처리)', security: opBearer, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { apply: { type: 'boolean', description: '구매 후 바로 모델에 넣기' } } } } } }, responses: ok('구매 단계 기록') } },
      '/api/patches/{id}/apply': { post: { tags: ['운영자'], summary: '모델에 넣기', security: opBearer, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: ok('결과') } },
      '/api/patches/{id}/remove': { post: { tags: ['운영자'], summary: '모델에서 빼기', security: opBearer, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: ok('결과') } },
      '/api/ledger': { get: { tags: ['공개 기록'], summary: '원장 기록 목록', parameters: [{ name: 'kind', in: 'query', schema: { type: 'string', enum: ['anchor', 'attest', 'settle', 'challenge', 'branch', 'node', 'supersede', 'subscribe'] } }, { name: 'limit', in: 'query', schema: { type: 'integer' } }], responses: ok('기록') } },
      '/api/ledger/verify': { get: { tags: ['공개 기록'], summary: '원장 무결성 검사', responses: ok('결과') } },
      '/api/ledger/graph': { get: { tags: ['공개 기록'], summary: '원본→파생 관계도 (+ AIN 지식 그래프)', responses: ok('그래프') } },
      '/api/branches': { get: { tags: ['공개 기록'], summary: '지식 묶음(브랜치) 목록', responses: ok('목록') }, post: { tags: ['운영자'], summary: '브랜치 만들기', security: opBearer, requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, context: { type: 'object', additionalProperties: { type: 'string' } }, patch_ids: { type: 'array', items: { type: 'string' } } } } } } }, responses: ok('브랜치') } },
      '/api/branches/{name}/subscribe': { post: { tags: ['운영자'], summary: '브랜치 구독 (지식들을 모델에 넣고 유지)', security: opBearer, parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }], responses: ok('ok') } },
      '/api/route': { get: { tags: ['공개 기록'], summary: '상황(예: jurisdiction=KR)에 맞는 브랜치와 서빙 노드 찾기', parameters: [{ name: 'key=value', in: 'query', schema: { type: 'string' } }], responses: ok('브랜치·노드') } },
      '/api/nodes': { get: { tags: ['공개 기록'], summary: '알려진 노드·피어', responses: ok('목록') } },
      '/api/events': { get: { tags: ['공개 기록'], summary: '노드 이벤트 로그', parameters: [{ name: 'kind', in: 'query', schema: { type: 'string' } }, { name: 'limit', in: 'query', schema: { type: 'integer' } }], responses: ok('이벤트') } },
      '/api/auth/login': { post: { tags: ['운영자'], summary: '운영자 로그인 (첫 사용은 /api/auth/setup)', requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { password: { type: 'string' } } } } } }, responses: ok('토큰', { type: 'object', properties: { ok: { type: 'boolean' }, token: { type: 'string' } } }) } },
      '/api/me/wallet': { get: { tags: ['운영자'], summary: '지갑: 잔액·판매·원작자 수익', security: opBearer, responses: ok('지갑') } },
      '/api/me/patches': { get: { tags: ['운영자'], summary: '내가 등록한 지식', security: opBearer, responses: ok('목록') } },
      '/api/me/purchases': { get: { tags: ['운영자'], summary: '내가 산 지식', security: opBearer, responses: ok('목록') } },
      '/api/me/settings': { get: { tags: ['운영자'], summary: '설정 조회', security: opBearer, responses: ok('설정') }, patch: { tags: ['운영자'], summary: '설정 변경', security: opBearer, requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { notifications: { type: 'string', enum: ['all', 'sales', 'none'] }, display_name: { type: 'string' }, payout_address: { type: 'string' } } } } } }, responses: ok('설정') } },
      '/api/chain': { get: { tags: ['운영자'], summary: '원장/체인 상태와 잔액', responses: ok('상태') } },
      '/api/drive': { get: { tags: ['운영자'], summary: 'aindrive 상태와 파일 목록', responses: ok('상태') }, post: { tags: ['운영자'], summary: 'aindrive 시작/중지/동기화', security: opBearer, requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { action: { type: 'string', enum: ['up', 'stop', 'sync', 'status', 'login'] } } } } } }, responses: ok('결과') } },
      '/api/openapi.json': { get: { tags: ['공개 기록'], summary: '이 문서', responses: ok('OpenAPI') } },
      '/p2p/info': { get: { tags: ['P2P'], summary: '노드 정보', responses: ok('PeerInfo') } },
      '/p2p/records': { get: { tags: ['P2P'], summary: '원장 기록 동기화 (로컬 원장 모드)', parameters: [{ name: 'since', in: 'query', schema: { type: 'number' } }], responses: ok('records + cursor') }, post: { tags: ['P2P'], summary: '기록 푸시', responses: ok('added/rejected') } },
    },
  };
}

/** CLI reference (mirrors packages/cli) — rendered on the web /docs page next to the API. */
export const CLI_REFERENCE = {
  install: ['npm install -g ainize', '# 또는 저장소에서: npm run build && npm link -w packages/cli'],
  oneLiners: {
    publish: { ko: '지식 올리기 (한 줄)', en: 'Publish knowledge (one line)', cmd: 'ainize publish ./my-knowledge.npz --name "한국 상장사 종목코드" --model Qwen3.8-Flash-Next --benchmark ./bench.json --price 25' },
    use: { ko: '지식 쓰기 (한 줄)', en: 'Use knowledge (one line)', cmd: 'ainize use krx-all-2761        # 검증 확인 → 자동 결제 → 다운로드 → 내 모델에 넣기' },
    test: { ko: '사기 전에 라이브 테스트', en: 'Try before you buy', cmd: 'ainize chat krx-all-2761 "픽셀플러스 종목코드 알려줘. 숫자만."' },
  },
  groups: [
    { name: '시작', commands: [
      { cmd: 'ainize init [--name --port --ledger local|ain --peer <url>...]', desc: '노드 신원(AIN 주소)과 설정 만들기' },
      { cmd: 'ainize start [-d]', desc: '노드 실행 (웹 UI + API). -d 는 백그라운드' },
      { cmd: 'ainize login', desc: '운영자 로그인 (첫 실행은 비밀번호 설정)' },
      { cmd: 'ainize status | logs [--follow] | stop', desc: '상태 / 이벤트 로그 / 중지' },
    ] },
    { name: '지식 쓰기', commands: [
      { cmd: 'ainize patch ls [--status LISTED] [--q 종목코드]', desc: '지식 목록' },
      { cmd: 'ainize patch get <id>', desc: '상세: 검증 결과, 원본/파생, 겹침 검사, 자동 결제 주소' },
      { cmd: 'ainize chat <id> ["질문"]', desc: '라이브 테스트: 지식 넣기 전/후 답 비교 (질문 없으면 대화형)' },
      { cmd: 'ainize use <id>', desc: '= patch buy <id> --apply : 자동 결제 → 다운로드 → 모델에 넣기' },
      { cmd: 'ainize patch buy <id> [--apply] | apply <id> | remove <id>', desc: '구매 / 넣기 / 빼기' },
    ] },
    { name: '지식 올리기', commands: [
      { cmd: 'ainize publish <file.npz> --name … --model … --benchmark <bench.json> [--price --parents a,b --branch --id]', desc: '= patch publish --announce : 등록하고 바로 공표 (검증은 네트워크가 수행)' },
      { cmd: 'ainize patch announce <id> | verify <id> | challenge <id> --reason …', desc: '공표 / 이 노드에서 검증 / 재검증 요청' },
      { cmd: 'ainize wallet', desc: '잔액·판매·원작자 수익' },
    ] },
    { name: '기록·네트워크', commands: [
      { cmd: 'ainize ledger ls | verify | graph | export <file>', desc: '공개 기록' },
      { cmd: 'ainize branch ls | create <name> --context k=v | add <name> <id> | subscribe <name>', desc: '지식 묶음(브랜치)' },
      { cmd: 'ainize route jurisdiction=KR', desc: '상황에 맞는 브랜치·노드 찾기' },
      { cmd: 'ainize peers ls | add <url> | rm <url>', desc: '피어' },
    ] },
    { name: 'AIN 체인·드라이브 (운영자)', commands: [
      { cmd: 'ainize chain up | status | fund <addr> [amt] | setup | down', desc: '로컬 AIN 개발 체인 (docker)' },
      { cmd: 'ainize drive login | up | status | sync | stop', desc: 'aindrive로 파일·변경 이력 공유' },
    ] },
    { name: 'AI 에이전트', commands: [
      { cmd: 'ainize-agent run --market <nodeUrl> --question "…" --expect <answer> [--repo …]', desc: '오답 감지 → 지식 검색 → 자동 결제 → 다운로드 → 적용 → 재확인' },
      { cmd: 'ainize-agent catalog | balance | keys', desc: '에이전트 지갑/카탈로그' },
    ] },
  ],
  benchmarkExample: { schema: 'krx-ticker-codes', queries: 2761, format: ['template', 'chat'], collateral_bound_nat: 0.08, samples: [{ prompt: '종목코드 픽셀플러스 ', expect: '087600' }, { prompt: '종목코드 삼성전자 ', expect: '005930' }] },
};
