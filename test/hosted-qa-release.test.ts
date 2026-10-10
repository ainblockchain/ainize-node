import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {HostedQaReviewStore} from '../src/hosted-qa-review-store.js';
import {HostedQaRelease,type QaReleaseGitHub} from '../src/hosted-qa-release.js';
import {qaCandidateDigest} from '../src/hosted-qa-validator.js';
import {captureReview,type ReviewTarget} from '../src/hosted-qa-review.js';
const target:ReviewTarget={jobId:'job',repository:'test/product',branch:'main',base:'a'.repeat(40),sha:'b'.repeat(40),number:1,candidateDigest:'c'.repeat(64),pageId:'page',databaseId:'board',workspaceId:'ainmem',teamsWorkspaceId:'teams',channelId:'qa',issuer:'https://auth.example',orgId:'org'};
const candidate={repository:target.repository,base:target.base,changes:{'file':'fixed'}};
target.candidateDigest=qaCandidateDigest(candidate);
const body=`https://github.com/test/product/pull/1\n${target.sha}`;
function fixture(t:any){
 const root=mkdtempSync(join(tmpdir(),'qa-release-'));const store=new HostedQaReviewStore(root);t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
 const presentation=captureReview(target,{jobId:'job',databaseId:'board',pageId:'page',workspaceId:'ainmem',issuer:target.issuer,orgId:'org',body,revision:1,digest:'d'.repeat(64),observedAt:'2026-10-10T00:00:00Z',truncated:false,approvalGranted:false,comments:[]},body);
 const review=store.bind('agent',presentation,0);
 store.enqueuePublication('agent','job',{...target,candidate});
 const approval={source:'ainmem' as const,jobId:'job',pageId:'page',commentId:'human-comment',subject:'admin',issuer:target.issuer,orgId:'org',repository:target.repository,number:1,sha:target.sha,candidateDigest:target.candidateDigest,presentationDigest:presentation.bodyDigest,approvedAt:'2026-10-10T00:00:10Z',checkedAt:'2026-10-10T00:00:20Z',generation:1};
 const state={tip:target.base,patches:0,checks:0,approved:true,validation:true,protection:null as any,rules:[] as any[],parents:[{sha:target.base}],loseReply:false,race:false};
 const github:QaReleaseGitHub=async(method,path,input:any)=>{
  if(method==='PATCH'){
   state.patches++;assert.deepEqual(input,{sha:target.sha,force:false});assert.ok(store.releaseRecord(review),'intent must exist before any external mutation');
   if(state.race)state.tip='e'.repeat(40);
   if(state.tip!==target.base&&state.tip!==target.sha)throw Error('non-fast-forward');
   state.tip=target.sha;if(state.loseReply){state.loseReply=false;throw Error('lost response');}return {object:{sha:state.tip}};
  }
  if(path.includes('/git/ref/'))return {object:{sha:state.tip}};
  if(path.includes('/branches?'))return state.protection||state.rules.length?[]:[{name:'main',protected:false}];
  if(path.endsWith('/branches/main'))return {name:'main',protected:!!state.protection||!!state.rules.length};
  if(path.includes('/git/commits/'))return {sha:target.sha,parents:state.parents};
  throw Error('Unexpected endpoint');
 };
 const make=()=>new HostedQaRelease(store,{check:async()=>{state.checks++;return state.approved?approval:null;}},{agent:{repository:target.repository,branch:'main',mode:'fast-forward-unprotected'}},github,()=>{if(!state.validation)throw Error('validation policy changed');});
 return {state,store,review,make};
}
test('fresh approval, direct-parent check and durable intent precede exact nonforced branch update',async t=>{
 const f=fixture(t);const result:any=await f.make().attempt('agent','job');
 assert.equal(result.state,'branch_updated');assert.equal(result.deploymentVerified,false);assert.equal(result.sha,target.sha);
 assert.equal(f.state.checks,1);assert.equal(f.state.patches,1);assert.equal(f.store.releaseRecord(f.review)?.receipt.sha,target.sha);
});
test('no approval or repository protection cannot be bypassed',async t=>{
 const f=fixture(t);f.state.approved=false;assert.deepEqual(await f.make().attempt('agent','job'),{state:'awaiting_approval'});assert.equal(f.state.patches,0);
 f.state.approved=true;f.state.protection={enforce_admins:{enabled:false}};await assert.rejects(f.make().attempt('agent','job'),/Protected/);assert.equal(f.state.patches,0);
 f.state.protection=null;f.state.rules=[{type:'pull_request'}];await assert.rejects(f.make().attempt('agent','job'),/Protected/);assert.equal(f.state.patches,0);
});
test('a concurrent main update is not overwritten and a changed base is not retried blindly',async t=>{
 const f=fixture(t);f.state.race=true;await assert.rejects(f.make().attempt('agent','job'),/non-fast-forward/);
 assert.equal(f.state.tip,'e'.repeat(40));assert.equal(f.state.patches,1);
 await assert.rejects(f.make().attempt('agent','job'),/base changed/);assert.equal(f.state.patches,1);
});
test('lost response and recreated release service reconcile the actual branch without another write',async t=>{
 const f=fixture(t);f.state.loseReply=true;
 const first:any=await f.make().attempt('agent','job');f.state.approved=false;
 const retry:any=await f.make().attempt('agent','job');assert.equal(first.sha,retry.sha);assert.equal(f.state.patches,1);assert.equal(f.state.checks,1);
});
test('unexpected commit ancestry and an already changed branch without an intent fail closed',async t=>{
 const f=fixture(t);f.state.parents=[{sha:'e'.repeat(40)}];await assert.rejects(f.make().attempt('agent','job'),/direct child/);
 f.state.tip=target.sha;await assert.rejects(f.make().attempt('agent','job'),/base changed/);assert.equal(f.state.patches,0);
});

test('changed host validation policy prevents release even with an administrator approval',async t=>{
 const f=fixture(t);f.state.validation=false;
 await assert.rejects(f.make().attempt('agent','job'),/validation policy changed/);
 assert.equal(f.state.patches,0);assert.equal(f.state.checks,0);assert.equal(f.store.releaseRecord(f.review),null);
});


test('host lifecycle exposes only matching release evidence and rejects changed review targets',async t=>{
 const f=fixture(t);
 assert.equal(f.store.lifecycle('agent','job').state,'awaiting_approval');
 await f.make().attempt('agent','job');assert.equal(f.store.lifecycle('agent','job').state,'branch_updated');
 f.store.releaseObserved(f.review,{repository:target.repository,sha:target.sha,state:'deployment_verified',servingCommit:'d'.repeat(40),mergeCommit:'e'.repeat(40)});
 const status=f.store.lifecycle('agent','job');assert.equal(status.state,'deployment_verified');assert.equal(status.servingCommit,'d'.repeat(40));assert.equal('candidate' in status,false);
 f.store.bind('agent',{...f.review.presentation,target:{...f.review.presentation.target,sha:'f'.repeat(40)},presentedAt:'2026-10-10T00:01:00Z'},1);
 assert.throws(()=>f.store.lifecycle('agent','job'),/binding changed/);
});

test('base changed at release remains invalidated if the branch returns to its previous tip',async t=>{
 const f=fixture(t);f.state.tip='e'.repeat(40);
 await assert.rejects(f.make().attempt('agent','job'),/base changed/);
 assert.equal(f.store.lifecycle('agent','job').state,'requires_revalidation');
 f.state.tip=target.base;
 await assert.rejects(f.make().attempt('agent','job'),/base changed/);
 assert.equal(f.state.patches,0);assert.equal(f.state.checks,0);
});
