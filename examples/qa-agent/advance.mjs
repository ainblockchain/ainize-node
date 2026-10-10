/** One bounded coding step. The host scheduler, not a detached Python process, will call this. */
import { CodingSession } from './coding.mjs';

export async function advanceCoding({ jobs, claim, checkpoints, snapshot, ctx }) {
  const { job, lease } = claim;
  if (!job || job.state !== 'running' || !['coding', undefined].includes(job.checkpoint.stage)) throw new Error('Job is not at the coding stage');
  const prior = job.checkpoint.coding;
  if (prior && prior.jobId !== job.id) throw new Error('Checkpoint belongs to another job');
  const session = new CodingSession(snapshot, job.input.text, prior ? checkpoints.load(prior) : undefined);
  // The read-only model step may outlive the initial claim; refresh its lease while it runs.
  jobs.renew(job.id, lease, 120_000);
  let lost = false;
  const heartbeat = setInterval(() => {
    try { jobs.renew(job.id, lease, 120_000); } catch { lost = true; }
  }, 30_000);
  heartbeat.unref();
  try {
    const state = await session.step(ctx);
    if (lost) throw new Error('Job lease lost during coding');
    jobs.renew(job.id, lease, 120_000);
    const coding = checkpoints.save(job.id, state);
    // Save before updating SQLite. An interrupted write may leave an unreferenced blob, never a broken reference.
    const ready = state.phase === 'needs_validation';
    const updated = jobs.finish(job.id, lease, ready ? 'waiting' : 'queued', {
      ...job.checkpoint,
      stage: ready ? 'needs_validation' : 'coding', coding, repository: snapshot.repository, base: snapshot.commit,
    });
    return { job: updated, state };
  } finally { clearInterval(heartbeat); }
}
