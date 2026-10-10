import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {HostedAgentGateway} from '../src/hosted-agent-gateway.js';
import {QaPublicationBaseChanged} from '../src/hosted-qa-publication.js';
import {HostedQaPublicationService} from '../src/hosted-qa-publication-service.js';
import {hostedAgentSpecInput} from '../src/hosted-agent-types.js';
import {createHostedAgentCtx} from '../src/hosted-agent-runtime/hostedAgentContext.js';
import {qaCandidateDigest} from '../src/hosted-qa-validator.js';
// @ts-expect-error example module
import {Jobs} from '../examples/qa-agent/jobs.mjs';
// @ts-expect-error example module
import {Checkpoints} from '../examples/qa-agent/checkpoints.mjs';
// @ts-expect-error example module
import {advanceHostedPublication} from '../examples/qa-agent/publication.mjs';
// @ts-expect-error example module
import {AinmemReports} from '../examples/qa-agent/ainmem.mjs';
test('private gateway publication polling persists PR/SHA, reports to Ainmem and never records approval',async t=>{
 const root=mkdtempSync(join(tmpdir(),'qa-publication-flow-'));t.after(()=>rmSync(root,{force:true,recursive:true}));
 const jobs=new Jobs(join(root,'jobs.sqlite3'));t.after(()=>jobs.close());const checkpoints=new Checkpoints(join(root,'checkpoints'));
 const candidate={repository:'test/product',base:'a'.repeat(40),changes:{'file.txt':'fixed'}};
 const digest=qaCandidateDigest(candidate),result={...candidate,candidateDigest:digest,sha:'b'.repeat(40),number:7,url:'https://github.com/test/product/pull/7'};
 let resolve!:(value:unknown)=>void;let executions=0;
 const service=new HostedQaPublicationService({publish:(id:string,job:string,received:unknown)=>{assert.equal(id,'agent');assert.equal(job,created.id);assert.deepEqual(received,candidate);executions++;return new Promise(r=>{resolve=r;});}} as any);
 const spec={...hostedAgentSpecInput.parse({id:'agent',name:'agent',model:'unused',mode:'handler',files:{'index.mjs':'export default {}'}}),version:1,owner:'test',createdAt:1,updatedAt:1};
 const gateway=new HostedAgentGateway({registry:()=>null,spec:id=>id==='agent'?spec:null,log:()=>{},qaPublication:(id,raw)=>service.submit(id,raw)});
 const url=await gateway.listen('127.0.0.1');t.after(()=>gateway.close());const token=gateway.issue('agent');
 const ctx=createHostedAgentCtx({spec,gateway:{url,token},secrets:{},log:()=>{}},{text:''});
 const created=jobs.enqueue('request',{repository:candidate.repository,base:candidate.base,text:'고쳐줘',service:'test'});
 const claim=jobs.claim();
 const coding=checkpoints.save(created.id,{repository:candidate.repository,commit:candidate.base,changes:candidate.changes});
 const validation=checkpoints.save(created.id,{candidateDigest:digest,passed:true});
 jobs.finish(created.id,claim.lease,'queued',{stage:'needs_publication',coding,validation});
 const polling=await advanceHostedPublication({jobs,claim:jobs.claim(),checkpoints,ctx});assert.equal(polling.state,'queued');
 resolve(result);await new Promise(r=>setImmediate(r));
 const completed=await advanceHostedPublication({jobs,claim:jobs.claim(),checkpoints,ctx});
 assert.equal(completed.checkpoint.stage,'awaiting_approval');assert.equal(completed.state,'waiting');assert.equal(completed.checkpoint.approval,undefined);assert.equal(executions,1);
 assert.equal(new Checkpoints(join(root,'checkpoints')).load(completed.checkpoint.publication).sha,result.sha);
 const uuid='11111111-1111-4111-8111-111111111111';
 const config={origin:'https://ainmem.example',databaseId:uuid,titlePropertyId:uuid,statusPropertyId:uuid,statusOptions:Object.fromEntries(['queued','coding','validating','waiting','completed','failed'].map(s=>[s,s]))};
 new AinmemReports(jobs,config).refresh(created.id);
 const payload=JSON.parse(jobs.db.prepare('SELECT payload FROM ainmem_reports WHERE job_id=?').get(created.id).payload);
 assert.ok(payload.body.includes(result.url));assert.ok(payload.body.includes(result.sha));assert.equal(payload.statusOptionId,'waiting');
 gateway.revoke(token);await assert.rejects(ctx.qa!.publish(created.id,candidate),/refused/);
});

