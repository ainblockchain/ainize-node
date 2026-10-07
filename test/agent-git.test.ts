/**
 * An agent's repository: the tree is the spec, and the spec is the tree.
 *
 * Against real `git`, deliberately. The thing on the other end of a push is ordinary git on somebody's laptop,
 * and a test that mocks it proves only that this file agrees with itself. What is pinned here is the round trip
 * (a spec written as a commit reads back as the same spec), that the node's own fields cannot be set by editing
 * a file, and that a tree which would have been refused as a POST is refused as a push — with the reason.
 *
 *   node --test --import tsx test/agent-git.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { AgentGit, AgentGitError, AGENT_GIT_DEFAULT_BRANCH, agentJsonOf } from '../src/agent-git.js';
import { hostedAgentSpecInput, type HostedAgentSpecInput } from '../src/hosted-agent-types.js';

const tmp = mkdtempSync(join(tmpdir(), 'ainize-agent-git-'));
let git: AgentGit;

const spec = (over: Partial<HostedAgentSpecInput> = {}): HostedAgentSpecInput =>
  hostedAgentSpecInput.parse({ id: 'news-review', name: 'News review', description: 'Scores an article.', model: 'Qwen3.8-Flash-Next', systemPrompt: 'You are a news desk.', ...over });

/** A clone, edited the way a person edits one, and pushed back. */
function clone(id: string, into: string): (args: string[], input?: string) => string {
  execFileSync('git', ['clone', '--quiet', git.dir(id), into], { encoding: 'utf8' });
  const run = (args: string[]) => execFileSync('git', ['-C', into, ...args], { encoding: 'utf8' });
  run(['config', 'user.name', 'A Person']);
  run(['config', 'user.email', 'person@example.com']);
  return run;
}

before(async () => {
  git = new AgentGit(join(tmp, 'agent-git'));
  await git.init('news-review');
});
after(() => rmSync(tmp, { recursive: true, force: true }));

test('a spec written as a commit reads back as the same spec', async () => {
  const s = spec();
  const sha = await git.commitSpec('news-review', { ...s, id: 'news-review' }, { message: 'Create the agent' });
  assert.match(sha, /^[0-9a-f]{40}$/);

  const read = await git.readSpec('news-review', AGENT_GIT_DEFAULT_BRANCH);
  assert.equal(read.commit, sha);
  assert.deepEqual(read.input, s, 'what goes in is what comes out — otherwise a push silently changes the agent');

  // The prompt is its own file because a prompt is prose and the point of this whole exercise is a readable diff.
  assert.equal(await git.show('news-review', sha, 'prompt.md'), 'You are a news desk.');
  const json = JSON.parse((await git.show('news-review', sha, 'agent.json'))!) as Record<string, unknown>;
  assert.deepEqual(json, agentJsonOf(s));
  assert.ok(!('id' in json) && !('owner' in json) && !('version' in json), 'the node owns those, so they are not in the tree');
});

test('code lands under files/, and comes back keyed the way the spec keys it', async () => {
  await git.init('tool-agent');
  const s = spec({ id: 'tool-agent', mode: 'tools', files: { 'index.mjs': 'export default {}\n', 'lib/util.mjs': 'export const x = 1\n' } });
  await git.commitSpec('tool-agent', { ...s, id: 'tool-agent' }, { message: 'first' });
  assert.deepEqual((await git.lsFiles('tool-agent', 'main')).sort(), ['agent.json', 'files/index.mjs', 'files/lib/util.mjs', 'prompt.md']);
  const read = await git.readSpec('tool-agent', 'main');
  assert.deepEqual(Object.keys(read.input.files).sort(), ['index.mjs', 'lib/util.mjs'], 'a nested path survives the round trip');
});

