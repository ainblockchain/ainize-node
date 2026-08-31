# deploy/

## Local AIN blockchain (`ain` ledger mode)

```
docker compose -f deploy/docker-compose.ain.yml up -d     # or: ainize chain up
curl -s localhost:8081/node_status | python3 -c 'import sys,json;print(json.load(sys.stdin)["result"]["state"])'   # SERVING
ainize chain setup                                          # registers /apps/knowledge (ain-js) + market rules, funds the node identity
```

- JSON-RPC: `http://localhost:8081` · event handler: `ws://localhost:5101`
- Genesis validator `0x00ADEc28B6a845a085e03591bE7550dd68673C1C` holds the test supply; `ainize chain fund <address> [amount]` transfers from it (local chain only).
- Chain data lives inside the container; `ainize chain down` discards it.

## Multi-node marketplace demo (local ledger, one machine)

```
ainize init --name alice --port 3402 && ainize start -d && ainize login && ainize seed   # real knowledge only; add --synthetic only for test fixtures
NGRAM_HOME=~/.ngram-b ainize init --name bob   --port 3403 --peer http://localhost:3402 --roles verifier && NGRAM_HOME=~/.ngram-b ainize start -d
NGRAM_HOME=~/.ngram-c ainize init --name carol --port 3404 --peer http://localhost:3402 --roles verifier,serving && NGRAM_HOME=~/.ngram-c ainize start -d
ainize patch ls          # bob & carol attest → quorum 2 → LISTED
```
