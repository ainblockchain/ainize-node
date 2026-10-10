/** Restore under the common repository queue; a failed application leaves the archive available for retry. */
import type { AgentArchive, AgentArchives } from './agent-archives.js';
import type { AgentGit } from './agent-git.js';
import type { AgentPullStore } from './agent-pulls.js';
import type { AgentMirrorStore } from './agent-mirror.js';
import type { HostedAgentStore } from './hosted-agent-store.js';
import type { HostedAgentHost } from './hosted-agent-host.js';
import type { HostedAgentSecretStore } from './hosted-agent-secrets.js';
import { hostedAgentSpecInput, type HostedAgentSpecInput } from './hosted-agent-types.js';
import { issueHostedAgentPopKey } from './hosted-agent-pop.js';
import { repositoryId, waitForAgentVersion, type AgentRuntimeStore, type RuntimeSource } from './repository-runtime.js';

export interface AgentArchiveRestoreDeps {
  archives: AgentArchives; git: AgentGit; store: HostedAgentStore; pulls: AgentPullStore;
  mirrors: AgentMirrorStore; runtimes: AgentRuntimeStore; secrets: HostedAgentSecretStore; host: HostedAgentHost;
  publicBase: string;
  initializeRepository?: (id: string) => void;
  reserved: (id: string) => boolean;
  validate: (input: HostedAgentSpecInput) => void | Promise<void>;
  timeoutMs?: number;
}
export class AgentArchiveRestoreError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

export async function restoreArchivedAgent(deps: AgentArchiveRestoreDeps, archive: AgentArchive) {
  const id = archive.agent;
  if (deps.store.get(id) || deps.git.exists(id) || deps.reserved(id)) throw new AgentArchiveRestoreError(409, 'id_taken', 'the agent address is already in use');
  if (deps.pulls.list(id).length || deps.mirrors.get(id) || deps.runtimes.get(id) || deps.runtimes.executionsOf(id).length || deps.secrets.names(id).length) throw new AgentArchiveRestoreError(409, 'state_exists', 'existing agent metadata must be resolved before restoring');
  const active = archive.runtime?.activeCommit;
  const ready = [...(archive.executions ?? [])].reverse().find((record) => record.status === 'ready' && record.sourceCommit === active);
  const projectSource = archive.runtime?.source.provider === 'aindrive';
  const externalSource = projectSource || archive.runtime?.source.provider === 'github' || !!archive.mirror;
  if (projectSource && active && !ready?.projectionCommit) throw new AgentArchiveRestoreError(409, 'active_version_missing', 'the archived active project projection is unavailable');
  let repositoryCreated = false, stateCreated = false, reviewsCreated = false, runtimeCreated = false, mirrorCreated = false;
  try {
    const repository = deps.archives.repositoryFile(archive.id, archive.owner);
    if (repository?.format === 'bare-tar') await deps.git.restoreBareArchive(id, repository.path);
    else if (repository) await deps.git.restoreBundle(id, repository.path);
    else await deps.git.init(id);
    repositoryCreated = true;
    deps.initializeRepository?.(id);
    const usesProjection = projectSource || (externalSource && !!ready?.projectionCommit) || !repository;
    let commit: string;
    let input: HostedAgentSpecInput;
    if (repository) {
      const ref = externalSource && ready?.projectionCommit ? ready.projectionCommit : active ?? 'main';
      const read = await deps.git.readSpec(id, ref, undefined, usesProjection ? '' : archive.mirror?.path ?? '');
      commit = read.commit;
      input = read.input;
      const before = await deps.git.resolve(id, 'main');
      if (before !== commit) {
        await deps.git.setRef(id, `archive/${archive.id}/original-main`, before);
        await deps.git.setRef(id, 'main', commit);
      }
    } else {
      if (archive.runtime?.activeVersion && archive.runtime.activeVersion !== archive.spec.version) throw new AgentArchiveRestoreError(409, 'active_version_missing', 'the active version cannot be reconstructed without its repository');
      input = hostedAgentSpecInput.parse(archive.spec);
      commit = await deps.git.commitSpec(id, input, { message: 'Restore legacy agent from archived metadata' });
    }
    input = { ...input, visibility: archive.spec.visibility ?? 'public', orgId: archive.spec.orgId ?? null };
    await deps.validate(input);
    let spec = deps.store.restore(archive.spec, input, deps.reserved);
    stateCreated = true;
    spec = issueHostedAgentPopKey(deps.store, deps.secrets, spec);
    deps.pulls.restoreAgent(id, archive.pulls);
    reviewsCreated = true;
    deps.runtimes.restore(id, archive.runtime ?? null, archive.executions ?? []);
    runtimeCreated = true;
    if (archive.mirror) { mirrorCreated = true; deps.mirrors.set(archive.mirror); }
    const url = `${deps.publicBase.replace(/\/+$/, '')}/git/${id}.git`;
    const sourceCommit = externalSource && usesProjection ? ready?.sourceCommit ?? active ?? archive.mirror?.lastCommit ?? null : commit;
    const source: RuntimeSource = archive.runtime ? { ...archive.runtime.source, sourceCommit } : archive.mirror ?
      { repoId: repositoryId(archive.mirror.url), provider: 'github', url: archive.mirror.url, path: archive.mirror.path, branch: archive.mirror.branch, sourceCommit, projectId: null, writable: false } :
      { repoId: repositoryId(url), provider: 'agent-git', url, path: '', branch: 'main', sourceCommit: commit, projectId: null, writable: true };
    const execution = deps.runtimes.begin(id, source, 'api', archive.owner);
    deps.host.apply(spec);
    await waitForAgentVersion(deps.host, id, spec.version, deps.timeoutMs);
    deps.runtimes.finish(id, execution.id, { status: 'ready', version: spec.version, error: null, projectionCommit: archive.mirror && !usesProjection ? null : commit });
    deps.archives.markRestored(archive.id, archive.owner);
    return { agentId: id, version: spec.version, commit, sourceCommit: source.sourceCommit, status: 'ready' as const, secretsRequired: spec.secretNames };
  } catch (error) {
    const cleanup: string[] = [];
    const attempt = async (operation: () => void | Promise<void>) => { try { await operation(); } catch (failure) { cleanup.push((failure as Error).message); } };
    if (stateCreated) { await attempt(() => deps.host.remove(id)); await attempt(() => { deps.store.delete(id); }); await attempt(() => deps.secrets.dropAgent(id)); }
    if (reviewsCreated) await attempt(() => deps.pulls.dropAgent(id));
    if (runtimeCreated) await attempt(() => deps.runtimes.remove(id));
    if (mirrorCreated) await attempt(() => { deps.mirrors.remove(id); });
    if (repositoryCreated) await attempt(() => deps.git.deleteRepo(id));
    if (cleanup.length) throw new AgentArchiveRestoreError(502, 'restore_cleanup_failed', `${(error as Error).message}; cleanup: ${cleanup.join('; ')}`);
    throw error;
  }
}
