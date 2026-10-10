/** Validate a coding candidate against a product's configured gates.
 *
 * Gate execution is injected. In production each gate runs the real product check
 * (typecheck/lint/test/build/browser) in an isolated, credential-free container built from the
 * pinned base commit plus the candidate's changed files; this module owns only the orchestration
 * and the strict binding of a verdict to the exact candidate. No gate here publishes a commit,
 * deploys, or can reach release credentials, and a verdict is bound to the candidate's content so
 * it can never be reattributed to a different candidate or an older commit.
 */
import { createHash } from 'node:crypto';

const canonical = value => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
};

/** A candidate is its repository, pinned base commit, and the exact changed files. */
export function candidateDigest({ repository, base, changes }) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repository ?? '')) throw new Error('Repository required');
  if (!/^[a-f0-9]{40}$/.test(base ?? '')) throw new Error('Full base commit SHA required');
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw new Error('Candidate changes required');
  const entries = Object.entries(changes);
  if (!entries.length || entries.length > 40 || entries.some(([path, content]) =>
    !path || path.startsWith('/') || path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..')
    || typeof content !== 'string')) throw new Error('Invalid candidate files');
  return createHash('sha256').update(JSON.stringify(canonical({ repository, base, changes }))).digest('hex');
}

const GATE = /^[a-z][a-z0-9_-]{0,31}$/;

/**
 * Run the configured gates in order and return a verdict bound to the candidate digest. Stops at
 * the first failing gate: later gates add no signal to an already-failed candidate. `passed` is true
 * only when every configured gate ran and passed.
 */
export async function validateCandidate({ repository, base, changes, gates, run }) {
  if (!Array.isArray(gates) || gates.length === 0 || gates.length > 16
    || !gates.every(g => GATE.test(g)) || new Set(gates).size !== gates.length) throw new Error('Invalid gate list');
  if (typeof run !== 'function') throw new Error('A gate runner is required');
  const digest = candidateDigest({ repository, base, changes });
  // Snapshot before the first await: caller and gate code cannot change what this digest covers.
  const candidate = Object.freeze({ repository, base, changes: Object.freeze({ ...changes }) });
  const gateNames = [...gates];
  const results = [];
  for (const gate of gateNames) {
    let outcome;
    try { outcome = await run(gate, candidate); }
    catch (error) { outcome = { passed: false, summary: `gate errored: ${error?.message ?? 'unknown'}` }; }
    results.push({ gate, passed: outcome?.passed === true, summary: typeof outcome?.summary === 'string' ? outcome.summary.slice(0, 4000) : '' });
    if (!results.at(-1).passed) break;
  }
  return { candidateDigest: digest, repository, base, gates: results, passed: results.length === gateNames.length && results.every(r => r.passed) };
}

/**
 * One bounded validation step under the SQLite lease, mirroring `advanceCoding`. The host schedules
 * this once a `needs_validation` job is woken; it loads the immutable coding checkpoint, runs the
 * gates, saves an immutable verdict, and parks the job in `waiting` at `needs_publication` (all gates
 * passed) or `validation_failed` (otherwise). It never publishes, deploys, or records an approval —
 * the candidate is preserved for a human-approved release path to pick up by the exact digest.
 */
export async function advanceValidation({ jobs, claim, checkpoints, gates, run }) {
  const { job, lease } = claim;
  if (!job || job.state !== 'running' || job.checkpoint.stage !== 'needs_validation') throw new Error('Job is not awaiting validation');
  const codingRef = job.checkpoint.coding;
  if (!codingRef || codingRef.jobId !== job.id) throw new Error('No coding candidate to validate');
  const coding = checkpoints.load(codingRef);
  if (coding.repository !== job.input.repository || coding.commit !== job.input.base) {
    throw new Error('Coding candidate does not match the job repository and base');
  }
  // Validation may outlive the initial claim; refresh the lease while gates run.
  jobs.renew(job.id, lease, 120_000);
  let lost = false;
  const heartbeat = setInterval(() => { try { jobs.renew(job.id, lease, 120_000); } catch { lost = true; } }, 30_000);
  heartbeat.unref();
  try {
    const result = await validateCandidate({ repository: coding.repository, base: coding.commit, changes: coding.changes, gates, run });
    if (lost) throw new Error('Job lease lost during validation');
    jobs.renew(job.id, lease, 120_000);
    const validation = checkpoints.save(job.id, { kind: 'validation', ...result });
    // Save before SQLite references it, so an interrupted write never leaves a broken reference.
    const updated = jobs.finish(job.id, lease, 'waiting', {
      ...job.checkpoint,
      stage: result.passed ? 'needs_publication' : 'validation_failed',
      validation,
    });
    return { job: updated, result };
  } finally { clearInterval(heartbeat); }
}
