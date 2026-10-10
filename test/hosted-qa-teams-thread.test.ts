import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readQaTeamsThread} from '../src/hosted-qa-teams-thread.js';
const root={id:'root',userId:'requester',content:'여백 고쳐줘.',parentId:null,createdAt:'2026-10-10T00:00:00Z'};
const policy={issuer:'https://auth.example',orgId:'org',workspaceId:'ainmem',teamsWorkspaceId:'teams',channelId:'qa',approverSubjects:['admin']};
const identities={'https://auth.example\nadmin':'admin-user'};
const binding={workspaceId:'teams',channelId:'qa',rootId:root.id,requestId:root.id,requestAuthorId:root.userId,requestCreatedAt:root.createdAt,requestDigest:createHash('sha256').update(root.content).digest('hex')};
const reply={id:'reply',userId:'admin-user',content:'LGTM',parentId:'root',createdAt:'2026-10-10T00:01:00Z'};
function fixture(){
 const state={channel:[root] as any[],parent:{...root},replies:[{...reply}] as any[],members:[{userId:'admin-user',isAgent:false}] as any[],nextCursor:null as any,calls:[] as string[]};
 const mcp={call:async(name:string)=>{state.calls.push(name);if(name==='list_channels')return [{id:'qa'}];if(name==='list_channel_members')return state.members;if(name==='read_channel')return {messages:state.channel,nextCursor:state.nextCursor};if(name==='read_thread')return {parent:state.parent,replies:state.replies};throw Error('Unexpected tool');}};
 return {state,read:(b=binding)=>readQaTeamsThread(mcp,b,policy,identities,2)};
}
test('original channel and request are verified and literal human replies remain evidence only',async()=>{
 const f=fixture();f.state.replies.push({...reply,id:'quoted',content:'"LGTM"'},{...reply,id:'fake',userId:'impostor',displayName:'admin'},{...reply,id:'plain',content:'배포해'});
 const result=await f.read();assert.deepEqual(result.comments.map(c=>c.id),['reply','plain']);assert.equal(result.approvalGranted,false);assert.equal(result.comments[0].subject,'admin');
 f.state.members=[];assert.equal((await f.read()).comments.length,0);
});
test('missing roots, edited requests, inconsistent parents and foreign replies fail closed',async()=>{
 for(const change of [(s:any)=>s.channel=[],(s:any)=>s.parent.content='edited',(s:any)=>s.replies[0].parentId='foreign',(s:any)=>s.replies.push({...reply}),(s:any)=>s.replies[0].createdAt='invalid']){
  const f=fixture();change(f.state);await assert.rejects(f.read());
 }
 const f=fixture();await assert.rejects(f.read({...binding,requestDigest:'f'.repeat(64)}),/request changed/);
 await assert.rejects(f.read({...binding,channelId:'foreign'}),/binding/);
});
test('reply requests bind their own author, contents and time; cursor cycles cannot scan forever',async()=>{
 const f=fixture(),request={...reply,id:'request',userId:'requester',content:'이것도 고쳐줘.'};f.state.replies.unshift(request);
 const result=await f.read({...binding,requestId:request.id,requestCreatedAt:request.createdAt,requestDigest:createHash('sha256').update(request.content).digest('hex')});assert.equal(result.comments.length,1);
 f.state.channel=[];f.state.nextCursor='same';await assert.rejects(f.read(),/pagination/);
 assert.ok(f.state.calls.filter(n=>n==='read_channel').length<=3);
});
test('root lookup follows channel cursors and excludes bot identities',async()=>{
 const calls:any[]=[];
 const mcp={call:async(name:string,args:any)=>{
  calls.push([name,args]);
  if(name==='list_channels')return [{id:'qa'}];
  if(name==='list_channel_members')return [{userId:'admin-user',isAgent:true}];
  if(name==='read_channel')return args.cursor?{messages:[root],nextCursor:null}:{messages:[],nextCursor:'older'};
  if(name==='read_thread')return {parent:root,replies:[reply]};
  throw Error('Unexpected tool');
 }};
 const result=await readQaTeamsThread(mcp,binding,policy,identities);assert.equal(result.comments.length,0);
 assert.deepEqual(calls.filter(([name])=>name==='read_channel').map(([,args])=>args),[{channelId:'qa'},{channelId:'qa',cursor:'older'}]);
});