test('handler automatically wakes a validated job for publication and stops at human approval',async t=>{
 // @ts-expect-error example module
 const {createHandler}=await import('../examples/qa-agent/index.mjs');
 const root=mkdtempSync(join(tmpdir(),'qa-publish-tick-'));t.after(()=>rmSync(root,{force:true,recursive:true}));
 const jobs=new Jobs(join(root,'jobs.sqlite3'));t.after(()=>jobs.close());const checkpoints=new Checkpoints(join(root,'checkpoints'));
 const candidate={repository:'test/product',base:'a'.repeat(40),changes:{'file.txt':'fixed'}};const digest=qaCandidateDigest(candidate);
 const job=jobs.enqueue('request',{repository:candidate.repository,base:candidate.base,text:'고쳐줘'});const claim=jobs.claim();
 const coding=checkpoints.save(job.id,{repository:candidate.repository,commit:candidate.base,changes:candidate.changes});
 jobs.finish(job.id,claim.lease,'queued',{stage:'needs_validation',coding});
 const handler=createHandler({stateDir:root,config:{service:'test',teamsOrigin:'https://teams.example',workspaceId:'ws',channelId:'ch',enabledAt:'2026-10-01T00:00:00Z',repository:candidate.repository,baseCommit:candidate.base,hostValidation:true,hostPublication:true}});
 const ctx={log(){},qa:{validate:async()=>({state:'done',result:{repository:candidate.repository,base:candidate.base,candidateDigest:digest,passed:true,gates:[{gate:'test',passed:true}]}}),publish:async()=>({state:'done',result:{repository:candidate.repository,base:candidate.base,candidateDigest:digest,sha:'b'.repeat(40),number:1,url:'https://github.com/test/product/pull/1'}})}};
 await handler.tick(ctx);assert.equal(jobs.get(job.id).state,'queued');assert.equal(jobs.get(job.id).checkpoint.stage,'needs_publication');
 await handler.tick(ctx);assert.equal(jobs.get(job.id).state,'waiting');assert.equal(jobs.get(job.id).checkpoint.stage,'awaiting_approval');
 await handler.tick(ctx);assert.equal(jobs.get(job.id).checkpoint.approval,undefined);
});


test('handler ticks observe release then deployment without restarting coding',async t=>{
 // @ts-expect-error example module
 const {createHandler}=await import('../examples/qa-agent/index.mjs');
 const root=mkdtempSync(join(tmpdir(),'qa-lifecycle-tick-'));t.after(()=>rmSync(root,{force:true,recursive:true}));
 const jobs=new Jobs(join(root,'jobs.sqlite3'));t.after(()=>jobs.close());
 const published={repository:'test/product',base:'a'.repeat(40),candidateDigest:'c'.repeat(64),sha:'b'.repeat(40)};
 const job=jobs.enqueue('request',{repository:published.repository,base:published.base,text:'고쳐줘'}),claim=jobs.claim();
 jobs.finish(job.id,claim.lease,'waiting',{stage:'awaiting_approval',published});
 const handler=createHandler({stateDir:root,config:{service:'test',teamsOrigin:'https://teams.example',workspaceId:'ws',channelId:'ch',enabledAt:'2026-10-01T00:00:00Z',repository:published.repository,baseCommit:published.base,hostReview:true}});
 let state='branch_updated',calls=0;
 const ctx={log(){},qa:{status:async(id:string)=>{calls++;assert.equal(id,job.id);return {jobId:id,...published,state,deploymentVerified:state==='deployment_verified',servingCommit:'d'.repeat(40),mergeCommit:'e'.repeat(40)};}}};
 await handler.tick(ctx);assert.equal(jobs.get(job.id).checkpoint.stage,'awaiting_deployment');
 state='deployment_verified';await handler.tick(ctx);assert.equal(jobs.get(job.id).state,'completed');
 await handler.tick(ctx);assert.equal(calls,2);
});

