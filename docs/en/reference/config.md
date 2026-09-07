---
title: Configuration reference
summary: Every key of a node config.json, its type, its default and the rules it is checked against
---

# Configuration reference

> [!NOTE]
> **This page is generated — do not edit it by hand.** It is written by `scripts/docs-gen.mjs` from `packages/core/src/config-schema.ts` and `packages/core/src/config.ts` and `packages/core/src/types.ts`.
> Regenerate with `npm run docs:gen`; `npm run docs:check` fails when this page and the source disagree.

All 127 keys a node config accepts, the environment variables that override them, and the file `ainize init` writes.

## How to read this page

A node keeps its settings in `config.json` inside its home directory (`~/.ainize` unless `AINIZE_HOME` says otherwise). Read and change them with
`ainize config show`, `ainize config get <key>`, `ainize config set <key> <value>` and `ainize config unset <key>` — see the [CLI reference](./cli.md#ainize-config).

Keys are dotted paths. The **Type** column is the schema's own description of what a key holds, followed by the rules it enforces — the same sentence `ainize config set` prints when a value is refused.

Money is a decimal string everywhere in this product, never a JSON number: `"0.1"`, not `0.1`.

## Keys

| Key | Type | Default | Notes |
|---|---|---|---|
| `name` | a string — must not be empty | `node-` + the first 6 hex of the node address |   |
| `dataDir` | a string — must not be empty | `<AINIZE_HOME>/data` |   |
| `port` | a number — must be a whole number; must be between 1 and 65535 | `3402` |   |
| `host` | a string — must be an interface to bind: an IP address (0.0.0.0, 127.0.0.1, ::) or a hostname | `"127.0.0.1"` |   |
| `publicUrl` | a string — must be an http(s) URL | unset |   |
| `roles` | a comma list of 'seller', 'verifier', 'serving', 'gateway' | `["seller","verifier","serving"]` |   |
| `peers` | a comma list | `[]` |   |
| `ledger` | an object (set its keys one at a time) |   |   |
| `ledger.kind` | one of 'local', 'ain' | `"local"` |   |
| `ledger.ain` | an object (set its keys one at a time) |   |   |
| `ledger.ain.providerUrl` | a string — must be an http(s) URL | `"http://localhost:8081"` |   |
| `ledger.ain.eventHandlerUrl` | a string — must be an http(s) URL | `null` |   |
| `ledger.ain.chainId` | a number — must be a whole number; must not be negative | `0` |   |
| `ledger.ain.appName` | a string — must not be empty | `"knowledge"` |   |
| `identity` | an object (set its keys one at a time) | minted by `ainize init` | **Protected.** |
| `identity.privateKey` | a string | minted by `ainize init` | **Protected.** |
| `identity.address` | a string | minted by `ainize init` | **Protected.** |
| `identity.publicKey` | a string | minted by `ainize init` | **Protected.** |
| `operatorPasswordHash` | a string | set by `ainize login` | **Protected.** |
| `runtime` | an object (set its keys one at a time) |   |   |
| `runtime.repo` | a string | unset — `ainize init` fills it with `/mnt/newdata/qwen3.8` when that directory exists on the machine it runs on |   |
| `runtime.api` | a string — must be an http(s) URL | `"http://localhost:8000"` |   |
| `runtime.hookApi` | a string — must be an http(s) URL | `"http://localhost:8001"` |   |
| `runtime.python` | a string | `"python3"` |   |
| `runtime.patchDir` | a string | unset | Patch-hook mailbox of the serving instance `api` points at (default \<repo>/ple_patch). One directory per vLLM instance: it carries the apply/remove requests and the cross-process runtime lock, so two servers (e.g. the demo cluster on its own GPUs and a second instance) never write into each other's table. |
| `runtime.gpus` | a string | unset | Which GPUs the serving instance `api` addresses occupies, e.g. "4,5" (item 145). Nothing on the node can discover this — the model is behind an HTTP URL — and without it the teach trainer cannot be stopped from being pointed at the GPUs that serve every verification and live test. Unset = no cross-check is possible. |
| `runtime.sampling` | a record | unset | Sampling + degeneracy guard per generation path (D1). Omit for the measured defaults. |
| `verifier` | an object (set its keys one at a time) |   |   |
| `verifier.quorum` | a number — must be a whole number; must be at least 1 | `2` |   |
| `verifier.stake` | a string — must be a decimal amount in quotes, e.g. "0.1" | unset | **Deprecated.** Never escrowed. Kept so existing config.json files still validate; the node ignores it and neither attestations nor challenges carry it any more (item 127). |
| `verifier.allowSelfAttest` | a boolean | `false` | false (the default): the author of an anchor cannot attest it — the write is refused and such records never count toward the quorum. |
| `verifier.intervalMs` | a number — must be a whole number; must be at least 1 | `5000` |   |
| `verifier.auto` | a boolean | `true` | false = verify only on demand (`ainize patch verify` / POST /api/patches/:id/verify); no background rounds. Default true. |
| `verifier.minBalance` | a number — must not be negative | `1` | Stop attesting below this balance, on a chain that charges gas (item 341). An attestation is a write the VERIFIER signs and pays for, and `verifier.auto` would keep writing until the account was empty — at which point every other thing this node does on chain (announce, settle, payout) fails too. Ignored on the local ledger, which has no gas. |
| `verifier.includeTest` | a boolean | `false` | Verify anchors published with `visibility: 'test'` (item 332). Default FALSE: on the demo chain 209 of 213 anchors were hidden test listings nobody can buy, and every e2e run of every other workstream cost each verifier a download and a benchmark. |
| `verifier.minPrice` | a string — must be a decimal amount in quotes, e.g. "0.1" | `"0"` | Skip anchors priced below this (decimal string, item 332). Default '0' — verify everything, free items included. |
| `verifier.maxPerHour` | a number | `40` | At most this many items per rolling hour (item 332). Default 40; 0 disables background verification entirely. |
| `verifier.maxModelMinutesPerHour` | a number | `10` | Minutes of shared-model lock this node will spend verifying per rolling hour (items 332 / 333). Default 10 — node-b spent 54.9 min on one demo afternoon, all of it in front of its own visitors. |
| `verifier.window` | an object (set its keys one at a time) |   | Local-time window `{from: 'HH:MM', to: 'HH:MM'}` outside which no background verification starts (item 333). |
| `verifier.window.from` | a string — must be HH:MM | unset |   |
| `verifier.window.to` | a string — must be HH:MM | unset |   |
| `verifier.retainBodies` | a boolean | `false` | Keep a body after the attestation that needed it counted (item 336). Default FALSE: a verifier's disk grew to 932 MB of files it neither wrote nor bought. Bodies this node authored, bought or serves are never dropped. |
| `market` | an object (set its keys one at a time) |   |   |
| `market.currency` | one of 'AIN', 'CREDIT' | `"CREDIT"`, or `"AIN"` with `ainize init --ledger ain` |   |
| `market.defaultPrice` | a string — must be a decimal amount in quotes, e.g. "0.1" | `"0.1"` |   |
| `market.royaltyShare` | a number — must be a fraction between 0 and 1 | `0.3` |   |
| `market.verifierShare` | a number — must be a fraction between 0 and 1 | `0.05` | Share of the SELLER side of each sale paid to the verifiers whose attestations count for that knowledge (item 325). Written into every anchor this node creates and floored at NETWORK_MIN_VERIFIER_SHARE when it is read back, so a seller cannot publish knowledge that pays its verifiers nothing. |
| `market.initialCredit` | a string — must be a decimal amount in quotes, e.g. "0.1" | `"100"` |   |
| `market.creditGrants` | a number — must be a whole number; must be at least 1 | `100` | How many addresses this node will ever hand `initialCredit` to (default 100). Local credit is issued by the node, not owned by the buyer: without a cap a fresh keypair is worth 100 CREDIT and any spend limit is one `ainize keys new` away (item 364). Every grant is recorded; past the cap a new address gets nothing. |
| `p2p` | an object (set its keys one at a time) |   | What this node accepts from the gossip network (items 136/137). Peer exchange used to add every endpoint any peer advertised — no cap, no record of where it came from, no way to refuse — so an operator could not answer "who is my node talking to?" from config.json, and `peers rm` survived exactly one gossip round. |
| `p2p.acceptExchange` | a boolean | `true` | Learn peers from peer exchange at all (default true). false = talk only to the configured list. |
| `p2p.maxPeers` | a number — must be a whole number; must not be negative | `50` | Ceiling on the peer table (default 50). Past it the least recently seen LEARNED peer is dropped. |
| `p2p.evictAfterFailures` | a number — must be a whole number; must not be negative | `60` | Drop a LEARNED peer after this many consecutive failed rounds (default 60; 0 = never). |
| `p2p.staleDays` | a number — must be a whole number; must not be negative | `7` | Drop a LEARNED peer this many days after it was last seen (default 7; 0 = never). |
| `server` | an object (set its keys one at a time) |   | HTTP server knobs. `trustProxy` is Express's `trust proxy` setting: `false` (default) → `req.ip` is the TCP peer, so a client cannot pick its own address with X-Forwarded-For (per-IP quotas, bans and rate limits key on `req.ip`). Behind a reverse proxy set it to the hop count (`1`), `'loopback'`, or the proxy's IP/CIDR list. |
| `server.trustProxy` | a boolean, number or string | `false` |   |
| `events` | an object (set its keys one at a time) |   | Retention of the node's own bookkeeping (item 128). `events.retentionDays` is how long raw rows of the `events` table are kept before the hourly purge removes them — the demand counters are materialised at write time, so nothing measured is lost with them. Default 90 days. |
| `events.retentionDays` | a number — must be a whole number; must be at least 1 | `90` |   |
| `teach` | an object (set its keys one at a time) |   | Teach mode (visitor-taught knowledge). Absent in configs written before teach mode → `teachConfig()` fills the defaults. |
| `teach.enabled` | a boolean | `false` | Master switch — every visitor teach route answers 403 `teaching_disabled` while false. |
| `teach.publish` | one of 'review', 'auto', 'never' | `"review"` | What happens when a visitor publishes: operator review (default), automatic announce, or never. |
| `teach.factsPerJob` | a number — must be a whole number; must be at least 1 | `8` |   |
| `teach.jobsPerKeyPerDay` | a number — must be a whole number; must not be negative | `3` |   |
| `teach.jobsPerIpPerDay` | a number — must be a whole number; must not be negative | `5` |   |
| `teach.queueMax` | a number — must be a whole number; must not be negative | `10` |   |
| `teach.contributorShare` | a number — must be a fraction between 0 and 1 | `0.7` | Default `Contributor.share` frozen into the anchor at publish (fraction of the seller remainder after lineage). |
| `teach.draftTtlDays` | a number — must be a whole number; must be at least 1 | `7` | Private READY drafts expire after this many days without save/publish. |
| `teach.backend` | one of 'gradient', 'stub' | `"gradient"` | 'gradient' runs train/teach.py in the trainer container; 'stub' copies a fixture npz (CI/e2e, no GPU). |
| `teach.stubOffline` | a boolean | `false` | With `backend: 'stub'`: never touch the serving model — preflight answers and CHECKING are simulated (a prompt that already contains the answer counts as "already known"; `LOCALITY_FAIL` in a fact fails the locality gate). For CI / e2e nodes without a model server. Ignored for the gradient backend. |
| `teach.trainer` | an object (set its keys one at a time) |   |   |
| `teach.trainer.container` | a string | `"flashtrain"` |   |
| `teach.trainer.script` | a string | `"train/teach.py"` |   |
| `teach.trainer.gpus` | a string | `""` |   |
| `teach.trainer.maxSteps` | a number — must be a whole number; must be at least 1 | `20` |   |
| `teach.trainer.timeoutMs` | a number — must be a whole number; must be at least 1 | `1800000` |   |
| `teach.trainer.minFreeGpuMb` | a number — must be a whole number; must not be negative | `20000` |   |
| `teach.trainer.idleStopMin` | a number — must be a whole number; must not be negative | `30` |   |
| `teach.locality` | an object (set its keys one at a time) |   | Locality gate: fixed prompts whose greedy answers must stay identical for at least `minSame` of them. |
| `teach.locality.prompts` | a comma list | 12 items — [the default `config.json`](#the-default-configjson) |   |
| `teach.locality.minSame` | a number — must be a whole number; must not be negative | `11` |   |
| `teach.dataset` | an object (set its keys one at a time) |   | Teach mode v2 — uploaded/collected datasets (design §6.4). |
| `teach.dataset.maxBytes` | a number — must be a whole number; must be at least 1 | `4000000` | Upload byte cap (operator ceiling 20 MB); the QUESTION cap must always bite first so the message is readable. |
| `teach.dataset.maxSourceLines` | a number — must be a whole number; must be at least 1 | `50000` | Parse ceiling — beyond this the parser stops and says so. |
| `teach.dataset.maxRows` | a number — must be a whole number; must be at least 1 | `2000` | Accepted questions stored per dataset. |
| `teach.dataset.perKeyPerDay` | a number — must be a whole number; must not be negative | `10` | New datasets per teaching key per day. |
| `teach.dataset.keptPerKey` | a number — must be a whole number; must not be negative | `20` | Datasets retained per key. |
| `teach.dataset.rowsPerKeyPerDay` | a number — must be a whole number; must not be negative | `300` | Questions TRAINED per key per day. |
| `teach.dataset.rowsPerIpPerDay` | a number — must be a whole number; must not be negative | `500` |   |
| `teach.dataset.bytesPerKeyPerDay` | a number — must be a whole number; must not be negative | `20000000` |   |
| `teach.dataset.ttlDays` | a number — must be a whole number; must be at least 1 | `7` | `ready` datasets are swept this many days after their last job finished. |
| `teach.dataset.stagedTtlHours` | a number — must be a whole number; must be at least 1 | `24` | `staged` datasets never used by a job are swept after this many hours. |
| `teach.dataset.createsPerIpPerMin` | a number — must be a whole number; must not be negative | `10` | In-memory per-IP create limiter (like `policyHits`). |
| `teach.dataset.declarationRows` | a number — must be a whole number; must not be negative | `100` | Above this many questions, publishing needs a rights/PII declaration. |
| `teach.rowsPerJob` | an object (set its keys one at a time) |   | How many questions one lesson may train. Derived at runtime from measured gradient runs; these are the bounds. |
| `teach.rowsPerJob.floorGradient` | a number — must be a whole number; must be at least 1 | `8` |   |
| `teach.rowsPerJob.floorStub` | a number — must be a whole number; must be at least 1 | `200` |   |
| `teach.rowsPerJob.ceiling` | a number — must be a whole number; must be at least 1 | `1000` |   |
| `teach.rowsPerJob.safetyFactor` | a number — must be a whole number; must be at least 1 | `2` |   |
| `teach.effort` | an object (set its keys one at a time) |   | The three effort presets. `lr` is fixed for all three — nobody has measured that changing it helps. |
| `teach.effort.quick` | an object (set its keys one at a time) |   |   |
| `teach.effort.quick.maxSteps` | a number — must be a whole number; must be at least 1 | `8` |   |
| `teach.effort.quick.evalEvery` | a number — must be a whole number; must be at least 1 | `2` |   |
| `teach.effort.balanced` | an object (set its keys one at a time) |   |   |
| `teach.effort.balanced.maxSteps` | a number — must be a whole number; must be at least 1 | `20` |   |
| `teach.effort.balanced.evalEvery` | a number — must be a whole number; must be at least 1 | `2` |   |
| `teach.effort.thorough` | an object (set its keys one at a time) |   |   |
| `teach.effort.thorough.maxSteps` | a number — must be a whole number; must be at least 1 | `40` |   |
| `teach.effort.thorough.evalEvery` | a number — must be a whole number; must be at least 1 | `4` |   |
| `teach.effort.lr` | a number — must not be negative | `0.002` |   |
| `teach.check` | an object (set its keys one at a time) |   | CHECKING budget — independent of dataset size, so a 1000-question lesson holds the runtime lock no longer than an 8-question one. |
| `teach.check.callBudget` | a number — must be a whole number; must be at least 1 | `68` |   |
| `teach.check.sampleRows` | a number — must be a whole number; must be at least 1 | `24` |   |
| `teach.check.chatFormRows` | a number — must be a whole number; must be at least 1 | `8` |   |
| `teach.check.parentSamplesMax` | a number — must be a whole number; must not be negative | `20` |   |
| `teach.check.lockTargetMs` | a number — must be a whole number; must be at least 1 | `300000` |   |
| `teach.check.lockAbortMs` | a number — must be a whole number; must be at least 1 | `480000` |   |
| `teach.check.lockGraceMs` | a number — must be a whole number; must be at least 1 | `1800000` | How long a lesson waits for a BUSY shared model before it is saved unchecked (item 244). A model OUTAGE has had a 15-minute grace since the beginning; a busy runtime was retried for ever, so a 3 a.m. bake could sit behind verification of its own yesterday's version with a terminal that said nothing. Default 30 min. |
| `teach.preflight` | an object (set its keys one at a time) |   | Interactive preflight sampling. |
| `teach.preflight.sampleRows` | a number — must be a whole number; must be at least 1 | `24` |   |
| `teach.preflight.perCall` | a number — must be a whole number; must be at least 1 | `8` |   |
| `teach.queuedRowsMax` | a number — must be a whole number; must be at least 1 | `2000` | Total questions the queue may hold across all waiting lessons. |
| `teach.checkStubLessons` | a boolean | `false` | Run the live side-effect check even when the trainer is the demo stub (item 247). Default false: a stub writes a PLACEHOLDER body, so the ~4.5 minutes of shared model the check costs measure nothing — the held lock is the only real thing about the run, and the lesson ends `NEEDS_MORE · taught 0/18` on a page that says nothing was trained. A test rig with a fake model server sets this, because the check path is what it asserts; a node pointed at a production vLLM should not. |
| `teach.trustedKeys` | a comma list | `[]` | Teaching keys this node does not ration (item 246): the daily lesson limit is meant to stop a stranger filling the GPU, and it locked the operator out of their OWN node after one failed bake and one retry — with no reset time anywhere. The node's own identity is always trusted; add the keys you teach with here. |
| `teach.lineage` | a boolean | `false` | Feature flag `teach.lineage` (lineage design §18): while false the node refuses `base_ids` on a teach job and the web hides "Build on this" / the basket base row / `--on`. Off until the runtime stack (L2) and the on-top trainer (L3) are verified end to end on the gradient backend; the dataset blob, its access levels and `dataset get` do not depend on it. |
| `gossipIntervalMs` | a number — must be a whole number; must be at least 1 | `4000` |   |
| `version` | a string — must not be empty | `"0.1.0"` |   |
| `includeTestAnchors` | a boolean | unset | Show anchors marked visibility:'test' (e2e suites) in this node's catalog. |

## Protected keys

`ainize config set` refuses these: the identity is the node's only key pair, and the password hash is written by `ainize login`.

- `identity`
- `identity.privateKey`
- `identity.address`
- `identity.publicKey`
- `operatorPasswordHash`

## Environment variables

These are read at start-up and overwrite what is in `config.json` for that run; the file is not changed.

| Variable | Sets | Accepted values |
|---|---|---|
| `AINIZE_HOME` | the directory holding `config.json`, the node key and the data directory |   |
| `AINIZE_PORT` | `port` |   |
| `AINIZE_HOST` | `host` |   |
| `AINIZE_PEERS` | `peers` |   |
| `AINIZE_LEDGER` | `ledger.kind` | `"ain"`, `"local"` |
| `AIN_PROVIDER_URL` | `ledger.ain.providerUrl` |   |
| `AINIZE_ROLES` | `roles` |   |
| `AINIZE_PUBLIC_URL` | `publicUrl` |   |
| `AINIZE_RUNTIME_REPO` | `runtime.repo` |   |
| `AINIZE_RUNTIME_API` | `runtime.api` |   |
| `AINIZE_RUNTIME_PATCH_DIR` | `runtime.patchDir` |   |
| `AINIZE_TEACH_BACKEND` | `teach.backend` | `"stub"`, `"gradient"` |
| `AINIZE_TEACH_ENABLED` | `teach.enabled` | `"1"`, `"0"` |
| `AINIZE_TRUST_PROXY` | `server.trustProxy` |   |
| `AINIZE_TEACH_STUB_OFFLINE` | `teach.stubOffline` | `"1"`, `"0"` |

## The default `config.json`

What `ainize init` writes, with the identity removed — it is minted per node.

```json
{
  "name": "node-19e7e3",
  "dataDir": "<AINIZE_HOME>/data",
  "port": 3402,
  "host": "127.0.0.1",
  "roles": [
    "seller",
    "verifier",
    "serving"
  ],
  "peers": [],
  "ledger": {
    "kind": "local",
    "ain": {
      "providerUrl": "http://localhost:8081",
      "eventHandlerUrl": null,
      "chainId": 0,
      "appName": "knowledge"
    }
  },
  "identity": {
    "privateKey": "…",
    "address": "0x…",
    "publicKey": "0x…"
  },
  "runtime": {
    "repo": "/mnt/newdata/qwen3.8",
    "api": "http://localhost:8000",
    "hookApi": "http://localhost:8001",
    "python": "python3"
  },
  "verifier": {
    "quorum": 2,
    "allowSelfAttest": false,
    "intervalMs": 5000,
    "auto": true,
    "minBalance": 1,
    "includeTest": false,
    "minPrice": "0",
    "maxPerHour": 40,
    "maxModelMinutesPerHour": 10,
    "window": null,
    "retainBodies": false
  },
  "market": {
    "currency": "CREDIT",
    "defaultPrice": "0.1",
    "royaltyShare": 0.3,
    "verifierShare": 0.05,
    "initialCredit": "100",
    "creditGrants": 100
  },
  "teach": {
    "enabled": false,
    "publish": "review",
    "factsPerJob": 8,
    "jobsPerKeyPerDay": 3,
    "jobsPerIpPerDay": 5,
    "queueMax": 10,
    "contributorShare": 0.7,
    "draftTtlDays": 7,
    "backend": "gradient",
    "stubOffline": false,
    "trainer": {
      "container": "flashtrain",
      "script": "train/teach.py",
      "gpus": "",
      "maxSteps": 20,
      "timeoutMs": 1800000,
      "minFreeGpuMb": 20000,
      "idleStopMin": 30
    },
    "locality": {
      "prompts": [
        "What is the capital of France?",
        "Write one sentence about the ocean.",
        "Translate \"good morning\" into Spanish.",
        "What is 17 + 25?",
        "Name three primary colors.",
        "Write a Python function that returns the square of a number.",
        "What year did the first human land on the Moon?",
        "Summarize the water cycle in one sentence.",
        "What is the chemical symbol for gold?",
        "List the days of the week.",
        "대한민국의 수도는 어디입니까?",
        "1부터 10까지 더하면 얼마입니까?"
      ],
      "minSame": 11
    },
    "dataset": {
      "maxBytes": 4000000,
      "maxSourceLines": 50000,
      "maxRows": 2000,
      "perKeyPerDay": 10,
      "keptPerKey": 20,
      "rowsPerKeyPerDay": 300,
      "rowsPerIpPerDay": 500,
      "bytesPerKeyPerDay": 20000000,
      "ttlDays": 7,
      "stagedTtlHours": 24,
      "createsPerIpPerMin": 10,
      "declarationRows": 100
    },
    "rowsPerJob": {
      "floorGradient": 8,
      "floorStub": 200,
      "ceiling": 1000,
      "safetyFactor": 2
    },
    "effort": {
      "quick": {
        "maxSteps": 8,
        "evalEvery": 2
      },
      "balanced": {
        "maxSteps": 20,
        "evalEvery": 2
      },
      "thorough": {
        "maxSteps": 40,
        "evalEvery": 4
      },
      "lr": 0.002
    },
    "check": {
      "callBudget": 68,
      "sampleRows": 24,
      "chatFormRows": 8,
      "parentSamplesMax": 20,
      "lockTargetMs": 300000,
      "lockAbortMs": 480000,
      "lockGraceMs": 1800000
    },
    "preflight": {
      "sampleRows": 24,
      "perCall": 8
    },
    "queuedRowsMax": 2000,
    "checkStubLessons": false,
    "trustedKeys": [],
    "lineage": false
  },
  "p2p": {
    "acceptExchange": true,
    "maxPeers": 50,
    "evictAfterFailures": 60,
    "staleDays": 7
  },
  "server": {
    "trustProxy": false
  },
  "events": {
    "retentionDays": 90
  },
  "gossipIntervalMs": 4000,
  "version": "0.1.0"
}
```
