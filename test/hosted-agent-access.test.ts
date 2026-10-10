import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, writeFileSync, readFileSync, symlinkSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { hostedAgentAccess } from '../src/hosted-agent-access.js';
import { HostedAgentDocker, prepareHostedAgentRuntimeContext } from '../src/hosted-agent-docker.js';

test('ACL command double: different UID receives only scoped access; failures propagate', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-acl-'));
  try {
    const calls: string[][] = [];
    const uid = process.getuid!() === 1000 ? 2000 : 1000;
    await hostedAgentAccess(join(dir, 'state'), 'state', async args => { calls.push(args); }, uid);
    assert.deepEqual(calls.map(c => c.slice(0, -1)), [
      ['--set', `u::rwx,u:${uid}:rwx,g::---,m::rwx,o::---`, '--'], ['-k', '--'],
      ['-d', '--set', `u::rwx,u:${process.getuid!()}:rwx,u:${uid}:rwx,g::---,m::rwx,o::---`, '--'],
    ]);
    calls.length = 0;
    await hostedAgentAccess(join(dir, 'same'), 'state', async args => { calls.push(args); }, process.getuid!());
    assert.equal(calls[0]![1], 'u::rwx,g::---,m::---,o::---');
    assert.equal(calls[2]![2], 'u::rwx,g::---,m::---,o::---');
    calls.length = 0;
    await hostedAgentAccess(join(dir, 'gateway'), 'gateway', async args => { calls.push(args); }, uid);
    assert.equal(calls[0]![1], `u::rwx,u:${uid}:r-x,g::---,m::r-x,o::---`);
    assert.equal(calls.length, 2);
    await assert.rejects(hostedAgentAccess(join(dir, 'state'), 'state', async () => { throw new Error('ACL unsupported'); }, uid), /ACL unsupported/);
    symlinkSync(join(dir, 'state'), join(dir, 'link'));
    await assert.rejects(hostedAgentAccess(join(dir, 'link'), 'state'), /expected type/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('identity/ACL doubles: reuse private runtime-owned state without mutation', async t => {
  const runtimeUid = process.getuid!();
  const dir = mkdtempSync(join(tmpdir(), 'agent-existing-'));
  chmodSync(dir, 0o700);
  writeFileSync(join(dir, 'saved'), 'existing state', { mode: 0o600 });
  const before = statSync(dir);
  // Only the API identity and ACL reader are doubles; files and mode checks are real.
  t.mock.method(process, 'getuid', () => runtimeUid === 2000 ? 2001 : 2000);
  let mutations = 0;
  const mutate = async () => { mutations++; };
  const inspect = async () => 'user::rwx\ngroup::---\nother::---\n';
  try {
    for (let restart = 0; restart < 2; restart++) {
      await hostedAgentAccess(dir, 'state', mutate, runtimeUid, inspect);
      assert.equal(readFileSync(join(dir, 'saved'), 'utf8'), 'existing state');
      assert.equal(statSync(dir).mode, before.mode);
      assert.equal(statSync(dir).uid, before.uid);
    }
    assert.equal(mutations, 0);
    await assert.rejects(hostedAgentAccess(dir, 'gateway', mutate, runtimeUid, inspect), /owned by the API host/);
    await assert.rejects(hostedAgentAccess(dir, 'state', mutate, runtimeUid + 10, inspect), /owned by the API host/);
    for (const mode of [0o770, 0o777, 0o750, 0o500]) {
      chmodSync(dir, mode);
      await assert.rejects(hostedAgentAccess(dir, 'state', mutate, runtimeUid, inspect), /private mode/);
    }
    chmodSync(dir, 0o700);
    await assert.rejects(hostedAgentAccess(dir, 'state', mutate, runtimeUid,
      async () => 'default:user::rwx\ndefault:group::rwx\ndefault:other::---'), /private default ACL/);
    await assert.rejects(hostedAgentAccess(dir, 'state', mutate, runtimeUid,
      async () => { throw Error('ACL read failed'); }), /ACL read failed/);
    assert.equal(mutations, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Docker command double: state survives starts and only the selected agent directory is mounted', async () => {
  // No real Docker invocation in this test. Cross-UID kernel enforcement is tested separately.
  const dir = mkdtempSync(join(tmpdir(), 'agent-state-'));
  const calls: string[][] = [];
  const docker = new HostedAgentDocker({ stateDir: join(dir, 'state'), gatewaySocketDir: join(dir, 'gateway'),
    workDir: join(dir, 'work'), runtimeImage: 'unused', network: 'internal', memory: '128m', cpus: 1, pidsLimit: 32, buildTimeoutMs: 1000 },
    async args => { calls.push(args); return { code: 0, stdout: args[0] === 'inspect' ? '172.20.0.2' : '', stderr: '' }; }, (path, kind) => hostedAgentAccess(path, kind, async () => {}));
  // Both Docker and ACL commands are explicit doubles, on every host UID.
  try {
    await docker.run('alpha', 1, {});
    writeFileSync(join(dir, 'state/alpha/value'), 'kept');
    await docker.run('alpha', 1, {});
    await docker.run('beta', 1, {});
    assert.equal(readFileSync(join(dir, 'state/alpha/value'), 'utf8'), 'kept');
    const runs = calls.filter(c => c[0] === 'run');
    assert.ok(runs[0]!.includes(`type=bind,src=${dir}/state/alpha,dst=/state`));
    assert.ok(!runs[2]!.join(' ').includes('/state/alpha'));
    assert.equal(runs[0]![runs[0]!.indexOf('--user') + 1], 'node');
    assert.equal(statSync(join(dir, 'state')).mode & 0o077, 0);
    await assert.rejects(docker.run('../alpha', 1, {}), /invalid agent id/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('permission preparation failure prevents Docker startup', async () => {
  let invoked = false;
  const docker = new HostedAgentDocker({ stateDir: '/unused', workDir: '/unused', runtimeImage: 'unused',
    network: 'none', memory: '128m', cpus: 1, pidsLimit: 32, buildTimeoutMs: 1000 },
    async () => { invoked = true; return { code: 0, stdout: '', stderr: '' }; },
    async () => { throw new Error('permission preparation failed'); });
  await assert.rejects(docker.run('alpha', 1, {}), /permission preparation failed/);
  assert.equal(invoked, false);
});

test('runtime exposes decoded state before import and preserves data across fresh processes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-import-'));
  try {
    await prepareHostedAgentRuntimeContext(join(dir, 'runtime'));
    // Compiled runtime resolves dependencies through this explicit test symlink.
    symlinkSync(join(process.cwd(), 'node_modules'), join(dir, 'runtime/node_modules'), 'dir');
    const alias = join(dir, 'runtime-alias');
    symlinkSync(join(dir, 'runtime'), alias, 'dir');
    const entry = join(dir, 'agent.mjs');
    writeFileSync(entry, `import {readFileSync,writeFileSync} from 'node:fs';
const path=process.env.AINIZE_AGENT_STATE_DIR+'/counter';
if(process.env.AINIZE_AGENT_TOKEN) throw Error('token exposed');
let n=0;try{n=Number(readFileSync(path,'utf8'))}catch{}
writeFileSync(path,String(n+1));throw Error('import-completed');`);
    for (let i = 1; i <= 2; i++) {
      await assert.rejects(promisify(execFile)(process.execPath, [join(alias, 'hostedAgentRuntimeMain.js')], {
        env: { ...process.env, AINIZE_AGENT_SPEC: '{}', AINIZE_AGENT_ENTRY: entry, AINIZE_AGENT_TOKEN: 'test-only',
          AINIZE_AGENT_STATE_DIR: 'b64:' + Buffer.from(dir).toString('base64') },
      }), { code: 1 });
      assert.equal(readFileSync(join(dir, 'counter'), 'utf8'), String(i));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
