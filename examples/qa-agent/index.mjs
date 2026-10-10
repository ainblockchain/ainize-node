import {createHash} from 'node:crypto';
/** Operational hosted QA handler.
 *
 * Composes the validated building blocks into the agent an Ainize host actually runs:
 *   execute  — intake a fix request, verified against the canonical Teams message, into a durable job.
 *   tick     — advance one queued job by a single bounded coding step, under a SQLite lease.
 *
 * Authority is the canonical Teams message and current channel membership, never the A2A caller's
 * text or metadata (the locator in `input.metadata.teamsMessage` is only an untrusted lookup hint).
 * Coding has no release credentials. Optional host capabilities validate the candidate and publish
 * its draft PR; the durable job then waits for a separate human approval/release path.
 */
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { TeamsMcp, verifyFixRequest } from './teams.mjs';
import { Jobs } from './jobs.mjs';
import { Checkpoints } from './checkpoints.mjs';
import { GitHubSnapshot } from './repository.mjs';
import { advanceCoding } from './advance.mjs';
import { advanceHostedRevalidation } from './revalidation.mjs';
import { advanceHostedLifecycle } from './lifecycle.mjs';
import { advanceHostedPublication } from './publication.mjs';
import { advanceHostedValidation } from './validation.mjs';
import { AinmemReports, parseAinmemConfig } from './ainmem.mjs';
import { enqueueSharedTeamsRequest } from './routing.mjs';

const idPattern = /^[a-zA-Z0-9-]{1,80}$/;
const slug = value => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value);

/** Validate the per-service binding. It carries identifiers and a pinned SHA only — never secrets. */
export function parseConfig(raw) {
  const config = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('QA config must be an object');
  const { service, teamsOrigin, workspaceId, channelId, enabledAt, repository, baseCommit } = config;
  const maxAgeMs = config.maxAgeMs ?? 3_600_000;
  if (!slug(service)) throw new Error('QA config requires a service slug');
  const origin = new URL(teamsOrigin);
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') {
    throw new Error('QA config requires an https Teams origin');
  }
  if (!idPattern.test(workspaceId ?? '') || !idPattern.test(channelId ?? '')) throw new Error('QA config requires workspace and channel ids');
  if (!Number.isFinite(Date.parse(enabledAt ?? ''))) throw new Error('QA config requires an enabledAt timestamp');
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repository ?? '')) throw new Error('QA config requires a repository');
  if (!/^[a-f0-9]{40}$/.test(baseCommit ?? '')) throw new Error('QA config requires a full base commit SHA');
  for(const key of ['hostBase','hostReview','hostValidation','hostPublication','hostRevalidation'])if(config[key]!==undefined&&typeof config[key]!=='boolean')throw new Error('Host capability flags must be boolean');
  if(config.hostBase===true&&(!config.hostReview||!config.hostValidation))throw new Error('Host base requires verified intake and validation');
  if(config.hostRevalidation&&(!config.hostBase||!config.hostReview||!config.hostValidation||!config.hostPublication))throw new Error('Host revalidation requires all host capabilities');
  let routes;
  if(config.routes!==undefined){
    if(!config.hostBase||!config.hostReview||!config.hostValidation||!config.hostPublication)throw new Error('Shared routes require all host capabilities');
    if(!config.routes||Object.keys(config.routes).sort().join(',')!=='api,web')throw new Error('Shared web/API routes required');
    routes=Object.fromEntries(Object.entries(config.routes).map(([key,value])=>{
      if(!slug(value?.service)||!/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value?.repository??'')||!/^[a-f0-9]{40}$/.test(value?.baseCommit??''))throw new Error('Invalid shared route');
      return [key,{service:value.service,repository:value.repository,baseCommit:value.baseCommit}];
    }));
    if(routes.web.repository!==repository||routes.web.baseCommit!==baseCommit||routes.web.service!==service||routes.api.repository===repository||routes.api.service===service)throw new Error('Shared default must match web repository');
  }
  if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs < 1000 || maxAgeMs > 86_400_000) throw new Error('QA config maxAgeMs out of range');
  // `enabledAt`/`maxAgeMs` reach the verifier, which re-reads the canonical message's time itself.
  return { service, teamsOrigin: origin.origin + '/', workspaceId, channelId, enabledAt, maxAgeMs, repository, baseCommit, ...(routes?{routes}:{}), hostRevalidation: config.hostRevalidation === true, hostBase: config.hostBase === true, hostValidation: config.hostValidation === true, hostPublication: config.hostPublication === true, hostReview: config.hostReview === true, ...(config.ainmem ? { ainmem: parseAinmemConfig(config.ainmem) } : {}) };
}

/**
 * Build a handler. Dependencies are injectable so the composition can be tested without a live
 * Teams node, a real repository, or the production model; production uses the defaults.
 */
