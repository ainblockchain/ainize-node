/** Real kernel/Docker evidence. Run on both UID 1000 and a different non-root host UID.
 * A skipped run is controller-pending, never evidence of container access. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, chmodSync, statSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostedAgentAccess } from '../src/hosted-agent-access.js';
import { HostedAgentDocker, hostedAgentDockerAvailable, hostedAgentDockerExec } from '../src/hosted-agent-docker.js';
import { HostedAgentGateway } from '../src/hosted-agent-gateway.js';
import { hostedAgentSpecInput } from '../src/hosted-agent-types.js';
import { HostedAgentStore } from '../src/hosted-agent-store.js';

const enabled = process.env.AINIZE_TEST_UNIX_PERMISSIONS === '1';
for (const existing of [false, true]) test(`real Docker: ${existing ? 'runtime-owned existing' : 'new host-owned'} state/restart, Unix model calls and unrelated UID refusal`, {
  skip: !enabled && 'controller-pending: opt in on both host UID 1000 and a different UID with Docker and setfacl', timeout: 900_000,
}, async () => {
  assert.ok(await hostedAgentDockerAvailable(), 'requested real Docker verification requires a working daemon');
  assert.notEqual(process.getuid!(), 0, 'run the API fixture as a non-root host user');
  assert.equal(String(process.getuid!()), process.env.AINIZE_TEST_HOST_UID, 'declare the actual host UID as matrix evidence');
  const dir = mkdtempSync(join(tmpdir(), 'uds-permissions-'));
  const socketDir = join(dir, 'gateway');
  const stateDir = join(dir, 'state');
  const store = new HostedAgentStore(join(dir, 'specs.json'));
  const spec = store.create(hostedAgentSpecInput.parse({ id: `acl-${process.pid}`, name: 'ACL test', mode: 'handler', model: 'test-model', files: { 'index.mjs': '' } }), '0x00000000000000000000000000000000000a11ce');
  let calls = 0;
  let existingPrepared = false;
  const gateway = new HostedAgentGateway({ registry: () => null, spec: id => store.get(id), log: () => {}, peerChat: {
    self: '0x1', target: () => ({ address: '0x2' } as never),
    fetch: async () => { calls++; return Response.json({ choices: [{ message: { content: 'model-ok' } }] }); },
  } });
  const docker = new HostedAgentDocker({ stateDir, gatewaySocketDir: socketDir, workDir: join(dir, 'work'),
    runtimeImage: 'ainize/hosted-agent-permissions-test', network: 'none', memory: '256m', cpus: 1, pidsLimit: 64, buildTimeoutMs: 600_000 });
  const token = gateway.issue(spec.id);
  try {
    await gateway.listenUnix(join(socketDir, 'gateway.sock'));
    await hostedAgentAccess(join(stateDir, 'beta'), 'state');
    writeFileSync(join(stateDir, 'beta/private'), 'sibling-only');
    await docker.buildAgent(spec.id, 1, { 'index.mjs': `
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
const dir=process.env.AINIZE_AGENT_STATE_DIR;
if(dir!=='/state'||process.getuid()!==1000||process.env.AINIZE_AGENT_TOKEN) throw Error('runtime identity/path/token');
if(existsSync('/state/../beta/private')) throw Error('sibling exposed');
let n=0;try{n=Number(readFileSync(dir+'/count','utf8'))}catch{}
writeFileSync(dir+'/import-count',String(n+1));
export default {execute:async(input,ctx)=>{
 const model=await ctx.llm.chat({messages:[{role:'user',content:'test'}]});
 if(model.message.content!=='model-ok') throw Error('model failed');
 writeFileSync(dir+'/count',String(n+1));return {text:'ok'};
}};
` });
    const image = await docker.ensureRuntimeImage();
    if (existing) {
      mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      // A non-root runtime creates the legacy fixture. No chown or root container.
      await promisify(execFile)('setfacl', ['-m', 'u:1000:rwx', '--', stateDir]);
      const seeded = await hostedAgentDockerExec(['run', '--rm', '--network', 'none', '--user', '1000:1000',
        '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
        '--mount', `type=bind,src=${stateDir},dst=/fixture`, image, 'node', '-e',
        `const fs=require('fs');const p='/fixture/${spec.id}';fs.mkdirSync(p,{mode:0o700});fs.writeFileSync(p+'/count','40',{mode:0o600});`]);
      assert.equal(seeded.code, 0, seeded.stderr);
      existingPrepared = true;
      chmodSync(stateDir, 0o700);
      assert.equal(statSync(join(stateDir, spec.id)).uid, 1000);
      assert.equal(statSync(join(stateDir, spec.id)).mode & 0o777, 0o700);
    }
    for (let n = 1; n <= 2; n++) {
      // network=none has no address, so run() reports that after successfully launching.
      await assert.rejects(docker.run(spec.id, 1, { AINIZE_AGENT_SPEC: JSON.stringify(spec), AINIZE_GATEWAY_URL: 'http://ainize-gateway', AINIZE_AGENT_TOKEN: token }), /has no address/);
      const until = Date.now() + 30_000;
      const payload = JSON.stringify({jsonrpc:'2.0',id:1,method:'message/send',params:{message:{kind:'message',role:'user',messageId:'m',parts:[{kind:'text',text:'test'}]}}});
      while (Date.now() < until) {
        const ready = await hostedAgentDockerExec(['exec', `ainize-hosted-${spec.id}`, 'node', '-e',
          `fetch('http://127.0.0.1:8080/',{method:'POST',headers:{'content-type':'application/json'},body:${JSON.stringify(payload)}}).then(async r=>process.exit((await r.json()).result?0:1),()=>process.exit(1))`]);
        if (ready.code === 0) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      // Read as the runtime, since a UID 2000 API cannot read legacy 0700 state.
      const saved = await hostedAgentDockerExec(['exec', `ainize-hosted-${spec.id}`, 'node', '-e',
        `const fs=require('fs');console.log(JSON.stringify(['import-count','count'].map(f=>fs.readFileSync('/state/'+f,'utf8'))))`]);
      assert.equal(saved.code, 0, saved.stderr);
      assert.deepEqual(JSON.parse(saved.stdout), [String((existing ? 40 : 0) + n), String((existing ? 40 : 0) + n)]);
      if (existing) {
        assert.equal(statSync(join(stateDir, spec.id)).uid, 1000);
        assert.equal(statSync(join(stateDir, spec.id)).mode & 0o777, 0o700);
      }
      assert.equal(readFileSync(join(stateDir, 'beta/private'), 'utf8'), 'sibling-only');
      await docker.stop(spec.id);
    }
    assert.equal(calls, 2);
    const unauthenticated = await hostedAgentDockerExec(['run', '--rm', '--network', 'none', '--user', '1000:1000', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--mount', `type=bind,src=${socketDir},dst=/gateway,readonly`, image,
      'node', '-e', `require('http').get({socketPath:'/gateway/gateway.sock',path:'/v1/models'},r=>{r.resume();r.on('end',()=>process.exit(r.statusCode===401?0:2))}).on('error',()=>process.exit(3))`]);
    assert.equal(unauthenticated.code, 0, 'filesystem access must not bypass gateway authentication');
    const denied = await hostedAgentDockerExec(['run', '--rm', '--network', 'none', '--user', '34567:34567', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--mount', `type=bind,src=${socketDir},dst=/gateway,readonly`, '--mount', `type=bind,src=${join(stateDir, spec.id)},dst=/state`, image,
      'node', '-e', `const fs=require('fs'),http=require('http');try{fs.writeFileSync('/state/intruder','bad');process.exit(2)}catch(e){if(e.code!=='EACCES')process.exit(3)}const r=http.get({socketPath:'/gateway/gateway.sock'},()=>process.exit(4));r.on('error',e=>process.exit(e.code==='EACCES'?0:5));`]);
    assert.equal(denied.code, 0, 'unrelated UID must receive EACCES for both state and socket');
  } finally {
    gateway.revoke(token);
    await docker.stop(spec.id);
    await gateway.close();
    if (existingPrepared) {
      const path = join(stateDir, spec.id);
      // Cleanup only this temporary fixture, under the same unprivileged identity.
      const cleaned = await hostedAgentDockerExec(['run', '--rm', '--network', 'none', '--user', '1000:1000',
        '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
        '--mount', `type=bind,src=${path},dst=/fixture`, await docker.ensureRuntimeImage(), 'node', '-e',
        `const fs=require('fs');for(const f of fs.readdirSync('/fixture'))fs.rmSync('/fixture/'+f,{recursive:true,force:true});`]);
      assert.equal(cleaned.code, 0, cleaned.stderr);
      // rmdir only needs write access on the host-owned parent.
      const { rmdirSync } = await import('node:fs');
      rmdirSync(path);
    }
    await docker.removeImages(spec.id);
    rmSync(dir, { recursive: true, force: true });
  }
});
