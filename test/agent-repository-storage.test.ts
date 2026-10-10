import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import express from 'express';
import { AgentGit, AgentGitStorageLimitError } from '../src/agent-git.js';
import { AgentGitHttp } from '../src/agent-git-http.js';
import { AgentRepositoryMaintenance } from '../src/agent-repository-maintenance.js';
import { AgentRepositoryQueue } from '../src/agent-repository-queue.js';
import { hostedAgentSpecInput } from '../src/hosted-agent-types.js';
const run = promisify(execFile);
const input = hostedAgentSpecInput.parse({ id: 'desk', name: 'Desk', model: 'test', systemPrompt: 'Original' });

test('a real HTTP push exceeding storage is refused for a proposal too; main and live state stay unchanged', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-storage-'));
  const git = new AgentGit(join(root, 'repos'), 8192); const queue = new AgentRepositoryQueue();
  let port = 0, applications = 0;
  const http = new AgentGitHttp({ git, serialize: (id, op) => queue.run(id, op), loopbackPort: () => port, canRead: () => true, canPush: () => true, apply: async () => { applications++; }, log: () => {} });
  const app = express(); app.use(http.router()); const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve)); port = (server.address() as {port:number}).port;
  try {
    await git.init('desk'); const initial = await git.commitSpec('desk', input, {message:'Initial'}); http.installHooks('desk');
    const clone = join(root, 'clone'); await run('git', ['clone', `http://127.0.0.1:${port}/git/desk.git`, clone]);
    const cmd = (args: string[]) => run('git', ['-C', clone, ...args]);
    await cmd(['config','user.name','Reviewer']); await cmd(['config','user.email','reviewer@test']);
    await cmd(['checkout','-b','proposal']); writeFileSync(join(clone,'large.bin'), randomBytes(32*1024));
    await cmd(['add','.']); await cmd(['commit','-m','Large proposal']);
    await assert.rejects(cmd(['push','origin','proposal']), /repository storage limit exceeded/);
    assert.equal(await git.resolve('desk','main'), initial); assert.equal(applications,0);
    await assert.rejects(git.resolve('desk','proposal'));
    const internal = await http.check('desk', [{ref:`refs/runtime-retained/${initial}`, before:'0'.repeat(40), after:initial}]);
    assert.equal(internal.ok,false); assert.match(internal.message!,/node-managed/);
    assert.ok(await git.storageBytes('desk') < git.storageLimitBytes, 'Git removes rejected quarantine objects');
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); rmSync(root,{recursive:true,force:true}); }
});

