/** Opt-in real hosted Docker → private gateway → isolated product validation. No live channel writes. */
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync,readFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { buildAgents } from '../src/agents.js';
import { HostedAgentGateway } from '../src/hosted-agent-gateway.js';
import { HostedAgentHost } from '../src/hosted-agent-host.js';
import { HostedAgentSecretStore } from '../src/hosted-agent-secrets.js';
import { HostedAgentStore } from '../src/hosted-agent-store.js';
import { HostedAgentDocker,hostedAgentDockerExec } from '../src/hosted-agent-docker.js';
import { hostedAgentSpecInput } from '../src/hosted-agent-types.js';
import { HostedQaValidationService } from '../src/hosted-qa-validation-service.js';
import { runQaValidation, type QaValidationProfile } from '../src/hosted-qa-validator.js';

test('scheduled hosted agent validates a real product through the gateway and survives runtime restart', {timeout:600000},async()=>{
 assert.ok(process.env.AINIZE_QA_VALIDATION_PROFILE,'operator diagnostic profile required');
 const profile=JSON.parse(readFileSync(process.env.AINIZE_QA_VALIDATION_PROFILE,'utf8')) as QaValidationProfile;
 const network=process.env.AINIZE_CI_DOCKER_NETWORK;
 assert.ok(network);assert.notEqual(network,'ainize-hosted-agents','never use the production network');
 assert.equal((await hostedAgentDockerExec(['network','inspect',network,'--format','{{.Internal}}'])).stdout.trim(),'true');
 const path=process.env.AINIZE_QA_DIAGNOSTIC_FILE??'README.md';
 const content=execFileSync('git',['-C',profile.checkout,'show',`${profile.base}:${path}`],{encoding:'utf8'});
 const candidate={repository:profile.repository,base:profile.base,changes:{[path]:content}};
 const dir=mkdtempSync(join(tmpdir(),'hosted-qa-product-')),agentId=`qa-product-${process.pid}`;
 const store=new HostedAgentStore(join(dir,'agents.json'));
 const secrets=new HostedAgentSecretStore(join(dir,'secrets.json'),join(dir,'secrets.key'));
 let executions=0;
 const service=new HostedQaValidationService(join(dir,'validation'),{[agentId]:profile},async(p,c)=>{executions++;return runQaValidation(p,c);});
 const gateway=new HostedAgentGateway({registry:()=>null,spec:id=>store.get(id),log:()=>{},qaValidation:(id,c)=>service.submit(id,c)});
 const docker=new HostedAgentDocker({memory:'256m',cpus:1,pidsLimit:128,network,buildTimeoutMs:300000,stateDir:join(dir,'state'),gatewaySocketDir:join(dir,'gateway'),workDir:join(dir,'work'),runtimeImage:'ainize/hosted-agent-runtime-test'});
 const host=new HostedAgentHost({gateway,secrets,docker,gatewaySocketPath:join(dir,'gateway','gateway.sock'),idleStopMs:600000,maxRunning:1,scheduledAgentIds:[agentId],scheduleIntervalMs:1000,log:()=>{}});
 await host.start([]);
 const app=express();app.use(express.json({verify:(req,_res,buf)=>{req.rawBody=buf;}}));
 app.use(buildAgents({identity:{address:'0x1'},agents:[],publicUrl:'https://node.example'},{hosted:{host,store}}));
 const server=createServer(app);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const address=server.address();assert.ok(address&&typeof address!=='string');
 try {
  const handler=`
   import {Jobs} from './jobs.mjs'; import {Checkpoints} from './checkpoints.mjs';
   import {advanceHostedValidation} from './validation.mjs'; import {join} from 'node:path';
   const candidate=${JSON.stringify(candidate)};
   const jobs=new Jobs(join(process.env.AINIZE_AGENT_STATE_DIR,'jobs.sqlite3'));
   const checkpoints=new Checkpoints(join(process.env.AINIZE_AGENT_STATE_DIR,'checkpoints'));
   export async function execute() {
    const job=jobs.enqueue('product-diagnostic',{repository:candidate.repository,base:candidate.base,text:'기존 PR 검증 진단'});
    return JSON.stringify({id:job.id,state:job.state,stage:job.checkpoint.stage??'queued',verdict:job.checkpoint.validation?checkpoints.load(job.checkpoint.validation):null});
   }
   export async function tick(ctx) {
    const claim=jobs.claim();if(!claim)return;
    if(!claim.job.checkpoint.stage){
     const coding=checkpoints.save(claim.job.id,{repository:candidate.repository,commit:candidate.base,changes:candidate.changes});
     jobs.finish(claim.job.id,claim.lease,'queued',{stage:'needs_validation',coding});return;
    }
    await advanceHostedValidation({jobs,claim,checkpoints,ctx});
   }`;
  const spec=store.create(hostedAgentSpecInput.parse({id:agentId,name:'Temporary product validation diagnostic',model:'unused',mode:'handler',allowedHosts:[],
   files:{'index.mjs':handler,...Object.fromEntries(['jobs.mjs','checkpoints.mjs','validation.mjs'].map(name=>[name,readFileSync(new URL('../examples/qa-agent/'+name,import.meta.url),'utf8')]))}}),'0x00000000000000000000000000000000000a11ce');
  host.apply(spec);
  const built=Date.now()+300000;while(host.status(agentId)?.status==='building'&&Date.now()<built)await new Promise(r=>setTimeout(r,500));
  assert.equal(host.status(agentId)?.status,'ready');
  const observe=async()=>{
   const response=await fetch(`http://127.0.0.1:${address.port}/agents/${agentId}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:'observe',method:'message/send',params:{message:{kind:'message',role:'user',messageId:'diagnostic',parts:[{kind:'text',text:'상태 확인'}]}}})});
   const body=await response.json();assert.ok(body.result,JSON.stringify(body.error));return JSON.parse(body.result.parts[0].text);
  };
  let result=await observe();const jobId=result.id;let restarted=false;
  const deadline=Date.now()+300000;
  while(Date.now()<deadline){
   if(executions===1&&!restarted){await host.restart(agentId);restarted=true;}
   await new Promise(r=>setTimeout(r,1000));
   const database=new DatabaseSync(join(dir,'state',agentId,'jobs.sqlite3'),{readOnly:true});
   try {
    const row=database.prepare('SELECT * FROM jobs WHERE id=?').get(jobId)!;
    const checkpoint=JSON.parse(String(row.checkpoint));
    result={id:row.id,state:row.state,stage:checkpoint.stage,verdict:checkpoint.validation?JSON.parse(readFileSync(join(dir,'state',agentId,'checkpoints',jobId,checkpoint.validation.checksum+'.json'),'utf8')):null};
   } finally {database.close();}
   assert.equal(result.id,jobId);
   if(result.stage==='needs_publication'||result.stage==='validation_failed')break;
  }
  assert.equal(restarted,true);assert.equal(executions,1,'runtime restart must not duplicate host execution');
  assert.equal(result.stage,'needs_publication',JSON.stringify(result.verdict));
  assert.equal(result.verdict.passed,true);
  assert.deepEqual(result.verdict.gates.map(g=>g.gate),profile.gates.map(g=>g.name));
 } finally {
  await host.remove(agentId).catch(()=>{});await host.stop();await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(dir,{recursive:true,force:true});
 }
});
