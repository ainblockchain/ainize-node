import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {HostedQaReviewStore} from '../src/hosted-qa-review-store.js';
import {HostedQaBases} from '../src/hosted-qa-base.js';
import {HostedQaRevalidationService} from '../src/hosted-qa-revalidation-service.js';
import {qaCandidateDigest} from '../src/hosted-qa-validator.js';
import {captureReview} from '../src/hosted-qa-review.js';
const old='a'.repeat(40),middle='b'.repeat(40),latest='c'.repeat(40),repository='test/product';
const binding={workspaceId:'teams',channelId:'qa',rootId:'root',requestId:'request',requestAuthorId:'human',requestDigest:'d'.repeat(64),requestCreatedAt:'2026-10-10T00:00:00Z'};
const target={jobId:'job',repository,branch:'main',base:old,sha:'d'.repeat(40),number:1,candidateDigest:'e'.repeat(64),pageId:'page',databaseId:'board',workspaceId:'ainmem',teamsWorkspaceId:'teams',channelId:'qa',issuer:'https://auth.example',orgId:'org',teamsRequest:binding};
const snapshot=(body:string)=>({jobId:'job',databaseId:'board',pageId:'page',workspaceId:'ainmem',issuer:target.issuer,orgId:'org',body,revision:1,digest:'f'.repeat(64),observedAt:'2026-10-11T00:00:00Z',truncated:false,approvalGranted:false as const,comments:[]});
for(const published of [false,true])test(`repeated main movement resumes with ${published?'an archived PR':'no prior PR'} and keeps exact candidate evidence`,async t=>{
 const root=mkdtempSync(join(tmpdir(),'qa-prepub-'));const store=new HostedQaReviewStore(join(root,'reviews'));
 t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});store.registerIntake('agent','job',binding);
 let original;
 if(published){
  store.enqueuePublication('agent','job',{...target,url:'https://github.com/test/product/pull/1'});
  original=store.bind('agent',captureReview(target,snapshot(`https://github.com/test/product/pull/1\n${target.sha}`),`https://github.com/test/product/pull/1\n${target.sha}`),0);
  store.invalidateBase(original,middle);
 }
 let main=old;
 const profile={repository,base:old,checkout:'/operator/repo',image:'sha256:'+'e'.repeat(64),dependencyPath:'/seed',cwd:'.',gates:[{name:'test',argv:['node','test']}]};
 const bases=new HostedQaBases(join(root,'bases'),{agent:{branch:'main',validation:profile}},{head:async()=>main,prepare:async()=>{}},()=>{assert(store.intake('agent','job'));},(id,job,request)=>store.authorizeRevalidation(id,job,request));
 await bases.prepare('agent','job');let service=new HostedQaRevalidationService(bases,store);
 for(const [index,base] of [old,middle].entries()){
  const candidate={repository,base,changes:{'a.js':`candidate-${index}`}},candidateDigest=qaCandidateDigest(candidate);
  main=index===0?middle:latest;
  store.recordPublicationBaseChange('agent','job',candidate,main);
  const input={jobId:'job',previousBase:base,sequence:index+1,sourceDigest:String(index+1).repeat(64),candidateDigest};
  assert.throws(()=>service.submit('agent',{...input,candidateDigest:'0'.repeat(64)}),/Matching publication drift/);
  assert.equal(service.submit('agent',input).state,'running');await service.drain();
  const status=service.submit('agent',input);assert.equal(status.state,'done');if(status.state!=='done')assert.fail();
  assert.equal(status.result.base,main);assert.equal(status.result.candidateDigest,candidateDigest);
  service=new HostedQaRevalidationService(bases,store);
  assert.equal(service.submit('agent',input).state,'running');await service.drain();assert.deepEqual(service.submit('agent',input),status);
 }
 const replacement={...target,base:latest,sha:'f'.repeat(40),candidateDigest:'1'.repeat(64),number:3,url:'https://github.com/test/product/pull/3'};
 assert.throws(()=>store.enqueuePublication('agent','job',{...replacement,base:middle}),/binding changed|reconciliation/);
 store.enqueuePublication('agent','job',replacement);
 const body=`${replacement.url}\n${replacement.sha}`,snap={...snapshot(body),observedAt:'2026-10-11T00:01:00Z',revision:2};
 const next=store.bind('agent',captureReview(replacement,snap,body),published?1:0);
 assert.equal(next.presentation.target.pageId,'page');assert.equal(next.generation,published?2:1);
 assert.equal(store.revalidationHistory('agent','job').length,2);
 if(published){assert.equal(store.baseChange(original!),middle);assert.equal(store.revalidationHistory('agent','job')[1].publication.sha,target.sha);}
 assert.throws(()=>store.bind('agent',captureReview({...replacement,pageId:'different'},{...snap,pageId:'different',observedAt:'2026-10-11T00:02:00Z'},body),next.generation),/reserved/);
});
