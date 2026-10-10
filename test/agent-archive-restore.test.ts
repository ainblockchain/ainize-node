import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AgentGit } from '../src/agent-git.js';
import { AgentArchives } from '../src/agent-archives.js';
import { restoreArchivedAgent } from '../src/agent-archive-restore.js';
import { AgentPullStore } from '../src/agent-pulls.js';
import { AgentMirrorStore } from '../src/agent-mirror.js';
import { AgentRuntimeStore, repositoryId, type RuntimeSource } from '../src/repository-runtime.js';
import { HostedAgentStore } from '../src/hosted-agent-store.js';
import { HostedAgentHost } from '../src/hosted-agent-host.js';
import { HostedAgentGateway } from '../src/hosted-agent-gateway.js';
import { HostedAgentSecretStore } from '../src/hosted-agent-secrets.js';
import { hostedAgentSpecInput } from '../src/hosted-agent-types.js';
import { issueHostedAgentPopKey } from '../src/hosted-agent-pop.js';
const exec = promisify(execFile);

async function fixture(kind: 'local' | 'project' | 'mirror' | 'code') {
  const directory = mkdtempSync(join(tmpdir(), 'ainize-restore-'));
  const id = 'restored-agent', owner = 'sso:owner';
  const git = new AgentGit(join(directory, 'git'));
  const store = new HostedAgentStore(join(directory, 'agents.json'));
  const secrets = new HostedAgentSecretStore(join(directory, 'secrets.json'), join(directory, 'secrets.key'));
  const pulls = new AgentPullStore(join(directory, 'pulls.json'));
  const mirrors = new AgentMirrorStore(join(directory, 'mirrors.json'));
  const runtimes = new AgentRuntimeStore(join(directory, 'runtimes.json'));
  const archives = new AgentArchives(join(directory, 'archives.json'), join(directory, 'archives'));
  const gateway = new HostedAgentGateway({ registry: () => null, spec: (agent) => store.get(agent), log: () => {} });
  const host = new HostedAgentHost({ gateway, secrets, docker: null, idleStopMs: 60_000, maxRunning: 2, log: () => {} });
  await host.start([]);
  let spec = issueHostedAgentPopKey(store, secrets, store.create(hostedAgentSpecInput.parse({ id, name: 'Restored agent', model: 'test-model', systemPrompt: 'Last working prompt', secretNames: ['KEY'], ...(kind === 'code' ? { mode: 'tools', files: { 'index.mjs': 'export default {}' } } : {}) }), owner));
  secrets.set(id, 'KEY', 'a test value that must not be restored');
  await git.init(id);
  let first = await git.commitSpec(id, spec, { message: 'Last working version' });
  if (kind === 'mirror') {
    const work = join(directory, 'source');
    await exec('git', ['clone', '--quiet', git.dir(id), work]);
    mkdirSync(join(work, 'agents/news'), { recursive: true });
    for (const file of ['agent.json', 'prompt.md']) renameSync(join(work, file), join(work, 'agents/news', file));
    await exec('git', ['-C', work, 'add', '.']);
    await exec('git', ['-C', work, '-c', 'user.name=Source owner', '-c', 'user.email=source@example.test', 'commit', '-qm', 'Agent folder']);
    await exec('git', ['-C', work, 'push', '--quiet', 'origin', 'main']);
    first = await git.resolve(id, 'main');
    const shallow = join(directory, 'shallow.git');
    await exec('git', ['clone', '--bare', '--depth=1', pathToFileURL(git.dir(id)).href, shallow]);
    await git.deleteRepo(id); renameSync(shallow, git.dir(id));
    assert.equal(git.isShallow(id), true);
    mirrors.set({ agent: id, url: 'https://github.com/example/news', branch: 'main', path: 'agents/news', lastCommit: first });
  }
  const sourceUrl = kind === 'project' ? 'https://aindrive.example/team/git/news' : kind === 'mirror' ? 'https://github.com/example/news' : `https://node.example/git/${id}.git`;
  const source: RuntimeSource = { repoId: repositoryId(sourceUrl), provider: kind === 'project' ? 'aindrive' : kind === 'mirror' ? 'github' : 'agent-git', url: sourceUrl, path: kind === 'mirror' ? 'agents/news' : '', branch: 'main', projectId: kind === 'project' ? 'prj_1234' : null, writable: kind === 'local' || kind === 'code', sourceCommit: kind === 'project' ? 'a'.repeat(40) : first };
  if (kind !== 'code') {
    const ready = runtimes.begin(id, source, 'push', owner);
    runtimes.finish(id, ready.id, { status: 'ready', version: spec.version, error: null, projectionCommit: kind === 'mirror' ? null : first });
  }
  if (kind === 'local' || kind === 'project') {
    const bad = hostedAgentSpecInput.parse({ ...spec, mode: 'tools', files: { 'index.mjs': 'export default {}' }, systemPrompt: 'Failed replacement' });
    spec = store.update(id, bad, owner);
    const second = await git.commitSpec(id, spec, { message: 'Failed replacement', parent: first });
    const failed = runtimes.begin(id, { ...source, sourceCommit: kind === 'project' ? 'b'.repeat(40) : second }, 'push', owner);
    runtimes.finish(id, failed.id, { status: 'error', version: spec.version, error: 'build failed', projectionCommit: second });
  }
  const pull = pulls.open({ agent: id, title: 'Preserved review', body: 'Review body', head: 'proposal', base: 'main', author: owner });
  pulls.addComment(id, pull.number, { author: owner, body: 'Preserved comment' });
  const archive = await archives.create(git, { spec, pulls: pulls.list(id), mirror: mirrors.get(id), runtime: runtimes.get(id), executions: runtimes.executionsOf(id) });
  store.delete(id); secrets.dropAgent(id); pulls.dropAgent(id); mirrors.remove(id); runtimes.remove(id); await git.deleteRepo(id);
  const deps = { archives, git, store, secrets, pulls, mirrors, runtimes, host, publicBase: 'https://node.example', reserved: () => false, validate: () => {}, timeoutMs: 1000 };
  return { directory, id, owner, first, archive, deps, cleanup: async () => { await host.stop(); rmSync(directory, { recursive: true, force: true }); } };
}

