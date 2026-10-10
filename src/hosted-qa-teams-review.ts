/** Host-configured SSO→Teams identity binding plus fresh canonical MCP membership reads. */
import type {ReviewMember,ReviewPolicy} from './hosted-qa-review.js';
export interface TeamsReviewMcp {call(name:string,args:Record<string,string>):Promise<unknown>}
export async function readTeamsReviewMembers(mcp:TeamsReviewMcp,rawPolicy:ReviewPolicy,rawIdentities:Record<string,string>):Promise<ReviewMember[]> {
 const policy=structuredClone(rawPolicy),identities=structuredClone(rawIdentities);
 if(!policy.issuer||!policy.orgId||!/^[-\w]{1,80}$/.test(policy.teamsWorkspaceId)||!/^[-\w]{1,80}$/.test(policy.channelId)||!Array.isArray(policy.approverSubjects)||!policy.approverSubjects.length||policy.approverSubjects.length>100||new Set(policy.approverSubjects).size!==policy.approverSubjects.length)throw new Error('Invalid Teams review policy');
 const mapped=new Map<string,string>();
 for(const subject of policy.approverSubjects){
  if(typeof subject!=='string'||!subject||subject.includes('\n'))throw new Error('Invalid reviewer subject');
  const key=`${policy.issuer}\n${subject}`;
  const userId=Object.hasOwn(identities,key)?identities[key]:undefined;
  if(typeof userId!=='string'||!/^[-\w]{1,80}$/.test(userId)||[...mapped.values()].includes(userId))throw new Error('Unverified or ambiguous Teams identity mapping');
  mapped.set(subject,userId);
 }
 // Workspace/channel relationship is resolved by the service, never locator metadata.
 const channels=await mcp.call('list_channels',{workspaceId:policy.teamsWorkspaceId});
 if(!Array.isArray(channels)||!channels.some(c=>c?.id===policy.channelId))throw new Error('Review channel is not in configured workspace');
 const members=await mcp.call('list_channel_members',{channelId:policy.channelId});
 if(!Array.isArray(members)||members.some(m=>!m||typeof m.userId!=='string'||typeof m.isAgent!=='boolean')||new Set(members.map(m=>m.userId)).size!==members.length)throw new Error('Incomplete or ambiguous channel membership');
 return [...mapped].filter(([,id])=>members.some(m=>m.userId===id&&m.isAgent===false)).map(([subject])=>({subject,issuer:policy.issuer,orgId:policy.orgId,workspaceId:policy.teamsWorkspaceId,channelId:policy.channelId,isAgent:false,active:true}));
}
