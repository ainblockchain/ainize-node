/**
 * Teach mode — what the visitor downloads next to the knowledge file (spec §10):
 *   recipe.json     the trainer's recipe (facts, exact sentences, benchmark samples, contrast, held-out, hyper-params,
 *                   model identity, probe results) plus the node-side lesson block
 *   RUN-LOCALLY.md  the "only me" instructions, rendered server-side with the lesson's identifiers filled in
 */
import type { BenchmarkSpec, PatchRecipe } from '@ngram/core';

/** Shape of `recipe.json` as written by `train/teach.py` (PR-4); every field is optional because the stub writes a subset. */
export interface TrainerRecipe {
  version?: number;
  trainer?: string;
  status?: string;
  facts?: { prompt: string; answer: string; alt_prompt?: string }[];
  sentences?: { kind: string; fact: number; prefix: string; target: string; n_tokens?: number; n_answer_tokens?: number; is_target?: boolean }[];
  /** Authoritative benchmark samples: the exact trained `Q:/A:` prefix and the stripped answer. */
  benchmark_samples?: { prompt: string; expect: string }[];
  contrast?: unknown[];
  heldout?: { kind: string; fact: number; prompt: string; prefix: string }[];
  hyper_params?: Record<string, unknown>;
  model?: Record<string, unknown>;
  probes?: Record<string, unknown>;
  rows?: number;
  mean_delta_norm?: number;
  load_s?: number;
  train_s?: number;
  step?: number;
  converged?: boolean;
  created_at?: number;
  /** Lineage (design §7.5): the stack the trainer loaded before step 1, what it exported and the pre-state hash. */
  parents?: { patch_id: string; sha256: string; rows: number; loaded?: boolean }[];
  export?: 'delta' | 'squash';
  pre_state_sha256?: string;
  fact_addrs?: Record<number, number[]>;
  known_used?: number;
  [k: string]: unknown;
}

export interface LessonMeta {
  job_id: string;
  draft_id: string | null;
  name: string;
  model_id: string;
  sha256: string;
  rows: number;
  size_bytes: number;
  filename: string;
  facts: { prompt: string; answer: string; alt_prompt?: string; hit?: boolean; heldout_hit?: boolean }[];
  contributor: { address: string; name?: string };
  context_patch_ids: string[];
  builds_on_context: boolean;
  /** What this lesson was trained from — the sha256 makes the run reproducible from the teacher's own copy. */
  dataset?: { sha256: string; rows: number; revision: number; source: string; name?: string; trained_rows: number };
  checks: unknown;
  created_at: number;
  node: { address: string; name: string; url: string };
}

/**
 * The anchor's `recipe` field (kept small — sentences and contrast go to recipe.json / the blob, never on-chain).
 * `dataset` is hash-only: enough for a buyer to verify that a re-train used the same input, never the input itself.
 */
export function anchorRecipe(tr: TrainerRecipe, modelId: string, probe: { hits: number; total: number; heldout_hits?: number }, dataset?: PatchRecipe['dataset']): PatchRecipe {
  const sentences = (tr.sentences ?? []).filter((s) => s.is_target !== false).map((s) => `${s.prefix}${s.target}`);
  return {
    corpus_template: 'Q: {prompt}\nA: {answer}',
    hyperparams: tr.hyper_params ?? {},
    sentences: sentences.slice(0, 32),
    contrast: (tr.contrast ?? []).map((c) => (typeof c === 'string' ? c : JSON.stringify(c))).slice(0, 8),
    held_out: (tr.heldout ?? []).map((h) => h.prompt).slice(0, 8),
    model_id: modelId,
    probe,
    ...(dataset ? { dataset } : {}),
    // lineage (design §5.1): ids and hashes only — `fact_addrs` stays in recipe.json
    ...(tr.parents?.length ? { parents: tr.parents.map((p) => ({ patch_id: p.patch_id, sha256: p.sha256, rows: p.rows, ...(p.loaded !== undefined ? { loaded: p.loaded } : {}) })) } : {}),
    ...(tr.export ? { export: tr.export } : {}),
    ...(tr.pre_state_sha256 ? { pre_state_sha256: tr.pre_state_sha256 } : {}),
  };
}

