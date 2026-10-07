/**
 * Push is the deploy — proven with a real `git push` over HTTP against the real server.
 *
 * Everything that makes this feature a claim rather than a diagram is in the seams: whether `git` on a laptop
 * can actually talk to it, whether a bad tree is refused BEFORE the ref moves, whether the person reads a
 * reason, and whether the agent that was running a second ago is running the pushed one now. None of that can
 * be checked by calling methods — so this starts the express app, clones over http://, commits, and pushes.
 *
 *   node --test --import tsx test/agent-git-http.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import express from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AgentGit } from '../src/agent-git.js';
import { AgentGitHttp } from '../src/agent-git-http.js';
import { hostedAgentSpecInput, type HostedAgentSpecInput } from '../src/hosted-agent-types.js';

const tmp = mkdtempSync(join(tmpdir(), 'ainize-git-http-'));
let git: AgentGit;
let server: Server;
let base = '';

/** What the node would have stored and applied: the test's stand-in for store.update + host.apply. */
const applied: { input: HostedAgentSpecInput; commit: string; by: string | null }[] = [];
let mayPush = true;
let mirror: { url: string } | null = null;

/**
 * Every git call here is ASYNCHRONOUS, and that is not a style choice.
 *
 * The server under test runs in this process. `execFileSync` blocks this process's event loop until git exits —
 * and git is waiting for an HTTP answer that this event loop is the only thing able to send. The two wait for
 * each other forever. A synchronous helper here deadlocks the whole file with no output at all.
 */
const exec = promisify(execFile);
const run = async (args: string[], env?: NodeJS.ProcessEnv) => {
  const { stdout, stderr } = await exec('git', args, { encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env } });
  return stdout + stderr;
};
const gitIn = (dir: string, args: string[], env?: NodeJS.ProcessEnv) => run(['-C', dir, ...args], env);
/** What a failed git command said — both streams, which is where a hook's message arrives. */
const failure = async (p: Promise<string>): Promise<string> => {
  try { await p; return ''; }
  catch (e) { const x = e as { stderr?: string; stdout?: string }; return `${x.stdout ?? ''}${x.stderr ?? ''}`; }
};

async function clone(id: string, into: string): Promise<void> {
  await run(['clone', '--quiet', `${base}/git/${id}.git`, into]);
  await gitIn(into, ['config', 'user.name', 'A Person']);
  await gitIn(into, ['config', 'user.email', 'person@example.com']);
}

before(async () => {
  git = new AgentGit(join(tmp, 'agent-git'));
  const app = express();
  const http = new AgentGitHttp({
    git,
    loopbackPort: () => (server.address() as AddressInfo).port,
    canPush: () => mayPush,
    canRead: () => true,
    mirrorOf: () => mirror,
    apply: async (id, input, commit, by) => { applied.push({ input, commit, by }); },
    log: () => {},
  });
  // Mounted before any body parser: a push IS the body, and a parser that has read it leaves nothing to pipe.
  app.use(http.router());
  app.use(express.json());
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  await git.init('news-review');
  http.installHooks('news-review');
  await git.commitSpec('news-review', {
    ...hostedAgentSpecInput.parse({ id: 'news-review', name: 'News review', model: 'Qwen3.8-Flash-Next', systemPrompt: 'You are a news desk.' }),
    id: 'news-review',
  }, { message: 'Create the agent' });
});
after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(tmp, { recursive: true, force: true });
});

test('an ordinary git clone works, and brings the agent as files', async () => {
  const dir = join(tmp, 'clone');
  await clone('news-review', dir);
  assert.equal(readFileSync(join(dir, 'prompt.md'), 'utf8'), 'You are a news desk.');
  const agent = JSON.parse(readFileSync(join(dir, 'agent.json'), 'utf8')) as Record<string, unknown>;
  assert.equal(agent.name, 'News review');
});

