# Real serving model to native chain receipt

This check makes one real **base-mode** streaming request through a fresh Ainize
node, persists its receipt, submits the actual receipt batch to a fresh local AIN
chain and verifies its successful finalized transaction and full block membership.
It does not mock the model, node API, ledger or RPC. It does not establish patched
inference, dataset/model support counts, multi-worker capacity or target TPS.

## Recorded run

- Model: the existing `Qwen3.8-Flash-Next` serving endpoint on localhost:8000.
- Native node request: `patch_ids=[]`, `mode=base`, `stream=true`, exact model
  constraint, prompt `Reply with exactly OK.`, maximum 32 output tokens.
- Returned answer: `OK`, normal `stop`, no truncation; client received `[DONE]`.
- Client receipt matched the node's persisted array and its SHA-256 commitment.
- Actual transaction: `0x9900bf9efe3b4d6ce115ad36a71fafeefe4af3cce205df4776ee4ca9bb3ab6b5`.
- Actual containing block: **53** of the isolated chain. The AINSCAN source parser
  accepted this transaction's native inference record and reported model/count.
- One observed request took 13,751 ms through the full node path; first wire data
  arrived at 13,272 ms. These are single-request observations, not a throughput
  estimate or a repeated latency distribution.

The [full evidence](../test/evidence/live-chat-chain-20260914/live-chat-chain.json)
contains the real response, receipt, batch, transaction and block. The
[wire stream](../test/evidence/live-chat-chain-20260914/live-chat.sse) is retained
separately. Existing node-reported model and empty applied-stack state matched
before and after. Both temporary containers, the internal chain network and the
shared runtime lock were confirmed removed/released after normal completion.
No existing model, trainer or blockchain service was restarted or stopped.

## Resources and limits

The temporary node controller used **2 CPUs / 4 GiB memory / 4 GiB memory+swap**;
the isolated chain also used **2 CPUs / 4 GiB**. Both had a 512-process limit.
The already-running model server was exposed to GPU devices 0–3, four
**A100-SXM4-80GB** GPUs, with a 4-CPU / 320-GiB container limit. These resources
were inspected, not changed. See the checked-in Docker and environment JSON
files alongside the evidence.

The controller image was Debian 12 / Node 24.21.0; the existing model image was
Ubuntu 24.04.3. This is **not** acceptance of the common procedure's uniform
Ubuntu environment or five independent L40S GPU nodes. The GPUs must not be
counted as four independent Ainize nodes, nor this request as an M4 result.
An existing served model ID is not proof of a specific Hugging Face weight revision.

## Reproduce against an already-running model

Required: this node checkout and its installed dependencies; current core source
and built `dist` (`npm ci --ignore-scripts && npm run build` in core); the pinned
local images described below; and an idle, already-running compatible model with
its real hook mailbox. No model download or new GPU model process is started.

From the core checkout:

```sh
AIN_TEST_IMAGE=sha256:cebf14bf492e5f5e39f3e9ae2681c44c28984e36d45b51b8a8a96f539208cef0 \
AIN_TEST_FOLLOWUP=/absolute/ainize-node/scripts/run-live-chat-chain.sh \
AIN_LIVE_CORE=/absolute/ainize-core \
AIN_LIVE_NODE_IMAGE=sha256:52e634617c0fad0207eeba4262ecdf142fc886649253ac42e4730ce75bd04dd5 \
AIN_LIVE_MODEL_REPO=/absolute/model-repository \
AIN_LIVE_MODEL_API=http://127.0.0.1:8000 \
AIN_LIVE_EXISTING_NODE=http://127.0.0.1:3410 \
  bash scripts/test-inference-chain.sh /absolute/new-output-directory
```

Image IDs require locally present or archived images; they are not registry
download addresses. See core's `docs/inference-chain-reproduction.md` for the
chain image build. The node-controller image supplies Node 24 and numpy-enabled
`/opt/runtime/bin/python3`; its code/dependencies are mounted from the explicit
checkouts. This validates source integration, not a published npm release.

The core launcher first verifies native chain setup, then runs the local follow-up
while the chain is alive and finally removes the chain/network. The follow-up
starts its own limited controller and removes only that controller. It uses host
networking to reach the existing model and the private Docker bridge; no GPU is
directly exposed to the controller. The model repository is read-only except its
`ple_patch` mailbox, which must be shared read-write for the normal cross-process
runtime lock and hook. Run only where that sharing is authorized.

The script refuses an existing reported applied stack or busy runtime before
starting. It uses a separate home and the public **development-only** genesis
identity on the fresh isolated chain, never a production wallet. A follow-up
assertion/timeout remains a failed check even if the chain's earlier synthetic
setup check passed. After an abnormal termination, inspect the retained home,
runtime lock and existing service state before retrying; do not force-clear a
lock belonging to another request. No public marketplace publication is performed.
