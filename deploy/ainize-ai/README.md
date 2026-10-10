# ainize.ai node — configuration that ships with the code

`config.overlay.json` holds the keys of the public node's `config.json` that are decided in review rather than
on the machine. `deploy/deploy-node.sh` applies it on every deploy: each **top-level key** in the overlay
replaces the same key in `$AINIZE_HOME/config.json` (a copy of the previous file is kept next to it, and a
failed deploy restores it along with the previous release). Keys not in the overlay — identity, peers, agents,
backends — are the machine's and are never touched.

## `deposits` — paying for throughput

- `receivingAddress` — where callers send AIN / sAIN. **Money sent here cannot be recovered by anyone who does
  not hold this address's key**; change it only to an address the operator controls.
- `chains` — Base AIN and Base sAIN (the staking vault share, credited 1:1). `rpcUrl` is Base's public RPC,
  which refuses `getLogs` ranges wider than about 2,000 blocks, hence `maxBlocksPerScan` (the watcher also
  halves on refusal by itself).
- `startBlock` — the block deposits are counted from on a node that has scanned nothing yet (the watcher's
  journal takes over after the first pass). Set when deposits were switched on; deposits before it are not
  credited.

The page that sells this is ainize-web `/billing`; the numbers come from `GET /api/throughput`.

## Environment on the ainize.ai host (systemd drop-ins)

Some settings live in the `ainize-public-node` user unit rather than in `config.json`, as drop-ins under
`~/.config/systemd/user/ainize-public-node.service.d/`. A host rebuilt from this repo needs them back:

| Drop-in | Setting | Why |
|---|---|---|
| `ain-sso.conf` | `AIN_SSO_ISSUER`, `AIN_SSO_CLIENT_ID`, `AIN_SSO_ADAPTER_URL`, `AIN_SSO_CLIENT_SECRET`, `AIN_SSO_SERVICE_APPS=aindrive` | AIN SSO sign-in (`docs/ain-sso.md`); the secret gives the node its machine identity for cloning project repos from aindrive (`docs/PROJECTS.md`) |
| `preferred-chat.conf` | `AINIZE_PREFERRED_CHAT_PEERS={"Qwen3.8-Flash-Next":"0x951e1767f18c4317479bb460950b281a3e122b93"}` | `/v1` chat for Qwen3.8 goes to the GPU peer (`ainize-gpu-models`), not the local runtime |
| `org-seed.conf` | `AINIZE_ORG_SEED=comcom=ComCom:comcom.ai` | the ComCom organization exists before anyone signs in; `@comcom.ai` people join at `domainRole` (write) |

After editing: `systemctl --user daemon-reload && systemctl --user restart ainize-public-node`.

The ComCom organization's first admin (kimminhyun, principal `google:101793548496807774755`, linked to AIN SSO
`acc_z30ycyh7madnj3e5qrqw4ezjs8`) was set by the operator on 2026-09-30 in `<AINIZE_HOME>/data/organizations.json`
(node stopped, `role: admin`, `via: admin`, audit `member.role`), since a seeded organization starts without members.