test('handler verifies and persists intake before continuing a prepared candidate',async t=>{
 // @ts-expect-error example module
 const {createHandler}=await import('../examples/qa-agent/index.mjs');
 const {createHash}=await import('node:crypto');
 const root=mkdtempSync(join(tmpdir(),'qa-intake-tick-'));t.after(()=>rmSync(root,{force:true,recursive:true}));
 const jobs=new Jobs(join(root,'jobs.sqlite3'));t.after(()=>jobs.close());const checkpoints=new Checkpoints(join(root,'checkpoints'));
 const candidate={repository:'test/product',base:'a'.repeat(40),changes:{file:'fixed'}},digest=qaCandidateDigest(candidate);
 const job=jobs.enqueue('request',{repository:candidate.repository,base:candidate.base,text:'여백 고쳐줘.',teams:{workspaceId:'ws',channelId:'ch',messageId:'request',parentId:'request'}}),claim=jobs.claim();
 const coding=checkpoints.save(job.id,{repository:candidate.repository,commit:candidate.base,changes:candidate.changes});
 jobs.finish(job.id,claim.lease,'queued',{stage:'needs_validation',coding});
 const config={service:'test',teamsOrigin:'https://teams.example',workspaceId:'ws',channelId:'ch',enabledAt:'2026-10-01T00:00:00Z',repository:candidate.repository,baseCommit:candidate.base,hostValidation:true,hostPublication:true,hostReview:true};
 let intake=0,validation=0;
 const ctx={log(){},qa:{intake:async(id:string,locator:any)=>{intake++;assert.equal(id,job.id);assert.equal(locator.messageId,'request');return intake===1?{state:'running'}:{state:'done',result:{requestId:'request',rootId:'request',workspaceId:'ws',channelId:'ch',requestDigest:createHash('sha256').update(job.input.text).digest('hex')}};},validate:async()=>{validation++;return {state:'done',result:{...candidate,candidateDigest:digest,passed:true,gates:[{gate:'test',passed:true}]}};}}};
 const handler=createHandler({stateDir:root,config});
 await handler.tick(ctx);assert.equal(validation,0);assert.equal(jobs.get(job.id).checkpoint.hostIntake,undefined);
 await handler.tick(ctx);assert.equal(validation,0);assert.equal(jobs.get(job.id).checkpoint.hostIntake,true);
 const restarted=createHandler({stateDir:root,config});await restarted.tick(ctx);assert.equal(intake,2);assert.equal(validation,1);assert.equal(jobs.get(job.id).checkpoint.stage,'needs_publication');
});


test('changed publication base archives the validated candidate and orphan PR without requesting approval',async t=>{
 const root=mkdtempSync(join(tmpdir(),'qa-publish-base-'));t.after(()=>rmSync(root,{force:true,recursive:true}));
 const jobs=new Jobs(join(root,'jobs.sqlite3'));t.after(()=>jobs.close());const checkpoints=new Checkpoints(join(root,'checkpoints'));
 const candidate={repository:'test/product',base:'a'.repeat(40),changes:{file:'fixed'}},digest=qaCandidateDigest(candidate);
 const job=jobs.enqueue('request',{repository:candidate.repository,base:candidate.base,text:'고쳐줘'}),claim=jobs.claim();
 const coding=checkpoints.save(job.id,{repository:candidate.repository,commit:candidate.base,changes:candidate.changes});
 const validation=checkpoints.save(job.id,{candidateDigest:digest,passed:true});
 jobs.finish(job.id,claim.lease,'queued',{stage:'needs_publication',coding,validation,hostIntake:true,hostBase:true});
 const artifact={sha:'b'.repeat(40),number:7,url:'https://github.com/test/product/pull/7'};let enqueued=0;
 const service=new HostedQaPublicationService({publish:async()=>{throw new QaPublicationBaseChanged('e'.repeat(40),artifact);}} as any,()=>{enqueued++;});
 const ctx={qa:{publish:async(id:string,c:unknown)=>service.submit('agent',{jobId:id,candidate:c})}};
 await advanceHostedPublication({jobs,claim:jobs.claim(),checkpoints,ctx});await new Promise(r=>setImmediate(r));
 const result=await advanceHostedPublication({jobs,claim:jobs.claim(),checkpoints,ctx});
 assert.equal(result.checkpoint.revalidationCandidateDigest,digest);
 assert.equal(result.checkpoint.stage,'needs_revalidation');assert.equal(result.checkpoint.holdReason,'base_changed');assert.equal(result.checkpoint.published,undefined);assert.equal(enqueued,0);
 const history=jobs.revalidationHistory(job.id);assert.equal(history.length,1);assert.equal(history[0].checkpoint.stage,'needs_publication');assert.deepEqual(checkpoints.load(history[0].checkpoint.coding).changes,candidate.changes);
 assert.deepEqual(checkpoints.load(result.checkpoint.revalidationEvidence).artifact,artifact);assert.equal(result.input.base,candidate.base);assert.equal(jobs.wake(job.id),false);
 const {advanceHostedRevalidation}=await import('../examples/qa-agent/revalidation.mjs');
 let wrong=true;
 const revalidate=async(id,request)=>{
  assert.equal(request.candidateDigest,digest);
  return {state:'done',result:{...request,jobId:id,repository:candidate.repository,base:'e'.repeat(40),candidateDigest:wrong?'f'.repeat(64):digest}};
 };
 await advanceHostedRevalidation({jobs,claim:jobs.claimRevalidation(),ctx:{qa:{revalidate}}});assert.equal(jobs.get(job.id).input.base,candidate.base);
 wrong=false;await advanceHostedRevalidation({jobs,claim:jobs.claimRevalidation(),ctx:{qa:{revalidate}}});
 assert.equal(jobs.get(job.id).input.base,'e'.repeat(40));assert.equal(jobs.get(job.id).checkpoint.validation,undefined);
 assert.deepEqual(checkpoints.load(jobs.revalidationHistory(job.id)[0].checkpoint.revalidationEvidence).artifact,artifact);
});

