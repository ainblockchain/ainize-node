# Outbound P2P knowledge relay

This extends the existing `POST /p2p/blob/:sha` protocol from PR #5. It does not
require a public seller URL, port forwarding, Tailscale Funnel, a new dataset
publication, or retraining. A publisher behind NAT makes an outbound connection
to an operator-configured peer that opts into holding knowledge bodies.

## Receiver configuration

The receiver needs both the node implementation and the relay configuration
fields in [ainize-core PR #3](https://github.com/ainblockchain/ainize-core/pull/3).
Do not identify that implementation by a package version alone: on 2026-09-11,
core main and this feature branch both called themselves 0.1.2, but only the
feature branch contained `relayBlobs` and `maxRelayBytes`. Later that day main
advanced to core0.1.3 (`695a8ad6`) and node0.1.2 (`20e599a6`); this hardening branch
incorporates those changes. The compatible certification CLI is0.1.1 (`9acc9de`).
The currently observed public `/api/info` still reports0.1.0, build
`2026-09-10T14:15:13.517Z`; source availability is not proof of the running binary.
The API version is the core `VERSION` constant, still0.1.0 in core0.1.3, not the
npm package version. The refreshed local node also reports0.1.0 with a newer
build stamp and handles the POST. Do not diagnose deployment from that version
string alone; compare the actual POST response, build/image and source identity.

```bash
ainize config set p2p.relayBlobs true
ainize config set p2p.maxRelayBytes 10737418240
```

Apply the config using the deployment's normal safe restart procedure. Do not
restart a shared trainer or model while an experiment holds its runtime lock.
Forward `POST /p2p/blob/:sha` to this node, in addition to the existing P2P routes.
Neither `/api/me/*` nor operator/teaching APIs need to become public for relaying.

The size setting is a conservative aggregate storage budget: **all locally held
knowledge blobs**, plus reservations for concurrent incoming bodies, count
toward it. Existing local/imported bodies therefore reduce relay headroom. This
avoids losing accounting across restarts without a new database migration. It
is not a per-file limit and is not a whole-filesystem quota; temporary upload
and copy space require additional disk headroom. Zero or unset disables relay.
This is a single-node-process budget; do not share its data directory between
multiple independently running receivers.

Accepted relay bodies have a persistent retention flag in the blob database.
Verification cleanup and `gc` do not discard them: an offered copy must not
disappear immediately after attestation. Ordinary verification downloads retain
their existing cleanup policy. The operator can explicitly release a relay copy
with `ainize patch forget <id>`. This flag is a storage obligation, not a purchase
or permission to apply paid knowledge. Older databases acquire the new column
with a zero default; re-offering an already-held body establishes retention.

Additional fixed bounds: 256 MiB encoded, 512 MiB expanded NPZ, eight concurrent
offers, one file per request, and a 60-second upload deadline. Oversized files
remain transferable by the existing authenticated pull path; this new public
ingress deliberately accepts a smaller, bounded subset. Required knowledge
arrays are little-endian int64 addresses and C-order float32 before/after rows.
ZIP64 central directories and archives with more than 64 arrays are refused.

## Protocol and recovery

1. Gossip the signed anchor using the existing ledger protocol.
2. POST multipart field `blob` to `/p2p/blob/<sha256>`, with the existing
   `x-ainize-auth: authHeader(authorIdentity, "blob:<sha256>")` signature.
3. Check the JSON receipt (`ok`, exact `sha256`, `size_bytes`, `already_held`).
   An HTML 200 is not a successful relay. Repeated valid offers are idempotent.
4. Check `/p2p/blobs`, the public knowledge detail's `has_body`, and finally run
   the real Live test. A successful file transfer does not prove answer quality.

For knowledge announced before the receiver was deployed, log into the **author
node** as its operator and call `POST /api/patches/<id>/relay` (for example, from
that node's browser console with `fetch('/api/patches/<id>/relay', {method:'POST'})`).
It retries the existing body without adding another anchor, retraining, or
publishing a dataset. `relayed: false` and an empty `accepted` list are failures
to place the body, not a successful publication. Only explicitly configured
peers receive automatic offers; peer exchange cannot silently add recipients.

If the author node cannot safely restart because a trainer is active, the
standalone recovery client can offer an already-published **free public** body
using the same signed protocol and the existing identity file:

```bash
node scripts/retry-public-blob.mjs /private/config.json /path/to/body.npz published-id https://ainize.ai
```

Run it with installed node/core dependencies (Node 24), preferably in a Docker
container with only the config and selected body mounted read-only. It checks
the source hash, anchored size, author and ledger signature before transmitting;
only the first 500 peer records are searched. It refuses redirects and bogus
acknowledgments, and requires an authenticated GET read-back with the same hash
after acceptance. It never prints the identity secret or request auth header.
The client does not retrain, create an anchor, publish a dataset, or modify the
running author node. A missing receiving route remains a failure, not success.

Authentication, known published-public anchor, author, storage budget, and
in-flight checks happen **before** multipart parsing. The receiver validates
exact anchored size, hash and dimensions, bounded ZIP inflation, and existing
destination integrity before registration. It cleans temporary files on
rejection and disconnection. Drafts, test anchors, retired/rejected knowledge,
unrelated authors, and corrupt stored copies are not acknowledged as valid.

Relaying does not grant a purchase, change verification quorum, mark knowledge
verified, or waive dataset access/PII rules. Paid-body relays must be peers the
publisher trusts to store those bytes; API download gates are not encryption
against the relay operator. The legacy signature purpose is retained for wire
compatibility and is not bound to an HTTP method or recipient; relay deployment
does not resolve that pre-existing protocol limitation.

## Reproducible validation

```bash
bash scripts/test-blob-relay-docker.sh /path/to/ainize-core /path/to/new-evidence
```

The default prebuilt dependency image is
`ain-cert-ainize-cli:hf-import-20260911-r5`; provide `AINIZE_TEST_IMAGE` for an
equivalent local image with Node 24, Python/NumPy, and core/node dependencies
under `/opt/ainize/ainize-{core,node}`. Source directories and the root filesystem
are read-only. Tests build both exact source trees in an executable tmpfs, with
network isolation, CPU quota 2, CPU set 0–7, RAM/swap ceiling 4 GiB, and no GPU.
The wrapper preserves build/test failures and container state as well as success.
The fixtures are synthetic, not the DART100 performance or public Live evidence.

The public route probes at 2026-09-11 08:48 and 08:54 UTC returned HTTP 404
(`Cannot POST /p2p/blob/...`) on both apex and www at the first check and www at
the second. Thus the visible endpoint had not yet demonstrated this receiver,
even though feature code was available. A relay-disabled **403** or signed-offer
**403** proves route matching; a **404** HTML `Cannot POST` does not. Record the
actual deployment commit and repeat the body transfer and Live test separately.

## Compatibility and runtime cleanup

The hardening branch incorporates node main `20e599a6` (node 0.1.2) and builds
against merged core `695a8ad6` (core 0.1.3). It retains the upstream
LISTED-to-VERIFIED terminology change rather than restoring older schemas.
The last public control probes at 09:52 UTC still returned HTML `Cannot POST`
on both domains; the presence of source on main does not establish deployment.

A separate cleanup regression exposed a watchdog snapshot race: it read a
visitor's applied stack before acquiring the runtime lock and could reconstruct
that obsolete stack after a completed removal. The stack, top body and rebuild
plan are now read inside the lock. Three deterministic regression tests fail on
the former implementation and pass with the fix. This prevents the modeled race;
it does not prove that this was the only cause of the observed DART audit cleanup
failure. No running model or active training job was restarted to test this fix.
