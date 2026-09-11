# Certification runtime refresh

These helpers are for the existing `/mnt/newdata/gov/kpi` deployment, not a clean-machine installer or a public-server deployment. They do not restart model containers or publish container images.

`build-source-refresh.sh` freezes compatible core/node/CLI source and rebuilds all three against the immutable ID of an existing dependency/Python runtime image. It saves source hashes, Git provenance, build output and image ID. CPU quota2, cpuset0–7 and RAM/swap4GiB bound the build. Changing dependencies requires rebuilding the dependency image first; this helper does not run an unlocked `npm install`.

```bash
AINIZE_BASE_IMAGE=sha256:563e96f6725136939bd6bac5cf6a6480fcc535f71fb51c0ab02ab19d7d8891d7 \
  bash deploy/build-source-refresh.sh /path/to/ainize-core /path/to/ainize-cli \
  /path/to/new-evidence ain-cert-ainize:relay-runtime-20260911
```

The verified build combines core `695a8ad6` (0.1.3), node runtime `257bfe85` (0.1.2 plus hardening/watchdog fix), and CLI `9acc9de` (0.1.1 including HF URL import and VERIFIED compatibility). Keeping the older CLI source caused a real `LISTED`/`VERIFIED` TypeScript error; that failed build is preserved. Rebuilding with this helper returned the exact same final image ID `sha256:da23af1a5c75cfee61bdad8403f39cad31b6bd2860e7af590a6ffbf03f31c4b0`. Dependency checks and all three package builds pass.

## Safe API-only replacement

Install `cert-docker/upgrade-ainize.sh` and `cert-docker/compose.ainize.json` verbatim in the deployment's `kpi/docker/`. The existing clone at `kpi/pr/an-relay` supplies `deploy/runtime-snapshot.mjs`. The compose default is the verified local image; `AINIZE_IMAGE` can select an explicit available image. This is not permission to replace another deployment's configuration.

Coordinate the lifecycle observer first. Pause it intentionally while it is only observing a known TRAINING job; do not interrupt an inference audit or cancel the actual job. Wait for the server's real terminal job state and an idle, empty model stack. The upgrade script refuses active observers and nonterminal jobs. A preflight check is not a distributed lock against another operator, so the runtime must be reserved for this maintenance.

```bash
cd /mnt/newdata/gov
RUN_ID=ainize_runtime_upgrade_20260911 bash kpi/docker/upgrade-ainize.sh
```

The script snapshots the job IDs, dataset bindings, patch hashes/checks, publisher identity, data files and trainer files. Published drive entries can be symlinks into `.teach/<job>/lesson.npz`: only SHA-named links under the explicit trainer root are followed and their bytes must match the name. Other links are refused. All checked job bodies must match their recorded SHA and size. Neither a symlink nor a public node's empty blob list proves the original body is gone.

Only the Ainize API container stops. Its private home and the linked trainer tree are backed up separately under `kpi/secrets/<RUN_ID>` (0700 directory/0600 archives). Backups are never release assets. After startup, actual JSON readiness, exact target image, every existing data/body hash, unchanged job binding and publisher/model identity are checked. `flashnext` and `flashtrain` container IDs/start times/PIDs must remain identical. An expired readiness observation is a failure to inspect, not a reason for blind restart. Resume the original lifecycle RUN_ID only after preservation checks pass; do not replace its frozen source or submit duplicate jobs.

Offline validation: `ainize_runtime_maintenance_final_tests_20260911` passed55 tests (30 relay/client/watchdog/snapshot +25 cluster/chat guards). Additional operator enumeration tests are recorded separately. The new snapshot tests include linked-body handling and refusal of foreign/mutated state. Enumeration uses the operator-only `/api/me/teach/jobs`, not the signature-only visitor endpoint or a teaching key's subset. An actual CHECKING job caused the guard to refuse the restart, leaving the same API instance running (`ainize_runtime_preflight_operator_reject_20260911`). An earlier `docker top` call missing its mandatory PID field is retained as a wrapper failure, not a successful guard test. Test fixtures and a successful local rebuild do not establish public-server deployment, P2P delivery, Live answer quality or all100 dataset evaluations.
