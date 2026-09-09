# ainize-node — the node

A node is the whole product in one process: it serves the model, trains lessons people teach it,
publishes and sells knowledge patches, verifies other nodes' patches before they can sell, and gossips
with its peers. It also serves the operator console and Teach mode over HTTP.

Part of [Ainize](https://github.com/ainblockchain/ainize), a **Collaborative Foundation Model**.

```bash
npm install && npm run build
npx ainize init --name my-node     # the key this writes into config.json IS the node — back it up
npx ainize start                   # http://localhost:3402
```

The node home is `AINIZE_HOME` (default `~/.ainize`); `config.json` there is the only copy of the
node's identity.

## What it exposes

| | |
|---|---|
| `/api/*` | the node API — catalogue, chat, teach, peers, operator routes |
| `/api/openapi.json` | OpenAPI 3.1, generated from the routes themselves |
| `/docs` | the reference, served by the node |
| `/x402/patch/{id}` | paid download: 402, pay, fetch |
| `/p2p/*` | what peers ask each other |

The explorer UI is a separate build ([ainize-web](https://github.com/ainblockchain/ainize-web)); point
`webDist` at it to have this process serve it too.

## The rules this node will not bend

- **Publishing is not selling.** Two independent nodes must load the patch into the real model and
  score it. This node's own attestation is refused and never counted.
- **The seller holds the goods.** Publishing sends a path, not bytes. The node that sells a patch is the
  node holding the file.
- **Lineage is binding.** A patch built on another records it as its parent and shares revenue with it.
  Buying or applying a child without its parent is refused.
- **Teaching is opt-in.** `teach.enabled` is off by default; an operator chooses whether visitors may
  train on this machine, and reviews what they publish.

`deploy/` has the compose file and the host requirements (docker group, trainer GPUs disjoint from the
serving GPUs). `docs/` is the design record. `e2e/` drives a real node in a browser.
