#!/usr/bin/env python3
"""Fine-tune a Cloudflare Clef decision model from a Teach job, by training ONLY its joint schema head.

This is the Clef counterpart of the PLE knowledge-patch trainer (`train/teach.py`): the node launches it
exactly the same way —

    docker exec -i <trainer.container> python3 /work/train/clef_teach.py --job /work/.teach/<id>/job.json --devices cuda:0,...

and it speaks the same stdout JSON-lines protocol (`{"event": "..."}` per line: load, step, eval, done, error)
and writes the same two artifacts next to job.json: `lesson.npz` (the trained head) and `recipe.json`.

What differs is WHAT is trained. Clef is not a causal LM with a knowledge table; it is a frozen Qwen3.8
backbone with a small `JointSchemaHead` that turns the backbone's hidden states into one logit per allowed
option of every question. So a lesson here trains the head and leaves the backbone untouched — the head is
the artifact, the way a PLE row-slice is for the language model. The serving sidecar swaps it in through its
`HEAD_OVERRIDE` env.

A Teach "fact" carries the demonstration as two JSON strings so the whole existing dataset/job pipeline works
unchanged:
    prompt = JSON of {"state": <any>, "questions": {qid: {type, instructions?, criteria?}}}
    answer = JSON of {qid: <label>}   label = choice option id | score index (int) | true/false for noul
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import traceback
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F


def emit(event: str, **fields) -> None:
    """One protocol line on stdout. The node reads lines starting with '{' and switches on `event`."""
    sys.stdout.write(json.dumps({"event": event, **fields}, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def option_ids_for(question: dict) -> list[str]:
    """The option ids in the SAME order the model's head emits logits (mirrors joint_schema_model.question_options)."""
    qtype = str(question["type"])
    if qtype == "noul":
        return ["true", "false"]
    if qtype == "choice":
        return sorted(str(k) for k in question["criteria"].keys())
    return [str(i) for i in range(len(question["criteria"]))]


def label_index(question: dict, label, options: list[str]) -> int:
    """Resolve a teacher's label to the index of the correct option among `options`."""
    qtype = str(question["type"])
    if qtype == "noul":
        truthy = label is True or str(label).strip().lower() in ("true", "yes", "1", "t", "y")
        return 0 if truthy else 1  # options == ["true", "false"]
    if qtype == "choice":
        return options.index(str(label))
    # score: an integer index, a numeric string, or the option description text.
    try:
        return int(label)
    except (TypeError, ValueError):
        criteria = [str(c) for c in question["criteria"]]
        return criteria.index(str(label))


def load_facts(job: dict, out_dir: Path) -> list[dict]:
    rows = job.get("facts")
    if not rows and job.get("facts_file"):
        path = out_dir / job["facts_file"]
        rows = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
    parsed: list[dict] = []
    for i, row in enumerate(rows or []):
        try:
            req = json.loads(row["prompt"]) if isinstance(row.get("prompt"), str) else row.get("prompt")
            ans = json.loads(row["answer"]) if isinstance(row.get("answer"), str) else row.get("answer")
            if not isinstance(req, dict) or "state" not in req or not isinstance(req.get("questions"), dict):
                raise ValueError("prompt must be JSON {state, questions}")
            if not isinstance(ans, dict) or not ans:
                raise ValueError("answer must be JSON {qid: label}")
            parsed.append({"fact": i, "state": req["state"], "questions": req["questions"], "labels": ans,
                           "images": req.get("images"), "videos": req.get("videos")})
        except Exception as e:  # a bad row is skipped, not fatal, unless none survive
            emit("skip", fact=i, reason=str(e))
    return parsed


