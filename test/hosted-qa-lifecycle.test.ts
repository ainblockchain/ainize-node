import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {HostedAgentGateway} from '../src/hosted-agent-gateway.js';
import {HostedQaReviewStore} from '../src/hosted-qa-review-store.js';
import {hostedAgentSpecInput} from '../src/hosted-agent-types.js';
import {createHostedAgentCtx} from '../src/hosted-agent-runtime/hostedAgentContext.js';
// @ts-expect-error example module
import {Jobs} from '../examples/qa-agent/jobs.mjs';
// @ts-expect-error example module
import {Checkpoints} from '../examples/qa-agent/checkpoints.mjs';
// @ts-expect-error example module
import {advanceHostedLifecycle} from '../examples/qa-agent/lifecycle.mjs';
// @ts-expect-error example module
import {AinmemReports} from '../examples/qa-agent/ainmem.mjs';
const published={repository:'test/product',base:'a'.repeat(40),sha:'b'.repeat(40),candidateDigest:'c'.repeat(64)};
function setup(t:any){
 const root=mkdtempSync(join(tmpdir(),'qa-lifecycle-'));let now=1000;
 const jobs=new Jobs(join(root,'jobs.sqlite3'),{now:()=>now});t.after(()=>{jobs.close();rmSync(root,{recursive:true,force:true});});
 const checkpoints=new Checkpoints(join(root,'checkpoints'));
 const enqueue=(key:string)=>{const job=jobs.enqueue(key,{repository:published.repository,base:published.base,text:'고쳐줘',service:'test'});const claim=jobs.claim();jobs.finish(job.id,claim.lease,'waiting',{stage:'awaiting_approval',published});return job;};
 return {root,jobs,checkpoints,enqueue,setNow:(value:number)=>{now=value;}};
}
test('lifecycle polling survives expiry, rotates waiting jobs and leaves coding claimable',t=>{
 const f=setup(t),a=f.enqueue('first');f.setNow(1001);const b=f.enqueue('second');
 const first=f.jobs.claimReview(1000);assert.equal(first.job.id,a.id);
 const second=f.jobs.claimReview(1000);assert.equal(second.job.id,b.id);assert.equal(f.jobs.claimReview(),null);
 const coding=f.jobs.enqueue('coding',{});assert.equal(f.jobs.claim().job.id,coding.id);
 f.setNow(2001);const retry=f.jobs.claimReview();assert.equal(retry.job.id,a.id);
 assert.throws(()=>f.jobs.finish(a.id,first.lease,'completed',{}),/lease lost/);
 f.jobs.finish(a.id,retry.lease,'waiting',retry.job.checkpoint);
 assert.equal(f.jobs.claimReview().job.id,b.id);
});
test('only matching host deployment evidence completes the durable job and Ainmem report',async t=>{
 const f=setup(t),job=f.enqueue('request');
 let status:any={jobId:job.id,...published,state:'awaiting_approval'};
 const advance=()=>advanceHostedLifecycle({jobs:f.jobs,claim:f.jobs.claimReview(),checkpoints:f.checkpoints,ctx:{qa:{status:async()=>status}}});
 assert.equal((await advance()).checkpoint.stage,'awaiting_approval');
 status={...status,state:'branch_updated'};assert.equal((await advance()).checkpoint.stage,'awaiting_deployment');
 status={...status,state:'deployment_verified',deploymentVerified:true,servingCommit:'d'.repeat(40),mergeCommit:'e'.repeat(40)};
 const done=await advance();assert.equal(done.state,'completed');assert.equal(done.checkpoint.approval,undefined);
 assert.equal(f.checkpoints.load(done.checkpoint.deployment).featureRegressionVerified,false);
 assert.equal(f.jobs.claimReview(),null);
 const uuid='11111111-1111-4111-8111-111111111111';
 new AinmemReports(f.jobs,{origin:'https://ainmem.example',databaseId:uuid,titlePropertyId:uuid,statusPropertyId:uuid,statusOptions:Object.fromEntries(['queued','coding','validating','waiting','completed','failed'].map(s=>[s,s]))}).refresh(job.id);
 const payload=JSON.parse(f.jobs.db.prepare('SELECT payload FROM ainmem_reports WHERE job_id=?').get(job.id).payload);
 assert.equal(payload.statusOptionId,'completed');assert.ok(payload.body.includes(status.servingCommit));
});
test('another candidate or incomplete deployment evidence cannot finish a job',async t=>{
 const f=setup(t),job=f.enqueue('request');
 for(const override of [{sha:'f'.repeat(40)},{candidateDigest:'f'.repeat(64)},{deploymentVerified:false},{servingCommit:'short'}]){
  const claim=f.jobs.claimReview();
  await assert.rejects(advanceHostedLifecycle({jobs:f.jobs,claim,checkpoints:f.checkpoints,ctx:{qa:{status:async()=>({jobId:job.id,...published,state:'deployment_verified',deploymentVerified:true,servingCommit:'d'.repeat(40),mergeCommit:'e'.repeat(40),...override})}}}));
  f.jobs.finish(job.id,claim.lease,'waiting',claim.job.checkpoint);
 }
 assert.equal(f.jobs.get(job.id).state,'waiting');
});
test('private status gateway scopes reads to the authenticated agent and returns no candidate content',async t=>{
 const f=setup(t),store=new HostedQaReviewStore(join(f.root,'review'));t.after(()=>store.close());
 store.enqueuePublication('agent','job',{...published,candidate:{changes:{'private':'secret source'}}});
 const spec={...hostedAgentSpecInput.parse({id:'agent',name:'agent',model:'unused',mode:'handler',files:{'index.mjs':'export default {}'}}),version:1,owner:'test',createdAt:1,updatedAt:1};
 const gateway=new HostedAgentGateway({registry:()=>null,spec:id=>['agent','other'].includes(id)?{...spec,id}:null,log:()=>{},qaStatus:(id,job)=>store.lifecycle(id,job)});
 const url=await gateway.listen('127.0.0.1');t.after(()=>gateway.close());
 const token=gateway.issue('agent'),other=gateway.issue('other');
 const ctx=createHostedAgentCtx({spec,gateway:{url,token},secrets:{},log:()=>{}},{text:''});
 assert.deepEqual(await ctx.qa!.status('job'),{jobId:'job',...published,state:'awaiting_presentation'});
 const response=await fetch(`${url}/t/${other}/qa/status`,{method:'POST',body:JSON.stringify({jobId:'job'})});assert.deepEqual(await response.json(),{state:'unknown'});
 const forged=await fetch(`${url}/t/${other}/qa/status`,{method:'POST',body:JSON.stringify({jobId:'job',agentId:'agent'})});assert.equal(forged.status,400);
 gateway.revoke(token);await assert.rejects(ctx.qa!.status('job'),/refused/);
});

