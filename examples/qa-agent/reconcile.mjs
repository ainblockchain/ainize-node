/** Read-only reconciliation of archived candidate metadata against current GitHub authority. */
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
export function pullNumber(repository, url) {
  const parsed = new URL(url);
  const match = parsed.pathname.match(/^\/([^/]+\/[^/]+)\/pull\/([1-9][0-9]*)$/);
  if (parsed.origin !== 'https://github.com' || parsed.username || parsed.password || parsed.search || parsed.hash
    || !match || match[1] !== repository || !Number.isSafeInteger(Number(match[2]))) throw new Error('PR does not belong to configured repository');
  return Number(match[2]);
}
/** Older workers stored {number,url}; never accept a mismatched number or foreign repository. */
export function legacyPullUrl(repository, value) {
  if (typeof value === 'string') { pullNumber(repository,value); return value; }
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.url !== 'string'
    || !Number.isSafeInteger(value.number) || value.number < 1 || pullNumber(repository,value.url) !== value.number) throw new Error('Invalid legacy PR reference');
  return value.url;
}
export async function reconcileCandidate({ repository, pullUrl, candidateSha, baseBranch = 'main', read }) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repository) || !sha(candidateSha)
    || !/^[A-Za-z0-9._/-]{1,200}$/.test(baseBranch)) throw new Error('Invalid candidate binding');
  const number = pullNumber(repository, pullUrl);
  const pull = await read(`pulls/${number}`);
  if (pull.number !== number || pull.base?.repo?.full_name !== repository || pull.base?.ref !== baseBranch
    || pull.head?.repo?.full_name !== repository || !sha(pull.head?.sha) || !sha(pull.base?.sha)) throw new Error('GitHub PR binding mismatch');
  const evidence = { repository, number, pullUrl, expectedSha: candidateSha, head: pull.head.sha,
    baseBranch, base: pull.base.sha, merged: pull.merged === true, mergedAt: pull.merged_at ?? null,
    mergeCommit: pull.merge_commit_sha ?? null };
  if (pull.head.sha !== candidateSha) return { ...evidence, action: 'candidate_changed' };
  if (pull.merged === true) {
    if (!sha(pull.merge_commit_sha) || !pull.merged_at) throw new Error('Incomplete merge evidence');
    return { ...evidence, action: 'verify_deployment' };
  }
  if (pull.state !== 'open') return { ...evidence, action: 'closed_unmerged' };
  // An unchanged candidate or prior approval does not prove it still passes against today's base.
  return { ...evidence, action: 'revalidate_candidate' };
}

/** Preserve current remote evidence without turning archived approvals into permission to release. */
export async function reconcileLegacyJob({ jobs, claim, checkpoints, read, baseBranch = 'main' }) {
  const { job, lease } = claim;
  if (job.state !== 'running' || job.checkpoint.stage !== 'legacy_reconciliation'
    || job.checkpoint.legacy?.jobId !== job.id) throw new Error('Job is not a legacy reconciliation');
  const archive = checkpoints.load(job.checkpoint.legacy);
  if (archive.job.id !== job.id || archive.repository !== job.input.repository) throw new Error('Legacy archive binding mismatch');
  const details = archive.job.details;
  const reference = baseBranch === 'main' ? details.pr_main : baseBranch === 'develop' ? details.pr_develop : null;
  if (!reference || !sha(details.code_sha)) throw new Error('Legacy job has no published candidate');
  const pullUrl = legacyPullUrl(job.input.repository, reference);
  jobs.renew(job.id, lease, 120_000);
  const result = await reconcileCandidate({ repository: job.input.repository, pullUrl, candidateSha: details.code_sha, baseBranch, read });
  if (details.superseded_by || details.superseded_pr) {
    const successor = jobs.get(details.superseded_by);
    if (!successor || successor.id === job.id || successor.input.repository !== job.input.repository || successor.checkpoint.legacy?.jobId !== successor.id) throw new Error('Legacy replacement binding unavailable');
    const replacement = checkpoints.load(successor.checkpoint.legacy);
    const next = replacement.job.details;
    const nextUrl = legacyPullUrl(job.input.repository, baseBranch === 'main' ? next.pr_main : next.pr_develop);
    if (replacement.job.id !== successor.id || replacement.repository !== job.input.repository || nextUrl !== legacyPullUrl(job.input.repository, details.superseded_pr)) throw new Error('Legacy replacement PR mismatch');
    const evidence = await reconcileCandidate({repository:job.input.repository,pullUrl:nextUrl,candidateSha:next.code_sha,baseBranch,read});
    result.replacement = {jobId:successor.id,...evidence,approvalInherited:false};
    if (result.action === 'closed_unmerged') result.action = 'superseded_candidate';
  }
  jobs.renew(job.id, lease, 120_000);
  const reconciliation = checkpoints.save(job.id, { kind: 'github-reconciliation-v1', ...result });
  return jobs.finish(job.id, lease, 'waiting', { ...job.checkpoint, reconciliation,
    stage: result.action, holdReason: 'native_reconciliation_required' });
}

/** Proves commit inclusion in the reported deployment, not that a UI regression is fixed. */
export async function verifyDeploymentCommit({ reconciliation, health, read }) {
  if (reconciliation.action !== 'verify_deployment' || !sha(reconciliation.mergeCommit)) throw new Error('Verified merge evidence required');
  if (health?.status !== 'ok' || typeof health.version !== 'string' || !/^[a-f0-9]{7,40}$/.test(health.version)) throw new Error('Healthy deployment version required');
  if (health.checks && Object.values(health.checks).some(check => check?.status !== 'ok')) throw new Error('Deployment dependency check failed');
  const commit = await read(`commits/${health.version}`);
  if (!sha(commit.sha) || !commit.sha.startsWith(health.version)) throw new Error('Deployment commit did not resolve');
  const comparison = await read(`compare/${reconciliation.mergeCommit}...${commit.sha}`);
  if (!['ahead','identical'].includes(comparison.status) || comparison.behind_by !== 0
    || comparison.base_commit?.sha !== reconciliation.mergeCommit || comparison.merge_base_commit?.sha !== reconciliation.mergeCommit) throw new Error('Deployment does not contain the merged candidate');
  return { kind: 'deployment-commit-inclusion-v1', repository: reconciliation.repository,
    pullUrl: reconciliation.pullUrl, mergeCommit: reconciliation.mergeCommit, servingCommit: commit.sha,
    candidateSha: reconciliation.expectedSha, featureRegressionVerified: false };
}