test('a person edits a clone and the node reads what they meant', async () => {
  const dir = join(tmp, 'work');
  const run = clone('news-review', dir);
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(dir, 'prompt.md'), 'You are a careful news desk.\n');
  run(['commit', '-qam', 'Say careful']);
  run(['push', '--quiet', 'origin', 'main']);

  const read = await git.readSpec('news-review', 'main');
  assert.equal(read.input.systemPrompt, 'You are a careful news desk.\n');
  const log = await git.log('news-review');
  assert.equal(log[0]!.subject, 'Say careful');
  assert.equal(log[0]!.author, 'A Person', 'the history names the person, which is the question a version number could not answer');
  assert.equal(log.length, 2);
});

test('a tree that would be refused as a POST is refused as a push, with the reason', async () => {
  const dir = join(tmp, 'bad');
  const run = clone('news-review', dir);
  const { writeFileSync } = await import('node:fs');
  const agent = JSON.parse(execFileSync('cat', [join(dir, 'agent.json')], { encoding: 'utf8' })) as Record<string, unknown>;

  // prompt mode runs no code — the schema says so, and the repository must not be a way around the schema.
  writeFileSync(join(dir, 'agent.json'), JSON.stringify({ ...agent, mode: 'prompt' }, null, 2));
  const { mkdirSync } = await import('node:fs');
  mkdirSync(join(dir, 'files'), { recursive: true });
  writeFileSync(join(dir, 'files/index.mjs'), 'export default {}\n');
  run(['add', '-A']); run(['commit', '-qm', 'Smuggle code into a prompt agent']); run(['push', '--quiet', 'origin', 'HEAD:refs/heads/sneaky']);

  await assert.rejects(() => git.readSpec('news-review', 'sneaky'), (e: AgentGitError) => {
    assert.match(e.message, /not a valid agent/);
    assert.match(e.message, /prompt mode runs no code/);
    return true;
  });
});

test('the node owns the id, and a file cannot take it', async () => {
  const dir = join(tmp, 'rename');
  const run = clone('news-review', dir);
  const { writeFileSync, readFileSync } = await import('node:fs');
  const agent = JSON.parse(readFileSync(join(dir, 'agent.json'), 'utf8')) as Record<string, unknown>;
  writeFileSync(join(dir, 'agent.json'), JSON.stringify({ ...agent, id: 'somebody-elses-address', version: 99 }, null, 2));
  run(['commit', '-qam', 'Rename myself']); run(['push', '--quiet', 'origin', 'HEAD:refs/heads/rename']);

  await assert.rejects(() => git.readSpec('news-review', 'rename'), (e: AgentGitError) => {
    // Refused, not ignored: a field that looks writable and is not is a trap.
    assert.match(e.message, /sets id, version, which the node owns/);
    assert.match(e.message, /public address/);
    return true;
  });
});

test('branches say how far a proposal has moved, which is what makes it reviewable', async () => {
  const { branches, head } = await git.refs('news-review');
  assert.equal(head, 'main');
  const names = branches.map((b) => b.name).sort();
  assert.deepEqual(names, ['main', 'rename', 'sneaky']);
  const sneaky = branches.find((b) => b.name === 'sneaky')!;
  assert.equal(sneaky.ahead, 1, 'one commit the main branch does not have');
  assert.equal(sneaky.behind, 0);
  assert.equal(branches.find((b) => b.name === 'main')!.ahead, undefined, 'main is not ahead of itself');

  const { diff } = await git.diff('news-review', 'main', 'sneaky');
  assert.match(diff, /files\/index\.mjs/, 'the diff is what a reviewer reads');
});

test('an empty repository says it is empty, in words a person can act on', async () => {
  await git.init('empty-agent');
  await assert.rejects(() => git.readSpec('empty-agent', 'main'), (e: Error) => {
    // git's own answer here is "fatal: Needed a single revision", which names neither the problem nor the fix.
    assert.match(e.message, /no commits yet — push one to main/);
    return true;
  });
  await assert.rejects(() => git.readSpec('news-review', 'no-such-branch'), (e: Error) => {
    assert.match(e.message, /no such ref "no-such-branch"/);
    return true;
  });
});
