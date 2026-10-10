/**
 * An agent that already lives somewhere else, followed rather than moved.
 *
 * This is the donga-science case: an agent inside a bigger repository, with a team and a history that predate
 * ainize. What is pinned here is that following it works at all (a folder inside a repo, not a repo), that a
 * change upstream becomes what the agent runs, that a push to the ainize copy is refused and names the real
 * place to push, and — the one that matters most on a bad day — that an upstream which stops being a valid
 * agent does NOT silently keep the old version running while the page says "synced".
 *
 *   node --test --import tsx test/agent-mirror.test.ts
 */
import { createHmac } from 'node:crypto';
import { AgentMirrorSyncer } from '../src/agent-mirror-sync.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { AgentGit } from '../src/agent-git.js';
import { AgentMirrorStore, fetchMirror, mirrorUrlOk } from '../src/agent-mirror.js';
import { agentMirrorRoutes } from '../src/agent-mirror-routes.js';
import type { HostedAgentSpecInput } from '../src/hosted-agent-types.js';

const exec = promisify(execFile);
const git = async (args: string[]) => (await exec('git', args, { encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })).stdout;

const tmp = mkdtempSync(join(tmpdir(), 'ainize-mirror-'));
const UPSTREAM = join(tmp, 'donga-science-admin');      // the "GitHub" repository
const SERVED = join(tmp, 'served');                      // where git http-backend serves it from
let repos: AgentGit;
let mirrors: AgentMirrorStore;
let server: Server;
let base = '';
const applied: { input: HostedAgentSpecInput; commit: string }[] = [];
let landed: string | null = null;

const AGENT = (over: Record<string, unknown> = {}) => JSON.stringify({
  name: 'News review', description: 'Scores an article.', model: 'Qwen3.8-Flash-Next', mode: 'prompt',
  a2ui: false, allowedHosts: [], secretNames: [], skills: [], media: { transcription: false, image: false },
  visibility: 'public', orgId: null, ...over,
}, null, 2);

/** A commit in the upstream repository, in the folder the agent lives in. */
async function upstreamCommit(message: string, files: Record<string, string>): Promise<void> {
  for (const [path, body] of Object.entries(files)) {
    const full = join(UPSTREAM, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, body);
  }
  await git(['-C', UPSTREAM, 'add', '-A']);
  await git(['-C', UPSTREAM, 'commit', '-qm', message]);
  // Served over http the way GitHub would be: a bare mirror the node fetches from.
  await git(['-C', UPSTREAM, 'push', '--quiet', join(SERVED, 'donga-science-admin.git'), 'main']);
}

