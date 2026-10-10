/**
 * The feature as a person meets it: create an agent, clone it, edit the prompt, push, and the agent that
 * answers is the one you pushed.
 *
 * Against a real node — its routes, its store, its host — because every seam this crosses is one where a
 * design can be right and the wiring wrong: the git routes must be mounted above the JSON parser, the push
 * must authenticate the way git can, and `store.update` + `host.apply` must be what a push ends in. A unit
 * test of any one piece would pass with all three miswired.
 *
 *   node --test --import tsx test/agent-git-node.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createIdentity, defaultConfig, type NodeConfig } from '@ainize/core';
import { startNode, type RunningNode } from '../src/server.js';
import { personalSign } from './fixtures/metamask.js';

const exec = promisify(execFile);
const tmp = mkdtempSync(join(tmpdir(), 'ainize-git-node-'));
const PORT = 24401;
const HOME = join(tmp, 'home');
const url = `http://127.0.0.1:${PORT}`;
const PERSON = createIdentity();
const MODEL = 'test-model';

let N: RunningNode;
let session = '';
let apiKey = '';

/** Asynchronous, always: the node serves from this event loop, and a sync git call would deadlock both. */
const git = async (args: string[], env?: NodeJS.ProcessEnv) => {
  const { stdout, stderr } = await exec('git', args, { encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env } });
  return stdout + stderr;
};
const call = async (method: string, path: string, body?: unknown, token = session) => {
  const r = await fetch(`${url}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) as Record<string, never> };
};

before(async () => {
  const cfg: NodeConfig = defaultConfig({ home: HOME, name: 'git-node', port: PORT, peers: [], roles: ['seller'], ledger: 'local' });
  cfg.runtime = { repo: undefined, api: 'http://127.0.0.1:1', hookApi: 'http://127.0.0.1:1' };
  cfg.host = '127.0.0.1'; cfg.publicUrl = url;
  cfg.verifier = { quorum: 1, allowSelfAttest: true, intervalMs: 300_000, auto: false };
  // A model the node says it serves: an agent may only be built on one, and nothing here ever calls it — what
  // is under test is the repository and the push, not a turn.
  cfg.backends = [{ id: 'fake', modality: 'chat', upstream: 'http://127.0.0.1:1', models: [MODEL], concurrency: 1 }];
  cfg.gossipIntervalMs = 60_000;
  N = await startNode(cfg, { home: HOME, quiet: true, serveWeb: false });

  const ch = (await call('POST', '/api/auth/challenge', { scheme: 'eip191' })).body as unknown as { nonce: string; message: string };
  const signed = await call('POST', '/api/auth/wallet', { address: PERSON.address, nonce: ch.nonce, signature: personalSign(ch.message, PERSON.privateKey) });
  session = (signed.body as unknown as { token: string }).token;
  const key = await call('POST', '/api/keys', { label: 'git' });
  apiKey = (key.body as unknown as { api_key?: string }).api_key ?? '';
});
after(async () => { await N?.stop(); rmSync(tmp, { recursive: true, force: true }); });

test('an agent created through the API is a repository with its first commit', async () => {
  const made = await call('POST', '/api/hosted-agents', {
    id: 'desk', name: 'Desk', description: 'A desk.', model: MODEL, systemPrompt: 'You are a desk.',
  });
  assert.equal(made.status, 201, JSON.stringify(made.body));

  const dir = join(tmp, 'clone');
  await git(['clone', '--quiet', `${url}/git/desk.git`, dir], { GIT_ASKPASS: 'echo' });
  assert.equal(readFileSync(join(dir, 'prompt.md'), 'utf8'), 'You are a desk.');
  const agent = JSON.parse(readFileSync(join(dir, 'agent.json'), 'utf8')) as Record<string, unknown>;
  assert.equal(agent.name, 'Desk');
  assert.ok(!('owner' in agent), 'the node owns the owner field, so it is not in the tree');

  const log = await git(['-C', dir, 'log', '--format=%s']);
  assert.match(log, /Create desk/);
});

test('a push with an API key updates the agent the node serves — same moment, no deploy step', async () => {
  const dir = join(tmp, 'clone');
  const remote = `http://x:${apiKey}@127.0.0.1:${PORT}/git/desk.git`;
  await git(['-C', dir, 'config', 'user.name', 'A Person']);
  await git(['-C', dir, 'config', 'user.email', 'person@example.com']);
  writeFileSync(join(dir, 'prompt.md'), 'You are a careful desk.');
  await git(['-C', dir, 'commit', '-qam', 'Be careful']);
  const out = await git(['-C', dir, 'push', '--quiet', remote, 'main']);
  assert.ok(!/rejected/.test(out), out);

  // Read back through the API: this is what every live address, and every importer, now resolves to.
  const after = await call('GET', '/api/hosted-agents/desk');
  const spec = (after.body as unknown as { agent: { systemPrompt: string; version: number } }).agent;
  assert.equal(spec.systemPrompt, 'You are a careful desk.', 'the push is the deploy');
  assert.equal(spec.version, 2, 'and it is a release, so anything pinning a version sees a new one');
});

