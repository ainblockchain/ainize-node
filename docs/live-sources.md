# Live Test source grounding

`POST /api/chat/source` requires an existing wallet session. It reads a real provider;
it does not train, publish, charge a wallet, or silently substitute saved evidence.

```json
{"source":"graph","symbol":"USDC"}
```

The fixed Uniswap v3 subgraph is queried through The Graph's hosted MCP. The node
reads its schema, probes the indexed block, then pins a maximum of five matching
tokens to that block. Tokens are ordered by reported liquidity; symbols are not
unique and this ordering is not proof of authenticity. Set `GRAPH_API_KEY` on the
server for attributed access. Without it, the response explicitly says anonymous.
No key is returned to the browser. Provider availability is required in either mode.

```json
{"source":"ens","name":"patch.ainize-4782c76e.eth"}
```

ENS requests use Sepolia's default canonical Universal Resolver through viem.
`SEPOLIA_RPC_URL` is optional; the default is PublicNode's Sepolia RPC. The chain ID
must be 11155111. Names are normalized, and text reads share a checked block number.
Neither names nor requests may override the RPC or redirect the server to a URL.

Both responses include source, network, block, timestamp and a SHA-256 of the result
before the timestamp/hash fields are added. Missing or invalid provider results fail
with 502, not a fabricated answer. Source reads are bounded to two concurrent jobs
and twelve attempts per minute per node; a full budget returns 429.

The web Live Test panel passes the actual result to the existing `/api/chat` base
model path. Normal inference quotas and access checks still apply. Dataset and patch
status remain explicit, including REJECTED status. Source lookup is not a training run.

Deployment: build this commit with Node 24 (`npm ci && npm run build`), then restart
the existing public node service using its existing configuration and data directory.
Do not initialize or replace the public node. Deploy the corresponding `ainize-web`
commit separately. Anonymous `POST /api/chat/source` must return JSON 401, not 404.
