import type { TeachJobRow } from './store.js';

export function lessonChainRecord(job: TeachJobRow, status: string, backend: string) {
  const trainingStartedAt = job.progress?.started_at;
  return {
    status,
    contributor: job.contributor,
    dataset_id: job.dataset_id ?? null,
    dataset_sha256: job.dataset_sha256 ?? null,
    rows: job.facts.length,
    effort: (job.training as { effort?: string } | null)?.effort ?? null,
    created_at: job.created_at,
    started_at: job.started_at,
    training_started_at: typeof trainingStartedAt === 'number' && Number.isSafeInteger(trainingStartedAt) ? trainingStartedAt : null,
    finished_at: job.finished_at,
    backend,
    patch_id: job.patch_id ?? job.draft_id ?? null,
    sha256: job.sha256 ?? null,
  };
}
