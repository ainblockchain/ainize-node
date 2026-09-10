#!/usr/bin/env python3
"""Thin client for the resident teach trainer (resident/teach_server.py).

Drop-in for train/teach.py in the Ainize node's `teach.trainer.script`: same --job argument, same stdout
JSON-lines protocol, same exit codes.  --dry-run is delegated to teach.py itself (no model needed).
If the resident server is not up (no <queue>/.ready), falls back to running teach.py one-shot.

    docker exec -i flashtrain python3 /work/train/teach_client.py --job /work/.teach/<id>/job.json
"""
import argparse, json, os, signal, subprocess, sys, time

QUEUE = os.environ.get("TEACH_QUEUE", "/work/.teach/_queue")
TEACH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "teach.py")


def tail(path, pos, out):
    if not os.path.exists(path): return pos
    with open(path, "rb") as f:
        f.seek(pos); data = f.read()
    if data:
        out.buffer.write(data); out.flush()
    return pos + len(data)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--job", required=True)
    ap.add_argument("--out", default=None)
    ap.add_argument("--dry-run", action="store_true")
    a, rest = ap.parse_known_args()
    out_dir = a.out or os.path.dirname(os.path.abspath(a.job))
    if a.dry_run:
        os.execv(sys.executable, [sys.executable, TEACH] + sys.argv[1:])
    # 상주 서버가 (재시작 등으로) 잠시 없으면 최대 5분 기다린 뒤에야 one-shot teach.py 로 폴백
    for _ in range(600):
        if os.path.exists(os.path.join(QUEUE, ".ready")): break
        time.sleep(0.5)
    else:
        os.execv(sys.executable, [sys.executable, TEACH] + sys.argv[1:])
    for n in (".resident.stdout", ".resident.stderr", ".resident.exit", ".resident.cancel"):
        try: os.remove(os.path.join(out_dir, n))
        except FileNotFoundError: pass
    cancel = os.path.join(out_dir, ".resident.cancel")
    def on_term(signum, frame):
        open(cancel, "w").write(str(signum))
    signal.signal(signal.SIGTERM, on_term); signal.signal(signal.SIGINT, on_term)
    req = os.path.join(QUEUE, f"{int(time.time() * 1000)}-{os.getpid()}.json")
    tmp = req + ".tmp"
    with open(tmp, "w") as f: json.dump({"job": os.path.abspath(a.job), "out": out_dir}, f)
    os.replace(tmp, req)
    so, se = os.path.join(out_dir, ".resident.stdout"), os.path.join(out_dir, ".resident.stderr")
    exit_file = os.path.join(out_dir, ".resident.exit")
    po = pe = 0
    while True:
        po = tail(so, po, sys.stdout); pe = tail(se, pe, sys.stderr)
        if os.path.exists(exit_file):
            po = tail(so, po, sys.stdout); pe = tail(se, pe, sys.stderr)
            try: code = int(open(exit_file).read().strip() or 0)
            except Exception: code = 1
            sys.exit(code)
        if os.path.exists(cancel) and not os.path.exists(req):
            # cancelled while running: the server exports + restores, then writes the exit file — wait for it (≤ 120 s)
            for _ in range(240):
                if os.path.exists(exit_file): break
                time.sleep(0.5)
                po = tail(so, po, sys.stdout); pe = tail(se, pe, sys.stderr)
            sys.exit(int(open(exit_file).read().strip()) if os.path.exists(exit_file) else 143)
        if not os.path.exists(os.path.join(QUEUE, ".ready")):
            sys.stdout.write(json.dumps({"event": "error", "message": "resident trainer went away"}) + "\n"); sys.stdout.flush()
            try: os.remove(req)
            except FileNotFoundError: pass
            sys.exit(1)
        if os.path.exists(cancel) and os.path.exists(req):
            os.remove(req)   # cancelled before the server picked it up
            sys.stdout.write(json.dumps({"event": "error", "message": "cancelled before start"}) + "\n"); sys.stdout.flush()
            sys.exit(143)
        time.sleep(0.5)


if __name__ == "__main__":
    main()
