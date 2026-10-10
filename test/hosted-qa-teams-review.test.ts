import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readTeamsReviewMembers} from '../src/hosted-qa-teams-review.js';
const policy={issuer:'https://auth.example',orgId:'org',workspaceId:'ainmem-ws',teamsWorkspaceId:'teams-ws',channelId:'qa-test',approverSubjects:['admin','extra']};
const identities={'https://auth.example\nadmin':'teams-admin','https://auth.example\nextra':'teams-extra'};
test('canonical channel reads bind existing SSO mapping and observe member removal without a cache',async()=>{
 let members=[{userId:'teams-admin',isAgent:false},{userId:'teams-extra',isAgent:true},{userId:'unmapped',isAgent:false,displayName:'admin'}];
 const calls:any[]=[];const mcp={call:async(name:string,args:unknown)=>{calls.push([name,args]);return name==='list_channels'?[{id:'qa-test'}]:members;}};
 assert.deepEqual((await readTeamsReviewMembers(mcp,policy,identities)).map(m=>m.subject),['admin']);
 assert.deepEqual(calls,[['list_channels',{workspaceId:'teams-ws'}],['list_channel_members',{channelId:'qa-test'}]]);
 members=[];assert.deepEqual(await readTeamsReviewMembers(mcp,policy,identities),[]);
});
test('unverified mapping, foreign workspace, ambiguous or partial member responses fail closed',async()=>{
 const mcp={call:async(name:string)=>name==='list_channels'?[{id:'qa-test'}]:[]};
 await assert.rejects(readTeamsReviewMembers(mcp,policy,{}),/mapping/);
 await assert.rejects(readTeamsReviewMembers(mcp,policy,{...identities,'https://auth.example\nextra':'teams-admin'}),/mapping/);
 await assert.rejects(readTeamsReviewMembers({call:async()=>[]},policy,identities),/workspace/);
 for(const response of [[{userId:'teams-admin'}],[{userId:'teams-admin',isAgent:false},{userId:'teams-admin',isAgent:true}],{members:[]}])
  await assert.rejects(readTeamsReviewMembers({call:async(name:string)=>name==='list_channels'?[{id:'qa-test'}]:response},policy,identities),/membership/);
});
