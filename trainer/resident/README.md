# trainer/resident — window-resident teach trainer

The node's default trainer (`teach.trainer.script = train/teach.py`, run one-shot inside the trainer
container) loads the base model for every lesson. On the Qwen3.8-Flash-Next PLE runtime that is
~2–4 minutes of the 6–19 minutes a lesson takes, and it is the fixed cost the
[production verification plan](../../docs/production-verification-plan.md) asks about.

This directory is the resident variant: the model is loaded **once**, lessons arrive through a queue
directory, and after every job the touched PLE rows are written back bit-exact so the next lesson
trains on the pristine table. The node is unchanged — it still runs `teach.trainer.script` per lesson;
that script is now the thin client below.

| file | runs where | role |
|---|---|---|
| `teach_server.py` | inside the trainer container, **outside** `train/` (the node treats any `train/` process as an operator job holding the GPUs) | loads the model, polls `<queue>/*.json`, runs jobs via `teach_job.py`, writes `.resident.{stdout,stderr,exit}` next to the job |
| `teach_job.py` | imported by the server, `importlib.reload`-ed before every job so edits apply to the next lesson | one lesson: `train/teach.py`'s real-run logic plus (1) exact-length batched probes — the linear-attention layers and the n-gram hook must never see padding, (2) pinpoint protection of the rows the locality prompts read, (3) a contrast-probe cache |
| `teach_client.py` | as `train/teach_client.py`, i.e. the node's `teach.trainer.script` | same `--job` argument, stdout JSON-lines protocol and exit codes as `teach.py`; forwards the job to the queue, tails the resident outputs, falls back to one-shot `teach.py` if no server is up within 5 minutes; `--dry-run` is delegated to `teach.py` |

## Install (runtime repo = the directory bind-mounted at `/work`)

```bash
RUNTIME=/path/to/finance-knowledge-training-demo          # the node's --runtime-repo
cp -r trainer/resident            "$RUNTIME/resident"
cp    trainer/resident/teach_client.py "$RUNTIME/train/teach_client.py"

ainize config set teach.trainer.script train/teach_client.py
ainize config set teach.trainer.timeoutMs 3600000
docker exec -d flashtrain bash -c 'python3 /work/resident/teach_server.py > /work/.teach/_server.log 2>&1'
ainize teach status                                       # trainer ready
```

`teach_server.py --devices cuda:0,cuda:1,cuda:2 --queue /work/.teach/_queue --model-dir <dir>` are the
knobs; the defaults match `train/teach.py`'s. The server removes `<queue>/.ready` on exit, which is what
the client watches before falling back.

## Protocol

```
request : <queue>/<name>.json        {"job": "/work/.teach/<id>/job.json", "out": "/work/.teach/<id>"}
output  : <out>/.resident.stdout     teach.py JSON-lines (load / baseline / step / eval / done / error)
          <out>/.resident.stderr     human log
          <out>/.resident.exit       exit code, written last (atomic rename)
cancel  : <out>/.resident.cancel     touched by the client on SIGTERM; checked between steps and probes
```

Measured on the certification run (108 DART lessons, `--effort quick`): 6–19 min per lesson with the
model resident, of which training is 8 steps × ~28 s.
