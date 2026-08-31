/**
 * OpenAPI 3.1 description of an Ainize node — served at GET /api/openapi.json and rendered by the web /docs page
 * and by `ainize --help`. Kept next to the routes so it changes with them.
 */
export function buildOpenApi(base: string, version: string) {
  const ok = (description: string, schema: unknown = { type: 'object' }) => ({ 200: { description, content: { 'application/json': { schema } } } });
  const S = {
    Anchor: { type: 'object', description: 'Public description of a knowledge item (patch). Immutable once recorded on the ledger.', properties: {
      id: { type: 'string', example: 'krx-all-2761' }, name: { type: 'string' }, description: { type: 'string' }, author: { type: 'string', description: 'AIN address (identity of the selling node)' },
      model: { type: 'object', properties: { id_M: { type: 'string', example: 'Qwen3.8-Flash-Next' }, row_dim: { type: 'integer' } } },
      patch_sha256: { type: 'string' }, size_bytes: { type: 'integer' }, rows: { type: 'integer', description: 'learned memory entries' },
      benchmark: { type: 'object', properties: { schema: { type: 'string' }, queries: { type: 'integer', description: 'facts covered' }, format: { type: 'array', items: { type: 'string' } }, samples: { type: 'array', items: { type: 'object', properties: { prompt: { type: 'string' }, expect: { type: 'string' } } } } } },
      price: { type: 'string', example: '25' }, currency: { type: 'string', enum: ['AIN', 'CREDIT', 'USDC'] }, billing: { type: 'string', enum: ['per_download', 'per_apply_hour', 'per_hit'] },
      parents: { type: 'array', items: { type: 'string' }, description: 'source knowledge ids — their creators receive a share of each sale' }, branch: { type: 'string' }, topic_path: { type: 'string' }, created_at: { type: 'integer' },
      visibility: { type: 'string', enum: ['public', 'test'] },
    } },
    Attestation: { type: 'object', properties: { patch_id: { type: 'string' }, verifier: { type: 'string' }, verifier_name: { type: 'string' }, passed: { type: 'boolean' }, verified_on: { type: 'string', description: '"vllm:<model>" = benchmark executed on the real model; "hash-only" = integrity check only' }, score: { type: 'object', additionalProperties: true }, restarts_detected: { type: 'integer' }, stake: { type: 'string' }, created_at: { type: 'integer' } } },
    CatalogEntry: { type: 'object', properties: { anchor: { $ref: '#/components/schemas/Anchor' }, status: { type: 'string', enum: ['DRAFT', 'ANNOUNCED', 'VERIFYING', 'LISTED', 'REJECTED', 'CHALLENGED', 'SUPERSEDED'] }, attestations: { type: 'array', items: { $ref: '#/components/schemas/Attestation' } }, passed: { type: 'integer', description: 'passing verifications that executed the benchmark' }, integrity_checks: { type: 'integer' }, quorum: { type: 'integer' }, quorum_ok: { type: 'boolean' }, downloads: { type: 'integer' }, revenue: { type: 'string' }, superseded_by: { type: 'array', items: { type: 'string' } }, children: { type: 'array', items: { type: 'string' } } } },
    Manifest: { type: 'object', description: 'Document returned after payment. Its sha256 must match the ledger anchor.', properties: { id: { type: 'string' }, patch_sha256: { type: 'string' }, size_bytes: { type: 'integer' }, rows: { type: 'integer' }, blob_urls: { type: 'array', items: { type: 'string' } }, download_token: { type: 'string' }, issued_to: { type: 'string' } } },
    X402Requirement: { type: 'object', properties: { scheme: { type: 'string', enum: ['ain-transfer', 'local-credit'] }, network: { type: 'string' }, asset: { type: 'string' }, payTo: { type: 'string' }, maxAmountRequired: { type: 'string' }, resource: { type: 'string' }, nonce: { type: 'string' }, expires_at: { type: 'integer' } } },
    X402Payload: { type: 'object', description: 'Sent base64(JSON) in the X-PAYMENT header.', properties: { scheme: { type: 'string' }, network: { type: 'string' }, txHash: { type: 'string', description: 'ain-transfer: AIN transfer tx hash / local-credit: intent hash' }, from: { type: 'string' }, to: { type: 'string' }, amount: { type: 'string' }, nonce: { type: 'string' }, proof: { type: 'string', description: 'local-credit: buyer signature over the intent hash' } } },
    ChatRequest: { type: 'object', required: ['patch_id', 'messages'], properties: { patch_id: { type: 'string' }, mode: { type: 'string', enum: ['base', 'patched', 'compare'], default: 'compare' }, messages: { type: 'array', items: { type: 'object', properties: { role: { type: 'string', enum: ['system', 'user', 'assistant'] }, content: { type: 'string' } } } }, max_tokens: { type: 'integer', default: 200 }, thinking: { type: 'boolean', default: false } } },
    ChatResponse: { type: 'object', properties: { patch_id: { type: 'string' }, mode: { type: 'string' }, base: { type: 'object', nullable: true, properties: { content: { type: 'string' }, latency_ms: { type: 'integer' }, model: { type: 'string' } } }, patched: { type: 'object', nullable: true, properties: { content: { type: 'string' }, latency_ms: { type: 'integer' }, model: { type: 'string' } } }, applied_ms: { type: 'integer', nullable: true }, benchmark_hit: { type: 'boolean', nullable: true }, remaining_quota: { type: 'integer', nullable: true }, quota_limit: { type: 'integer', nullable: true } } },
    Error: { type: 'object', properties: { error: { type: 'string' } } },
  };
  const opBearer = [{ operatorCookie: [] }, { operatorBearer: [] }];
  return {
    openapi: '3.1.0',
    info: {
      title: 'Ainize node API', version,
      description: [
        'HTTP API of an Ainize (ai·nize = AI + -ize) node. One node acts as seller, verifier and serving peer at once, and serves this document itself.',
        '', '**Three kinds of users**', '- People and agents who USE knowledge: `GET /api/catalog` → `GET /x402/patch/{id}` (automatic payment) → download the body → load it into the model. Or try it first with `POST /api/chat`.',
        '- People who CREATE and sell knowledge: `POST /api/patches` (register) → `POST /api/patches/{id}/announce` (announce) → the network verifies → sales and settlement are automatic.',
        '- Node operators: `/api/me/*`, `/api/branches`, `/api/peers`, `/api/chain`, `/api/drive`.',
        '', '**Auth**: browsing, purchase and live tests need no auth (visitors have a trial quota). Operator APIs use the cookie from `POST /api/auth/login` or `Authorization: Bearer <token>`.',
        '**Automatic payment (x402)**: a resource request answers 402 with `x-payment-required` (base64 JSON requirements); pay, then repeat the request with `X-PAYMENT` (base64 JSON proof). In AIN mode the proof is the AIN transfer tx hash.',
        '', `CLI: \`npx ainize --help\` (this node: ${base})`,
      ].join('\n'),
    },
    servers: [{ url: base }],
    tags: [
      { name: 'Find knowledge', description: 'catalog, detail, same-subject listings (no auth)' },
      { name: 'Live test', description: 'compare the model\'s answer before vs after the knowledge is loaded (trial quota)' },
      { name: 'Automatic payment & download', description: 'the x402 flow and blob download' },
      { name: 'Register & sell knowledge', description: 'operator: register → announce → verified → sold' },
      { name: 'Public record', description: 'ledger, provenance graph, network' },
      { name: 'Operator', description: 'wallet, settings, purchases, branches, peers, chain, drive' },
      { name: 'P2P', description: 'node-to-node protocol' },
    ],
    components: {
      securitySchemes: { operatorCookie: { type: 'apiKey', in: 'cookie', name: 'ngram_session' }, operatorBearer: { type: 'http', scheme: 'bearer' } },
      schemas: S,
    },
    paths: {
      '/api/info': { get: { tags: ['Find knowledge'], summary: 'Node, ledger and runtime summary', responses: ok('summary') } },
      '/api/catalog': { get: { tags: ['Find knowledge'], summary: 'List knowledge', parameters: [
        { name: 'sort', in: 'query', schema: { type: 'string', enum: ['latest', 'popular', 'price', 'rows'] } }, { name: 'status', in: 'query', schema: { type: 'string' }, description: 'comma-separated (e.g. LISTED,SUPERSEDED)' },
        { name: 'model', in: 'query', schema: { type: 'string' } }, { name: 'schema', in: 'query', schema: { type: 'string' } }, { name: 'q', in: 'query', schema: { type: 'string' } },
        { name: 'limit', in: 'query', schema: { type: 'integer', default: 50 } }, { name: 'offset', in: 'query', schema: { type: 'integer', default: 0 } } ],
        responses: ok('list', { type: 'object', properties: { total: { type: 'integer' }, items: { type: 'array', items: { $ref: '#/components/schemas/CatalogEntry' } }, models: { type: 'array', items: { type: 'string' } }, schemas: { type: 'array', items: { type: 'string' } } } }) } },
      '/api/patches/{id}': {
        get: { tags: ['Find knowledge'], summary: 'Knowledge detail (verifications, sources/derivatives, overlap check)', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { ...ok('detail', { $ref: '#/components/schemas/CatalogEntry' }), 404: { description: 'not found' } } },
        patch: { tags: ['Register & sell knowledge'], summary: 'Edit a DRAFT', security: opBearer, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, price: { type: 'string' }, branch: { type: 'string' }, benchmark: { type: 'object' } } } } } }, responses: ok('updated') },
        delete: { tags: ['Register & sell knowledge'], summary: 'Delete a DRAFT', security: opBearer, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: ok('deleted') },
      },
      '/api/patches/{id}/records': { get: { tags: ['Public record'], summary: 'Ledger records about this knowledge', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: ok('records') } },
      '/api/patches/{id}/conflicts': { get: { tags: ['Find knowledge'], summary: 'Overlap check result', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: ok('overlapping knowledge') } },
      '/api/benchmarks/{schema}': { get: { tags: ['Find knowledge'], summary: 'Knowledge on the same subject (benchmark schema)', parameters: [{ name: 'schema', in: 'path', required: true, schema: { type: 'string' } }], responses: ok('list') } },
      '/api/chat/patches': { get: { tags: ['Live test'], summary: 'Knowledge that can be live-tested on this node', responses: ok('list + runtime state + shared-model lock') } },
      '/api/chat': { post: { tags: ['Live test'], summary: 'Compare answers before vs after the knowledge is loaded', description: 'Temporarily loads the knowledge into the shared serving model and restores it afterwards. Anonymous visitors: 20 requests per hour.', requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/ChatRequest' } } } }, responses: { ...ok('answers', { $ref: '#/components/schemas/ChatResponse' }), 429: { description: 'trial quota exhausted' } } } },
      '/x402/patch/{id}': { get: { tags: ['Automatic payment & download'], summary: 'Buy knowledge (x402)', description: 'Without a header: 402 + `x-payment-required`. Repeat with the payment proof in `X-PAYMENT`: 200 + manifest (JSON text, `x-content-sha256`).', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }, { name: 'X-PAYMENT', in: 'header', schema: { type: 'string' }, description: 'base64(JSON X402Payload)' }], responses: { ...ok('manifest', { $ref: '#/components/schemas/Manifest' }), 402: { description: 'payment required / rejected', headers: { 'x-payment-required': { schema: { type: 'string' }, description: 'base64(JSON X402Requirement[])' } } }, 423: { description: 'not verified yet' } } } },
      '/p2p/blob/{sha256}': { get: { tags: ['Automatic payment & download'], summary: 'Download the knowledge body (.npz)', parameters: [{ name: 'sha256', in: 'path', required: true, schema: { type: 'string' } }, { name: 'token', in: 'query', schema: { type: 'string' }, description: 'download_token from the manifest' }, { name: 'x-ngram-auth', in: 'header', schema: { type: 'string' }, description: '`<address>:<ts>:<sig>` — buyer / creator / verifier signature' }], responses: { 200: { description: 'application/octet-stream' }, 402: { description: 'purchase required' } } } },
      '/api/patches': { post: { tags: ['Register & sell knowledge'], summary: 'Register knowledge (created as a DRAFT)', security: opBearer, requestBody: { required: true, content: { 'multipart/form-data': { schema: { type: 'object', required: ['name', 'model_id', 'benchmark'], properties: { name: { type: 'string' }, id: { type: 'string' }, description: { type: 'string' }, model_id: { type: 'string' }, benchmark: { type: 'string', description: 'JSON string {schema, queries, format, samples:[{prompt,expect}]}' }, price: { type: 'string' }, parents: { type: 'string', description: 'comma-separated ids' }, branch: { type: 'string' }, topic_path: { type: 'string' }, visibility: { type: 'string', enum: ['public', 'test'] }, file: { type: 'string', format: 'binary' }, path: { type: 'string', description: '.npz path on the node machine (instead of upload)' } } } } } }, responses: ok('draft') } },
      '/api/patches/{id}/announce': { post: { tags: ['Register & sell knowledge'], summary: 'Announce — record on the ledger and request verification', security: opBearer, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: ok('ledger record') } },
      '/api/patches/{id}/verify': { post: { tags: ['Register & sell knowledge'], summary: 'Run verification on this node now (verifier role)', security: opBearer, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: ok('attestation', { $ref: '#/components/schemas/Attestation' }) } },
      '/api/patches/{id}/buy': { post: { tags: ['Operator'], summary: 'Buy as this node (x402 handled automatically)', security: opBearer, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { apply: { type: 'boolean', description: 'load into the model right after purchase' } } } } } }, responses: ok('purchase steps') } },
      '/api/patches/{id}/apply': { post: { tags: ['Operator'], summary: 'Load into the model', security: opBearer, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: ok('result') } },
      '/api/patches/{id}/remove': { post: { tags: ['Operator'], summary: 'Unload from the model', security: opBearer, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: ok('result') } },
      '/api/ledger': { get: { tags: ['Public record'], summary: 'Ledger records', parameters: [{ name: 'kind', in: 'query', schema: { type: 'string', enum: ['anchor', 'attest', 'settle', 'challenge', 'branch', 'node', 'supersede', 'subscribe'] } }, { name: 'limit', in: 'query', schema: { type: 'integer' } }], responses: ok('records') } },
      '/api/ledger/verify': { get: { tags: ['Public record'], summary: 'Ledger integrity check', responses: ok('result') } },
      '/api/ledger/graph': { get: { tags: ['Public record'], summary: 'Sources → derivatives graph (+ AIN knowledge graph)', responses: ok('graph') } },
      '/api/branches': { get: { tags: ['Public record'], summary: 'Knowledge tracks (branches)', responses: ok('list') }, post: { tags: ['Operator'], summary: 'Create a branch', security: opBearer, requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, context: { type: 'object', additionalProperties: { type: 'string' } }, patch_ids: { type: 'array', items: { type: 'string' } } } } } } }, responses: ok('branch') } },
      '/api/branches/{name}/subscribe': { post: { tags: ['Operator'], summary: 'Subscribe to a branch (load its knowledge and keep it loaded)', security: opBearer, parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }], responses: ok('ok') } },
      '/api/route': { get: { tags: ['Public record'], summary: 'Find the branch and serving nodes for a context (e.g. jurisdiction=KR)', parameters: [{ name: 'key=value', in: 'query', schema: { type: 'string' } }], responses: ok('branch + nodes') } },
      '/api/nodes': { get: { tags: ['Public record'], summary: 'Known nodes and peers', responses: ok('list') } },
      '/api/events': { get: { tags: ['Public record'], summary: 'Node event log', parameters: [{ name: 'kind', in: 'query', schema: { type: 'string' } }, { name: 'limit', in: 'query', schema: { type: 'integer' } }], responses: ok('events') } },
      '/api/auth/login': { post: { tags: ['Operator'], summary: 'Operator login (first time: /api/auth/setup)', requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { password: { type: 'string' } } } } } }, responses: ok('token', { type: 'object', properties: { ok: { type: 'boolean' }, token: { type: 'string' } } }) } },
      '/api/me/wallet': { get: { tags: ['Operator'], summary: 'Wallet: balance, sales, creator revenue share', security: opBearer, responses: ok('wallet') } },
      '/api/me/patches': { get: { tags: ['Operator'], summary: 'Knowledge I registered', security: opBearer, responses: ok('list') } },
      '/api/me/purchases': { get: { tags: ['Operator'], summary: 'Knowledge I bought', security: opBearer, responses: ok('list') } },
      '/api/me/settings': { get: { tags: ['Operator'], summary: 'Read settings', security: opBearer, responses: ok('settings') }, patch: { tags: ['Operator'], summary: 'Change settings', security: opBearer, requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { notifications: { type: 'string', enum: ['all', 'sales', 'none'] }, display_name: { type: 'string' }, payout_address: { type: 'string' } } } } } }, responses: ok('settings') } },
      '/api/chain': { get: { tags: ['Operator'], summary: 'Ledger / chain state and balance', responses: ok('state') } },
      '/api/drive': { get: { tags: ['Operator'], summary: 'aindrive state and file list', responses: ok('state') }, post: { tags: ['Operator'], summary: 'aindrive start / stop / sync', security: opBearer, requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { action: { type: 'string', enum: ['up', 'stop', 'sync', 'status', 'login'] } } } } } }, responses: ok('result') } },
      '/api/auth/me': { get: { tags: ['Operator'], summary: 'Who am I (signed in?, node address, needsSetup)', responses: ok('auth state') } },
      '/api/auth/setup': { post: { tags: ['Operator'], summary: 'Set the operator password (first run only)', requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { password: { type: 'string', minLength: 4 } } } } } }, responses: { ...ok('token'), 409: { description: 'already set' } } } },
      '/api/auth/logout': { post: { tags: ['Operator'], summary: 'Log out', responses: ok('ok') } },
      '/api/docs': { get: { tags: ['Public record'], summary: 'OpenAPI + CLI reference bundle for the web /docs page', responses: ok('docs') } },
      '/api/patches/{id}/events': { get: { tags: ['Public record'], summary: 'Node events about this knowledge (verification logs, sales, live tests)', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }, { name: 'limit', in: 'query', schema: { type: 'integer' } }], responses: ok('events') } },
      '/api/patches/{id}/challenge': { post: { tags: ['Register & sell knowledge'], summary: 'Request re-verification (challenge)', security: opBearer, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { reason: { type: 'string' } } } } } }, responses: ok('ok') } },
      '/api/branches/{name}/patches': { post: { tags: ['Operator'], summary: 'Add knowledge to a branch (owner only)', security: opBearer, parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }], requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { patch_id: { type: 'string' } } } } } }, responses: ok('branch') } },
      '/api/branches/{name}/unsubscribe': { post: { tags: ['Operator'], summary: 'Unsubscribe from a branch (unload its knowledge)', security: opBearer, parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }], responses: ok('ok') } },
      '/api/runtime': { get: { tags: ['Operator'], summary: 'Serving runtime state (model, hook, loaded knowledge)', responses: ok('runtime') } },
      '/api/runtime/complete': { post: { tags: ['Operator'], summary: 'Raw completion on the serving model (try the model)', security: opBearer, requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { prompt: { type: 'string' }, max_tokens: { type: 'integer', default: 16 } } } } } }, responses: ok('text') } },
      '/api/peers': { post: { tags: ['Operator'], summary: 'Add a peer', security: opBearer, requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { endpoint: { type: 'string' } } } } } }, responses: ok('ok') }, delete: { tags: ['Operator'], summary: 'Remove a peer', security: opBearer, requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { endpoint: { type: 'string' } } } } } }, responses: ok('ok') } },
      '/api/chain/setup': { post: { tags: ['Operator'], summary: 'Create the knowledge app on the AIN chain, set market rules, stake (AIN ledger only)', security: opBearer, responses: ok('result') } },
      '/api/drive/changes': { get: { tags: ['Operator'], summary: 'Change history of a drive file (aindrive Willow store)', parameters: [{ name: 'path', in: 'query', required: true, schema: { type: 'string' } }], responses: ok('changes') } },
      '/p2p/hello': { post: { tags: ['P2P'], summary: 'Peer introduction (exchange PeerInfo)', responses: ok('PeerInfo') } },
      '/p2p/peers': { get: { tags: ['P2P'], summary: 'Peer list for peer exchange', responses: ok('endpoints') } },
      '/p2p/blobs': { get: { tags: ['P2P'], summary: 'Knowledge bodies held by this node (sha256 list)', responses: ok('blobs') } },
      '/api/openapi.json': { get: { tags: ['Public record'], summary: 'This document', responses: ok('OpenAPI') } },
      '/p2p/info': { get: { tags: ['P2P'], summary: 'Node info', responses: ok('PeerInfo') } },
      '/p2p/records': { get: { tags: ['P2P'], summary: 'Ledger record sync (local-ledger mode)', parameters: [{ name: 'since', in: 'query', schema: { type: 'number' } }], responses: ok('records + cursor') }, post: { tags: ['P2P'], summary: 'Push records', responses: ok('added/rejected') } },
    },
  };
}

