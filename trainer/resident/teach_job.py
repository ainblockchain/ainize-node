#!/usr/bin/env python3
"""One teach job on the resident model (reloaded by teach_server.py before every job, so edits here apply to the next job)."""
import json, os, random, sys, time, traceback
sys.path.insert(0, "/work/train")
import teach  # noqa: E402

CONTRAST_CACHE = {}   # prefix -> got  (filled by the server; survives reloads because the server re-injects it)


def probe_fast(model, tok, items, device, tag="", log=None):
    """teach.probe() semantics, but prompts with the SAME token length are generated as one batch (no padding —
    the linear-attention layers and the n-gram hook must see exactly the unpadded sequence)."""
    import torch
    from teach import is_hit, PROBE_TOKENS
    enc = {}
    for i, it in enumerate(items):
        ids = tok(it["prefix"], add_special_tokens=False).input_ids
        enc.setdefault(len(ids), []).append((i, ids))
    got_all = [None] * len(items)
    pad_id = tok.pad_token_id if tok.pad_token_id is not None else tok.eos_token_id
    with torch.no_grad():
        for L, group in sorted(enc.items()):
            for k in range(0, len(group), 8):
                chunk = group[k:k + 8]
                ids = torch.tensor([g[1] for g in chunk], dtype=torch.long, device=device)
                g = model.generate(ids, max_new_tokens=PROBE_TOKENS, do_sample=False, pad_token_id=pad_id)
                for row, (i, _) in enumerate(chunk):
                    got_all[i] = tok.decode(g[row, L:], skip_special_tokens=True)
    res = []
    for it, got in zip(items, got_all):
        hit = is_hit(it["kind"], got, it["answer"])
        res.append(dict(kind=it["kind"], fact=it["fact"], prompt=it["prompt"], answer=it["answer"], got=got, hit=hit))
        if log: log(f"    {tag}{'O' if hit else 'X'} [{it['kind']:5s}] {it['prompt'][:40]!r} -> {got[:40]!r}")
    return res


# 부수효과 게이트가 재는 무관 프롬프트 (ainize-core DEFAULT_LOCALITY_PROMPTS 와 동일). 이 프롬프트들이 읽는 행은 갱신하지 않는다.
LOCALITY_PROMPTS = [
    'What is the capital of France?', 'Write one sentence about the ocean.', 'Translate "good morning" into Spanish.',
    'What is 17 + 25?', 'Name three primary colors.', 'Write a Python function that returns the square of a number.',
    'What year did the first human land on the Moon?', 'Summarize the water cycle in one sentence.',
    'What is the chemical symbol for gold?', 'List the days of the week.', '대한민국의 수도는 어디입니까?', '1부터 10까지 더하면 얼마입니까?',
]
PROTECT_CACHE = {}   # prefix text -> set(addr)  (re-injected by the server)


def protected_rows(model, tok, rows, prefixes, device):
    """Union of PLE row addresses read while running each prefix (chat/qa renderings of unrelated + contrast prompts).
    Training then leaves these rows untouched (pinpoint), so the unrelated answers stay bit-identical."""
    import torch
    out = set()
    with torch.no_grad():
        for p in prefixes:
            if p in PROTECT_CACHE: out |= PROTECT_CACHE[p]; continue
            ids = tok(p, return_tensors="pt", add_special_tokens=False).input_ids.to(device)
            rows.begin_step()
            try:
                model(input_ids=ids, use_cache=False)
                addrs = set(rows.active_addrs.tolist()) if rows.active_addrs is not None else set()
            finally:
                rows.end_step()
            PROTECT_CACHE[p] = addrs; out |= addrs
    return out