test('host base invalidation preserves the candidate and removes misleading approval solicitation',async t=>{
 const f=setup(t),job=f.enqueue('request'),claim=f.jobs.claimReview();
 const result=await advanceHostedLifecycle({jobs:f.jobs,claim,checkpoints:f.checkpoints,ctx:{qa:{status:async()=>({jobId:job.id,...published,state:'requires_revalidation',observedBase:'e'.repeat(40)})}}});
 assert.equal(result.state,'waiting');assert.equal(result.checkpoint.stage,'needs_revalidation');assert.equal(result.checkpoint.holdReason,'base_changed');
 assert.deepEqual(result.checkpoint.published,published);assert.equal(result.input.base,published.base);assert.equal(f.jobs.claimReview(),null);
 const uuid='11111111-1111-4111-8111-111111111111';
 new AinmemReports(f.jobs,{origin:'https://ainmem.example',databaseId:uuid,titlePropertyId:uuid,statusPropertyId:uuid,statusOptions:Object.fromEntries(['queued','coding','validating','waiting','completed','failed'].map(s=>[s,s]))}).refresh(job.id);
 const payload=JSON.parse(f.jobs.db.prepare('SELECT payload FROM ainmem_reports WHERE job_id=?').get(job.id).payload);
 assert.equal(payload.approvalPending,false);assert.ok(payload.body.includes('main이 변경되어'));assert.equal(payload.body.includes('관리자 배포 승인이 필요합니다.'),false);
});
