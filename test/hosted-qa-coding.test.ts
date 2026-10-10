import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GitHubSnapshot, sourcePath } from '../examples/qa-agent/repository.mjs';
import { CodingSession } from '../examples/qa-agent/coding.mjs';

const commit = 'a'.repeat(40), blob = 'b'.repeat(40);
function snapshot(files = { 'src/sum.js': 'export const sum = (a, b) => a - b;\n' }) {
  return { repository: 'example/product', commit, list: async () => Object.keys(files), read: async path => {
    if (!Object.hasOwn(files, path)) throw new Error('Source file not found'); return files[path];
  } };
}
const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const assistant = (calls, content = null) => ({ finish_reason: calls.length ? 'tool_calls' : 'stop', message: { role: 'assistant', content, tool_calls: calls } });

test('native coding uses model tool calls, resumes on the pinned commit, and stops at validation', async () => {
  const initial = new CodingSession(snapshot(), '덧셈을 고쳐줘.');
  const read = await initial.step({ llm: { chat: async () => assistant([call('read', 'read_file', { path: 'src/sum.js', startLine: 1 })]) } });
  const resumed = new CodingSession(snapshot(), '덧셈을 고쳐줘.', JSON.parse(JSON.stringify(read)));
  await resumed.step({ llm: { chat: async request => {
    assert.ok(request.messages.some(m => m.role === 'tool' && m.content.includes('a - b')));
    return assistant([call('edit', 'replace_text', { path: 'src/sum.js', oldText: 'a - b', newText: 'a + b' }),
      call('test', 'create_file', { path: 'test/sum.js', content: "import { sum } from '../src/sum.js';\nif (sum(2, 3) !== 5) throw new Error('sum');\n" })]);
  } } });
  const result = await resumed.step({ llm: { chat: async () => assistant([], '덧셈과 회귀 테스트를 수정했습니다. 검증이 필요합니다.') } });
  assert.equal(result.phase, 'needs_validation'); assert.match(result.changes['src/sum.js'], /a \+ b/);
  assert.equal('approved' in result, false); assert.equal('merged' in result, false);
  assert.throws(() => new CodingSession({ ...snapshot(), commit: 'c'.repeat(40) }, '덧셈을 고쳐줘.', result), /another request or revision/);
});

test('edits require exact text actually read, ambiguity fails, and paths cannot escape the snapshot', async () => {
  const session = new CodingSession(snapshot({ 'src/x.js': 'first\nrepeat\nrepeat\nlast' }), '반복 문제 고쳐줘.');
  await assert.rejects(session.tool('replace_text', { path: 'src/x.js', oldText: 'first', newText: 'next' }), /Read the exact/);
  await session.tool('read_file', { path: 'src/x.js', startLine: 1 });
  await assert.rejects(session.tool('replace_text', { path: 'src/x.js', oldText: 'repeat', newText: '' }), /exactly once/);
  for (const path of ['../x', '/tmp/x', 'src/../../x', '.git/config', '.env', '.env.local', 'src\\x', 'a\u0000b']) {
    assert.equal(sourcePath(path), false);
    await assert.rejects(session.tool('create_file', { path, content: 'x' }), /Invalid source path/);
  }
  await assert.rejects(session.tool('create_file', { path: 'src/x.js', content: 'x' }), /already exists/);
});

test('partial reads do not grant unseen text; successful edits must be re-read', async () => {
  const session = new CodingSession(snapshot({ 'large.js': Array.from({ length: 400 }, (_, i) => `line-${i}`).join('\n') }), '마지막 줄 고쳐줘.');
  await session.tool('read_file', { path: 'large.js', startLine: 1 });
  await assert.rejects(session.tool('replace_text', { path: 'large.js', oldText: 'line-399', newText: 'last' }), /Read the exact/);
  await session.tool('read_file', { path: 'large.js', startLine: 399 });
  await session.tool('replace_text', { path: 'large.js', oldText: 'line-399', newText: 'last' });
  await assert.rejects(session.tool('replace_text', { path: 'large.js', oldText: 'last', newText: 'another' }), /Read the exact/);
});