test('API-generated oversized commits and mirror/merge ref changes cannot move main', async () => {
  const root=mkdtempSync(join(tmpdir(),'agent-storage-api-')); const git=new AgentGit(root,8192);
  try {
    await git.init('desk'); const initial=await git.commitSpec('desk',input,{message:'Initial'});
    await assert.rejects(git.commitSpec('desk',{...input,systemPrompt:randomBytes(32*1024).toString('hex')},{message:'Too large',parent:initial}),AgentGitStorageLimitError);
    assert.equal(await git.resolve('desk','main'),initial);
    await assert.rejects(git.setRef('desk','main',initial),AgentGitStorageLimitError);
    assert.equal(await git.resolve('desk','main'),initial);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('GC removes old unreachable objects while keeping branches, tags and recorded runtime commits', async () => {
  const root=mkdtempSync(join(tmpdir(),'agent-maintenance-')); const git=new AgentGit(root);
  try {
    await git.init('desk'); const active=await git.commitSpec('desk',input,{message:'Active'});
    const next=await git.commitSpec('desk',{...input,systemPrompt:'Other root'},{message:'New root'});
    await run('git',['--git-dir',git.dir('desk'),'update-ref','refs/tags/release',next]);
    const empty=join(root,'unreferenced'); writeFileSync(empty,'unreferenced old object');
    const orphan=(await run('git',['--git-dir',git.dir('desk'),'hash-object','-w',empty])).stdout.trim();
    const old=new Date(Date.now()-30*86400_000); utimesSync(join(git.dir('desk'),'objects',orphan.slice(0,2),orphan.slice(2)),old,old);
    await git.maintain('desk',[active]);
    assert.equal(await git.resolve('desk','main'),next); assert.equal(await git.resolve('desk','release'),next);
    assert.equal(await git.resolve('desk',`refs/runtime-retained/${active}`),active);
    await assert.rejects(run('git',['--git-dir',git.dir('desk'),'cat-file','-e',orphan]));
    await git.maintain('desk',[]); await assert.rejects(git.resolve('desk',`refs/runtime-retained/${active}`));
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('maintenance waits behind a repository writer, deduplicates sweeps and drains on stop', async () => {
  const root=mkdtempSync(join(tmpdir(),'agent-maintenance-queue-')); const git=new AgentGit(root); const queue=new AgentRepositoryQueue();
  try {
    await git.init('desk'); const commit=await git.commitSpec('desk',input,{message:'Initial'});
    let release!:()=>void; const gate=new Promise<void>(resolve=>{release=resolve;});
    const writing=queue.run('desk',()=>gate); const errors:string[]=[];
    const maintenance=new AgentRepositoryMaintenance(git,(id,op)=>queue.run(id,op),()=>[commit],m=>errors.push(m));
    const sweep=maintenance.sweep(); assert.equal(maintenance.sweep(),sweep);
    let finished=false; void sweep.then(()=>{finished=true;}); await new Promise(resolve=>setTimeout(resolve,25)); assert.equal(finished,false);
    release(); await writing; await sweep; assert.deepEqual(errors,[]);
    assert.equal(await git.resolve('desk',`refs/runtime-retained/${commit}`),commit);
    await maintenance.stop();
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('real CRUD quota refusals leave the stored release, runtime and Git history unchanged', async () => {
  const { HostedAgentStore } = await import('../src/hosted-agent-store.js');
  const { HostedAgentSecretStore } = await import('../src/hosted-agent-secrets.js');
  const { HostedAgentGateway } = await import('../src/hosted-agent-gateway.js');
  const { HostedAgentHost } = await import('../src/hosted-agent-host.js');
  const { hostedAgentRoutes } = await import('../src/hosted-agent-routes.js');
  const root=mkdtempSync(join(tmpdir(),'agent-storage-crud-')); const git=new AgentGit(join(root,'repos'),8192);
  const store=new HostedAgentStore(join(root,'agents.json')); const secrets=new HostedAgentSecretStore(join(root,'secrets.json'),join(root,'secrets.key'));
  const gateway=new HostedAgentGateway({registry:()=>null,spec:id=>store.get(id),log:()=>{}});
  const host=new HostedAgentHost({gateway,secrets,docker:null,idleStopMs:60000,maxRunning:2,log:()=>{}}); await host.start([]);
  const queue=new AgentRepositoryQueue(), app=express(); app.use(express.json());
  app.use(hostedAgentRoutes({store,secrets,host,publicBase:()=> 'http://node.example',registry:()=>null,sessionAddress:()=> '0x1111111111111111111111111111111111111111', reserved:()=>false,peerChat:{self:'0x1111111111111111111111111111111111111111',serves:()=>true},repo:{serialize:(id,op)=>queue.run(id,op),
    create:async spec=>{await git.init(spec.id);try{await git.commitSpec(spec.id,spec,{message:'Create'});}catch(error){await git.deleteRepo(spec.id);throw error;}},
    commit:async(spec,message)=>{await git.commitSpec(spec.id,spec,{message,parent:await git.resolve(spec.id,'main')});},remove:async id=>{await git.deleteRepo(id);}}}));
  const server=app.listen(0,'127.0.0.1'); await new Promise<void>(resolve=>server.once('listening',resolve)); const url=`http://127.0.0.1:${(server.address() as {port:number}).port}/api/hosted-agents`;
  try {
    const send=(path:string,method:string,body:unknown)=>fetch(url+path,{method,headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    assert.equal((await send('','POST',input)).status,201); const before=structuredClone(store.get('desk')); const sha=await git.resolve('desk','main');
    const large={...input,systemPrompt:randomBytes(16384).toString('hex')};
    const update=await send('/desk','PUT',large); assert.equal(update.status,413,await update.text());
    assert.deepEqual(store.get('desk'),before); assert.equal(await git.resolve('desk','main'),sha); assert.equal(host.status('desk')?.liveVersion,before?.version);
    const create=await send('','POST',{...large,id:'too-large'}); assert.equal(create.status,413,await create.text());
    assert.equal(store.get('too-large'),null); assert.equal(git.exists('too-large'),false); assert.equal(host.status('too-large'),null);
  } finally {await new Promise<void>(resolve=>server.close(()=>resolve())); await host.stop(); rmSync(root,{recursive:true,force:true});}
});