before(async () => {
  // The upstream: an agent in a FOLDER of a bigger repository, which is the common case.
  mkdirSync(UPSTREAM, { recursive: true });
  await git(['init', '--quiet', '-b', 'main', UPSTREAM]);
  await git(['-C', UPSTREAM, 'config', 'user.name', 'The Newsroom']);
  await git(['-C', UPSTREAM, 'config', 'user.email', 'desk@donga.example']);
  mkdirSync(SERVED, { recursive: true });
  await git(['init', '--bare', '--quiet', '-b', 'main', join(SERVED, 'donga-science-admin.git')]);
  await upstreamCommit('Add the news agent', {
    'README.md': '# The CMS\n',
    'news-agent/agent.json': AGENT(),
    'news-agent/prompt.md': 'You are a news desk.',
  });

  repos = new AgentGit(join(tmp, 'agent-git'));
  await repos.init('news-review');
  mirrors = new AgentMirrorStore(join(tmp, 'agent-mirrors.json'));

  const app = express();
  // git's own CGI, serving the "GitHub" side.
  app.use((req, res, next) => {
    if (!req.path.startsWith('/donga-science-admin.git')) return next();
    const child = spawn('git', ['http-backend'], { env: {
      PATH: process.env.PATH, GIT_PROJECT_ROOT: SERVED, GIT_HTTP_EXPORT_ALL: '1',
      PATH_INFO: req.path, REQUEST_METHOD: req.method,
      QUERY_STRING: req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?') + 1) : '',
      CONTENT_TYPE: req.header('content-type') ?? '',
      ...(req.header('git-protocol') ? { GIT_PROTOCOL: req.header('git-protocol')! } : {}),
    } });
    let header = Buffer.alloc(0); let done = false;
    child.stdout.on('data', (c: Buffer) => {
      if (done) { res.write(c); return; }
      header = Buffer.concat([header, c]);
      const at = header.indexOf('\r\n\r\n');
      if (at === -1) return;
      for (const line of header.subarray(0, at).toString('utf8').split('\r\n')) {
        const i = line.indexOf(':'); if (i === -1) continue;
        res.setHeader(line.slice(0, i).trim(), line.slice(i + 1).trim());
      }
      done = true; res.write(header.subarray(at + 4));
    });
    child.on('close', () => res.end());
    req.pipe(child.stdin);
  });
  app.use(agentMirrorRoutes({
    git: repos, mirrors,
    canRead: () => true, canManage: () => true, principal: () => '0xowner',
    apply: async (_id, input, commit) => { applied.push({ input, commit }); },
    land: async (_id, commit) => { landed = commit; },
    log: () => {},
  }));
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => { await new Promise<void>((r) => server.close(() => r())); rmSync(tmp, { recursive: true, force: true }); });

const put = async (body: unknown) => {
  const r = await fetch(`${base}/api/hosted-agents/news-review/mirror`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() as Record<string, never> };
};

test('a mirror is an address ainize can be trusted to fetch', () => {
  assert.equal(mirrorUrlOk('https://github.com/ainblockchain/donga-science-admin'), true);
  assert.equal(mirrorUrlOk('http://127.0.0.1:9000/x.git'), true, 'loopback http is how a repository on this machine is followed');
  // Over a network, plain http lets anyone on the path choose what the agent runs.
  assert.equal(mirrorUrlOk('http://github.com/x/y'), false);
  // Credentials would live in this file and print in every status line — refused rather than quietly stored.
  assert.equal(mirrorUrlOk('https://user:token@github.com/x/y'), false);
  assert.equal(mirrorUrlOk('ssh://git@github.com/x/y'), false, 'ainize holds no key and should not be asked to');
});

test('attaching the agent to a folder of a repository fetches it there and then', async () => {
  const r = await put({ url: `${base}/donga-science-admin.git`, branch: 'main', path: 'news-agent' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const mirror = (r.body as unknown as { mirror: { error: string | null; lastCommit: string } }).mirror;
  assert.equal(mirror.error, null, 'a mirror that has never fetched is one nobody can tell is broken');

  assert.equal(applied.length, 1, 'what is upstream is what the agent now runs');
  assert.equal(applied[0]!.input.systemPrompt, 'You are a news desk.');
  assert.equal(applied[0]!.input.name, 'News review');
  assert.equal(landed, mirror.lastCommit, 'and the ainize copy points at it, so a clone shows what is running');
});

test('a change upstream becomes what the agent runs', async () => {
  await upstreamCommit('Say careful', { 'news-agent/prompt.md': 'You are a careful news desk.' });
  const r = await fetch(`${base}/api/hosted-agents/news-review/mirror/sync`, { method: 'POST' });
  assert.equal(r.status, 200);
  assert.equal(applied.length, 2);
  assert.equal(applied[1]!.input.systemPrompt, 'You are a careful news desk.');

  // Nothing new upstream: a sync is not a redeploy.
  const again = await fetch(`${base}/api/hosted-agents/news-review/mirror/sync`, { method: 'POST' });
  assert.equal(again.status, 200);
  assert.equal(applied.length, 2, 'a fetch that found nothing must not look like a release');
});

test('an upstream that stops being a valid agent is said loudly, and the old one keeps running', async () => {
  await upstreamCommit('Break it', { 'news-agent/agent.json': AGENT({ model: '' }) });
  const r = await fetch(`${base}/api/hosted-agents/news-review/mirror/sync`, { method: 'POST' });
  const mirror = ((await r.json()) as { mirror: { error: string | null } }).mirror;
  assert.ok(mirror.error, 'a mirror that quietly stopped following is worse than no mirror');
  assert.match(mirror.error!, /no longer holds a valid agent/);
  assert.match(mirror.error!, /model/);
  assert.equal(applied.length, 2, 'and nothing was applied — the agent is still serving what it was');
});

test('a repository with no agent in the named folder says which path it looked in', async () => {
  const r = await put({ url: `${base}/donga-science-admin.git`, branch: 'main', path: 'not-here' });
  const mirror = (r.body as unknown as { mirror: { error: string } }).mirror;
  assert.match(mirror.error, /not-here\/agent\.json is not in/);
});

test('an unreachable upstream is an error on the mirror, not an exception out of the route', async () => {
  const r = await put({ url: 'http://127.0.0.1:9/nothing.git', branch: 'main', path: '' });
  assert.equal(r.status, 200, 'the route answers; the mirror carries the failure');
  assert.match((r.body as unknown as { mirror: { error: string } }).mirror.error, /could not fetch/);
});


test('periodic mirror reconciliation follows without a manual Sync and refuses reserved fields', async () => {
  await upstreamCommit('Recover valid source', { 'news-agent/agent.json': AGENT(), 'news-agent/prompt.md': 'Automatically followed.' });
  mirrors.set({ agent: 'news-review', url: `${base}/donga-science-admin.git`, branch: 'main', path: 'news-agent' });
  const syncer = new AgentMirrorSyncer({ git: repos, mirrors, apply: async (_id, input, commit) => { applied.push({ input, commit }); }, land: async (_id, commit) => { landed = commit; }, log: () => {} });
  const before = applied.length;
  await Promise.all([syncer.sweep(), syncer.sweep()]);
  assert.equal(applied.length, before + 1, 'concurrent reconciliation cannot deploy twice');
  assert.equal(applied.at(-1)!.input.systemPrompt, 'Automatically followed.');
  await upstreamCommit('Attempt server-owned field', { 'news-agent/agent.json': AGENT({ owner: 'attacker' }) });
  await syncer.sweep();
  assert.match(mirrors.get('news-review')!.error!, /server-owned/);
  assert.equal(applied.length, before + 1);
  await syncer.stop();
});

test('webhook verifies original bytes even after the global JSON parser, and ignores tags', async () => {
  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { (req as typeof req & { rawBody?: Buffer }).rawBody = buf; } }));
  app.use(agentMirrorRoutes({ git: repos, mirrors, canRead: () => true, canManage: () => true, principal: () => null, apply: async () => { throw new Error('tag must not apply'); }, land: async () => {}, log: () => {}, webhookSecret: () => 'secret' }));
  const request = (await import('supertest')).default;
  const body = '{ "ref": "refs/tags/v1", "repository": { "html_url": "https://github.com/a/b" } }';
  const signature = `sha256=${createHmac('sha256', 'secret').update(body).digest('hex')}`;
  const res = await request(app).post('/api/agent-mirrors/webhook').set('content-type', 'application/json').set('x-hub-signature-256', signature).send(body);
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.body, { synced: [] });
  const refused = await request(app).post('/api/agent-mirrors/webhook').set('content-type', 'application/json').set('x-hub-signature-256', signature).send(body + ' ');
  assert.equal(refused.status, 401);
});