def record_of(fact: dict) -> dict:
    rec = {"state": fact["state"], "questions": fact["questions"]}
    if fact.get("images"):
        rec["images"] = fact["images"]
    if fact.get("videos"):
        rec["videos"] = fact["videos"]
    return rec


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--job", required=True)
    ap.add_argument("--devices", default="cuda:0")
    args = ap.parse_args()

    device = args.devices.split(",")[0].strip() or "cuda:0"
    job_path = Path(args.job)
    out_dir = job_path.parent
    npz_path = out_dir / "lesson.npz"
    recipe_path = out_dir / "recipe.json"

    try:
        job = json.loads(job_path.read_text())
    except Exception as e:
        emit("error", message=f"bad job.json: {e}")
        return 1

    model_id = (job.get("model") or {}).get("id_M") or os.environ.get("SERVED_MODEL_NAME", "clef-flash")
    model_path = os.environ.get("CLEF_MODEL_PATH") or model_id
    if not Path(str(model_path)).is_dir() and "/" not in str(model_path):
        model_path = f"Cloudflare/{model_path}"  # a bare id like "clef-flash" -> the HF repo

    max_steps = int(job.get("max_steps") or 20)
    lr = float(job.get("lr") or 5e-4)
    micro = max(1, int(job.get("micro") or 4))
    eval_sample = job.get("eval_sample") or {}
    eval_n = int(eval_sample.get("n") or 0)

    facts = load_facts(job, out_dir)
    if not facts:
        emit("error", message="no usable decision facts: each needs prompt=JSON{state,questions} and answer=JSON{qid:label}")
        return 1

    t0 = time.time()
    # The model ships its own loader + head; import it from the snapshot like the sidecar does.
    from huggingface_hub import snapshot_download
    path = model_path if Path(str(model_path)).is_dir() else snapshot_download(str(model_path))
    sys.path.insert(0, str(path))
    from joint_schema_model import load_release_model, collate_records  # type: ignore

    model, processor = load_release_model(path, device=device)
    tokenizer = processor.tokenizer
    pad_id = tokenizer.pad_token_id if tokenizer.pad_token_id is not None else tokenizer.eos_token_id

    # Freeze the backbone; train the head only. The head is the lesson.
    for p in model.language_model.parameters():
        p.requires_grad_(False)
    for p in model.head.parameters():
        p.requires_grad_(True)
    model.head.train()

    base_model = model.language_model.get_base_model() if hasattr(model.language_model, "get_base_model") else model.language_model
    text_model = base_model.model
    emb_weight = base_model.get_output_embeddings().weight

    def forward_logits(records):
        """ClefModel.forward, but the frozen backbone runs under no_grad so only the head accumulates gradients."""
        encoded = [__import__("joint_schema_model").encode_record(tokenizer, record_of(f), processor=processor) for f in records]
        batch = collate_records(encoded, pad_id, torch.device(device))
        media = batch.get("media") or {}
        tm = text_model
        if not media and hasattr(tm, "language_model"):
            tm = tm.language_model
        with torch.no_grad():
            outputs = tm(input_ids=batch["input_ids"], attention_mask=batch["attention_mask"],
                         use_cache=False, return_dict=True, **media)
        hidden = outputs.last_hidden_state.detach()
        logits = model.head(hidden, batch["input_ids"], batch["attention_mask"], batch["records"], emb_weight)
        return encoded, logits

    def targets_for(fact: dict):
        out = []
        for qid, q in fact["questions"].items():
            opts = option_ids_for(q)
            out.append(label_index(q, fact["labels"].get(qid), opts))
        return out

    optim = torch.optim.Adam([p for p in model.head.parameters() if p.requires_grad], lr=lr)
    emit("load", secs=round(time.time() - t0, 1), rows=len(facts), model=model_id)

    def evaluate(sample: list[dict]):
        model.head.eval()
        hits = total = 0
        per_fact = []
        with torch.no_grad():
            for f in sample:
                _, logits = forward_logits([f])
                tgts = targets_for(f)
                ok = 0
                picks = {}
                for q_logits, tgt, (qid, q) in zip(logits[0], tgts, f["questions"].items()):
                    pred = int(q_logits.float().argmax().item())
                    ok += int(pred == tgt)
                    picks[qid] = option_ids_for(q)[pred]
                hits += ok
                total += len(tgts)
                per_fact.append({"fact": f["fact"], "hits": ok, "total": len(tgts),
                                 "heldout": 0, "heldout_total": 0,
                                 "after_answer": json.dumps(picks, ensure_ascii=False)})
        model.head.train()
        return hits, total, per_fact

    import random
    rng = random.Random(1234)
    order = list(range(len(facts)))
    try:
        for step in range(1, max_steps + 1):
            s0 = time.time()
            rng.shuffle(order)
            batch = [facts[i] for i in order[:micro]]
            encoded, logits = forward_logits(batch)
            losses = []
            hits = total = 0
            for rec_logits, f in zip(logits, batch):
                tgts = targets_for(f)
                for q_logits, tgt in zip(rec_logits, tgts):
                    losses.append(F.cross_entropy(q_logits.float().unsqueeze(0),
                                                  torch.tensor([tgt], device=q_logits.device)))
                    hits += int(q_logits.float().argmax().item() == tgt)
                    total += 1
            loss = torch.stack(losses).mean()
            optim.zero_grad(set_to_none=True)
            loss.backward()
            optim.step()
            emit("step", step=step, max_steps=max_steps, loss=round(float(loss.item()), 4),
                 hits=hits, total=total, rows_touched=len(batch), secs=round(time.time() - s0, 2))

            if eval_n and (step % max(1, max_steps // 4) == 0 or step == max_steps):
                sample = facts if eval_n >= len(facts) else [facts[i] for i in rng.sample(range(len(facts)), eval_n)]
                eh, et, pf = evaluate(sample)
                emit("eval", hits=eh, total=et, facts=pf, sampled={"n": len(sample), "of": len(facts)})
    except Exception as e:
        emit("error", message=f"training failed: {e}\n{traceback.format_exc()[-800:]}")
        return 1

    # Final pass over all facts for the done event, then export the trained head.
    fh, ft, final_facts = evaluate(facts)
    for pf in final_facts:
        pf["hit"] = pf["hits"] == pf["total"]

    try:
        arrays = {k: v.detach().float().cpu().numpy() for k, v in model.head.state_dict().items()}
        # The node's BlobStore treats a lesson.npz as a knowledge patch and requires an `addrs`
        # member (plus before/after). A Clef lesson is a trained joint head, not PLE memory rows, so
        # it carries an EMPTY patch envelope — nothing for the node to apply — while the head weights
        # ride along under their own keys. The serving sidecar's HEAD_OVERRIDE reads the head keys and
        # ignores addrs/before/after; nothing ever applies the empty rows (this node has no PLE runtime).
        # One trivial no-op row (addr 0, before == after) rather than an empty set: the node stores a
        # non-null address set for every blob, and before == after means applying it changes nothing
        # even if some PLE runtime ever did (this decision node never applies it).
        envelope = {
            "addrs": np.zeros((1,), dtype=np.int64),
            "before": np.zeros((1, 1), dtype=np.float32),
            "after": np.zeros((1, 1), dtype=np.float32),
        }
        np.savez(npz_path, **envelope, **arrays)
        recipe = {
            "trainer": "clef_teach", "status": "ok", "model": {"id_M": model_id, "path": str(path)},
            "head": {"params": sum(int(a.size) for a in arrays.values()), "tensors": len(arrays)},
            "hp": {"max_steps": max_steps, "lr": lr, "micro": micro},
            "rows": len(facts), "final_hits": fh, "final_total": ft,
            "export": "head", "artifact": str(npz_path),
        }
        recipe_path.write_text(json.dumps(recipe, ensure_ascii=False, indent=1))
    except Exception as e:
        emit("error", message=f"export failed: {e}")
        return 1

    emit("done", rows=len(facts), sentences=ft, hits=fh, total=ft, facts=final_facts, export="head")
    return 0


if __name__ == "__main__":
    sys.exit(main())