test('a push to main applies the new tree — which is what makes every live address serve it', async () => {
  const dir = join(tmp, 'clone');
  writeFileSync(join(dir, 'prompt.md'), 'You are a careful news desk.\n');
  await gitIn(dir, ['commit', '-qam', 'Say careful']);
  const out = await gitIn(dir, ['push', 'origin', 'main']);
  assert.ok(!/rejected/.test(out), out);

  assert.equal(applied.length, 1, 'the push applied exactly once');
  assert.equal(applied[0]!.input.systemPrompt, 'You are a careful news desk.\n');
  assert.equal(applied[0]!.commit, (await gitIn(dir, ['rev-parse', 'HEAD'])).trim(), 'the applied version names the commit it came from');
});

test('a tree that would not run is refused BEFORE the ref moves, and says why on the terminal', async () => {
  const dir = join(tmp, 'clone');
  const before = (await run(['--git-dir', git.dir('news-review'), 'rev-parse', 'main'])).trim();
  const agent = JSON.parse(readFileSync(join(dir, 'agent.json'), 'utf8')) as Record<string, unknown>;
  writeFileSync(join(dir, 'agent.json'), JSON.stringify({ ...agent, model: '' }, null, 2));
  await gitIn(dir, ['commit', '-qam', 'Forget the model']);

  const failed = await failure(gitIn(dir, ['push', 'origin', 'main']));
  assert.ok(failed, 'the push should have been refused');

  // The person's whole error message: what was refused, why, and what state they are in.
  assert.match(failed, /would not run/);
  assert.match(failed, /model/);
  assert.match(failed, /still serving what it was/);

  const after = (await run(['--git-dir', git.dir('news-review'), 'rev-parse', 'main'])).trim();
  assert.equal(after, before, 'main did not move — a refused push must not be a rewind somebody has to notice');
  assert.equal(applied.length, 1, 'and nothing was applied');
});

test('a work-in-progress branch is not held to the same bar — that is what branches are for', async () => {
  const dir = join(tmp, 'clone');
  const out = await gitIn(dir, ['push', 'origin', 'HEAD:refs/heads/wip']);
  assert.ok(!/rejected/.test(out), out);
  assert.equal(applied.length, 1, 'but it deploys nothing');
  await gitIn(dir, ['reset', '--hard', 'HEAD~1']);
});

test('main cannot be deleted: an agent with no main branch has nothing to serve', async () => {
  const dir = join(tmp, 'clone');
  const failed = await failure(gitIn(dir, ['push', 'origin', '--delete', 'main']));
  assert.match(failed, /cannot be deleted/);
});

test('somebody who may not push is asked for credentials rather than let in', async () => {
  mayPush = false;
  const dir = join(tmp, 'clone');
  writeFileSync(join(dir, 'prompt.md'), 'Whatever.\n');
  await gitIn(dir, ['commit', '-qam', 'Not mine to push']);
  const failed = await failure(gitIn(dir, ['push', 'origin', 'main'], { GIT_ASKPASS: 'echo' }));
  assert.match(failed, /Authentication|not allowed to push|403|401/);
  mayPush = true;
  await gitIn(dir, ['reset', '--hard', 'HEAD~1']);
});

test('a mirrored agent refuses a push and names the place to push instead', async () => {
  mirror = { url: 'https://github.com/ainblockchain/donga-science-admin' };
  const dir = join(tmp, 'clone');
  writeFileSync(join(dir, 'prompt.md'), 'Edited in the wrong copy.\n');
  await gitIn(dir, ['commit', '-qam', 'Wrong copy']);
  const failed = await failure(gitIn(dir, ['push', 'origin', 'main'], { GIT_ASKPASS: 'echo' }));
  assert.match(failed, /github\.com\/ainblockchain\/donga-science-admin/);
  mirror = null;
  await gitIn(dir, ['reset', '--hard', 'HEAD~1']);
});

test('the hook endpoint belongs to this node alone', async () => {
  const res = await fetch(`${base}/api/internal/agent-git/pre-receive`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ainize-agent-git': 'guessed' },
    body: JSON.stringify({ id: 'news-review', updates: [{ ref: 'refs/heads/main', before: '0'.repeat(40), after: '0'.repeat(40) }] }),
  });
  assert.equal(res.status, 403, 'approving a push is not something a stranger gets to do');
});
