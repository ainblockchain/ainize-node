import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {HostedQaReviewStore} from '../src/hosted-qa-review-store.js';
import {HostedQaRoutes} from '../src/hosted-qa-routes.js';
function fixture(t:any){
 const root=mkdtempSync(join(tmpdir(),'qa-host-routes-'));let store=new HostedQaReviewStore(root);
 t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
 const profile={repository:'test/web',branch:'main',databaseId:'board',intakeEnabledAt:new Date(Date.now()-60000).toISOString(),policy:{issuer:'https://auth.example',orgId:'org',workspaceId:'ainmem',teamsWorkspaceId:'teams',channelId:'qa',approverSubjects:['admin']},identities:{'https://auth.example\nadmin':'admin-user'}};
 const profiles={web:profile,api:{...profile,repository:'test/api'}};
 const messages:any[]=[];let reads=0;
 const add=(id:string,content:string,parentId:string|null=null)=>{messages.push({id,content,parentId,userId:'human',createdAt:new Date().toISOString()});};
 const mcp={call:async(name:string,args:any)=>{
  reads++;
  if(name==='list_channels')return [{id:'qa'}];
  if(name==='list_channel_members')return [{userId:'human',isAgent:false},{userId:'admin-user',isAgent:false}];
  if(name==='read_channel')return {messages:messages.filter(m=>!m.parentId),nextCursor:null};
  if(name==='read_thread')return {parent:messages.find(m=>m.id===args.messageId),replies:messages.filter(m=>m.parentId===args.messageId)};
  throw Error('unexpected call');
 }};
 const selection={bot:{web:'web',api:'api'}};
 const service=()=>new HostedQaRoutes(store,selection,profiles,()=>mcp);
 return {get store(){return store;},profiles,selection,mcp,service,add,reads:()=>reads,reopen:()=>{store.close();store=new HostedQaReviewStore(root);}};
}
const input=(jobId:string,messageId=jobId,parentId?:string)=>({jobId,locator:{messageId,...(parentId?{parentId}:{})}});
test('host independently routes canonical requests and binds all later calls across restart',async t=>{
 const f=fixture(t),service=f.service();f.add('request','API 응답 고쳐줘.');
 assert.throws(()=>service.resolve('bot','job'),/intake required/);
 assert.throws(()=>service.submit('bot',{...input('job','request'),route:'web'}),/Invalid/);
 assert.equal(service.submit('bot',input('job','request')).state,'running');await service.drain();
 const result=service.submit('bot',input('job','request'));assert.equal(result.state,'done');assert.equal(result.result?.repository,'test/api');
 assert.equal(service.resolve('bot','job'),'api');assert.ok(f.store.intake('api','job'));assert.equal(f.store.intake('web','job'),null);
 const reads=f.reads();f.reopen();const restored=f.service();
 assert.equal(restored.resolve('bot','job'),'api');assert.equal(restored.submit('bot',input('job','request')).state,'done');assert.equal(f.reads(),reads);
 assert.throws(()=>restored.resolve('api','job'),/Internal/);
 assert.throws(()=>restored.resolve('bot',undefined),/requires a job/);
 assert.throws(()=>restored.submit('bot',input('job','other')),/locator changed/);
 assert.equal(restored.resolve('ordinary-agent','job'),'ordinary-agent');
});
test('thread replies inherit repository; duplicate and conflicting concurrent requests leave no stray intake',async t=>{
 const f=fixture(t),s=f.service();f.add('root','API 오류 고쳐줘.');
 s.submit('bot',input('first','root'));await s.drain();
 f.add('reply','이것도 고쳐줘.','root');s.submit('bot',input('second','reply','root'));await s.drain();assert.equal(s.resolve('bot','second'),'api');
 f.add('conflict','웹 오류 고쳐줘.','root');s.submit('bot',input('conflict','conflict','root'));await s.drain();assert.equal(s.submit('bot',input('conflict','conflict','root')).state,'failed');assert.equal(f.store.intake('web','conflict'),null);
 const other=f.service();s.submit('bot',input('duplicate1','root'));other.submit('bot',input('duplicate2','root'));await Promise.all([s.drain(),other.drain()]);
 for(const job of ['duplicate1','duplicate2'])assert.equal(f.store.routedIntake('bot',job),null);
 f.add('new','메시지 여백 고쳐줘.');s.submit('bot',input('new'));await s.drain();assert.equal(s.resolve('bot','new'),'web');
});
test('routing policy changes require reconciliation; invalid or different channel policies cannot start',async t=>{
 const f=fixture(t),s=f.service();f.add('job','API 오류 고쳐줘.');s.submit('bot',input('job'));await s.drain();
 const changed={...f.profiles,api:{...f.profiles.api,repository:'test/other'}};
 const later=new HostedQaRoutes(f.store,f.selection,changed,()=>f.mcp);
 assert.throws(()=>later.resolve('bot','job'),/policy changed/);
 f.add('reply','다시 고쳐줘.','job');later.submit('bot',input('reply','reply','job'));await later.drain();assert.equal(later.submit('bot',input('reply','reply','job')).state,'failed');
 assert.throws(()=>new HostedQaRoutes(f.store,{bot:{web:'web',api:'web'}},f.profiles,()=>f.mcp),/unique/);
 assert.throws(()=>new HostedQaRoutes(f.store,{web:{web:'web',api:'api'}},f.profiles,()=>f.mcp),/unique/);
 assert.throws(()=>new HostedQaRoutes(f.store,f.selection,{...f.profiles,api:{...f.profiles.api,policy:{...f.profiles.api.policy,channelId:'other'}}},()=>f.mcp),/policy must match/);
});