test('somebody else cannot push, whatever key they hold', async () => {
  const other = createIdentity();
  const ch = (await call('POST', '/api/auth/challenge', { scheme: 'eip191' })).body as unknown as { nonce: string; message: string };
  const signed = await call('POST', '/api/auth/wallet', { address: other.address, nonce: ch.nonce, signature: personalSign(ch.message, other.privateKey) });
  const theirSession = (signed.body as unknown as { token: string }).token;
  const theirKey = ((await call('POST', '/api/keys', { label: 'theirs' }, theirSession)).body as unknown as { api_key: string }).api_key;

  const dir = join(tmp, 'clone');
  writeFileSync(join(dir, 'prompt.md'), 'Mine now.');
  await git(['-C', dir, 'commit', '-qam', 'Take it over']);
  let failed = '';
  try { await git(['-C', dir, 'push', `http://x:${theirKey}@127.0.0.1:${PORT}/git/desk.git`, 'main'], { GIT_ASKPASS: 'echo' }); }
  catch (e) { const x = e as { stdout?: string; stderr?: string }; failed = `${x.stdout ?? ''}${x.stderr ?? ''}`; }
  assert.match(failed, /not allowed to push|403|401|Authentication/);

  const after = await call('GET', '/api/hosted-agents/desk');
  assert.equal((after.body as unknown as { agent: { systemPrompt: string } }).agent.systemPrompt, 'You are a careful desk.', 'and nothing moved');
  await git(['-C', dir, 'reset', '--hard', 'HEAD~1']);
});

test('an edit made through the API is a commit too — one history, not one per door', async () => {
  const current = ((await call('GET', '/api/hosted-agents/desk')).body as unknown as { agent: Record<string, unknown> }).agent;
  const put = await call('PUT', '/api/hosted-agents/desk', {
    id: 'desk', name: 'Desk', description: current.description, model: current.model, systemPrompt: 'Edited in the browser.',
  });
  assert.equal(put.status, 200, JSON.stringify(put.body));

  const dir = join(tmp, 'clone');
  await git(['-C', dir, 'fetch', '--quiet', 'origin']);
  const log = await git(['-C', dir, 'log', '--format=%s%x1f%an', 'origin/main', '-3']);
  assert.match(log, /Update desk \(v3\)/, 'the API edit shows up in the history');
  assert.match(log, new RegExp(PERSON.address.toLowerCase().slice(0, 10)), 'authored by the person who made it, not by the node');
  assert.equal((await git(['-C', dir, 'show', 'origin/main:prompt.md'])), 'Edited in the browser.');
});

/**
 * The history, through the API a page reads.
 *
 * The point of putting an agent in git is that somebody can answer "what changed and who changed it" without
 * cloning anything, so the answer has to exist over HTTP. The refusals matter as much: a ref is a string a
 * caller supplies, and it is about to be an argument to `git`.
 */
test('a page can read the history, the branches and a diff without cloning', async () => {
  const commits = await call('GET', '/api/hosted-agents/desk/commits?limit=10');
  assert.equal(commits.status, 200);
  const body = commits.body as unknown as { commits: { subject: string; author: string; short: string }[]; clone_url: string };
  assert.equal(body.clone_url, `${url}/git/desk.git`, 'the page can tell a person where to clone from');
  assert.deepEqual(body.commits.map((c) => c.subject), ['Update desk (v3)', 'Be careful', 'Create desk']);
  assert.match(body.commits[0]!.short, /^[0-9a-f]{7,}$/);

  const refs = await call('GET', '/api/hosted-agents/desk/refs');
  assert.deepEqual((refs.body as unknown as { branches: { name: string }[] }).branches.map((b) => b.name), ['main']);

  const diff = await call('GET', '/api/hosted-agents/desk/diff?base=HEAD~1&head=HEAD');
  assert.match((diff.body as unknown as { diff: string }).diff, /Edited in the browser/);

  const file = await call('GET', '/api/hosted-agents/desk/tree?path=prompt.md');
  assert.equal((file.body as unknown as { content: string }).content, 'Edited in the browser.');
});

