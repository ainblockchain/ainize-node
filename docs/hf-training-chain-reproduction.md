# HF CLI to native training record integration

This integration downloads eight public DART question/answer rows from the
existing HF dataset, imports them through the actual CLI into a fresh Ainize
node, runs its explicitly configured **stub** trainer, and checks the resulting
READY write on a fresh isolated blockchain. No HF response, CLI command, node
API or blockchain RPC is mocked. The trainer is simulated: this is not real GPU
training, patch application, model inference or metric 6 completion.

## Prerequisites

Use local checkouts of ainize-node, ainize-core, ainize-cli and ainize-bench with
dependencies installed. Build core first (`npm run build` in ainize-core), so the
node uses current ledger code. The controller image must contain Node.js 24,
Python and NumPy for stub patch generation. Both images below are pinned local
image IDs; on another machine build/load them and use the resulting IDs.

The immutable public input is repository
`Minhyun/ainize-dart100-reproduction-20260911`, revision
`9a523ed3268688e90ee18f1ecd93f4fb72a8f056`, file
`data/dart-001-company_ceo_nm.jsonl`. This is one dataset selection with eight
rows, not 100 independent integrations. No HF token is read or sent. Source
availability and permissions remain prerequisites; fetch failure stops the run.

## Run from ainize-core

```sh
export AIN_HF_CORE=/absolute/path/to/ainize-core
export AIN_HF_CLI=/absolute/path/to/ainize-cli
export AIN_HF_BENCH=/absolute/path/to/ainize-bench
export AIN_HF_IMAGE=sha256:52e634617c0fad0207eeba4262ecdf142fc886649253ac42e4730ce75bd04dd5
export AIN_TEST_IMAGE=sha256:eddd95425bbec1c97bfb6f06371ce22a9a146fee936c90f54f17fe04dd1aa955
export AIN_TEST_FOLLOWUP=/absolute/path/to/ainize-node/scripts/run-hf-training-chain.sh
bash scripts/test-inference-chain.sh /absolute/path/to/new-output
```

To verify the resulting HF-backed transaction in actual AINSCAN pages before
the private chain is removed, also set these variables before the same command:

```sh
export AINSCAN_SOURCE=/absolute/path/to/ainscan
export AINSCAN_BUILD_DIR=/absolute/path/to/successful-production-build-output
export AINSCAN_IMAGE=sha256:52e634617c0fad0207eeba4262ecdf142fc886649253ac42e4730ce75bd04dd5
```

The build output must come from AINSCAN's `scripts/verify-production-build.sh`,
and its recorded clean source commit must match the current clean checkout.
The optional explorer starts only after the HF binding check succeeds. Its
CPU=1, memory=1 GiB production server uses the still-running private chain and
binds only to loopback. It does not deploy or query the public AINSCAN website.
The parent keeps the chain alive until all explorer checks finish. The explorer
checks use this actual job's READY transaction, not replacement synthetic lessons.

The parent sets up a private chain using its standard public development key.
Never use/fund that key on a public network. The chain has CPU=2 and memory=4 GiB
on its own internal Docker network. The controller also has CPU=2 and memory=4
GiB, with no additional swap, no GPU devices and no Docker socket. Its host
network access reaches the private chain and public HF downloads; the temporary
Ainize HTTP listener binds only to `127.0.0.1` on a random port. Existing serving
models, GPU workers and production nodes are not modified.

The CLI runs `dataset <url> --revision <sha> --file <file> --train` once, without
`--wait`: the stub result is unmeasured and must not be treated as a successful
real-model wait outcome. The controller waits for that same job's READY receipt
and chain finalization, then uses `teach status` and `teach dataset get` to gather
its bindings and canonical bytes. It invokes the benchmark repository's
read-only HF training-record verifier. Publishing is disabled.

## Evidence and limits

`hf-training-binding.json` contains the verified hashes, dataset/job IDs, native
path, transaction hash, containing block, reported model/backend and latency.
`integrationVerified` remains false and `backendReported` must be `stub`.
`hf-training-block.json` retains the actual transaction result and full block.
Other output files retain CLI import/status/download results, controller logs
and Docker limits. The private `hf-home` directory also contains generated
teaching keys and the node database: never publish that directory wholesale.
Select and review non-secret evidence files before sharing.

The controller has a 240-second timeout. Parent and follow-up EXIT traps remove
only their own containers/network. Failed or timed-out runs retain local files
for diagnosis and are not automatically retried. No npm publication or public
service deployment is performed by this procedure.

## Recorded result, 2026-09-14

The actual run passed with CLI source `cb1dee8`, core `b291694`, benchmark
verifier `183e5e3`, and node worker source `a5ddf2d` plus this integration harness.
All eight rows were imported, and their retained input, upload and canonical
bytes had SHA-256
`405249ef16b48a3754b481092a968d004996acafd9c60f72fd06b655fe80f8c4`.
These hash domains happened to contain identical bytes in this selection; that
is not assumed for mapped imports.

Dataset `11075bd8-0302-4f4e-b4cb-5c8a32835116` produced job
`5d09cf26-f7f0-4ffb-9311-5e89fc352759`. Its READY transaction
`0x7216375853020fe9b46f2a38948b0471663654e748643ecc58c1c415346da44a`
was successful and finalized in block **96**. Reported submission-to-inclusion
latency was **334 ms**. The verifier returned `bindingVerified: true` and
`integrationVerified: false`, with backend `stub`. The recorded model label
`Qwen3.8-Flash-Next` does not mean a real model was loaded or used in this run.

Selected non-secret block/binding and Docker evidence is retained in
`test/evidence/hf-cli-native-chain-20260914/`. Full private working files remain
in the execution output, not in Git. Both temporary containers and the private
chain network were removed after a clean exit. Core build, strict TypeScript
checking of the integration script and shell syntax checks passed. The initial
standalone TypeScript command omitted strict mode and produced narrowing errors;
rerunning with the repository's strict semantics passed without source changes.

This proves one real source/import/native-record connection using simulated
training. It does not prove 100 dataset integrations, inference, AINSCAN rendering
of this particular transaction, public deployment or any performance target.

## Optional explorer run, 2026-09-14

A subsequent fresh run with the explorer variables enabled passed all seven
AINSCAN route checks, including eight dedicated training detail fields. This
run's actual HF-backed READY transaction
`0x511f8d60f511007316ad4197b058faa63c7bf109c00a57d4f528100d72e441d2`
was finalized in block 89 and displayed **415 ms**, matching its recorded block
and submission timestamps. AINSCAN source was `7c40ae3`, production build
`oEhap0hdJErgigG__fIg2`. Selected HTML, binding and block evidence is committed in
ainize-core at `test/evidence/hf-cli-ainscan-20260914/`, with detailed scope and
the initial Copy-button parsing failure documented in its reproduction guide.
The backend still displayed `stub`; this adds actual explorer rendering evidence,
not real model training/inference, a performance-target pass or public deployment.
