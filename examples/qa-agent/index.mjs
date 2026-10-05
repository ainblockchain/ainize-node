/** Operational hosted QA handler.
 *
 * Composes the validated building blocks into the agent an Ainize host actually runs:
 *   execute  — intake a fix request, verified against the canonical Teams message, into a durable job.
 *   tick     — advance one queued job by a single bounded coding step, under a SQLite lease.
 *
 * Authority is the canonical Teams message and current channel membership, never the A2A caller's
 * text or metadata (the locator in `input.metadata.teamsMessage` is only an untrusted lookup hint).
 * This handler does not publish commits, run repository code, or deploy. A candidate stops at
 * `needs_validation`; validation, GitHub publishing, Ainmem lifecycle, and release approval are
 * separate steps with their own credentials. Release tokens are never loaded here — only the
 * repository read token and the agent's own model are reachable from the coding path.
 */
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { TeamsMcp, verifyFixRequest } from './teams.mjs';
import { Jobs } from './jobs.mjs';
import { Checkpoints } from './checkpoints.mjs';
import { GitHubSnapshot } from './repository.mjs';
import { advanceCoding } from './advance.mjs';

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
  if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs < 1000 || maxAgeMs > 86_400_000) throw new Error('QA config maxAgeMs out of range');
  // `enabledAt`/`maxAgeMs` reach the verifier, which re-reads the canonical message's time itself.
  return { service, teamsOrigin: origin.origin + '/', workspaceId, channelId, enabledAt, maxAgeMs, repository, baseCommit };
}

/** A stable key folds in the pinned base SHA: a new base is a new job, and an old approval cannot ride along. */
const requestKey = (config, verified) =>
  `${config.service}:${config.workspaceId}:${config.channelId}:${verified.parentId}:${verified.messageId}:${config.baseCommit}`;

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
      const job = jobs.enqueue(requestKey(config, verified), {
        service: config.service, repository: config.repository, base: config.baseCommit,
        text: verified.text,
        teams: { workspaceId: verified.workspaceId, channelId: verified.channelId, messageId: verified.messageId, parentId: verified.parentId },
      });
      return {
        text: `수정 요청을 접수했습니다. 작업 ${job.id} (${job.state}). 검증과 배포 승인은 별도 단계로 진행됩니다.`,
        metadata: { jobId: job.id, state: job.state, service: config.service },
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
    try {
      const claim = jobs.claim(60_000);
      if (!claim) return; // Nothing queued; a running job holds its own lease.
      const job = claim.job;
      // Defensive: only advance work pinned to this service's repository and base.
      if (job.input?.repository !== config.repository || job.input?.base !== config.baseCommit) {
        ctx?.log?.('qa tick skipping foreign job', job.id);
        return;
      }
      const snapshot = newSnapshot(ctx, job.input.repository, job.input.base);
      const checkpoints = new CheckpointsClass(checkpointsDir);
      const { job: updated } = await advance({ jobs, claim, checkpoints, snapshot, ctx });
      ctx?.log?.('qa tick advanced', updated.id, updated.state, updated.checkpoint?.stage);
    } catch (error) {
      // A lost lease or a transient read error leaves the job for the next tick; never deploy on error.
      ctx?.log?.('qa tick step failed', error?.message);
    } finally {
      jobs.close();
    }
  }

  return { execute, tick };
}

/** Production entry: bind to the per-service config file and the agent's own private state mount. */
function fromEnvironment() {
  const configPath = process.env.AINIZE_QA_CONFIG;
  const stateDir = process.env.AINIZE_AGENT_STATE_DIR;
  if (!configPath || !stateDir) return null;
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
