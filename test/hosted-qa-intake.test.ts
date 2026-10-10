import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {HostedQaReviewStore} from '../src/hosted-qa-review-store.js';
import {HostedQaIntake} from '../src/hosted-qa-intake.js';
import {HostedQaPublicationService} from '../src/hosted-qa-publication-service.js';
function fixture(t:any){
 const root=mkdtempSync(join(tmpdir(),'qa-intake-'));let store=new HostedQaReviewStore(root);t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
 const parent={id:'request',userId:'human',content:'메시지 여백 고쳐줘.',parentId:null,createdAt:new Date().toISOString()};
 const profile={repository:'test/product',branch:'main',databaseId:'board',intakeEnabledAt:new Date(Date.now()-60000).toISOString(),policy:{issuer:'https://auth.example',orgId:'org',workspaceId:'ainmem',teamsWorkspaceId:'teams',channelId:'qa',approverSubjects:['admin']},identities:{'https://auth.example\nadmin':'admin-user'}};
 let reads=0;
 const mcp={call:async(name:string)=>{reads++;if(name==='list_channels')return [{id:'qa'}];if(name==='list_channel_members')return [{userId:'human',isAgent:false},{userId:'admin-user',isAgent:false}];if(name==='read_channel')return {messages:[parent],nextCursor:null};if(name==='read_thread')return {parent,replies:[]};throw Error();}};
 return {get store(){return store;},parent,profile,mcp,reads:()=>reads,reopen:()=>{store.close();store=new HostedQaReviewStore(root);},service:()=>new HostedQaIntake(store,{agent:profile},()=>mcp)};
}
test('host intake survives restart and refuses rebinding or duplicate original requests',async t=>{
 const f=fixture(t),service=f.service(),input={jobId:'job',locator:{messageId:'request'}};
 assert.equal(service.submit('agent',input).state,'running');await service.drain();
 const result=service.submit('agent',input);assert.equal(result.state,'done');assert.equal(result.result?.requestAuthorId,'human');
 const reads=f.reads();f.reopen();assert.equal(f.service().submit('agent',input).state,'done');assert.equal(f.reads(),reads);
 assert.throws(()=>f.service().submit('agent',{jobId:'job',locator:{messageId:'other'}}),/changed/);
 const duplicate=f.service();duplicate.submit('agent',{...input,jobId:'duplicate'});await duplicate.drain();assert.equal(duplicate.submit('agent',{...input,jobId:'duplicate'}).state,'failed');
 assert.equal(f.store.intake('agent','duplicate'),null);
});
test('stale requests, approval commands and forged author fields never register',async t=>{
 const f=fixture(t),input={jobId:'job',locator:{messageId:'request'}};
 f.parent.content='LGTM';const command=f.service();command.submit('agent',input);await command.drain();assert.equal(command.submit('agent',input).state,'failed');
 f.parent.content='여백 고쳐줘.';f.parent.createdAt='2020-01-01T00:00:00Z';const stale=f.service();stale.submit('agent',input);await stale.drain();assert.equal(stale.submit('agent',input).state,'failed');
 assert.throws(()=>f.service().submit('agent',{...input,locator:{messageId:'request',author:'admin'}}),/Invalid/);
 assert.throws(()=>f.service().submit('other',input),/disabled/);assert.equal(f.store.intake('agent','job'),null);
});
test('publication guard runs before GitHub work and host attaches the stored original request',async t=>{
 const f=fixture(t);let writes=0;
 const publisher=new HostedQaPublicationService({publish:async()=>{writes++;return {sha:'b'.repeat(40)};}} as any,(id,job,r)=>f.store.enqueuePublication(id,job,{...(r as object),teamsRequest:f.store.intake(id,job)}),(id,job)=>{if(!f.store.intake(id,job))throw Error('Verified intake required');});
 const input={jobId:'job',candidate:{repository:'test/product',base:'a'.repeat(40),changes:{file:'fix'}}};
 assert.throws(()=>publisher.submit('agent',input),/intake required/);assert.equal(writes,0);
 const intake=f.service();intake.submit('agent',{jobId:'job',locator:{messageId:'request'}});await intake.drain();
 publisher.submit('agent',input);await new Promise(r=>setImmediate(r));assert.equal(writes,1);assert.equal(f.store.publication('agent','job').teamsRequest.requestId,'request');
});