/** Benchmark spec of a taught lesson: unique schema per lesson so `reconcileSupersedes` never demotes curated listings. */
export function lessonBenchmark(schema: string, samples: { prompt: string; expect: string }[]): BenchmarkSpec {
  const seen = new Set<string>();
  const uniq = samples.filter((s) => { const k = `${s.prompt}\u0000${s.expect}`; if (seen.has(k)) return false; seen.add(k); return true; });
  return { schema, queries: uniq.length, format: ['template', 'chat'], collateral_bound_nat: 0.08, samples: uniq };
}

/** recipe.json served to the visitor = trainer recipe + node-side lesson block. */
export function buildRecipeJson(tr: TrainerRecipe, lesson: LessonMeta, benchmark: BenchmarkSpec): Record<string, unknown> {
  return { ...tr, lesson, benchmark, model_id: lesson.model_id };
}

/** Repository the RUN-LOCALLY recipe clones (one source of truth for the markdown, the save response and the web sheet). */
export const LOCAL_RUN_REPO_URL = 'git@github.com:GenAI-Leader-Finance-ComCom/finance-knowledge-training-demo.git';

export interface RunLocallyInput {
  model_id: string;
  sha256: string;
  filename: string;
  download_url: string;
  recipe_url: string;
  first_prompt: string;
  slug: string;
  parents: { id: string; name: string }[];
  /** true when `parents` is the base stack the file was trained on top of (a delta): they MUST be loaded first, in order. */
  parents_required?: boolean;
  repo_url?: string;
}

