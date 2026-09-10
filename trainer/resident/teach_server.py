#!/usr/bin/env python3
"""Resident teach trainer — loads Qwen3.8-Flash-Next ONCE and serves teach jobs from a queue directory.

    python3 /work/resident/teach_server.py [--queue /work/.teach/_queue] [--devices cuda:0,cuda:1,cuda:2]

Protocol (file based, shared /work bind-mount):
    request : <queue>/<name>.json   {"job": "/work/.teach/<id>/job.json", "out": "/work/.teach/<id>"}
    output  : <out>/.resident.stdout   (teach.py JSON-lines protocol: load/baseline/step/eval/done/error)
              <out>/.resident.stderr   (human log)
              <out>/.resident.exit     (exit code, written last)
    cancel  : <out>/.resident.cancel   (client touches it on SIGTERM; checked between steps/probes)

Training logic is train/teach.py's real-run section, with two changes: the model is loaded once, and after
every job the touched PLE rows are written back to their pre-job values (bit-exact, bf16) so the next job
trains on the pristine table.  Placed outside train/ on purpose: the Ainize node treats any `train/` process
inside the container as an operator job holding the GPUs.
"""
import argparse, glob, json, os, random, sys, time, traceback

sys.path.insert(0, "/work/train"); sys.path.insert(0, "/work/resident")
import teach  # noqa: E402  (functions + constants of the one-shot trainer)


class Tee:
    """Redirect writes to a file (per-job stdout/stderr)."""
    def __init__(self, path): self.f = open(path, "a", buffering=1, encoding="utf-8")
    def write(self, s): self.f.write(s); self.f.flush()
    def flush(self): self.f.flush()
    def close(self): self.f.close()




import importlib
import teach_job
JOB_STATE = {"contrast": {}, "protect": {}}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--queue", default="/work/.teach/_queue")
    ap.add_argument("--model-dir", default=teach.DEFAULT_MODEL_DIR)
    ap.add_argument("--devices", default="cuda:0,cuda:1,cuda:2")
    a = ap.parse_args()
    os.makedirs(a.queue, exist_ok=True)
    devices = tuple(d.strip() for d in a.devices.split(",") if d.strip())
    from transformers import AutoTokenizer
    import hf_model
    hf_model.MODEL_DIR = a.model_dir
    tok = AutoTokenizer.from_pretrained(a.model_dir)
    t0 = time.time()
    model, tc, rows = hf_model.load_model(devices=devices, verbose=False)
    load_s = time.time() - t0
    model.gradient_checkpointing_enable(gradient_checkpointing_kwargs={"use_reentrant": False})
    model.eval()
    print(json.dumps(dict(event="resident_ready", load_s=round(load_s, 1), devices=devices)), flush=True)
    open(os.path.join(a.queue, ".ready"), "w").write(str(time.time()))
    import atexit, signal as _sig
    def _bye(*_):
        try: os.remove(os.path.join(a.queue, ".ready"))
        except FileNotFoundError: pass
    atexit.register(_bye)
    _sig.signal(_sig.SIGTERM, lambda *_: sys.exit(143))
    real_out, real_err = sys.stdout, sys.stderr
    while True:
        reqs = sorted(glob.glob(os.path.join(a.queue, "*.json")), key=os.path.getmtime)
        if not reqs:
            time.sleep(1); continue
        rp = reqs[0]
        try:
            req = json.load(open(rp))
        except Exception:
            time.sleep(0.5); continue
        os.remove(rp)
        out_dir = req.get("out") or os.path.dirname(os.path.abspath(req["job"]))
        os.makedirs(out_dir, exist_ok=True)
        so, se = Tee(os.path.join(out_dir, ".resident.stdout")), Tee(os.path.join(out_dir, ".resident.stderr"))
        sys.stdout, sys.stderr = so, se
        t1 = time.time()
        try:
            importlib.reload(teach_job)                      # 코드 수정을 다음 작업부터 반영
            teach_job.CONTRAST_CACHE = JOB_STATE["contrast"]; teach_job.PROTECT_CACHE = JOB_STATE["protect"]
            code = teach_job.run_job(req, model, tok, rows, load_s, devices, a.model_dir)
        except SystemExit as e:
            code = int(e.code or 0)
        except Exception as e:
            traceback.print_exc(file=se); code = 1
        finally:
            sys.stdout, sys.stderr = real_out, real_err
            so.close(); se.close()
        with open(os.path.join(out_dir, ".resident.exit.tmp"), "w") as f: f.write(str(code))
        os.replace(os.path.join(out_dir, ".resident.exit.tmp"), os.path.join(out_dir, ".resident.exit"))
        print(json.dumps(dict(event="resident_job_done", job=req["job"], code=code, secs=round(time.time() - t1, 1))), flush=True)


if __name__ == "__main__":
    main()
