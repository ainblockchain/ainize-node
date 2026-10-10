import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {verifyHistoricalQaIntake} from '../src/hosted-qa-historical-intake.js';
import {captureQaTeamsRequest} from '../src/hosted-qa-teams-thread.js';
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function setup(){
 const parent={id:'request',userId:'human',content:'메시지 여백 고쳐줘.',parentId:null,createdAt:'2020-01-01T00:00:00.123Z'};
 const profile={repository:'test/product',branch:'main',databaseId:'board',intakeEnabledAt:'2026-10-01T00:00:00Z',policy:{issuer:'https://auth.example',orgId:'org',workspaceId:'ainmem',teamsWorkspaceId:'teams',channelId:'qa',approverSubjects:['admin']},identities:{'https://auth.example\nadmin':'admin-user'}};
 const archive={kind:'legacy-job-v1',repository:'test/product',workspaceId:'teams',channelId:'qa',job:{id:'job',message_id:'request',status:'awaiting_approval',payload:{message_id:'request',parent_id:'request',sender_id:'human',text:parent.content,created_at:Date.parse(parent.createdAt)/1000},details:{approval:{subject:'admin',command:'LGTM'},code_sha:'a'.repeat(40)}},reports:[]};
 let author=true,channel=true,truncated=false;
 const mcp={call:async(name:string)=>{
  if(name==='list_channels')return channel?[{id:'qa'}]:[];
  if(name==='list_channel_members')return [...(author?[{userId:'human',isAgent:false}]:[]),{userId:'admin-user',isAgent:false}];
  if(name==='read_channel')return {messages:[parent],nextCursor:null};
  if(name==='read_thread')return {parent,replies:[],truncated};throw Error('unexpected tool');
 }};
 return {parent,profile,archive,mcp,revoke(){author=false;},hide(){channel=false;},truncate(){truncated=true;}};
}
test('offline historical verification preserves the original timestamp and excludes archived approvals',async()=>{
 const f=setup();
 await assert.rejects(captureQaTeamsRequest(f.mcp,f.profile.policy,f.profile.identities,{messageId:'request'},f.profile.intakeEnabledAt),/fresh fix/);
 const evidence=await verifyHistoricalQaIntake(f.mcp,f.profile,f.archive,hash(f.archive));
 assert.equal(evidence.binding.requestCreatedAt,f.parent.createdAt);assert.equal(evidence.jobId,'job');
 assert.equal(evidence.archiveDigest,hash(f.archive));assert.equal(evidence.text,f.parent.content);
 assert.deepEqual(Object.keys(evidence).sort(),['archiveDigest','binding','jobId','repository','text']);
 assert.equal('approval' in evidence,false);
});
test('historical verification refuses changed canonical content, author, timestamp and incomplete reads',async()=>{
 for(const field of ['content','userId','createdAt']){
  const f=setup(),fingerprint=hash(f.archive);f.parent[field]=field==='createdAt'?'2020-01-01T00:00:00.124Z':'changed';
  await assert.rejects(verifyHistoricalQaIntake(f.mcp,f.profile,f.archive,fingerprint),/Original request changed/);
 }
 for(const action of ['revoke','hide','truncate'] as const){const f=setup();f[action]();await assert.rejects(verifyHistoricalQaIntake(f.mcp,f.profile,f.archive,hash(f.archive)));}
});
test('terminal jobs, missing times, wrong scope and forged archives cannot obtain historical evidence',async()=>{
 const f=setup();await assert.rejects(verifyHistoricalQaIntake(f.mcp,f.profile,f.archive,'a'.repeat(64)),/archive binding/);
 for(const status of ['completed','failed','queued','working']){
  const archive={...f.archive,job:{...f.archive.job,status}};await assert.rejects(verifyHistoricalQaIntake(f.mcp,f.profile,archive,hash(archive)),/unfinished/);
 }
 for(const created_at of [null,undefined,NaN,Date.now()]){
  const archive={...f.archive,job:{...f.archive.job,payload:{...f.archive.job.payload,created_at}}};
  await assert.rejects(verifyHistoricalQaIntake(f.mcp,f.profile,archive,hash(archive)),/timestamp/);
 }
 await assert.rejects(verifyHistoricalQaIntake(f.mcp,{...f.profile,repository:'other/product'},f.archive,hash(f.archive)),/binding/);
 const approval={...f.archive,job:{...f.archive.job,payload:{...f.archive.job.payload,text:'LGTM'}}};
 await assert.rejects(verifyHistoricalQaIntake(f.mcp,f.profile,approval,hash(approval)),/not a fix/);
});