/** RUN-LOCALLY.md (spec §10) — English; the `patch.py status` line is the English `applied: yes` line PR-4 added next to the Korean one. */
export function renderRunLocally(i: RunLocallyInput): string {
  const q = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
  const repo = i.repo_url ?? LOCAL_RUN_REPO_URL;
  const names = i.parents.map((p) => `"${p.name}" (${p.id})`).join(', ');
  /**
   * An add-on is not a file you can run (design §8, SC-15). Its rows start from the table state its bases leave
   * behind, so the instructions have to say that BEFORE the download, not in a footnote after Option C — and they
   * have to show the loading ORDER and how to take it apart again. The journal is what makes the second half true:
   * `remove` replays the value the hook returned when the add-on went on, so the base is still there afterwards.
   */
  const stackHead = i.parents.length && i.parents_required
    ? `\n> **This is an add-on.** It was trained ON TOP OF ${names}, and it only means anything with ${i.parents.length > 1 ? 'those knowledges' : 'that knowledge'} loaded underneath, in this order:
> ${[...i.parents.map((p) => p.id), i.slug ? `taught-${i.slug}` : 'this file'].join(' → ')}.
> Get ${i.parents.length > 1 ? 'them' : 'it'} first — on a node, \`ainize patch buy <id> --bundle\` takes one knowledge and everything under it in one go.\n`
    : '';
  const stackSteps = i.parents.length && i.parents_required
    ? `\n## Loading it on top of ${names}

The order is the point: the base goes on first, then this file. \`--journal\` records what each write replaced, so
removing this add-on puts the base back instead of the bare model, and \`--verify-before\` refuses to write at all
unless the rows underneath are the ones it was trained against.

\`\`\`bash
${i.parents.map((p) => `python3 scripts/patch.py apply <${p.id}.npz> --journal ${p.id}.journal.npz`).join('\n')}
python3 scripts/patch.py apply ${i.filename} --journal this.journal.npz --verify-before   # refuses if the base is not underneath
python3 scripts/patch.py remove ${i.filename} --journal this.journal.npz                  # the base stays loaded
\`\`\`

Through your own node the same thing is two lines — it takes the whole stack under one lock and refuses to load an
add-on onto the wrong table:

\`\`\`bash
ainize patch buy ${i.parents[0].id} --bundle       # the knowledge under this one, and anything under IT
ainize patch import ./${i.filename} --recipe ./recipe.json
ainize patch apply taught-${i.slug} --with-base    # ${i.parents.map((p) => p.id).join(', ')} first, then this
ainize patch stack                                 # what is on the model, bottom first
ainize patch remove taught-${i.slug}               # take it off; the base is left standing
\`\`\`
`
    : '';
  const parentsNote = i.parents.length && !i.parents_required
    ? `\nThis lesson was taught with ${names} loaded; load them first for the same behaviour.\n`
    : '';
  return `# Run this knowledge yourself
${stackHead}
Works only with the exact model this node serves: ${i.model_id} (same checkpoint hash and tokenizer).
Hardware: 2× 40 GB GPUs (TP=2, 8K context) or 4× 40 GB (TP=4, full context) or 1× 80 GB-class GPU;
~110 GB host RAM when the memory table is CPU-offloaded; ~170 GB disk. Docker with NVIDIA runtime; Python 3.
There is no llama.cpp / laptop path today.

File: \`${i.filename}\` · sha256 \`${i.sha256}\`
Recipe: \`recipe.json\` (${i.recipe_url})

## Option A — live switch (recommended, reversible)

\`\`\`bash
git clone ${repo} qwen3.8 && cd qwen3.8
cp .env.example .env                       # SUDO_PW only if your docker needs sudo
pip install numpy safetensors tokenizers
./pull.sh                                  # vllm/vllm-openai:qwen38-flash-next
# put the checkpoint at $MODEL_DIR (${i.model_id}, 168 GB)
ENGRAM_HOOK=1 MODEL_DIR=$MODEL_DIR GPUS='"device=0,1"' TP=2 MAXLEN=8192 MAXSEQS=8 MTP=0 ./serve.sh
#   4 GPUs: ENGRAM_HOOK=1 MODEL_DIR=$MODEL_DIR ./serve.sh
until curl -sf localhost:8000/v1/models >/dev/null; do sleep 10; done
curl -L -o ${i.filename} "${i.download_url}"
sha256sum ${i.filename}                       # expect ${i.sha256}
python3 scripts/patch.py info   ${i.filename}
python3 scripts/patch.py apply  ${i.filename}  # about 2 s
python3 scripts/patch.py status ${i.filename}  # must print "applied: yes" (the Korean line reads 학습값(끼워짐))
curl -s localhost:8000/v1/chat/completions -H 'content-type: application/json' -d '{
  "model":"<id from /v1/models>","messages":[{"role":"user","content":"${q(i.first_prompt)}"}],
  "max_tokens":64,"temperature":0,"chat_template_kwargs":{"enable_thinking":false}}'
# raw form that was trained:
curl -s localhost:8000/v1/completions -H 'content-type: application/json' -d '{"model":"<id from /v1/models>","prompt":"Q: ${q(i.first_prompt)}\\nA: ","max_tokens":16,"temperature":0}'
nohup python3 scripts/patch_watchdog.py ${i.filename} &   # the table reverts on server restart; this re-applies
python3 scripts/patch.py remove ${i.filename}             # undo
\`\`\`

## Option B — through your own Ainize node

\`\`\`bash
ainize init && ainize start                 # runtime.api → your vLLM from Option A, runtime.repo → ./qwen3.8
ainize patch import ./${i.filename} --recipe ./recipe.json   # private DRAFT on your node, no ledger record
ainize patch apply taught-${i.slug}            # ainize chat taught-${i.slug} "<question>" compares before/after
ainize patch remove taught-${i.slug}
\`\`\`

## Option C — bake into a model copy (no hook; another 168 GB; never touch your reference checkpoint)

\`\`\`bash
cp -r $MODEL_DIR $MODEL_DIR-taught
ENGRAM_MODEL_DIR=$MODEL_DIR-taught python3 -c 'import numpy as np; from engram.core import write_rows; z=np.load("${i.filename}"); write_rows(z["addrs"], z["after"], dry_run=False)'
MODEL_DIR=$MODEL_DIR-taught ENGRAM_HOOK=0 ./serve.sh
\`\`\`

## Tips

Ask in the form you taught (chat with thinking off, or "Q: …\\nA: "). Very different phrasings may not fire —
that is a property of the memory-table method. \`patch.py status\` tells you whether the lesson is loaded
(\`applied: yes\` / \`applied: no\`).
${parentsNote}${stackSteps}`;
}