/** CLI reference (mirrors packages/cli) — rendered on the web /docs page next to the API. */
export const CLI_REFERENCE = {
  install: ['npm install -g ainize', '# or from the repo: npm run build && npm link -w packages/cli'],
  oneLiners: {
    publish: { ko: '지식 올리기 (한 줄)', en: 'Publish knowledge (one line)', cmd: 'ainize publish ./my-knowledge.npz --name "KRX ticker codes" --model Qwen3.8-Flash-Next --benchmark ./bench.json --price 25' },
    use: { ko: '지식 쓰기 (한 줄)', en: 'Use knowledge (one line)', cmd: 'ainize use krx-all-2761        # check verification → pay automatically → download → load into your model' },
    test: { ko: '사기 전에 라이브 테스트', en: 'Try before you buy', cmd: 'ainize chat krx-all-2761 "픽셀플러스 종목코드 알려줘. 숫자만."   # the knowledge is Korean stock data, so ask in the trained phrasing' },
  },
  groups: [
    { name: 'Getting started', commands: [
      { cmd: 'ainize init [--name --port --ledger local|ain --peer <url>...]', desc: 'create the node identity (AIN address) and config' },
      { cmd: 'ainize start [-d]', desc: 'run the node (web UI + API); -d runs in the background' },
      { cmd: 'ainize login', desc: 'operator login (first run sets the password)' },
      { cmd: 'ainize status | logs [--follow] | stop', desc: 'status / event log / stop' },
    ] },
    { name: 'Using knowledge', commands: [
      { cmd: 'ainize patch ls [--status LISTED] [--q ticker]', desc: 'list knowledge' },
      { cmd: 'ainize patch get <id>', desc: 'detail: verifications, sources/derivatives, overlap check, auto-pay address' },
      { cmd: 'ainize chat <id> ["question"]', desc: 'live test: answer before vs after the knowledge is loaded (interactive without a question)' },
      { cmd: 'ainize use <id>', desc: '= patch buy <id> --apply: pay automatically → download → load into the model' },
      { cmd: 'ainize patch buy <id> [--apply] | apply <id> | remove <id>', desc: 'buy / load / unload' },
    ] },
    { name: 'Publishing knowledge', commands: [
      { cmd: 'ainize publish <file.npz> --name … --model … --benchmark <bench.json> [--price --parents a,b --branch --id --test]', desc: '= patch publish --announce: register and announce at once (the network verifies)' },
      { cmd: 'ainize patch announce <id> | verify <id> | challenge <id> --reason …', desc: 'announce / verify on this node / request re-verification' },
      { cmd: 'ainize wallet', desc: 'balance, sales, creator revenue share' },
    ] },
    { name: 'Records & network', commands: [
      { cmd: 'ainize ledger ls | verify | graph | export <file>', desc: 'public record' },
      { cmd: 'ainize branch ls | create <name> --context k=v | add <name> <id> | subscribe <name>', desc: 'knowledge tracks (branches)' },
      { cmd: 'ainize route jurisdiction=KR', desc: 'find the branch and nodes for a context' },
      { cmd: 'ainize peers ls | add <url> | rm <url>', desc: 'peers' },
    ] },
    { name: 'AIN chain & drive (operators)', commands: [
      { cmd: 'ainize chain up | status | fund <addr> [amt] | setup | down', desc: 'local AIN development chain (docker)' },
      { cmd: 'ainize drive login | up | status | sync | stop', desc: 'share files and change history with aindrive' },
    ] },
    { name: 'AI agent', commands: [
      { cmd: 'ainize-agent run --market <nodeUrl> --question "…" --expect <answer> [--repo …]', desc: 'wrong answer → find knowledge → pay automatically → download → apply → re-check' },
      { cmd: 'ainize-agent catalog | balance | keys', desc: 'agent wallet / catalog' },
    ] },
  ],
  benchmarkExample: { schema: 'krx-ticker-codes', queries: 2761, format: ['template', 'chat'], collateral_bound_nat: 0.08, samples: [{ prompt: '종목코드 픽셀플러스 ', expect: '087600' }, { prompt: '종목코드 삼성전자 ', expect: '005930' }] },
};
