# Builder persistent state and Unix gateway permissions

Preauthorized scope: fix access when the API host UID differs from the runtime's
node UID (1000), decode the state directory before importing agent code, preserve
state across starts, and keep per-agent bind mounts and token authorization.
No operating data changes, root agent, public write permissions, Docker socket
mounts, version changes, commits, PRs, merges or deployment in this checkout.
The controller owns publishing and administrator approval.

Use owner-controlled paths and named POSIX UID ACLs for the runtime, including
search access on the gateway directory and read/write access on its socket.
Fail closed if the filesystem or host lacks ACL support (`setfacl`, package `acl`).
Only each agent's state directory is mounted; the parent stays private. Docker
user namespace remapping is not supported by this UID contract.

Validation: unit tests with explicit command injection (not container evidence),
real Docker regression coverage for state write/restart, Unix model calls,
isolation and unrelated UID refusal; typecheck, full tests, docs check and build.
Unavailable Docker/server execution and sibling documentation checks are
controller-pending, never reported as passing integration evidence. Ainmem card
creation is controller-pending because no Ainmem tool is available here.

## Controller validation matrix

Install the host `acl` package and use a local, non-remapped Docker daemon on an
ACL-capable filesystem. Run the command below from a readable checkout as each
host account (UID 1000 and UID 2000, neither root). The container remains node
UID 1000 in both runs. The test asserts the declared host identity and fails,
rather than skips, if its explicit opt-in cannot reach Docker.

```sh
AINIZE_TEST_UNIX_PERMISSIONS=1 AINIZE_TEST_HOST_UID=1000 node --test --import tsx test/hosted-agent-permissions-docker.test.ts
# Run the next command under the host account with UID 2000:
AINIZE_TEST_UNIX_PERMISSIONS=1 AINIZE_TEST_HOST_UID=2000 node --test --import tsx test/hosted-agent-permissions-docker.test.ts
```

Only temporary test directories and test containers/images are changed. The
fixture uses network=none and docker exec for the inbound A2A call; the outbound
model call uses the production Unix gateway. A third UID (34567) is given the
same mounts and must receive EACCES for state and socket. Tokens travel through
the production private env file and are scrubbed before module import.

Preauthorized P1 follow-up: preserve existing runtime-owned (UID 1000) private
state without changing its owner, contents or permissions. Validate its private
access and default ACL before reuse; gateway paths remain API-host-owned.
Other foreign-owned paths and symlinks fail closed; this change does not silently chown existing operator
data. ACL support is required even for matching UIDs to clear inherited grants.
All agents use UID 1000 inside separate containers; isolation between agents is
provided by separate state bind mounts, private host parents, and gateway tokens,
not by different numeric UIDs inside the containers. Host UID 1000 is therefore
part of the trusted runtime identity when the API runs under a different UID.

## Checkout results and review

- Typecheck and build passed. Targeted tests: four passed, real Docker test
  skipped (controller-pending). Command doubles are not Docker/ACL evidence.
- Full `npm test` stalled under sandbox test-process isolation and was stopped;
  full-suite diagnostic with isolation disabled failed on `listen EPERM`.
  Existing Unix transport test also fails at socket listen with EPERM.
- `docs:check`: controller-pending, missing ainize-core/ainize-cli/ainize-web.
- Docker daemon access denied; `setfacl` absent. Both real host UID matrix rows
  remain controller-pending. No claim of real container success is made.
- Self-review: root package version, release policies and instructions unchanged;
  no world access grants, privileged agent, Docker socket mount, token logging,
  commits, PR creation, merge or deployment. ACL errors stop startup; symlink or
  untrusted foreign-owned targets fail closed. Independent final review and PR creation
  belong to the controller. Ainmem card link still requires controller tooling.

## P1 existing-state follow-up validation

The runtime-owned reuse branch accepts a real directory owned by UID 1000 with
mode 0700 and no permissive default ACL. It reads metadata using `getfacl` and
never chmods, chowns or sets ACLs on that directory. Host ownership remains
required for gateway paths. ACL read failures and unsafe modes fail closed.
The host does not need access to the state's contents.

Both controller UID matrix commands above now cover new host-owned state and
preexisting runtime-owned 0700 state with a 0600 counter seeded to 40. A non-root
UID 1000 fixture container prepares that counter; two agent starts must yield
41 then 42, with model calls, isolation, authentication and unrelated UID checks.
Counters are inspected inside the runtime, not by the UID 2000 API host.

Follow-up checkout results:
- Targeted tests with isolation disabled: 5 passed, 2 real Docker cases skipped.
  The identity/ACL doubles are explicitly labeled and are not kernel evidence.
- `npm run typecheck` and `npm run build`: passed; `git diff --check`: passed.
- `npm test`: stalled after two file results and was interrupted. Full-suite
  diagnostic with isolation disabled failed with `listen EPERM 127.0.0.1`.
  Full suite remains controller-pending; no test gate was changed.
- Explicit real Docker opt-in: both cases failed the working-daemon prerequisite.
  `getfacl` and `setfacl` are also absent here. Actual UID 1000/2000 execution
  remains controller-pending.
- `npm run docs:check`: failed because the three sibling repositories are absent;
  controller-pending. Ainmem tooling is unavailable, so its card link also
  remains controller-pending. Final independent review and PR are controller work.
- Self-review confirmed no operating-data mutation, root agent, global grants,
  authentication bypass, version/policy/instruction edits or publishing actions.