test('operator activation is atomic, idempotent and rechecks membership on retry',async t=>{
 const {mkdtempSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const {DatabaseSync}=await import('node:sqlite');const {HostedQaReviewStore}=await import('../src/hosted-qa-review-store.js');const {HostedQaIntake}=await import('../src/hosted-qa-intake.js');
 const root=mkdtempSync(join(tmpdir(),'qa-history-activate-')),store=new HostedQaReviewStore(root),f=setup();
 t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
 const service=new HostedQaIntake(store,{agent:f.profile},()=>f.mcp);
 const db=new DatabaseSync(join(root,'reviews.sqlite3'));db.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON review_historical_intakes BEGIN SELECT RAISE(ABORT,'audit write failed'); END");db.close();
 await assert.rejects(service.importHistorical('agent',f.archive,hash(f.archive)),/audit write failed/);
 assert.equal(store.intake('agent','job'),null);assert.equal(store.historicalIntake('agent','job'),null);
 const repair=new DatabaseSync(join(root,'reviews.sqlite3'));repair.exec('DROP TRIGGER fail_audit');repair.close();
 const verified=await service.importHistorical('agent',f.archive,hash(f.archive));
 assert.deepEqual(await service.importHistorical('agent',f.archive,hash(f.archive)),verified);
 assert.deepEqual(store.intake('agent','job'),verified.binding);assert.equal(store.publication('agent','job'),null);assert.equal(store.current('agent','job'),null);
 const duplicate={...f.archive,job:{...f.archive.job,id:'other-job'}};
 await assert.rejects(service.importHistorical('agent',duplicate,hash(duplicate)),/already assigned/);
 f.revoke();await assert.rejects(service.importHistorical('agent',f.archive,hash(f.archive)),/no longer/);
 assert.deepEqual(store.historicalIntake('agent','job'),verified);
 assert.throws(()=>store.registerHistoricalIntake('agent',{...verified,approval:{approved:true}} as any),/Invalid/);
});

test('historical shared activation preserves the archived API route and rolls back partial route writes',async t=>{
 const {mkdtempSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {DatabaseSync}=await import('node:sqlite');
 const {HostedQaReviewStore}=await import('../src/hosted-qa-review-store.js');const {HostedQaRoutes}=await import('../src/hosted-qa-routes.js');const {HostedQaIntake}=await import('../src/hosted-qa-intake.js');
 const root=mkdtempSync(join(tmpdir(),'qa-history-route-')),store=new HostedQaReviewStore(root),f=setup();
 t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
 const profiles={web:f.profile,api:{...f.profile,repository:'test/api'}};
 const routes=new HostedQaRoutes(store,{bot:{web:'web',api:'api'}},profiles,()=>f.mcp);
 const archive={...f.archive,repository:'test/api'},fingerprint=hash(archive);
 routes.importHistory('bot',[{archive,fingerprint}]);
 await assert.rejects(new HostedQaIntake(store,profiles,()=>f.mcp).importHistorical('api',archive,fingerprint),/requires routed/);
 const db=new DatabaseSync(join(root,'reviews.sqlite3'));db.exec("CREATE TRIGGER fail_route BEFORE INSERT ON review_routes BEGIN SELECT RAISE(ABORT,'route write failed'); END");db.close();
 await assert.rejects(routes.activateHistory('bot',archive,fingerprint),/route write failed/);
 assert.equal(store.intake('api','job'),null);assert.equal(store.historicalIntake('api','job'),null);assert.equal(store.routedIntake('bot','job'),null);
 const repair=new DatabaseSync(join(root,'reviews.sqlite3'));repair.exec('DROP TRIGGER fail_route');repair.close();
 const evidence=await routes.activateHistory('bot',archive,fingerprint);
 assert.equal(routes.resolve('bot','job'),'api');assert.equal(store.routedIntake('bot','job')?.route,'api');assert.equal(store.intake('web','job'),null);
 assert.deepEqual(await routes.activateHistory('bot',archive,fingerprint),evidence);
 assert.equal(routes.submit('bot',{jobId:'job',locator:{messageId:'request'}}).state,'done');
 assert.throws(()=>routes.resolve('api','job'),/Internal/);
 assert.equal(store.current('api','job'),null);assert.equal(store.publication('api','job'),null);
});
