import {test} from 'node:test';
import assert from 'node:assert/strict';
import {observeQaDeployment,validateDeploymentProfile,type QaDeploymentProfile} from '../src/hosted-qa-deployment.js';
import type {StoredReview} from '../src/hosted-qa-review-store.js';
const profile:QaDeploymentProfile={repository:'test/product',branch:'main',url:'https://product.example/api/health',revisionPath:['version'],healthy:[{path:['status'],equals:'ok'},{path:['checks','database','status'],equals:'ok'}]};
const candidate='a'.repeat(40),merge='b'.repeat(40),serving='c'.repeat(40);
const review={presentation:{target:{repository:profile.repository,branch:'main',sha:candidate,number:7}}} as StoredReview;
const pr={number:7,head:{sha:candidate,repo:{full_name:profile.repository}},base:{ref:'main',repo:{full_name:profile.repository}},merged:true,merge_commit_sha:merge,merged_at:'2026-10-10T00:00:00Z'};
const read=async(path:string)=>path.includes('/pulls/')?pr:path.includes('/commits/')?{sha:serving}:{status:'ahead',behind_by:0,base_commit:{sha:path.split('/compare/')[1].split('...')[0]},merge_base_commit:{sha:path.split('/compare/')[1].split('...')[0]}};
const health={status:'ok',version:serving.slice(0,9),checks:{database:{status:'ok'}}};
const response=(body:any)=>async()=>new Response(JSON.stringify(body));
test('only a healthy deployed commit containing both reviewed candidate and GitHub merge is verified',async()=>{
 const calls:string[]=[];
 const result=await observeQaDeployment(profile,review,async path=>{calls.push(path);return read(path);},response(health));
 assert.equal(result.state,'deployment_verified');if(result.state!=='deployment_verified')throw Error();
 assert.equal(result.servingCommit,serving);assert.equal(result.featureRegressionVerified,false);
 assert.ok(calls.includes(`/repos/test/product/compare/${candidate}...${serving}`));assert.ok(calls.includes(`/repos/test/product/compare/${merge}...${serving}`));
});
test('an open PR or older deployment stays pending',async()=>{
 assert.equal((await observeQaDeployment(profile,review,async()=>({...pr,merged:false}),async()=>{throw Error('must not fetch');})).state,'awaiting_merge_evidence');
 const result=await observeQaDeployment(profile,review,async path=>path.includes('/compare/')?{status:'behind',behind_by:1}:read(path),response(health));
 assert.equal(result.state,'awaiting_deployment');
});
test('changed PR, unhealthy dependency, missing revision, semver and unrelated resolution fail closed',async()=>{
 await assert.rejects(observeQaDeployment(profile,review,async()=>({...pr,head:{...pr.head,sha:serving}}),response(health)),/PR changed/);
 for(const value of [{...health,checks:{database:{status:'down'}}},{...health,version:undefined},{...health,version:'0.4.2'}])await assert.rejects(observeQaDeployment(profile,review,read,response(value)));
 await assert.rejects(observeQaDeployment(profile,review,async path=>path.includes('/commits/')?{sha:merge}:read(path),response(health)),/did not resolve/);
 assert.throws(()=>validateDeploymentProfile({...profile,healthy:[]}),/Explicit/);
});
test('configured endpoint is read without redirect or caching',async()=>{
 await observeQaDeployment(profile,review,read,async(url,init)=>{assert.equal(url,profile.url);assert.equal(init?.redirect,'error');assert.equal(init?.cache,'no-store');assert.equal(new Headers(init?.headers).has('authorization'),false);return new Response(JSON.stringify(health));});
 assert.throws(()=>validateDeploymentProfile({...profile,url:'http://product.example/api/health'}),/binding/);
});
