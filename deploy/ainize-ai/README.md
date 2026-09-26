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