export function createHandler({
  config,
  stateDir,
  verifyIntake,
  newSnapshot = (ctx, repository, commit) => new GitHubSnapshot(ctx, repository, commit),
  JobsClass = Jobs,
  CheckpointsClass = Checkpoints,
  advance = advanceCoding,
} = {}) {
  if (!config) throw new Error('QA handler requires a config');
  config = parseConfig(config);
  if (typeof stateDir !== 'string' || !stateDir) throw new Error('QA handler requires a state directory');
  const jobsFile = join(stateDir, 'jobs.sqlite3');
  const checkpointsDir = join(stateDir, 'checkpoints');

  // Default intake re-reads the canonical Teams message; the locator is only a hint.
  const verify = verifyIntake ?? (async (ctx, locator) => {
    const mcp = new TeamsMcp(ctx, config.teamsOrigin);
    return verifyFixRequest(mcp, {
      workspaceId: config.workspaceId, channelId: config.channelId,
      enabledAt: config.enabledAt, maxAgeMs: config.maxAgeMs,
    }, locator);
  });

  async function report(jobs, ctx, jobId) {
    if (!config.ainmem) return null;
    let reports;
    try {
      reports = new AinmemReports(jobs, config.ainmem, { checkpoints: new CheckpointsClass(checkpointsDir) });
      if (jobId) reports.refresh(jobId);
      await reports.flush(ctx);
      return jobId ? reports.refresh(jobId) : null;
    } catch {
      ctx?.log?.('qa Ainmem report pending');
      // An unrelated report failure must not hide this job's successfully delivered link.
      try { return reports && jobId ? reports.refresh(jobId) : null; } catch { return null; }
    }
  }

  async function execute(_input, ctx) {
    const locator = ctx?.input?.metadata?.teamsMessage;
    // No trustworthy pointer to a canonical message: cannot verify, so do not enqueue.
    if (!locator || typeof locator !== 'object') {
      return { text: '요청을 확인할 수 없습니다. QA 채널의 메시지에서 다시 요청해 주세요.' };
    }
    let verified;
    try {
      verified = await verify(ctx, locator);
    } catch (error) {
      ctx?.log?.('qa intake verify failed', error?.message);
      return { text: '요청 확인 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.' };
    }
    // Only a genuine fix request from an active human member of this channel passes. Deployment
    // commands (LGTM/배포) are not fix requests and are never enqueued here — release is separate.
    if (!verified) {
      return { text: '이 채널에서 확인된 수정 요청이 아닙니다. (배포 승인은 별도 경로로 처리됩니다.)' };
    }
    const jobs = new JobsClass(jobsFile);
    try {
      const job = config.routes?enqueueSharedTeamsRequest(jobs,config,verified):jobs.enqueueTeamsRequest({
        service: config.service, repository: config.repository, base: config.baseCommit,
        text: verified.text,
        teams: { workspaceId: verified.workspaceId, channelId: verified.channelId, messageId: verified.messageId, parentId: verified.parentId },
      });
      const pageUrl = await report(jobs, ctx, job.id);
      return {
        text: pageUrl ? `[칸반 작업 열기](${pageUrl})\n\n진행 상태와 결과는 이 작업 페이지에서 확인할 수 있습니다.` : `수정 요청을 접수했습니다. 작업 ${job.id} (${job.state}). 검증과 배포 승인은 별도 단계로 진행됩니다.`,
        metadata: { jobId: job.id, state: job.state, service: job.input.service },
      };
    } catch (error) {
      ctx?.log?.('qa intake enqueue failed', error?.message);
      return { text: '요청 접수에 실패했습니다. 동일 요청이 이미 처리 중일 수 있습니다.' };
    } finally {
      jobs.close();
    }
  }

  async function tick(ctx) {
    const jobs = new JobsClass(jobsFile);
    let claim;
    try {
      await report(jobs, ctx);
      if(config.hostRevalidation){
        const retry=jobs.claimRevalidation();
        if(retry){
          try{await advanceHostedRevalidation({jobs,claim:retry,ctx});}
          catch{ctx?.log?.('QA revalidation lease recovery pending');}
          await report(jobs,ctx,retry.job.id);
        }
      }
      if(config.hostReview){
        const reviewClaim=jobs.claimReview();
        if(reviewClaim){
          try{await advanceHostedLifecycle({jobs,claim:reviewClaim,checkpoints:new CheckpointsClass(checkpointsDir),ctx});}
          catch{try{jobs.finish(reviewClaim.job.id,reviewClaim.lease,'waiting',reviewClaim.job.checkpoint);}catch{}ctx?.log?.('QA lifecycle observation pending');}
          await report(jobs,ctx,reviewClaim.job.id);
        }
      }
      claim = jobs.claim(60_000);
      if (!claim) return; // Nothing queued; a running job holds its own lease.
      const job = claim.job;
      // Defensive: only advance work pinned to this service's repository and base.
      const expected=config.routes?config.routes[job.input?.route]:{repository:config.repository,service:config.service,baseCommit:config.baseCommit};
      if (!expected||job.input?.repository !== expected.repository||(config.routes&&job.input?.service!==expected.service) || (!config.hostBase && job.input?.base !== expected.baseCommit)) {
        jobs.finish(job.id, claim.lease, 'waiting', { ...job.checkpoint, holdReason: 'configuration_changed' });
        ctx?.log?.('qa tick parked job with changed configuration', job.id);
        return;
      }
      if(config.hostReview&&!job.checkpoint.hostIntake){
        const locator=job.input.teams;
        if(!locator||locator.workspaceId!==config.workspaceId||locator.channelId!==config.channelId)throw new Error('Original QA locator missing');
        const intake=await ctx.qa.intake(job.id,{messageId:locator.messageId,parentId:locator.parentId});
        if(intake?.state==='failed'){jobs.finish(job.id,claim.lease,'waiting',{...job.checkpoint,holdReason:'host_intake_failed'});return;}
        if(intake?.state==='running'){jobs.finish(job.id,claim.lease,'queued',job.checkpoint);return;}
        if(intake?.state!=='done'||intake.result?.requestId!==locator.messageId||intake.result.rootId!==locator.parentId||intake.result.workspaceId!==config.workspaceId||intake.result.channelId!==config.channelId||intake.result.requestDigest!==createHash('sha256').update(job.input.text).digest('hex'))throw new Error('Host intake binding mismatch');
        if(config.routes&&(intake.result.repository!==job.input.repository||intake.result.route!==job.input.route))throw new Error('Host repository route mismatch');
        jobs.finish(job.id,claim.lease,'queued',{...job.checkpoint,hostIntake:true});return;
      }
      if(config.hostBase&&!job.checkpoint.hostBase){
        if(Object.keys(job.checkpoint).some(k=>!['hostIntake','stepFailures'].includes(k))){
          jobs.finish(job.id,claim.lease,'waiting',{...job.checkpoint,holdReason:'base_reconciliation_required'});return;
        }
        const prepared=await ctx.qa.base(job.id);
        if(prepared?.state==='running'){jobs.finish(job.id,claim.lease,'queued',job.checkpoint);return;}
        if(prepared?.state==='failed'){jobs.finish(job.id,claim.lease,'waiting',{...job.checkpoint,holdReason:'base_preparation_failed'});return;}
        if(prepared?.state!=='done'||prepared.result?.repository!==job.input.repository||!/^[a-f0-9]{40}$/.test(prepared.result?.base??''))throw new Error('Host base binding mismatch');
        jobs.bindBase(job.id,claim.lease,prepared.result.base);return;
      }
      if (job.checkpoint.stage === 'needs_validation') {
        const updated=await advanceHostedValidation({jobs,claim,checkpoints:new CheckpointsClass(checkpointsDir),ctx});
        if(config.hostPublication && updated.checkpoint.stage==='needs_publication')jobs.wake(updated.id);
        return;
      }
      if(job.checkpoint.stage==='needs_publication'){
        if(!config.hostPublication){jobs.finish(job.id,claim.lease,'waiting',job.checkpoint);return;}
        await advanceHostedPublication({jobs,claim,checkpoints:new CheckpointsClass(checkpointsDir),ctx});
        return;
      }
      const snapshot = newSnapshot(ctx, job.input.repository, job.input.base);
      const checkpoints = new CheckpointsClass(checkpointsDir);
      const { job: updated } = await advance({ jobs, claim, checkpoints, snapshot, ctx });
      await report(jobs, ctx, updated.id);
      if (config.hostValidation && updated.checkpoint.stage === 'needs_validation') jobs.wake(updated.id);
      ctx?.log?.('qa tick advanced', updated.id, updated.state, updated.checkpoint?.stage);
    } catch (error) {
      // Bound retries while preserving the last durable candidate. Never overwrite a newer lease.
      if (claim) {
        try {
          const failures = (claim.job.checkpoint.stepFailures ?? 0) + 1;
          jobs.finish(claim.job.id, claim.lease, failures >= 3 ? 'waiting' : 'queued', {
            ...claim.job.checkpoint, stepFailures: failures,
            ...(failures >= 3 ? { holdReason: 'step_retry_limit' } : {}),
          });
        } catch { /* Another owner or an expired lease controls recovery. */ }
      }
      ctx?.log?.('qa tick step failed', error?.message);
    } finally {
      if (claim) await report(jobs, ctx, claim.job.id);
      jobs.close();
    }
  }

  return { execute, tick };
}

/** Production entry: bind to the per-service config file and the agent's own private state mount. */
function fromEnvironment() {
  const configPath = process.env.AINIZE_QA_CONFIG ?? new URL('./qa-config.json', import.meta.url);
  const stateDir = process.env.AINIZE_AGENT_STATE_DIR;
  if (!stateDir) return null;
  const config = parseConfig(readFileSync(configPath, 'utf8'));
  return createHandler({ config, stateDir });
}

const handler = fromEnvironment();

export const execute = (input, ctx) => {
  if (!handler) throw new Error('QA handler is not configured (AINIZE_QA_CONFIG, AINIZE_AGENT_STATE_DIR)');
  return handler.execute(input, ctx);
};
export const tick = ctx => {
  if (!handler) throw new Error('QA handler is not configured (AINIZE_QA_CONFIG, AINIZE_AGENT_STATE_DIR)');
  return handler.tick(ctx);
};

export default { execute, tick };
