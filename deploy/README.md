# deploy/

## Local AIN blockchain (`ain` ledger mode)

```
docker compose -f deploy/docker-compose.ain.yml up -d     # or: ngram chain up
curl -s localhost:8081/node_status | python3 -c 'import sys,json;print(json.load(sys.stdin)["result"]["state"])'   # SERVING
ngram chain setup                                          # registers /apps/knowledge (ain-js) + market rules, funds the node identity
```

- JSON-RPC: `http://localhost:8081` · event handler: `ws://localhost:5101`
- Genesis validator `0x00ADEc28B6a845a085e03591bE7550dd68673C1C` holds the test supply; `ngram chain fund <address> [amount]` transfers from it (local chain only).
- Chain data lives inside the container; `ngram chain down` discards it.

## Multi-node marketplace demo (local ledger, one machine)

```
ngram init --name alice --port 3402 && ngram start -d && ngram login && ngram seed
NGRAM_HOME=~/.ngram-b ngram init --name bob   --port 3403 --peer http://localhost:3402 --roles verifier && NGRAM_HOME=~/.ngram-b ngram start -d
NGRAM_HOME=~/.ngram-c ngram init --name carol --port 3404 --peer http://localhost:3402 --roles verifier,serving && NGRAM_HOME=~/.ngram-c ngram start -d
ngram patch ls          # bob & carol attest → quorum 2 → LISTED
```
