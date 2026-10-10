# Native hosted QA product validator

`src/hosted-qa-validator.ts` runs on the Ainize host. It exports `runQaValidation(profile, candidate)`.
It must not be uploaded as a handler that has access to a Docker socket. The production gateway
binding/authorization and tick-to-validation dispatch are still pending; this module alone is not
an enabled production pipeline.

Operator profile pins repository, full base SHA, checkout path, immutable dependency image digest,
image dependency directory (`/seed/...`), product working directory, and ordered fixed gate argv.
The candidate must match repository/base. It is copied before async work and its SHA-256 digest
binds the returned verdict to the exact changed text files.

The host exports the exact Git commit, refuses symlink/submodule/unsafe paths, applies candidate
text files, and mounts only this temporary export read-only. Gates run as a non-root user with
no network, read-only root, no capabilities, no new privileges, bounded memory/CPU/PIDs/time, and
an ephemeral work directory. Repository commands receive a fixed environment without host or
release credentials. No package install runs: package.json and every source lockfile must exactly
match the dependency image or validation fails. Updating dependencies needs a rebuilt, pinned image.

Each gate receives a fresh copy of source and a read-only node_modules link. The first failed gate
stops the sequence. Container cleanup runs on success, error or timeout; temporary source is deleted.
Host crash recovery/orphan reconciliation remains necessary before production activation.
Private diagnostics are returned separately; never copy arbitrary gate output into public cards.

## Verification / limitations

- Local QA suite and typecheck cover configuration/path limits; real container execution was tested
  on Ainize .41 with the existing pinned Ainspace dependency image.
- Ainspace PR #198 commit `6bec65cef4a05e42f52a668850fd728ba09c42d2`: unchanged README supplied as the
  candidate overlay, so this is a check of the existing PR tree, not a new agent-authored fix or
  the result of rebasing onto latest main.
- With 4 GiB memory: lint and test passed; build exited 137 after printing `Killed`. This suggests
  resource pressure but the log alone does not prove OOM. An 8 GiB build retry was started separately.
- Evidence root: `/mnt/newdata/qa-services/validation/native-validator-20261010-3nezNA`.
  `result.json` records the 4 GiB run; `result-build-8g.json` is the follow-up result.
- Multi-package repositories need all configured product scopes; a single scope cannot satisfy them.
  Database/browser fixtures and network-dependent build assets are not supplied by this module.
- A passing validation checkpoint now waits at `needs_publication`, not approval: no reviewable
  published commit or PR exists until the publication stage actually succeeds.
