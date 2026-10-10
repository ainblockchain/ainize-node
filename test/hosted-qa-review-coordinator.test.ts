import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {HostedQaReviewStore} from '../src/hosted-qa-review-store.js';
import {HostedQaReviewCoordinator} from '../src/hosted-qa-review-coordinator.js';
import {captureReview,type ReviewTarget,type ReviewSnapshot} from '../src/hosted-qa-review.js';
const target:ReviewTarget={jobId:'job',repository:'test/product',branch:'main',base:'a'.repeat(40),sha:'b'.repeat(40),number:1,candidateDigest:'c'.repeat(64),pageId:'page',databaseId:'board',workspaceId:'ainmem',teamsWorkspaceId:'teams',channelId:'qa',issuer:'https://auth.example',orgId:'org'};
const body=`https://github.com/test/product/pull/1\n${target.sha}`;
const policy={issuer:target.issuer,orgId:target.orgId,workspaceId:target.workspaceId,teamsWorkspaceId:target.teamsWorkspaceId,channelId:target.channelId,approverSubjects:['admin']};
const profile={repository:target.repository,branch:target.branch,databaseId:target.databaseId,policy,identities:{'https://auth.example\nadmin':'teams-admin'}};
const snapshot:ReviewSnapshot={jobId:'job',databaseId:'board',pageId:'page',workspaceId:'ainmem',issuer:target.issuer,orgId:'org',body,revision:1,digest:'d'.repeat(64),observedAt:'2026-10-10T00:00:00Z',truncated:false,approvalGranted:false,comments:[]};
const pr={state:'open',number:1,head:{sha:target.sha,repo:{full_name:target.repository}},base:{sha:target.base,ref:'main',repo:{full_name:target.repository}}};
test('restart preserves first presentation; every observation rereads permissions and does not cache approval',async t=>{
 const root=mkdtempSync(join(tmpdir(),'qa-review-ledger-'));let store=new HostedQaReviewStore(root);t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
 let current=structuredClone(snapshot),active=true,reads=0;
 const readers={ainmem:async()=>{reads++;return structuredClone(current);},github:async()=>pr,teams:()=>({call:async(name:string)=>name==='list_channels'?[{id:'qa'}]:active?[{userId:'teams-admin',isAgent:false}]:[]})};
 let coordinator=new HostedQaReviewCoordinator(store,{agent:profile},readers);
 const first=await coordinator.register('agent',target,body);assert.equal(first.generation,1);
 store.close();store=new HostedQaReviewStore(root);coordinator=new HostedQaReviewCoordinator(store,{agent:profile},readers);
 current.observedAt='2026-10-10T00:00:20Z';
 assert.equal((await coordinator.register('agent',target,body)).presentation.presentedAt,snapshot.observedAt);
 current.comments=[{id:'comment',body:'LGTM',createdAt:'2026-10-10T00:00:10Z',authorId:'human',subject:'admin'}];
 const decision=await coordinator.check('agent','job',Date.parse(current.observedAt));assert.equal(decision?.generation,1);assert.equal(decision?.sha,target.sha);
 active=false;assert.equal(await coordinator.check('agent','job',Date.parse(current.observedAt)),null);assert.equal(reads,4);
 assert.equal(statSync(join(root,'reviews.sqlite3')).mode&0o077,0);
 await assert.rejects(coordinator.check('other','job'),/not configured/);
 const changed=new HostedQaReviewCoordinator(store,{agent:{...profile,policy:{...policy,approverSubjects:['admin','new']}}},readers);
 await assert.rejects(changed.check('agent','job',Date.parse(current.observedAt)),/policy changed/);
});
test('candidate changes create a new generation; old approval and delayed capture cannot overwrite it',()=>{
 const root=mkdtempSync(join(tmpdir(),'qa-review-race-'));const store=new HostedQaReviewStore(root);
 try{
  const first=store.bind('agent',captureReview(target,snapshot,body),0);
  const nextTarget={...target,sha:'e'.repeat(40)},nextBody=body.replace(target.sha,nextTarget.sha);
  const nextSnapshot={...snapshot,body:nextBody,revision:2,observedAt:'2026-10-10T00:00:30Z'};
  const next=store.bind('agent',captureReview(nextTarget,nextSnapshot,nextBody),1);assert.equal(next.generation,2);
  assert.throws(()=>store.observe(first,{} as any),/changed while checking/);
  assert.throws(()=>store.bind('agent',captureReview(target,{...snapshot,observedAt:'2026-10-10T00:00:40Z'},body),1),/changed while capturing/);
  // Returning to a previous candidate is a new generation, never reuse of the previous review.
  const restored=store.bind('agent',captureReview(target,{...snapshot,observedAt:'2026-10-10T00:01:00Z'},body),2);
  assert.equal(restored.generation,3);assert.equal(restored.presentation.presentedAt,'2026-10-10T00:01:00Z');
 }finally{store.close();rmSync(root,{recursive:true,force:true});}
});
test('an in-flight canonical check cannot record approval after another worker replaces the review',async()=>{
 const root=mkdtempSync(join(tmpdir(),'qa-review-check-race-'));const store=new HostedQaReviewStore(root);
 try{
  const bootstrap=new HostedQaReviewCoordinator(store,{agent:profile},{ainmem:async()=>snapshot,github:async()=>pr,teams:()=>({call:async()=>[]})});
  const first=await bootstrap.register('agent',target,body);
  const later={...snapshot,observedAt:'2026-10-10T00:00:20Z',comments:[{id:'comment',body:'LGTM',createdAt:'2026-10-10T00:00:10Z',authorId:'human',subject:'admin'}]};
  const coordinator=new HostedQaReviewCoordinator(store,{agent:profile},{github:async()=>pr,teams:()=>({call:async(name:string)=>name==='list_channels'?[{id:'qa'}]:[{userId:'teams-admin',isAgent:false}]}),ainmem:async()=>{
   store.bind('agent',captureReview(target,{...snapshot,revision:2,observedAt:'2026-10-10T00:00:30Z'},body),first.generation);return later;
  }});
  await assert.rejects(coordinator.check('agent','job',Date.parse(later.observedAt)),/changed while checking/);
 }finally{store.close();rmSync(root,{recursive:true,force:true});}
});
