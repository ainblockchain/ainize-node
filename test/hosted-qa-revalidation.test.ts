import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Jobs} from '../examples/qa-agent/jobs.mjs';
import {Checkpoints} from '../examples/qa-agent/checkpoints.mjs';
import {createHandler,parseConfig} from '../examples/qa-agent/index.mjs';
import {advanceHostedRevalidation} from '../examples/qa-agent/revalidation.mjs';
import {HostedQaRevalidationService} from '../src/hosted-qa-revalidation-service.js';
const old='a'.repeat(40),next='b'.repeat(40);
const config={service:'test',teamsOrigin:'https://teams.example/',workspaceId:'workspace',channelId:'channel',enabledAt:'2026-10-01T00:00:00Z',repository:'test/product',baseCommit:old,hostBase:true,hostReview:true,hostPublication:true,hostValidation:true,hostRevalidation:true};
function setup(t:any){
 const stateDir=mkdtempSync(join(tmpdir(),'qa-resume-')),jobs=new Jobs(join(stateDir,'jobs.sqlite3'));
 t.after(()=>{jobs.close();rmSync(stateDir,{recursive:true,force:true});});
 const job=jobs.enqueue('original',{repository:config.repository,base:old,service:'test',text:'여백 고쳐줘',teams:{workspaceId:'workspace',channelId:'channel',messageId:'message',parentId:'message'}});
 const claim=jobs.claim();jobs.finish(job.id,claim.lease,'waiting',{hostIntake:true,hostBase:true,stage:'awaiting_approval',published:{repository:config.repository,base:old,sha:'c'.repeat(40)},approval:{old:true}});
 const review=jobs.claimReview();jobs.parkForRevalidation(job.id,review.lease,next);
 const prior=jobs.get(job.id).checkpoint.priorAttempt;
 const receipt={jobId:job.id,repository:config.repository,previousBase:old,base:next,...prior};
 return {stateDir,jobs,job,receipt};
}
test('handler restarts coding on the prepared base with the same task and no prior approval',async t=>{
 const f=setup(t);let prepared=0;
 const handler=createHandler({config,stateDir:f.stateDir,newSnapshot:(_ctx,repository,commit)=>{
  assert.equal(commit,next);return {repository,commit,list:async()=>['a.js'],read:async()=> 'new-broken'};
 }});
 const ctx={log(){},qa:{revalidate:async(id,request)=>{prepared++;assert.equal(id,f.job.id);assert.equal(request.previousBase,old);return {state:'done',result:f.receipt};}},
  llm:{chat:async()=>({finish_reason:'tool_calls',message:{role:'assistant',content:null,tool_calls:[{id:'read',type:'function',function:{name:'read_file',arguments:JSON.stringify({path:'a.js',startLine:1})}}]}})}};
 await handler.tick(ctx);
 let stored=f.jobs.get(f.job.id);assert.equal(stored.input.base,next);assert.equal(stored.checkpoint.stage,'coding');
 assert.equal(stored.checkpoint.approval,undefined);assert.equal(stored.checkpoint.published,undefined);assert.equal(prepared,1);
 const checkpoints=new Checkpoints(join(f.stateDir,'checkpoints'));
 const state=checkpoints.load(stored.checkpoint.coding);assert.equal(state.commit,next);assert.equal(state.rounds,1);assert.deepEqual(state.changes,{});
 const reopened=createHandler({config,stateDir:f.stateDir,newSnapshot:(_ctx,repository,commit)=>({repository,commit,list:async()=>['a.js'],read:async()=> 'new-broken'})});
 await reopened.tick({...ctx,llm:{chat:async()=>({finish_reason:'tool_calls',message:{role:'assistant',content:null,tool_calls:[{id:'fix',type:'function',function:{name:'replace_text',arguments:JSON.stringify({path:'a.js',oldText:'new-broken',newText:'fixed'})}}]}})}});
 stored=f.jobs.get(f.job.id);assert.equal(checkpoints.load(stored.checkpoint.coding).changes['a.js'],'fixed');
 assert.equal(prepared,1);assert.equal(f.jobs.revalidationHistory(f.job.id)[0].checkpoint.approval.old,true);
});
test('revalidation is opt-in and failure retries cannot wake the old candidate',async t=>{
 const f=setup(t);
 assert.throws(()=>parseConfig({...config,hostPublication:false}),/requires all/);
 await createHandler({config:{...config,hostRevalidation:false},stateDir:f.stateDir}).tick({log(){}});
 assert.equal(f.jobs.get(f.job.id).checkpoint.holdReason,'base_changed');
 for(let i=1;i<=3;i++){
  const result=await advanceHostedRevalidation({jobs:f.jobs,claim:f.jobs.claimRevalidation(),ctx:{qa:{revalidate:async()=>({state:'failed'})}}});
  assert.equal(result.input.base,old);assert.equal(result.state,'waiting');assert.equal(result.checkpoint.revalidationFailures,i);
  assert.equal(f.jobs.claim(),null);
 }
 assert.equal(f.jobs.claimRevalidation(),null);assert.equal(f.jobs.get(f.job.id).checkpoint.holdReason,'revalidation_preparation_failed');
 assert.equal(f.jobs.revalidationHistory(f.job.id).length,1);
});
test('a ledger commit failure is not acknowledged as prepared and a retry can recover',async()=>{
 let fail=true,authorized=0;
 const receipt={jobId:'job',repository:'test/product',previousBase:old,base:next,sequence:1,sourceDigest:'d'.repeat(64)};
 const service=new HostedQaRevalidationService({prepareRevalidation:async()=>receipt} as any,{authorizeRevalidation(){authorized++;},commitRevalidationBase(){if(fail)throw Error('disk failure');}} as any);
 const input={jobId:'job',previousBase:old,sequence:1,sourceDigest:receipt.sourceDigest};
 assert.equal(service.submit('agent',input).state,'running');await service.drain();
 assert.equal(service.submit('agent',input).state,'failed');fail=false;
 assert.equal(service.submit('agent',input).state,'running');await service.drain();
 assert.deepEqual(service.submit('agent',input),{state:'done',result:receipt});assert.equal(authorized,4);
 assert.throws(()=>service.submit('agent',{...input,agentId:'other'}),/Invalid/);
});
