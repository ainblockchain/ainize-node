#!/usr/bin/env python3
"""Fine-tune a Cloudflare Clef decision model from a Teach job — for real.

Unlike a head-only pass, this adapts the model itself: LoRA adapters on the Qwen3.8 backbone's
attention and MLP projections ARE trained together with the joint schema head, so the model's
representation shifts, not only the decision mapping. The base backbone weights stay frozen (LoRA
is ~0.15% of params), which keeps the lesson small and one GPU enough (clef-flash ~22 GB with
gradient checkpointing; clef 27B fits one A100 80 GB the same way).

The node launches it exactly like the PLE trainer and it speaks the same stdout JSON-lines protocol
(load/step/eval/done/error) and writes the same two artifacts next to job.json: `lesson.npz` (the
trained LoRA adapter + head + a tiny no-op knowledge-patch envelope the node's BlobStore requires)
and `recipe.json`. The serving sidecar re-applies the LoRA and the head through its HEAD_OVERRIDE.

A Teach "fact" carries the demonstration as two JSON strings so the whole dataset/job pipeline works
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

LORA_TARGETS = ["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"]


def emit(event: str, **fields) -> None:
    sys.stdout.write(json.dumps({"event": event, **fields}, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def option_ids_for(question: dict) -> list[str]:
    qtype = str(question["type"])
    if qtype == "noul":
        return ["true", "false"]
    if qtype == "choice":
        return sorted(str(k) for k in question["criteria"].keys())
    return [str(i) for i in range(len(question["criteria"]))]


def label_index(question: dict, label, options: list[str]) -> int:
    qtype = str(question["type"])
    if qtype == "noul":
        truthy = label is True or str(label).strip().lower() in ("true", "yes", "1", "t", "y")
        return 0 if truthy else 1
    if qtype == "choice":
        return options.index(str(label))
    try:
        return int(label)
    except (TypeError, ValueError):
        return [str(c) for c in question["criteria"]].index(str(label))


def load_facts(job: dict, out_dir: Path) -> list[dict]:
    rows = job.get("facts")
    if not rows and job.get("facts_file"):
        rows = [json.loads(l) for l in (out_dir / job["facts_file"]).read_text().splitlines() if l.strip()]
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
        except Exception as e:
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
    npz_path, recipe_path = out_dir / "lesson.npz", out_dir / "recipe.json"

    try:
        job = json.loads(job_path.read_text())
    except Exception as e:
        emit("error", message=f"bad job.json: {e}"); return 1

    model_id = (job.get("model") or {}).get("id_M") or os.environ.get("SERVED_MODEL_NAME", "clef-flash")
    model_path = os.environ.get("CLEF_MODEL_PATH") or model_id
    if not Path(str(model_path)).is_dir() and "/" not in str(model_path):
        model_path = f"Cloudflare/{model_path}"
    max_steps = int(job.get("max_steps") or 20)
    lr = float(job.get("lr") or 1e-4)
    micro = max(1, int(job.get("micro") or 2))
    lora_r = int(job.get("lora_r") or os.environ.get("CLEF_LORA_R", 16))
    lora_alpha = int(job.get("lora_alpha") or os.environ.get("CLEF_LORA_ALPHA", 32))
    eval_n = int((job.get("eval_sample") or {}).get("n") or 0)

    facts = load_facts(job, out_dir)
    if not facts:
        emit("error", message="no usable decision facts: each needs prompt=JSON{state,questions} and answer=JSON{qid:label}")
        return 1

    t0 = time.time()
    from huggingface_hub import snapshot_download
    path = model_path if Path(str(model_path)).is_dir() else snapshot_download(str(model_path))
    sys.path.insert(0, str(path))
    from joint_schema_model import load_release_model  # type: ignore
    model, processor = load_release_model(path, device=device)
    tokenizer = processor.tokenizer

    # --- real fine-tuning: LoRA on the backbone + the joint schema head ---
    from peft import LoraConfig, get_peft_model
    base = model.language_model.get_base_model() if hasattr(model.language_model, "get_base_model") else model.language_model
    present = {n.split(".")[-1] for n, m in base.named_modules() if isinstance(m, torch.nn.Linear)}
    targets = [t for t in LORA_TARGETS if t in present] or ["q_proj", "v_proj"]
    lora_cfg = LoraConfig(r=lora_r, lora_alpha=lora_alpha, target_modules=targets, lora_dropout=0.0, bias="none")
    model.language_model = get_peft_model(model.language_model, lora_cfg)
    for n, p in model.language_model.named_parameters():
        p.requires_grad_("lora_" in n)
    for p in model.head.parameters():
        p.requires_grad_(True)
    # train through the frozen backbone cheaply: checkpoint activations, and let grad reach the LoRA inputs
    try:
        gb = model.language_model.get_base_model()
        gb.gradient_checkpointing_enable()
        gb.enable_input_require_grads()
    except Exception as e:
        emit("skip", fact=-1, reason=f"gradient_checkpointing unavailable: {e}")
    model.head.train()

    def targets_for(fact):
        return [label_index(q, fact["labels"].get(qid), option_ids_for(q)) for qid, q in fact["questions"].items()]

    def forward_logits(batch_facts):
        import joint_schema_model as J  # type: ignore
        enc = [J.encode_record(tokenizer, record_of(f), processor=processor) for f in batch_facts]
        return model(J.collate_records(enc, tokenizer.pad_token_id, torch.device(device)))

    trainable = [p for p in model.language_model.parameters() if p.requires_grad] + list(model.head.parameters())
    n_lora = sum(p.numel() for n, p in model.language_model.named_parameters() if p.requires_grad)
    n_head = sum(p.numel() for p in model.head.parameters())
    optim = torch.optim.AdamW(trainable, lr=lr)
    emit("load", secs=round(time.time() - t0, 1), rows=len(facts), model=model_id,
         lora={"r": lora_r, "alpha": lora_alpha, "targets": targets, "params": int(n_lora)}, head_params=int(n_head))

    def evaluate(sample):
        model.head.eval()
        hits = total = 0
        per = []
        with torch.no_grad():
            for f in sample:
                logits = forward_logits([f])[0]
                tg = targets_for(f)
                ok = 0
                picks = {}
                for ql, t, (qid, q) in zip(logits, tg, f["questions"].items()):
                    pred = int(ql.float().argmax().item()); ok += int(pred == t)
                    picks[qid] = option_ids_for(q)[pred]
                hits += ok; total += len(tg)
                per.append({"fact": f["fact"], "hits": ok, "total": len(tg), "heldout": 0, "heldout_total": 0,
                            "after_answer": json.dumps(picks, ensure_ascii=False)})
        model.head.train()
        return hits, total, per

    import random
    rng = random.Random(1234)
    order = list(range(len(facts)))
    try:
        for step in range(1, max_steps + 1):
            s0 = time.time()
            rng.shuffle(order)
            batch = [facts[i] for i in order[:micro]]
            logits = forward_logits(batch)
            losses, hits, total = [], 0, 0
            for rec_logits, f in zip(logits, batch):
                for ql, t in zip(rec_logits, targets_for(f)):
                    losses.append(F.cross_entropy(ql.float().unsqueeze(0), torch.tensor([t], device=ql.device)))
                    hits += int(ql.float().argmax().item() == t); total += 1
            loss = torch.stack(losses).mean()
            optim.zero_grad(set_to_none=True)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(trainable, 1.0)
            optim.step()
            emit("step", step=step, max_steps=max_steps, loss=round(float(loss.item()), 4),
                 hits=hits, total=total, rows_touched=len(batch), secs=round(time.time() - s0, 2))
            if eval_n and (step % max(1, max_steps // 4) == 0 or step == max_steps):
                sample = facts if eval_n >= len(facts) else [facts[i] for i in rng.sample(range(len(facts)), eval_n)]
                eh, et, pf = evaluate(sample)
                emit("eval", hits=eh, total=et, facts=pf, sampled={"n": len(sample), "of": len(facts)})
    except Exception as e:
        emit("error", message=f"training failed: {e}\n{traceback.format_exc()[-800:]}"); return 1

    fh, ft, final = evaluate(facts)
    for pf in final:
        pf["hit"] = pf["hits"] == pf["total"]

    try:
        from peft import get_peft_model_state_dict
        arrays = {}
        for k, v in model.head.state_dict().items():
            arrays[f"head.{k}"] = v.detach().float().cpu().numpy()
        for k, v in get_peft_model_state_dict(model.language_model).items():
            arrays[f"lora.{k}"] = v.detach().float().cpu().numpy()
        arrays["lora_config"] = np.frombuffer(
            json.dumps({"r": lora_r, "lora_alpha": lora_alpha, "target_modules": targets}).encode(), dtype=np.uint8)
        # one trivial no-op row so the node's BlobStore accepts the file as a knowledge patch
        arrays["addrs"] = np.zeros((1,), dtype=np.int64)
        arrays["before"] = np.zeros((1, 1), dtype=np.float32)
        arrays["after"] = np.zeros((1, 1), dtype=np.float32)
        np.savez(npz_path, **arrays)
        recipe_path.write_text(json.dumps({
            "trainer": "clef_teach", "status": "ok", "export": "lora+head",
            "model": {"id_M": model_id, "path": str(path)},
            "lora": {"r": lora_r, "alpha": lora_alpha, "targets": targets, "params": int(n_lora)},
            "head": {"params": int(n_head)}, "hp": {"max_steps": max_steps, "lr": lr, "micro": micro},
            "rows": len(facts), "final_hits": fh, "final_total": ft, "artifact": str(npz_path),
        }, ensure_ascii=False, indent=1))
    except Exception as e:
        emit("error", message=f"export failed: {e}\n{traceback.format_exc()[-500:]}"); return 1

    emit("done", rows=len(facts), sentences=ft, hits=fh, total=ft, facts=final, export="lora+head")
    return 0


if __name__ == "__main__":
    sys.exit(main())