def run_job(req, model, tok, rows, load_s, devices, model_dir):
    """One teach job with the resident model. Returns the exit code. Mirrors teach.main()'s real run."""
    import numpy as np, torch, torch.nn.functional as F
    from teach import emit, log, render, probe_one, probe, build_corpus, build_heldout, collate, LazyAdam, \
        load_job, chown_like, model_identity, write_recipe, is_hit, Cancelled
    job_path, out_dir = req["job"], req.get("out") or os.path.dirname(os.path.abspath(req["job"]))
    dev0 = devices[0]
    cancel_flag = os.path.join(out_dir, ".resident.cancel")
    def check_cancel():
        if os.path.exists(cancel_flag): raise Cancelled("cancel flag")
    t_start = time.time()
    try:
        facts, contrast, hp, job = load_job(job_path)
    except Exception as e:
        emit("error", message=f"bad job.json: {e}"); return 1
    pad = tok.pad_token_id if tok.pad_token_id is not None else tok.eos_token_id
    # 전배치 갱신(loss/len(batches))이라 마이크로배치 크기는 수학적으로 결과에 무관 → 크게 잡아 스텝 시간을 줄인다
    hp["micro"] = max(hp["micro"], int(os.environ.get("TEACH_MICRO", "32")))
    emit("load", secs=round(load_s, 1), resident=True)
    ident = model_identity(model_dir, job)
    ident.update(ple_rows=int(rows.table.shape[0]), row_dim=int(rows.table.shape[1]))
    original = {}
    probes = {}
    npz_path = os.path.join(out_dir, "lesson.npz"); recipe_path = os.path.join(out_dir, "recipe.json")
    os.makedirs(out_dir, exist_ok=True)
    seqs, contrast_used, heldout = [], [], []

    def export(status, extra=None):
        if original:
            addrs = np.array(sorted(original), dtype=np.int64)
            before = np.stack([original[x].float().numpy() for x in addrs]).astype(np.float32)
            after = rows.table[torch.from_numpy(addrs)].float().numpy().astype(np.float32)
            np.savez(npz_path, addrs=addrs, before=before, after=after)
            n = len(addrs); delta = float(np.linalg.norm(after - before, axis=1).mean())
        else:
            n, delta = 0, 0.0
        write_recipe(recipe_path, facts, seqs, heldout, contrast_used, hp, ident, probes, status,
                     dict(rows=n, mean_delta_norm=delta, npz=npz_path if original else None, load_s=round(load_s, 1), resident=True, **(extra or {})))
        chown_like(job_path, npz_path, recipe_path)
        return n

    code = 0
    try:
        log("== contrast probe ==")
        for c in contrast:
            if len(contrast_used) >= hp["max_contrast"]: break
            check_cancel()
            r = render(tok, "qa", c["prompt"], c["answer"])
            if r is None: continue
            if r[0] in CONTRAST_CACHE: got = CONTRAST_CACHE[r[0]]
            else: got = CONTRAST_CACHE[r[0]] = probe_one(model, tok, r[0], dev0)
            ok = is_hit("qa", got, c["answer"])
            log(f"    {'O' if ok else 'X'} {c['prompt'][:40]!r} -> {got[:30]!r}")
            if ok: contrast_used.append(dict(c, got=got))
        if not contrast_used: log("warning: no contrast pair survived probing; shared rows are unprotected")

        seqs, skipped = build_corpus(tok, facts, contrast_used)
        heldout = build_heldout(tok, facts)
        target_items = [s for s in seqs if s["is_target"]]
        if not target_items:
            emit("error", message="no fact rendering survived tokenization: " + json.dumps(skipped, ensure_ascii=False)); return 1
        n_t = len(target_items); n_c = len(seqs) - n_t
        log(f"corpus {len(seqs)} sentences (target {n_t}, contrast {n_c}), held-out {len(heldout)}, skipped {len(skipped)}")

        from teach import chat_prefix
        prot_prefixes = []
        # 무관 프롬프트: 서빙 모델이 낸 기본 답(48토큰, greedy)까지 포함한 전체 경로의 행을 보호 → 답이 비트 단위로 유지된다
        base_answers = {}
        lb = "/work/.teach/_locality_base.jsonl"
        if os.path.exists(lb):
            for line in open(lb, encoding="utf-8"):
                try: o = json.loads(line); base_answers[o["prompt"]] = o["answer"]
                except Exception: pass
        for q in LOCALITY_PROMPTS:
            prot_prefixes.append(chat_prefix(tok, q) + base_answers.get(q, "")); prot_prefixes.append(f"Q: {q}\nA:")
        for sq in seqs:
            if not sq["is_target"]: prot_prefixes.append(sq["prefix"])
        protected = protected_rows(model, tok, rows, prot_prefixes, dev0)
        log(f"protected rows (unrelated/contrast prompts): {len(protected)}")

        log("== baseline ==")
        check_cancel()
        qa_items = [s for s in target_items if s["kind"] == "qa"]
        base = probe_fast(model, tok, qa_items, dev0, log=log); base_h = sum(r["hit"] for r in base)
        base_ho = probe_fast(model, tok, heldout, dev0, tag="held-out ", log=log) if heldout else []
        probes["baseline"] = dict(step=0, trained=base, heldout=base_ho)
        emit("baseline", hits=base_h, total=n_t, heldout=sum(r["hit"] for r in base_ho), heldout_total=len(heldout),
             contrast=len(contrast_used), sentences=len(seqs), skipped=skipped)
        hits, total, ho_hits = base_h, n_t, sum(r["hit"] for r in base_ho)

        opt = LazyAdam(hp["lr"], betas=hp["betas"])
        rng = random.Random(hp["seed"]); order = list(range(len(seqs)))
        success = False; last_step = 0; t_train = time.time(); step_times = []
        for step in range(1, hp["max_steps"] + 1):
            check_cancel()
            ts = time.time(); model.train(); rng.shuffle(order)
            batches = [[seqs[i] for i in order[k:k + hp["micro"]]] for k in range(0, len(order), hp["micro"])]
            acc_g, acc_r = {}, {}; tot_loss = 0.0
            for chunk in batches:
                ids, att, labels = collate(chunk, pad, dev0)
                rows.begin_step()
                out = model(input_ids=ids, attention_mask=att, use_cache=False)
                logits = out.logits[:, :-1].float(); tgt = labels[:, 1:].to(logits.device)
                loss = F.cross_entropy(logits.reshape(-1, logits.shape[-1]), tgt.reshape(-1), ignore_index=-100)
                (loss / len(batches)).backward()
                addrs, r = rows.active_addrs, rows.active_rows
                g = r.grad.detach().cpu(); rc = r.detach().cpu()
                for i, ad in enumerate(addrs.tolist()):
                    if ad in protected: continue          # pinpoint: rows read by unrelated/contrast prompts stay as they are
                    original.setdefault(ad, rc[i].clone())
                    acc_g[ad] = acc_g[ad] + g[i] if ad in acc_g else g[i].clone(); acc_r[ad] = rc[i]
                rows.end_step(); tot_loss += loss.item() / len(batches)
                del out, logits, loss, ids, att, labels
            model.zero_grad(set_to_none=True)
            addrs = torch.tensor(sorted(acc_g), dtype=torch.long)
            if len(acc_g):
                R = torch.stack([acc_r[x] for x in addrs.tolist()]); G = torch.stack([acc_g[x] for x in addrs.tolist()])
                rows.write_rows(addrs, opt.step(addrs, R, G))
            model.eval(); last_step = step
            step_s = time.time() - ts; step_times.append(step_s)
            log(f"step {step:3d} loss {tot_loss:.4f} touched {len(addrs)} cumulative {len(original)} {step_s:.1f}s")
            emit("step", step=step, max_steps=hp["max_steps"], loss=round(tot_loss, 4), hits=hits, total=total,
                 touched=len(addrs), rows=len(original), protected=len(protected), secs=round(step_s, 1))
            if step % hp["eval_every"] == 0 or step == hp["max_steps"]:
                log(f"== eval step {step} ==")
                res_ho = probe_fast(model, tok, heldout, dev0, tag="held-out ", log=log) if heldout else []
                partial = probe_fast(model, tok, qa_items, dev0, log=log)
                # 전체 렌더링 평가는 qa·held-out 이 전부 맞아 수렴 가능성이 있을 때만 (라이브 검증은 노드가 서빙 모델에서 따로 한다)
                if all(r["hit"] for r in partial) and all(r["hit"] for r in res_ho):
                    res = probe_fast(model, tok, target_items, dev0, log=log)
                else:
                    res = partial
                hits = sum(r["hit"] for r in res); total = len(res)
                ho_hits = sum(r["hit"] for r in res_ho)
                probes["last"] = dict(step=step, trained=res, heldout=res_ho)
                per_fact = [dict(fact=fi, hits=sum(r["hit"] for r in res if r["fact"] == fi),
                                 total=sum(1 for r in res if r["fact"] == fi),
                                 heldout=sum(r["hit"] for r in res_ho if r["fact"] == fi),
                                 heldout_total=sum(1 for r in res_ho if r["fact"] == fi),
                                 after_answer=next((r["got"] for r in res if r["fact"] == fi and r["kind"] == "qa"), None))
                            for fi in range(len(facts))]
                emit("eval", step=step, hits=hits, total=total, heldout=ho_hits, heldout_total=len(heldout), facts=per_fact)
                export("training", dict(step=step))
                if hits == total and ho_hits == len(heldout) and len(res) == len(target_items):
                    success = True; log(f"success at step {step}: trained {hits}/{total}, held-out {ho_hits}/{len(heldout)}"); break
        total = len(target_items)
        train_s = time.time() - t_train
        probes["steps"] = last_step
        n_rows = export("done" if success else "max_steps", dict(step=last_step, converged=success, train_s=round(train_s, 1)))
        emit("done", rows=n_rows, npz=npz_path, recipe=recipe_path, hits=hits, total=total, heldout=ho_hits, heldout_total=len(heldout),
             converged=success, steps=last_step, load_s=round(load_s, 1), train_s=round(train_s, 1),
             avg_step_s=round(sum(step_times) / max(1, len(step_times)), 1), total_s=round(time.time() - t_start, 1),
             facts=[dict(fact=fi, base_answer=next((r["got"] for r in base if r["fact"] == fi and r["kind"] == "qa"), None),
                         after_answer=next((r["got"] for r in probes.get("last", {}).get("trained", []) if r["fact"] == fi and r["kind"] == "qa"), None),
                         hit=all(r["hit"] for r in probes.get("last", {}).get("trained", []) if r["fact"] == fi),
                         heldout_hit=all(r["hit"] for r in probes.get("last", {}).get("heldout", []) if r["fact"] == fi))
                    for fi in range(len(facts))])
    except Cancelled as e:
        try: export("cancelled")
        except Exception: pass
        emit("error", message=f"cancelled ({e})"); code = 143
    except Exception as e:
        traceback.print_exc(file=sys.stderr)
        try: export("failed", dict(error=f"{type(e).__name__}: {e}"))
        except Exception: pass
        emit("error", message=f"{type(e).__name__}: {e}"); code = 1
    finally:
        # restore the pristine table for the next job (bit-exact: originals are the bf16 rows widened to fp32)
        try:
            import torch
            if original:
                addrs = torch.tensor(sorted(original), dtype=torch.long)
                rows.write_rows(addrs, torch.stack([original[x] for x in addrs.tolist()]))
                log(f"restored {len(addrs)} rows")
            model.zero_grad(set_to_none=True); model.eval()
            torch.cuda.empty_cache()
        except Exception:
            traceback.print_exc(file=sys.stderr)
    return code