test('malformed/truncated model responses roll back a step and never produce a validation-ready candidate', async () => {
  const session = new CodingSession(snapshot(), '덧셈 고쳐줘.');
  const before = JSON.stringify(session.state);
  for (const reply of [assistant([], '다 했습니다'), { ...assistant([call('r', 'list_files', { contains: '' })]), finish_reason: 'length' },
    assistant([call('r', 'list_files', { contains: '' }), call('r', 'list_files', { contains: '' })])]) {
    await assert.rejects(session.step({ llm: { chat: async () => reply } }));
    assert.equal(JSON.stringify(session.state), before);
  }
  const result = await session.step({ llm: { chat: async () => assistant([call('bad', 'deploy', { target: 'main' })]) } });
  assert.equal(result.phase, 'coding'); assert.equal(Object.keys(result.changes).length, 0);
  assert.match(result.messages.at(-1).content, /Invalid source path|Unknown coding tool/);
});

test('GitHub snapshot reads only configured repository at immutable revision and refuses partial trees', async () => {
  const seen = [];
  const text = 'export const sum = (a, b) => a - b;\n';
  const ctx = { secret: () => 'private-read-token', fetch: async (url, init) => {
    seen.push({ url, init });
    return Response.json(url.includes('/git/trees/') ? { truncated: false, tree: [
      { path: 'src/sum.js', type: 'blob', mode: '100644', sha: blob, size: Buffer.byteLength(text) },
      { path: 'link', type: 'blob', mode: '120000', sha: blob, size: 10 },
      { path: '.env', type: 'blob', mode: '100644', sha: blob, size: 10 },
    ] } : { sha: blob, encoding: 'base64', content: Buffer.from(text).toString('base64') });
  } };
  const repository = new GitHubSnapshot(ctx, 'example/product', commit);
  assert.deepEqual(await repository.list(), ['src/sum.js']); assert.equal(await repository.read('src/sum.js'), text);
  assert.equal(await repository.read('src/sum.js'), text); assert.equal(seen.length, 2);
  assert.match(seen[0].url, new RegExp(`/git/trees/${commit}\\?recursive=1$`));
  assert.ok(seen.every(r => r.init.redirect === 'error' && !r.init.method));
  assert.throws(() => new GitHubSnapshot(ctx, '../product', commit), /Repository/);
  assert.throws(() => new GitHubSnapshot(ctx, 'example/product', 'main'), /full commit/);
  const incomplete = new GitHubSnapshot({ secret: () => undefined, fetch: async () => Response.json({ truncated: true, tree: [] }) }, 'example/product', commit);
  await assert.rejects(incomplete.list(), /Complete repository tree/);
});

test('bounded model context retains complete tool exchanges and candidate file memory', async () => {
  const session = new CodingSession(snapshot(), '덧셈 고쳐줘.');
  for (let n = 0; n < 20; n++) {
    session.state.messages.push({ role: 'assistant', content: null, tool_calls: [call(`r${n}`, 'read_file', { path: 'src/sum.js', startLine: 1 })] },
      { role: 'tool', tool_call_id: `r${n}`, content: 'x'.repeat(5000) });
  }
  session.state.changes['src/sum.js'] = 'changed';
  const messages = session.modelMessages();
  assert.ok(Buffer.byteLength(JSON.stringify(messages)) < 16_000);
  assert.ok(messages[2].content.includes('src/sum.js'));
  const ids = new Set(messages.flatMap(m => m.tool_calls ?? []).map(c => c.id));
  for (const message of messages.filter(m => m.role === 'tool')) assert.ok(ids.has(message.tool_call_id));
  assert.ok(messages.some(m => m.tool_call_id === 'r19'));
});
