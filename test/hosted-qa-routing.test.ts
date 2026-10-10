import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
// @ts-expect-error plain ESM example
import {Jobs} from '../examples/qa-agent/jobs.mjs';
// @ts-expect-error plain ESM example
import {enqueueSharedTeamsRequest,requestedRepositoryRoute} from '../examples/qa-agent/routing.mjs';
const config={service:'ainize',workspaceId:'ws',channelId:'ch',routes:{web:{service:'ainize',repository:'test/web',baseCommit:'a'.repeat(40)},api:{service:'ainize-node',repository:'test/node',baseCommit:'b'.repeat(40)}}};
const message=(text:string,messageId='m1',parentId=messageId)=>({workspaceId:'ws',channelId:'ch',messageId,parentId,text});
function setup(t:any,options={}){
 const root=mkdtempSync(join(tmpdir(),'qa-routing-')),file=join(root,'jobs.sqlite');
 const opened:any[]=[];t.after(()=>{for(const db of opened){try{db.close();}catch{}}rmSync(root,{recursive:true,force:true});});
 return ()=>{const db=new Jobs(file,options);opened.push(db);return db;};
}
test('shared channel selects verified API/web text and defaults a new ordinary request to web',t=>{
 const jobs=setup(t)();
 for(const text of ['API 응답 고쳐줘','백엔드: 오류 고쳐줘','/fix ainize-node 오류'])assert.equal(requestedRepositoryRoute(text),'api');
 assert.equal(requestedRepositoryRoute('API키 표시 고쳐줘'),null);
 assert.equal(enqueueSharedTeamsRequest(jobs,config,message('여백 고쳐줘')).input.repository,'test/web');
 assert.equal(enqueueSharedTeamsRequest(jobs,config,message('API 오류 고쳐줘','m2')).input.repository,'test/node');
 assert.equal(enqueueSharedTeamsRequest(jobs,config,message('웹: 오류 고쳐줘','m3')).input.repository,'test/web');
});
test('restart and retry preserve candidate/approval while replies stay with the original repository',t=>{
 const open=setup(t),jobs=open();const request=message('API 오류 고쳐줘');
 const original=enqueueSharedTeamsRequest(jobs,config,request),claim=jobs.claim();
 jobs.finish(original.id,claim.lease,'waiting',{stage:'awaiting_approval',published:{sha:'c'.repeat(40)},approval:{historical:true}});
 jobs.close();const restored=open();
 const changed={...config,routes:{...config.routes,api:{...config.routes.api,baseCommit:'d'.repeat(40)}}};
 const again=enqueueSharedTeamsRequest(restored,changed,request);
 assert.equal(again.id,original.id);assert.equal(again.input.base,'b'.repeat(40));assert.deepEqual(again.checkpoint.approval,{historical:true});
 assert.equal(enqueueSharedTeamsRequest(restored,changed,message('이것도 고쳐줘','reply','m1')).input.repository,'test/node');
 assert.throws(()=>enqueueSharedTeamsRequest(restored,changed,message('웹 오류 고쳐줘','other','m1')),/new thread/);
 assert.throws(()=>enqueueSharedTeamsRequest(restored,changed,message('웹 오류 고쳐줘','m1')),/request changed/);
 assert.throws(()=>enqueueSharedTeamsRequest(restored,changed,message(request.text,'m1','different-root')),/request changed/);
});
test('historical cross-repository ambiguity is preserved and rejected, with no extra job',t=>{
 const jobs=setup(t)();
 for(const [key,route] of Object.entries(config.routes))jobs.enqueue(key,{service:route.service,repository:route.repository,base:route.baseCommit,text:'old',teams:message('old',key,'thread')});
 assert.throws(()=>enqueueSharedTeamsRequest(jobs,config,message('고쳐줘','new','thread')),/Ambiguous/);
 assert.equal(jobs.db.prepare('SELECT count(*) AS n FROM jobs').get().n,2);
});
test('canonical scope and configuration mismatches do not create jobs; capacity rollback leaves no route',t=>{
 const jobs=setup(t,{limit:1})();
 assert.throws(()=>enqueueSharedTeamsRequest(jobs,config,{...message('API 고쳐줘'),channelId:'other'}),/scope/);
 enqueueSharedTeamsRequest(jobs,config,message('고쳐줘'));
 assert.throws(()=>enqueueSharedTeamsRequest(jobs,config,message('API 고쳐줘','m2')),/capacity/);
 assert.equal(jobs.db.prepare('SELECT count(*) AS n FROM jobs').get().n,1);
 const changed={...config,routes:{...config.routes,web:{...config.routes.web,repository:'other/web'}}};
 assert.throws(()=>enqueueSharedTeamsRequest(jobs,changed,message('고쳐줘')),/route changed/);
});
test('two open database connections observe the same thread owner and deduplicate a delivery',t=>{
 const open=setup(t),first=open(),second=open(),request=message('API 오류 고쳐줘');
 const job=enqueueSharedTeamsRequest(first,config,request);
 assert.equal(enqueueSharedTeamsRequest(second,config,request).id,job.id);
 assert.throws(()=>enqueueSharedTeamsRequest(second,config,message('웹 오류 고쳐줘','reply','m1')),/new thread/);
 assert.equal(first.db.prepare('SELECT count(*) AS n FROM jobs').get().n,1);
});
