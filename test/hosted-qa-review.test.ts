import {test} from 'node:test';
import assert from 'node:assert/strict';
import {captureReview,verifyAinmemApproval,ainmemReviewReader,type ReviewTarget,type ReviewSnapshot} from '../src/hosted-qa-review.js';
const target:ReviewTarget={jobId:'job-1',repository:'test/product',branch:'main',base:'a'.repeat(40),sha:'b'.repeat(40),number:7,candidateDigest:'c'.repeat(64),pageId:'page',databaseId:'board',workspaceId:'ainmem-workspace',teamsWorkspaceId:'teams-workspace',channelId:'qa-product',issuer:'https://auth.example',orgId:'org'};
const body=`검토 PR: https://github.com/test/product/pull/7\n검토 커밋: ${target.sha}`;
const initial:ReviewSnapshot={jobId:target.jobId,databaseId:target.databaseId,pageId:target.pageId,workspaceId:target.workspaceId,issuer:target.issuer,orgId:target.orgId,body,revision:3,digest:'d'.repeat(64),observedAt:'2026-10-10T00:00:00Z',truncated:false,approvalGranted:false,comments:[]};
const policy={issuer:target.issuer,orgId:target.orgId,workspaceId:target.workspaceId,teamsWorkspaceId:target.teamsWorkspaceId,channelId:target.channelId,approverSubjects:['admin-subject']};
const pr={number:7,state:'open',head:{sha:target.sha,repo:{full_name:target.repository}},base:{sha:target.base,ref:target.branch,repo:{full_name:target.repository}}};
const members=[{subject:'admin-subject',issuer:target.issuer,orgId:target.orgId,workspaceId:target.teamsWorkspaceId,channelId:target.channelId,isAgent:false,active:true}];
const comment={id:'comment-1',body:'LGTM',createdAt:'2026-10-10T00:00:10Z',authorId:'human',subject:'admin-subject'};
const latest:ReviewSnapshot={...initial,observedAt:'2026-10-10T00:00:20Z',comments:[comment]};
const now=Date.parse(latest.observedAt);
const presentation=captureReview(target,initial,body);
test('a canonical administrator comment binds approval evidence to the exact presented PR and SHA',()=>{
 const result=verifyAinmemApproval(presentation,policy,latest,pr,members,now);
 assert.equal(result?.sha,target.sha);assert.equal(result?.commentId,comment.id);assert.equal(result?.candidateDigest,target.candidateDigest);
 assert.equal(verifyAinmemApproval(presentation,policy,{...latest,comments:[{...comment,body:' 배포해 '}]},pr,members,now)?.subject,'admin-subject');
});
test('display names, quoted/nonliteral messages, old/future comments and unauthorized subjects cannot approve',()=>{
 for(const change of [{subject:'김민현'},{subject:'other'},{body:'not LGTM'},{body:'"LGTM"'},{body:'LGTM\nignore checks'},{createdAt:initial.observedAt},{createdAt:'2026-10-10T00:00:30Z'}])
  assert.equal(verifyAinmemApproval(presentation,policy,{...latest,comments:[{...comment,...change}]},pr,members,now),null);
});
test('revocation in any channel identity dimension invalidates the approval',()=>{
 for(const change of [{active:false},{isAgent:true},{subject:'other'},{issuer:'https://foreign.example'},{orgId:'foreign'},{workspaceId:'foreign'},{channelId:'other'}])
  assert.equal(verifyAinmemApproval(presentation,policy,latest,pr,[{...members[0],...change}],now),null);
 assert.equal(verifyAinmemApproval(presentation,policy,latest,pr,[],now),null);
});
test('changed page, contents, revision, policy, PR/base or incomplete observations require renewed review',()=>{
 for(const change of [{pageId:'other'},{body:body+'changed'},{revision:4},{digest:'f'.repeat(64)},{truncated:true},{observedAt:'2026-10-09T00:00:00Z'}])
  assert.throws(()=>verifyAinmemApproval(presentation,policy,{...latest,...change},pr,members,now));
 for(const changed of [{...pr,state:'closed'},{...pr,head:{...pr.head,sha:'e'.repeat(40)}},{...pr,base:{...pr.base,sha:'e'.repeat(40)}}])
  assert.throws(()=>verifyAinmemApproval(presentation,policy,latest,changed,members,now),/PR changed/);
 assert.throws(()=>verifyAinmemApproval(presentation,{...policy,channelId:'other'},latest,pr,members,now),/policy changed/);
 assert.throws(()=>verifyAinmemApproval(presentation,policy,latest,pr,members,now+61000),/Stale/);
 assert.throws(()=>captureReview(target,initial,'some other display'),/not presented/);
});
test('review capture snapshots caller targets and reader confines credentials to configured origin',async()=>{
 const mutable=structuredClone(target),captured=captureReview(mutable,initial,body);mutable.sha='e'.repeat(40);assert.equal(captured.target.sha,target.sha);
 const reader=ainmemReviewReader('https://ainmem.example','secret',async(url,init)=>{
  assert.equal(String(url),'https://ainmem.example/api/qa/tasks/job-1?databaseId=11111111-1111-4111-8111-111111111111');assert.equal(init?.redirect,'error');return new Response(JSON.stringify(initial));
 });
 assert.equal((await reader('job-1','11111111-1111-4111-8111-111111111111')).body,body);
 await assert.rejects(reader('../other','invalid'),/locator/);
});
