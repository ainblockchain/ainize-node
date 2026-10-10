import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AgentGit } from '../src/agent-git.js';
import { AgentArchives } from '../src/agent-archives.js';
import { HostedAgentStore } from '../src/hosted-agent-store.js';
import { hostedAgentSpecInput } from '../src/hosted-agent-types.js';
const exec = promisify(execFile);

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'ainize-agent-archive-'));
  const git = new AgentGit(join(directory, 'repositories'));
  const store = new HostedAgentStore(join(directory, 'agents.json'));
  const spec = store.create(hostedAgentSpecInput.parse({ id: 'archive-test', name: 'Archived agent', description: 'Preserve history', model: 'test-model', mode: 'tools', systemPrompt: 'Original prompt', files: { 'index.mjs': 'export default {}', 'reference.txt': 'Reference content' } }), 'sso:owner');
  await git.init(spec.id);
  const first = await git.commitSpec(spec.id, spec, { message: 'First version' });
  await git.setRef(spec.id, 'proposal', first);
  const second = await git.commitSpec(spec.id, { ...spec, systemPrompt: 'Second prompt' }, { message: 'Second version', parent: first });
  await exec('git', ['--git-dir', git.dir(spec.id), 'update-ref', 'refs/pull-proposals/7', first]);
  await exec('git', ['--git-dir', git.dir(spec.id), 'tag', 'v1', first]);
  return { directory, git, spec, first, second };
}

test('private archive survives restart and restores all Git refs, ancestors and files after source deletion', async () => {
  const f = await fixture();
  try {
    const path = join(f.directory, 'archives.json'), bundles = join(f.directory, 'archives');
    const archive = new AgentArchives(path, bundles);
    const record = await archive.create(f.git, { spec: f.spec, pulls: [], mirror: null });
    const refs = (await exec('git', ['--git-dir', f.git.dir(f.spec.id), 'show-ref'])).stdout;
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(statSync(archive.bundle(record.id, 'sso:owner')!).mode & 0o777, 0o600);
    assert.equal(archive.get(record.id, 'sso:stranger'), null);
    assert.equal(archive.bundle(record.id, 'sso:stranger'), null);
    const copy = archive.get(record.id, 'sso:owner')!; copy.spec.systemPrompt = 'Mutation';
    assert.equal(archive.get(record.id, 'sso:owner')!.spec.systemPrompt, 'Original prompt');
    await f.git.deleteRepo(f.spec.id);
    const again = new AgentArchives(path, bundles);
    assert.equal(again.list('sso:owner').length, 1);
    await f.git.restoreBundle(f.spec.id, again.bundle(record.id, 'sso:owner')!);
    assert.equal((await exec('git', ['--git-dir', f.git.dir(f.spec.id), 'show-ref'])).stdout, refs);
    assert.equal(await f.git.resolve(f.spec.id, 'main'), f.second);
    assert.equal(await f.git.show(f.spec.id, f.first, 'prompt.md'), 'Original prompt');
    assert.equal(await f.git.show(f.spec.id, f.second, 'prompt.md'), 'Second prompt');
    assert.equal(await f.git.show(f.spec.id, f.second, 'files/reference.txt'), 'Reference content');
    assert.equal((await exec('git', ['--git-dir', f.git.dir(f.spec.id), 'remote'])).stdout, '');
    await assert.rejects(f.git.restoreBundle(f.spec.id, again.bundle(record.id, 'sso:owner')!), /already exists/);
    assert.equal(again.remove(record.id, 'sso:owner'), 'not_exported');
    assert.equal(again.markExported(record.id, 'sso:stranger'), null);
    again.markExported(record.id, 'sso:owner'); again.markRestored(record.id, 'sso:owner');
    assert.ok(new AgentArchives(path, bundles).get(record.id, 'sso:owner')?.restoredAt);
    assert.equal(again.remove(record.id, 'sso:owner'), 'removed');
    assert.equal(again.get(record.id, 'sso:owner'), null);
    assert.equal(await f.git.resolve(f.spec.id, 'main'), f.second, 'removing the archive cannot break the independent restored repository');
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test('concurrent archive creation respects owner quota and failed export leaves the source intact', async () => {
  const f = await fixture();
  try {
    const archives = new AgentArchives(join(f.directory, 'archives.json'), join(f.directory, 'archives'), { perOwner: 1, total: 5, bytes: 1_000_000 });
    const snapshot = { spec: f.spec, pulls: [], mirror: null };
    const result = await Promise.allSettled([archives.create(f.git, snapshot), archives.create(f.git, snapshot)]);
    assert.equal(result.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(result.filter((r) => r.status === 'rejected').length, 1);
    assert.equal(archives.list('sso:owner').length, 1);
    const tiny = new AgentArchives(join(f.directory, 'tiny.json'), join(f.directory, 'tiny'), { perOwner: 5, total: 5, bytes: 1 });
    await assert.rejects(tiny.create(f.git, snapshot), /storage quota/);
    assert.equal(tiny.list('sso:owner').length, 0);
    assert.equal(await f.git.resolve(f.spec.id, 'main'), f.second);
    const bad = join(f.directory, 'bad.bundle'); writeFileSync(bad, 'not a bundle');
    await assert.rejects(f.git.restoreBundle('broken-restore', bad));
    assert.equal(f.git.exists('broken-restore'), false);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});