for (const kind of ['local', 'project'] as const) test(`${kind} restore selects the last successful version and preserves failed history without activating it`, async () => {
  const f = await fixture(kind);
  try {
    const restored = await restoreArchivedAgent(f.deps, f.archive);
    assert.equal(restored.commit, f.first);
    assert.equal(restored.sourceCommit, kind === 'project' ? 'a'.repeat(40) : f.first);
    assert.equal(f.deps.store.get(f.id)?.systemPrompt, 'Last working prompt');
    assert.equal(f.deps.store.get(f.id)?.version, f.archive.spec.version + 2);
    assert.notEqual(f.deps.store.get(f.id)?.popJwk?.kid, f.archive.spec.popJwk?.kid);
    assert.deepEqual(f.deps.secrets.reveal(f.id, ['KEY']), {});
    assert.deepEqual(restored.secretsRequired, ['KEY']);
    assert.equal(f.deps.pulls.get(f.id, 1)?.comments?.[0]?.body, 'Preserved comment');
    assert.equal(f.deps.runtimes.executionsOf(f.id).length, 3);
    assert.equal(f.deps.runtimes.get(f.id)?.activeCommit, restored.sourceCommit);
    assert.notEqual(await f.deps.git.resolve(f.id, `archive/${f.archive.id}/original-main`), f.first);
    assert.ok(f.deps.archives.get(f.archive.id, f.owner)?.restoredAt);
    await assert.rejects(restoreArchivedAgent(f.deps, f.archive), /already in use/);
  } finally { await f.cleanup(); }
});

test('a mirrored agent restores its original source folder and read-only mirror identity', async () => {
  const f = await fixture('mirror');
  try {
    const result = await restoreArchivedAgent(f.deps, f.archive);
    assert.equal(result.commit, f.first);
    assert.equal(f.deps.store.get(f.id)?.systemPrompt, 'Last working prompt');
    assert.equal(f.deps.mirrors.get(f.id)?.path, 'agents/news');
    assert.equal(f.deps.runtimes.get(f.id)?.source.writable, false);
    await assert.rejects(f.deps.git.readSpec(f.id, 'main', undefined, 'agents/../news'), /invalid agent source path/);
  } finally { await f.cleanup(); }
});

test('failed runtime application rolls back every restored state while retaining the archive for retry', async () => {
  const f = await fixture('code');
  try {
    await assert.rejects(restoreArchivedAgent(f.deps, f.archive), /Docker is not enabled/);
    assert.equal(f.deps.store.get(f.id), null);
    assert.equal(f.deps.git.exists(f.id), false);
    assert.equal(f.deps.mirrors.get(f.id), null);
    assert.equal(f.deps.pulls.list(f.id).length, 0);
    assert.equal(f.deps.runtimes.get(f.id), null);
    assert.equal(f.deps.runtimes.executionsOf(f.id).length, 0);
    assert.deepEqual(f.deps.secrets.names(f.id), []);
    assert.equal(f.deps.archives.get(f.archive.id, f.owner)?.restoredAt, undefined);
    assert.ok(f.deps.archives.bundle(f.archive.id, f.owner));
    const again = new AgentRuntimeStore(join(f.directory, 'runtimes.json'));
    assert.equal(again.get(f.id), null); assert.equal(again.executionsOf(f.id).length, 0);
  } finally { await f.cleanup(); }
});

test('a metadata-only mirror preserves its source SHA separately from its reconstructed projection across another deletion', async () => {
  const f = await fixture('mirror');
  try {
    const archives = new AgentArchives(join(f.directory, 'legacy-archives.json'), join(f.directory, 'legacy-archives'));
    const snapshot = { spec: f.archive.spec, pulls: f.archive.pulls, mirror: f.archive.mirror, runtime: f.archive.runtime, executions: f.archive.executions };
    const legacy = await archives.create(f.deps.git, snapshot);
    assert.equal(legacy.repository, false);
    const deps = { ...f.deps, archives };
    const restored = await restoreArchivedAgent(deps, legacy);
    assert.equal(restored.sourceCommit, f.first);
    assert.notEqual(restored.commit, f.first);
    assert.equal(deps.runtimes.get(f.id)?.source.provider, 'github');
    assert.equal(deps.runtimes.get(f.id)?.source.writable, false);
    assert.equal(deps.runtimes.executionsOf(f.id).at(-1)?.projectionCommit, restored.commit);
    const next = await archives.create(deps.git, { spec: deps.store.get(f.id)!, pulls: deps.pulls.list(f.id), mirror: deps.mirrors.get(f.id), runtime: deps.runtimes.get(f.id), executions: deps.runtimes.executionsOf(f.id) });
    await deps.host.remove(f.id); deps.store.delete(f.id); deps.secrets.dropAgent(f.id); deps.pulls.dropAgent(f.id); deps.mirrors.remove(f.id); deps.runtimes.remove(f.id); await deps.git.deleteRepo(f.id);
    const again = await restoreArchivedAgent(deps, next);
    assert.equal(again.sourceCommit, f.first);
    assert.equal(again.commit, restored.commit);
    assert.equal(deps.store.get(f.id)?.systemPrompt, 'Last working prompt');
  } finally { await f.cleanup(); }
});
