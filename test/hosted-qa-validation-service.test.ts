import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostedQaValidationService } from '../src/hosted-qa-validation-service.js';
import { qaCandidateDigest } from '../src/hosted-qa-validator.js';
const profile={repository:'test/product',base:'a'.repeat(40),checkout:'/operator/repo',image:'sha256:'+'b'.repeat(64),dependencyPath:'/seed/0',cwd:'.',gates:[{name:'test',argv:['yarn','test']}]};
const candidate={repository:profile.repository,base:profile.base,changes:{'b.js':'b','a.js':'a'}};
test('only configured agent can start validation; duplicates and restarts reuse exact receipts',async t=>{
 const root=mkdtempSync(join(tmpdir(),'qa-service-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 let resolve!:()=>void;const pending=new Promise<void>(r=>{resolve=r;});let runs=0;
 const run=async()=>{runs++;await pending;return {repository:candidate.repository,base:candidate.base,candidateDigest:qaCandidateDigest(candidate),gates:[{gate:'test',passed:true,summary:'ok',diagnostics:''}],passed:true};};
 const service=new HostedQaValidationService(root,{agent:profile},run);
 assert.throws(()=>service.submit('other',candidate),/not configured/);
 assert.deepEqual(service.submit('agent',candidate),{state:'running'});
 assert.deepEqual(service.submit('agent',{...candidate,changes:{'a.js':'a','b.js':'b'}}),{state:'running'});
 assert.deepEqual(service.submit('agent',{...candidate,changes:{'a.js':'different'}}),{state:'busy'});
 await new Promise(r=>setImmediate(r));assert.equal(runs,1);
 resolve();await new Promise(r=>setImmediate(r));
 assert.equal(service.submit('agent',candidate).state,'done');
 const restored=new HostedQaValidationService(root,{agent:profile},async()=>{throw new Error('must not re-run');});
 assert.equal(restored.submit('agent',candidate).state,'done');
 assert.throws(()=>service.submit('agent',{...candidate,image:'user-supplied'}),/shape/);
});

test('runtime gateway binds validation to the authenticated agent and polling preserves the job stage',async t=>{
 const {HostedAgentGateway}=await import('../src/hosted-agent-gateway.js');
 const {hostedAgentSpecInput}=await import('../src/hosted-agent-types.js');
 const {createHostedAgentCtx}=await import('../src/hosted-agent-runtime/hostedAgentContext.js');
 // @ts-expect-error - example module
 const {Jobs}=await import('../examples/qa-agent/jobs.mjs');
 // @ts-expect-error - example module
 const {Checkpoints}=await import('../examples/qa-agent/checkpoints.mjs');
 // @ts-expect-error - example module
 const {advanceHostedValidation}=await import('../examples/qa-agent/validation.mjs');
 const root=mkdtempSync(join(tmpdir(),'qa-gateway-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const jobs=new Jobs(join(root,'jobs.sqlite3'));t.after(()=>jobs.close());
 const checkpoints=new Checkpoints(join(root,'checkpoints'));
 let resolve!:()=>void;const pending=new Promise<void>(r=>{resolve=r;});
 const service=new HostedQaValidationService(join(root,'host'),{agent:profile},async()=>{
  await pending;return {repository:candidate.repository,base:candidate.base,candidateDigest:qaCandidateDigest(candidate),gates:[{gate:'test',passed:true,summary:'ok',diagnostics:''}],passed:true};
 });
 const spec=(id:string)=>({...hostedAgentSpecInput.parse({id,name:id,model:'unused',mode:'handler',files:{'index.mjs':'export default {}'}}),version:1,owner:'test',createdAt:1,updatedAt:1});
 const gateway=new HostedAgentGateway({registry:()=>null,spec:id=>spec(id),log:()=>{},qaValidation:(id,c)=>service.submit(id,c)});
 const url=await gateway.listen('127.0.0.1');t.after(()=>gateway.close());
 const token=gateway.issue('agent'),other=gateway.issue('other');
 const ctx=createHostedAgentCtx({spec:spec('agent'),gateway:{url,token},secrets:{},log:()=>{}},{text:''});
 const denied=await fetch(`${url}/t/${other}/qa/validation`,{method:'POST',body:JSON.stringify(candidate)});
 assert.equal(denied.status,403);
 const forged=await fetch(`${url}/t/${token}/qa/validation`,{method:'POST',body:JSON.stringify({...candidate,agentId:'other'})});
 assert.equal(forged.status,403);
 const job=jobs.enqueue('request',{repository:candidate.repository,base:candidate.base,text:'고쳐줘'});
 const claim=jobs.claim();const coding=checkpoints.save(job.id,{repository:candidate.repository,commit:candidate.base,changes:candidate.changes});
 jobs.finish(job.id,claim.lease,'queued',{stage:'needs_validation',coding});
 const polling=await advanceHostedValidation({jobs,claim:jobs.claim(),checkpoints,ctx});
 assert.equal(polling.state,'queued');assert.equal(polling.checkpoint.stage,'needs_validation');
 resolve();await new Promise(r=>setImmediate(r));
 const done=await advanceHostedValidation({jobs,claim:jobs.claim(),checkpoints,ctx});
 assert.equal(done.state,'waiting');assert.equal(done.checkpoint.stage,'needs_publication');
 assert.equal(done.checkpoint.approval,undefined);
 assert.equal(checkpoints.load(done.checkpoint.validation).candidateDigest,qaCandidateDigest(candidate));
 gateway.revoke(token);
 await assert.rejects(ctx.qa!.validate(candidate),/refused/);
});

test('publication requires durable passing evidence for the exact agent, candidate and gate policy',async t=>{
 const root=mkdtempSync(join(tmpdir(),'qa-publish-proof-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 let runs=0;
 const result={repository:candidate.repository,base:candidate.base,candidateDigest:qaCandidateDigest(candidate),gates:[{gate:'test',passed:true,summary:'ok',diagnostics:''}],passed:true};
 const service=new HostedQaValidationService(root,{agent:profile},async()=>{runs++;return result;});
 assert.throws(()=>service.requirePassed('agent',candidate),/no passing/);assert.equal(runs,0);
 service.submit('agent',candidate);await new Promise(r=>setImmediate(r));
 assert.equal(service.requirePassed('agent',candidate).candidateDigest,result.candidateDigest);
 assert.throws(()=>service.requirePassed('other',candidate),/not configured/);
 assert.throws(()=>service.requirePassed('agent',{...candidate,changes:{'a.js':'changed'}}),/no passing/);
 const changedPolicy=new HostedQaValidationService(root,{agent:{...profile,gates:[...profile.gates,{name:'build',argv:['yarn','build']}]} });
 assert.throws(()=>changedPolicy.requirePassed('agent',candidate),/no passing/);
 const {readdirSync,writeFileSync}=await import('node:fs');
 writeFileSync(join(root,readdirSync(root)[0]!),JSON.stringify({state:'done',result:{...result,gates:[]}}));
 assert.throws(()=>service.requirePassed('agent',candidate),/result binding/);
});

test('runner cannot attest a different candidate or omit mandatory gates',async t=>{
 for(const altered of [{candidateDigest:'0'.repeat(64)},{gates:[]},{gates:[{gate:'other',passed:true}]}]){
  const root=mkdtempSync(join(tmpdir(),'qa-invalid-proof-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const result={repository:candidate.repository,base:candidate.base,candidateDigest:qaCandidateDigest(candidate),gates:[{gate:'test',passed:true,summary:'ok',diagnostics:''}],passed:true,...altered};
  const service=new HostedQaValidationService(root,{agent:profile},async()=>result as any);
  service.submit('agent',candidate);await new Promise(r=>setImmediate(r));
  assert.deepEqual(service.submit('agent',candidate),{state:'failed'});
  assert.throws(()=>service.requirePassed('agent',candidate),/no passing/);
 }
});

test('host preserves bounded private streams across gates without exposing their paths to the agent',async t=>{
 const {readFileSync,readdirSync,statSync}=await import('node:fs');
 const root=mkdtempSync(join(tmpdir(),'qa-private-logs-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const p={...profile,gates:[...profile.gates,{name:'build',argv:['npm','run','build']}]};
 const service=new HostedQaValidationService(root,{agent:p},async(_p,c,evidence)=>{
  await evidence!('test',{passed:true,stdout:'TEST SUMMARY',stderr:'warning'});
  await evidence!('build',{passed:false,stdout:'start\n'+'x'.repeat(2*1024*1024)+'\nend',stderr:'ROOT CAUSE'});
  return {repository:c.repository,base:c.base,candidateDigest:qaCandidateDigest(c),passed:false,gates:[{gate:'test',passed:true,summary:'ok',diagnostics:''},{gate:'build',passed:false,summary:'failed',diagnostics:''}]};
 });
 service.submit('agent',candidate);await new Promise(r=>setImmediate(r));
 const status=service.submit('agent',candidate);assert.equal(status.state,'done');assert(!JSON.stringify(status).includes(root));
 const logs=join(root,'logs',readdirSync(join(root,'logs'))[0]!);
 assert.equal(readFileSync(join(logs,'test.stdout.log'),'utf8'),'TEST SUMMARY');
 assert.equal(readFileSync(join(logs,'build.stderr.log'),'utf8'),'ROOT CAUSE');
 const long=readFileSync(join(logs,'build.stdout.log'),'utf8');assert(long.startsWith('start\n'));assert(long.endsWith('\nend'));assert(long.includes('[private log truncated]'));assert(Buffer.byteLength(long)<1024*1024+100);
 for(const name of readdirSync(logs))assert.equal(statSync(join(logs,name)).mode&0o077,0);
});

test('a redirected log directory cannot receive evidence or authorize a passing receipt',async t=>{
 const {symlinkSync,readdirSync}=await import('node:fs');
 const root=mkdtempSync(join(tmpdir(),'qa-log-link-')),outside=mkdtempSync(join(tmpdir(),'qa-log-outside-'));
 t.after(()=>{rmSync(root,{recursive:true,force:true});rmSync(outside,{recursive:true,force:true});});
 symlinkSync(outside,join(root,'logs'),'dir');
 const service=new HostedQaValidationService(root,{agent:profile},async(_p,c,evidence)=>{
  await evidence!('test',{passed:true,stdout:'private diagnostic',stderr:''});
  return {repository:c.repository,base:c.base,candidateDigest:qaCandidateDigest(c),passed:true,gates:[{gate:'test',passed:true,summary:'ok',diagnostics:''}]};
 });
 service.submit('agent',candidate);await new Promise(r=>setImmediate(r));
 assert.deepEqual(service.submit('agent',candidate),{state:'failed'});
 assert.deepEqual(readdirSync(outside),[]);assert.throws(()=>service.requirePassed('agent',candidate),/no passing/);
});

test('host execution exceptions retry after a durable delay and recover across restart',async t=>{
 const root=mkdtempSync(join(tmpdir(),'qa-execution-retry-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 let now=100000,runs=0;
 const run=async()=>{runs++;if(runs===1)throw new Error('temporary export failure');return {repository:candidate.repository,base:candidate.base,candidateDigest:qaCandidateDigest(candidate),gates:[{gate:'test',passed:true,summary:'ok',diagnostics:''}],passed:true};};
 let service=new HostedQaValidationService(root,{agent:profile},run,undefined,()=>now);
 assert.equal(service.submit('agent',candidate).state,'running');await new Promise(r=>setImmediate(r));
 assert.deepEqual(service.submit('agent',candidate),{state:'busy'});assert.equal(runs,1);
 assert.throws(()=>service.requirePassed('agent',candidate),/no passing/);
 service=new HostedQaValidationService(root,{agent:profile},run,undefined,()=>now);
 assert.equal(service.submit('agent',candidate).state,'busy');now+=30000;
 assert.equal(service.submit('agent',candidate).state,'running');assert.equal(service.submit('agent',candidate).state,'running');
 await new Promise(r=>setImmediate(r));assert.equal(runs,2);assert.equal(service.requirePassed('agent',candidate).passed,true);
});
test('host execution retries stop at three attempts but product failures are returned unchanged',async t=>{
 const root=mkdtempSync(join(tmpdir(),'qa-retry-limit-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 let now=100000,runs=0;
 const service=new HostedQaValidationService(root,{agent:profile},async()=>{runs++;throw new Error('unavailable');},undefined,()=>now);
 for(let i=0;i<3;i++){assert.equal(service.submit('agent',candidate).state,'running');await new Promise(r=>setImmediate(r));now+=30000;}
 assert.deepEqual(service.submit('agent',candidate),{state:'failed'});assert.equal(runs,3);
 const otherRoot=join(root,'product');let productRuns=0;
 const product=new HostedQaValidationService(otherRoot,{agent:profile},async()=>{productRuns++;return {repository:candidate.repository,base:candidate.base,candidateDigest:qaCandidateDigest(candidate),gates:[{gate:'test',passed:false,summary:'assertion failed',diagnostics:''}],passed:false};});
 product.submit('agent',candidate);await new Promise(r=>setImmediate(r));
 const status=product.submit('agent',candidate);assert.equal(status.state,'done');if(status.state==='done')assert.equal(status.result.passed,false);
 assert.equal(productRuns,1);
});