test('a ref is a string somebody supplied, and it is about to be an argument to git', async () => {
  // `HEAD~1` and `main^` are how a page asks for "the one before", so they are accepted; the rest are not refs.
  for (const good of ['HEAD~1', 'main', 'main^']) {
    const r = await call('GET', `/api/hosted-agents/desk/commits?ref=${encodeURIComponent(good)}`);
    assert.notEqual(r.status, 400, `"${good}" is a ref and was refused`);
  }
  for (const bad of ['--upload-pack=touch%20pwned', 'main..main', '-x', '../../etc/passwd']) {
    const r = await call('GET', `/api/hosted-agents/desk/commits?ref=${encodeURIComponent(bad)}`);
    assert.equal(r.status, 400, `"${bad}" was accepted as a ref`);
    assert.equal((r.body as unknown as { error: { code: string } }).error.code, 'invalid_ref');
  }
});

test('the history is no more public than the agent it belongs to', async () => {
  const stranger = createIdentity();
  const ch = (await call('POST', '/api/auth/challenge', { scheme: 'eip191' })).body as unknown as { nonce: string; message: string };
  const theirs = ((await call('POST', '/api/auth/wallet', { address: stranger.address, nonce: ch.nonce, signature: personalSign(ch.message, stranger.privateKey) })).body as unknown as { token: string }).token;

  await call('PUT', '/api/hosted-agents/desk', { id: 'desk', name: 'Desk', description: 'A desk.', model: MODEL, systemPrompt: 'Edited in the browser.', visibility: 'private' });
  const r = await call('GET', '/api/hosted-agents/desk/commits', undefined, theirs);
  assert.equal(r.status, 404, 'a private agent\'s history is its owner\'s alone');
  const mine = await call('GET', '/api/hosted-agents/desk/commits');
  assert.equal(mine.status, 200);
});

/**
 * Pull requests: propose a branch, read it, merge it — and the merge is held to the bar a push is held to.
 *
 * The case that justifies the design is the last one here. Two trees that each pass validation can merge into
 * one that does not, so a merge button that trusted its inputs would be a way to deploy exactly the trees a
 * push refuses. The merge is built, the RESULT is validated, and only then does the deployed branch move.
 */
test('a branch is proposed, read back, and merging it is what deploys it', async () => {
  // Make the agent visible again (an earlier test made it private) and push a proposal.
  await call('PUT', '/api/hosted-agents/desk', { id: 'desk', name: 'Desk', description: 'A desk.', model: MODEL, systemPrompt: 'Edited in the browser.' });
  const dir = join(tmp, 'clone');
  const remote = `http://x:${apiKey}@127.0.0.1:${PORT}/git/desk.git`;
  await git(['-C', dir, 'fetch', '--quiet', 'origin']);
  await git(['-C', dir, 'reset', '--hard', '--quiet', 'origin/main']);
  await git(['-C', dir, 'checkout', '--quiet', '-B', 'friendlier']);
  writeFileSync(join(dir, 'prompt.md'), 'You are a friendly desk.');
  await git(['-C', dir, 'commit', '-qam', 'Be friendly']);
  await git(['-C', dir, 'push', '--quiet', remote, 'friendlier']);

  const live = await call('GET', '/api/hosted-agents/desk');
  assert.equal((live.body as unknown as { agent: { systemPrompt: string } }).agent.systemPrompt, 'Edited in the browser.', 'a branch deploys nothing by itself');

  const opened = await call('POST', '/api/hosted-agents/desk/pulls', { title: 'Be friendlier', head: 'friendlier' });
  assert.equal(opened.status, 201, JSON.stringify(opened.body));
  const pull = (opened.body as unknown as { pull: { number: number; state: string; base: string } }).pull;
  assert.equal(pull.number, 1);
  assert.equal(pull.base, 'main', 'a proposal is for the branch the node deploys from, unless it says otherwise');

  // What a reviewer reads before pressing merge.
  const diff = await call('GET', '/api/hosted-agents/desk/diff?base=main&head=friendlier');
  assert.match((diff.body as unknown as { diff: string }).diff, /friendly desk/);

  const merged = await call('POST', '/api/hosted-agents/desk/pulls/1/merge', {});
  assert.equal(merged.status, 200, JSON.stringify(merged.body));
  assert.equal((merged.body as unknown as { pull: { state: string } }).pull.state, 'merged');

  const after = await call('GET', '/api/hosted-agents/desk');
  assert.equal((after.body as unknown as { agent: { systemPrompt: string } }).agent.systemPrompt, 'You are a friendly desk.', 'merging is the deploy');
});