test('one real gateway token dispatches every job capability to its canonical repository scope',async t=>{
 const {HostedAgentGateway}=await import('../src/hosted-agent-gateway.js');
 const {hostedAgentSpecInput}=await import('../src/hosted-agent-types.js');
 const {createHostedAgentCtx}=await import('../src/hosted-agent-runtime/hostedAgentContext.js');
 const {scopedQaCapabilities}=await import('../src/hosted-qa-routes.js');
 const f=fixture(t),routes=f.service();f.add('request','API 오류 고쳐줘.');
 const calls:string[]=[];
 const observe=(cap:string)=>(id:string,_input:unknown)=>{calls.push(`${cap}:${id}`);return {state:'done'};};
 const spec=(id:string)=>({...hostedAgentSpecInput.parse({id,name:id,model:'unused',mode:'handler',files:{'index.mjs':'export default {}'}}),version:1,owner:'test',createdAt:1,updatedAt:1});
 const gateway=new HostedAgentGateway({registry:()=>null,spec:id=>spec(id),log:()=>{},...scopedQaCapabilities(routes,{qaIntake:observe('intake'),qaBase:observe('base'),qaStatus:observe('status'),qaValidation:observe('validation'),qaPublication:observe('publication')})});
 const url=await gateway.listen('127.0.0.1');t.after(()=>gateway.close());
 const ctx=(id:string)=>createHostedAgentCtx({spec:spec(id),gateway:{url,token:gateway.issue(id)},secrets:{},log:()=>{}},{text:''});
 const qa=ctx('bot').qa!;
 await assert.rejects(qa.base!('job'),/refused/);
 await qa.intake!('job',{messageId:'request'});await routes.drain();
 assert.equal((await qa.intake!('job',{messageId:'request'}) as any).result.repository,'test/api');
 await qa.base!('job');await qa.status!('job');
 const candidate={repository:'test/api',base:'a'.repeat(40),changes:{file:'fix'}};
 await qa.validate(candidate,'job');await qa.publish!('job',candidate);
 assert.deepEqual(calls,['base:api','status:api','validation:api','publication:api']);
 await assert.rejects(qa.validate(candidate),/refused/);
 await assert.rejects(qa.publish!('unknown',candidate),/refused/);
 await assert.rejects(ctx('api').qa!.base!('job'),/refused/);
 assert.equal(calls.length,4);
});
