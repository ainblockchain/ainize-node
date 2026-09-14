import type { TeachJobRow } from './store.js';

export interface LessonChainSubmission {
  status: string;
  submittedAt: number;
  acknowledgedAt: number;
  path: string | null;
  txHash: string | null;
  outcome: 'submitted' | 'unconfirmed';
}

export function lessonChainSubmissions(jobId: string, get: (key: string) => string | null | undefined): LessonChainSubmission[] {
  const statuses = ['QUEUED', 'PREFLIGHT', 'LOADING', 'TRAINING', 'EXPORTED', 'CHECKING', 'READY', 'NEEDS_MORE', 'FAILED', 'CANCELLED', 'PENDING_REVIEW', 'REJECTED', 'ANNOUNCED', 'EXPIRED'];
  const submissions: LessonChainSubmission[] = [];
  for (const status of statuses) {
    const raw = get(`teach.chain.${jobId}.${status}`);
    if (!raw || raw.length > 16384) continue;
    try {
      const value = JSON.parse(raw);
      if (!value || value.status !== status || !Number.isSafeInteger(value.submittedAt) || value.submittedAt <= 0
        || !Number.isSafeInteger(value.acknowledgedAt) || value.acknowledgedAt < value.submittedAt
        || !['submitted', 'unconfirmed'].includes(value.outcome)) continue;
      if (value.outcome === 'submitted' && (typeof value.path !== 'string' || !value.path || typeof value.txHash !== 'string' || !value.txHash)) continue;
      submissions.push({ status, submittedAt: value.submittedAt, acknowledgedAt: value.acknowledgedAt,
        path: typeof value.path === 'string' ? value.path : null, txHash: typeof value.txHash === 'string' ? value.txHash : null, outcome: value.outcome });
    } catch {}
  }
  return submissions.sort((left, right) => left.submittedAt - right.submittedAt);
}

export function lessonChainRecord(job: TeachJobRow, status: string, backend: string, recipeModelId: unknown = null) {
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
    model_id: typeof recipeModelId === 'string' && recipeModelId.trim() && recipeModelId.length <= 512 ? recipeModelId : null,
    patch_id: job.patch_id ?? job.draft_id ?? null,
    sha256: job.sha256 ?? null,
  };
}