test('somebody who may not push may not merge either', async () => {
  const stranger = createIdentity();
  const ch = (await call('POST', '/api/auth/challenge', { scheme: 'eip191' })).body as unknown as { nonce: string; message: string };
  const theirs = ((await call('POST', '/api/auth/wallet', { address: stranger.address, nonce: ch.nonce, signature: personalSign(ch.message, stranger.privateKey) })).body as unknown as { token: string }).token;

  const dir = join(tmp, 'clone');
  const remote = `http://x:${apiKey}@127.0.0.1:${PORT}/git/desk.git`;
  await git(['-C', dir, 'checkout', '--quiet', '-B', 'theirs', 'origin/main']);
  writeFileSync(join(dir, 'prompt.md'), 'A stranger wrote this.');
  await git(['-C', dir, 'commit', '-qam', 'From a stranger']);
  await git(['-C', dir, 'push', '--quiet', remote, 'theirs']);

  const opened = await call('POST', '/api/hosted-agents/desk/pulls', { title: 'Mine', head: 'theirs' }, theirs);
  assert.equal(opened.status, 201, 'anyone who can see the agent can propose a change');
  const n = (opened.body as unknown as { pull: { number: number } }).pull.number;

  const refused = await call('POST', `/api/hosted-agents/desk/pulls/${n}/merge`, {}, theirs);
  assert.equal(refused.status, 403, 'but merging changes what the agent runs');
  const after = await call('GET', '/api/hosted-agents/desk');
  assert.equal((after.body as unknown as { agent: { systemPrompt: string } }).agent.systemPrompt, 'You are a friendly desk.');
});

test('a merge whose RESULT would not run is refused, and nothing moves', async () => {
  const dir = join(tmp, 'clone');
  const remote = `http://x:${apiKey}@127.0.0.1:${PORT}/git/desk.git`;
  await git(['-C', dir, 'fetch', '--quiet', 'origin']);
  await git(['-C', dir, 'checkout', '--quiet', '-B', 'breaks', 'origin/main']);
  // Each side is a valid agent on its own: this branch only edits agent.json, and main only edits prompt.md.
  const agent = JSON.parse(readFileSync(join(dir, 'agent.json'), 'utf8')) as Record<string, unknown>;
  writeFileSync(join(dir, 'agent.json'), JSON.stringify({ ...agent, model: '' }, null, 2));
  await git(['-C', dir, 'commit', '-qam', 'Drop the model']);
  // It cannot be pushed to main — but it is a perfectly pushable branch, which is the point.
  await git(['-C', dir, 'push', '--quiet', remote, 'breaks']);

  const opened = await call('POST', '/api/hosted-agents/desk/pulls', { title: 'Breaks it', head: 'breaks' });
  const n = (opened.body as unknown as { pull: { number: number } }).pull.number;
  const merged = await call('POST', `/api/hosted-agents/desk/pulls/${n}/merge`, {});
  assert.equal(merged.status, 409, JSON.stringify(merged.body));
  const err = (merged.body as unknown as { error: { code: string; message: string } }).error;
  assert.equal(err.code, 'would_not_run');
  assert.match(err.message, /Nothing was merged/);

  const still = await call('GET', '/api/hosted-agents/desk');
  assert.equal((still.body as unknown as { agent: { systemPrompt: string } }).agent.systemPrompt, 'You are a friendly desk.', 'the agent is untouched');
  const open = await call('GET', '/api/hosted-agents/desk/pulls?state=open');
  assert.ok((open.body as unknown as { pulls: { number: number }[] }).pulls.some((p) => p.number === n), 'and the proposal stays open');
});

/**
 * What a product importing this agent is told.
 *
 * ainteams and ainmem import an agent by its A2A address, so a push updating it in place is what makes "push
 * once, every importer updates" true. But an importer deciding whether to depend on an agent is asking what it
 * is about to depend on, and `version: 7` does not answer that. The commit does — and if the agent follows a
 * repository somewhere else, the honest answer names that repository, because that is where its history is.
 */
test('every agent row says where to clone it and which commit is live', async () => {
  const r = await call('GET', '/api/hosted-agents/desk');
  const agent = (r.body as unknown as { agent: { a2a_url: string; version: number; git: { clone_url: string; commit: string; mirror: unknown } } }).agent;

  // The address importers hold, unchanged by any push: that is what makes one push reach all of them.
  assert.equal(agent.a2a_url, `${url}/agents/desk`);
  assert.equal(agent.git.clone_url, `${url}/git/desk.git`);
  assert.match(agent.git.commit, /^[0-9a-f]{40}$/);
  assert.equal(agent.git.mirror, null, 'this one is not following anybody');

  // And it is the commit the repository actually has, not a number that happens to look like one.
  const head = (await git(['--git-dir', join(HOME, 'data', 'agent-git', 'desk.git'), 'rev-parse', 'main'])).trim();
  assert.equal(agent.git.commit, head);
});