test('mismatched revalidation responses cannot archive or replace a pending publication',async t=>{
 const root=mkdtempSync(join(tmpdir(),'qa-publish-forged-'));t.after(()=>rmSync(root,{force:true,recursive:true}));
 const jobs=new Jobs(join(root,'jobs.sqlite3'));t.after(()=>jobs.close());const checkpoints=new Checkpoints(join(root,'checkpoints'));
 const candidate={repository:'test/product',base:'a'.repeat(40),changes:{file:'fixed'}},digest=qaCandidateDigest(candidate);
 const job=jobs.enqueue('request',{repository:candidate.repository,base:candidate.base,text:'고쳐줘'}),initial=jobs.claim();
 const checkpoint={stage:'needs_publication',coding:checkpoints.save(job.id,{repository:candidate.repository,commit:candidate.base,changes:candidate.changes}),validation:checkpoints.save(job.id,{candidateDigest:digest,passed:true})};
 jobs.finish(job.id,initial.lease,'queued',checkpoint);
 for(const patch of [{repository:'other/product'},{candidateDigest:'f'.repeat(64)},{observedBase:candidate.base},{observedBase:'invalid'},{artifact:{sha:'b'.repeat(40),number:7,url:'https://github.com/other/product/pull/7'}}]){
  const claim=jobs.claim();await assert.rejects(advanceHostedPublication({jobs,claim,checkpoints,ctx:{qa:{publish:async()=>({state:'requires_revalidation',repository:candidate.repository,base:candidate.base,candidateDigest:digest,observedBase:'e'.repeat(40),...patch})}}}),/binding mismatch/);
  assert.deepEqual(jobs.revalidationHistory(job.id),[]);assert.deepEqual(jobs.get(job.id).checkpoint,checkpoint);jobs.finish(job.id,claim.lease,'queued',checkpoint);
 }
});


test('cached publication cannot bypass a revoked intake or changed validation policy',async()=>{
 const candidate={repository:'test/product',base:'a'.repeat(40),changes:{file:'fixed'}};
 const receipt={repository:candidate.repository,base:candidate.base,candidateDigest:qaCandidateDigest(candidate),sha:'b'.repeat(40),number:1,url:'https://github.com/test/product/pull/1'};
 let allowed=true,calls=0,checks=0;const recorded:unknown[]=[];
 const service=new HostedQaPublicationService({publish:async()=>{calls++;return receipt;}} as any,(_id,_job,r)=>recorded.push(r),(id,job,c)=>{
  checks++;assert.equal(id,'agent');assert.equal(job,'job');assert.deepEqual(c,candidate);if(!allowed)throw Error('current policy refused');
 });
 const input={jobId:'job',candidate};assert.equal(service.submit('agent',input).state,'running');await new Promise(r=>setImmediate(r));
 const cached:any=service.submit('agent',input);assert.equal(cached.state,'done');cached.result.sha='f'.repeat(40);
 assert.equal((service.submit('agent',input) as any).result.sha,receipt.sha);
 allowed=false;assert.throws(()=>service.submit('agent',input),/current policy refused/);assert.equal(calls,1);assert.equal(recorded.length,1);assert.ok(checks>=4);
});

test('revocation while publication is in flight prevents success registration and acknowledgement',async()=>{
 const candidate={repository:'test/product',base:'a'.repeat(40),changes:{file:'fixed'}};
 let allowed=true,resolve!:(r:unknown)=>void,registrations=0;
 const service=new HostedQaPublicationService({publish:()=>new Promise(r=>{resolve=r;})} as any,()=>{registrations++;},()=>{if(!allowed)throw Error('revoked');});
 const input={jobId:'job',candidate};const running:any=service.submit('agent',input);assert.equal(running.state,'running');running.state='done';assert.equal(service.submit('agent',input).state,'running');allowed=false;resolve({sha:'b'.repeat(40)});await new Promise(r=>setImmediate(r));
 assert.equal(registrations,0);assert.throws(()=>service.submit('agent',input),/revoked/);
 allowed=true;assert.equal(service.submit('agent',input).state,'failed');
});