test('a reader proposes from a private fork, and merging uses the recorded commit after the fork changes or is deleted', async () => {
  const person = createIdentity();
  const challenge = (await call('POST', '/api/auth/challenge', { scheme: 'eip191' })).body as unknown as { nonce: string; message: string };
  const login = await call('POST', '/api/auth/wallet', { nonce: challenge.nonce, address: person.address, signature: personalSign(challenge.message, person.privateKey) });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  const token = (login.body as unknown as { token: string }).token;
  const keyed = await call('POST', '/api/keys', { label: 'fork' }, token);
  const key = (keyed.body as unknown as { api_key: string }).api_key;
  const made = await call('POST', '/api/hosted-agents/desk/forks', {}, token);
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const fork = (made.body as unknown as { fork: { id: string; owner: string; baseCommit: string } }).fork;
  assert.equal(fork.owner, person.address.toLowerCase());
  assert.equal((await call('POST', '/api/hosted-agents', { id: fork.id, name: 'Replace private fork', model: MODEL }, token)).status, 409, 'an agent cannot take a private repository id');
  assert.equal((await call('GET', `/api/hosted-agents/${fork.id}`)).status, 404, 'forks never create a running agent');
  assert.equal((await call('GET', `/api/hosted-agents/${fork.id}/refs`)).status, 404, 'a fork is private even to the original owner');
  assert.equal((await call('GET', `/api/hosted-agents/${fork.id}/refs`, undefined, token)).status, 200);
  const previewResponse = await call('POST', '/api/hosted-agents/desk/previews', { ref: fork.baseCommit }, token);
  assert.equal(previewResponse.status, 202, JSON.stringify(previewResponse.body));
  const previewId = (previewResponse.body as unknown as { preview: { id: string } }).preview.id;
  assert.equal((await call('GET', `/api/agent-previews/${previewId}`, undefined, token)).status, 200);
  assert.equal((await call('GET', `/api/agent-previews/${previewId}`)).status, 404);
  assert.equal((await call('POST', '/api/hosted-agents', { id: previewId, name: 'Replace preview', model: MODEL }, token)).status, 409);
  assert.equal((await call('DELETE', `/api/agent-previews/${previewId}`, undefined, token)).status, 200);
  const remote = `http://x:${key}@127.0.0.1:${PORT}/git/${fork.id}.git`;
  const dir = join(tmp, 'private-fork');
  await git(['clone', '--quiet', remote, dir]);
  await git(['-C', dir, 'config', 'user.name', 'Reviewer']);
  await git(['-C', dir, 'config', 'user.email', 'reviewer@example.com']);
  writeFileSync(join(dir, 'prompt.md'), 'The reviewed proposal.');
  await git(['-C', dir, 'commit', '-qam', 'Proposed change']);
  await git(['-C', dir, 'push', '--quiet', 'origin', 'main']);
  const snapshot = (await git(['-C', dir, 'rev-parse', 'HEAD'])).trim();
  assert.equal((await call('POST', '/api/hosted-agents/desk/pulls', { title: 'Steal fork', headAgent: fork.id, head: 'main' })).status, 403);
  const opened = await call('POST', '/api/hosted-agents/desk/pulls', { title: 'Proposal from a reader', headAgent: fork.id, head: 'main' }, token);
  assert.equal(opened.status, 201, JSON.stringify(opened.body));
  const pull = (opened.body as unknown as { pull: { number: number; headCommit: string } }).pull;
  assert.equal(pull.headCommit, snapshot);
  writeFileSync(join(dir, 'prompt.md'), 'A later, unreviewed change.');
  await git(['-C', dir, 'commit', '-qam', 'Later change']);
  await git(['-C', dir, 'push', '--quiet', 'origin', 'main']);
  assert.equal((await call('DELETE', `/api/agent-forks/${fork.id}`, undefined, token)).status, 200);
  assert.equal((await call('POST', `/api/hosted-agents/desk/pulls/${pull.number}/merge`, {}, token)).status, 403);
  const merged = await call('POST', `/api/hosted-agents/desk/pulls/${pull.number}/merge`, {});
  assert.equal(merged.status, 200, JSON.stringify(merged.body));
  const live = (await call('GET', '/api/hosted-agents/desk')).body as unknown as { agent: { systemPrompt: string } };
  assert.equal(live.agent.systemPrompt, 'The reviewed proposal.');
});
