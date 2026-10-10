/** Canonical thread evidence. This read does not establish SSO status or authorize release. */
import {createHash} from 'node:crypto';
import type {ReviewPolicy} from './hosted-qa-review.js';
import {readTeamsReviewMembers,type TeamsReviewMcp} from './hosted-qa-teams-review.js';
export interface QaTeamsThreadBinding {
 workspaceId:string;channelId:string;rootId:string;requestId:string;
 requestAuthorId:string;requestCreatedAt:string;requestDigest:string;
}
interface Message {id:string;userId:string;content:string;parentId:string|null;createdAt:string}
const id=(v:unknown):v is string=>typeof v==='string'&&/^[-\w]{1,80}$/.test(v);
const digest=(v:string)=>createHash('sha256').update(v).digest('hex');
function message(value:any):Message {
 if(!value||!id(value.id)||!id(value.userId)||typeof value.content!=='string'||value.content.length>20000||!(value.parentId==null||id(value.parentId))||typeof value.createdAt!=='string'||!Number.isFinite(Date.parse(value.createdAt)))throw new Error('Incomplete canonical Teams message');
 return {id:value.id,userId:value.userId,content:value.content,parentId:value.parentId??null,createdAt:new Date(value.createdAt).toISOString()};
}
/** binding must come from host-verified intake, never from an approval message or model metadata. */
export async function readQaTeamsThread(mcp:TeamsReviewMcp,rawBinding:QaTeamsThreadBinding,rawPolicy:ReviewPolicy,rawIdentities:Record<string,string>,maxPages=20){
 const binding=structuredClone(rawBinding),policy=structuredClone(rawPolicy),identities=structuredClone(rawIdentities);
 if(!binding||!['workspaceId','channelId','rootId','requestId','requestAuthorId'].every(k=>id(binding[k as keyof QaTeamsThreadBinding]))||!/^[a-f0-9]{64}$/.test(binding.requestDigest)||!Number.isFinite(Date.parse(binding.requestCreatedAt))||binding.workspaceId!==policy.teamsWorkspaceId||binding.channelId!==policy.channelId||!Number.isInteger(maxPages)||maxPages<1||maxPages>100)throw new Error('Invalid original request binding');
 // Prove channel membership of the root independently; read_thread only gates the caller's access.
 const channels=await mcp.call('list_channels',{workspaceId:binding.workspaceId});
 if(!Array.isArray(channels)||!channels.some(c=>c?.id===binding.channelId))throw new Error('Original request channel unavailable');
 let root:Message|undefined,cursor:string|undefined;const seen=new Set<string>();
 for(let page=0;page<maxPages;page++){
  const result:any=await mcp.call('read_channel',{channelId:binding.channelId,...(cursor?{cursor}:{})});
  if(!Array.isArray(result?.messages)||result.messages.length>1000)throw new Error('Incomplete channel observation');
  const matches=result.messages.filter((m:any)=>m?.id===binding.rootId);
  if(matches.length>1)throw new Error('Ambiguous original root');
  if(matches.length){root=message(matches[0]);if(root.parentId!==null)throw new Error('Original root is a reply');break;}
  const next=result.nextCursor;
  if(next==null)break;
  if(typeof next!=='string'||!next||next.length>2048||seen.has(next))throw new Error('Invalid channel pagination');
  seen.add(next);cursor=next;
 }
 if(!root)throw new Error('Original request root not observed');
 const thread:any=await mcp.call('read_thread',{messageId:binding.rootId});
 const parent=message(thread?.parent);
 if(JSON.stringify(parent)!==JSON.stringify(root))throw new Error('Original root changed during observation');
 if(!Array.isArray(thread?.replies)||thread.replies.length>10000||thread.nextCursor||thread.truncated===true)throw new Error('Incomplete thread observation');
 const replies=thread.replies.map(message) as Message[];
 if(replies.some(m=>m.parentId!==binding.rootId||m.id===binding.rootId)||new Set(replies.map(m=>m.id)).size!==replies.length)throw new Error('Thread reply binding mismatch');
 const request=binding.requestId===root.id?root:replies.find(m=>m.id===binding.requestId);
 if(!request||request.userId!==binding.requestAuthorId||request.createdAt!==new Date(binding.requestCreatedAt).toISOString()||digest(request.content)!==binding.requestDigest)throw new Error('Original request changed');
 // This fresh membership read also validates the entire configured SSO→Teams mapping.
 const members=await readTeamsReviewMembers(mcp,policy,identities);
 const subjects=new Map(members.map(m=>[identities[`${policy.issuer}\n${m.subject}`],m.subject]));
 const comments=replies.filter(m=>m.id!==binding.requestId&&/^(?:lgtm|배포해)$/i.test(m.content.trim())&&subjects.has(m.userId))
  .map(m=>({id:m.id,body:m.content,createdAt:m.createdAt,authorId:m.userId,subject:subjects.get(m.userId)!}));
 return {source:'teams' as const,binding,observedAt:new Date().toISOString(),comments,members,approvalGranted:false as const};
}

/** Resolve a fresh fix request independently of agent-provided author/text/time fields. */
export async function captureQaTeamsRequestWithText(mcp:TeamsReviewMcp,policy:ReviewPolicy,identities:Record<string,string>,locator:{messageId:string;parentId?:string},enabledAt:string,now=Date.now()){
 if(!locator||!id(locator.messageId)||(locator.parentId!==undefined&&!id(locator.parentId))||!Number.isFinite(Date.parse(enabledAt)))throw new Error('Invalid intake configuration');
 const rootId=locator.parentId??locator.messageId;
 const thread:any=await mcp.call('read_thread',{messageId:rootId});
 const parent=message(thread?.parent);
 if(parent.id!==rootId||parent.parentId!==null||!Array.isArray(thread.replies))throw new Error('Original request thread unavailable');
 const request=locator.messageId===rootId?parent:message(thread.replies.find((m:any)=>m?.id===locator.messageId));
 const created=Date.parse(request.createdAt);
 const direct=request.content.replace(/```[\s\S]*?```|`[^`\n]*`/g,'').replace(/^\s*>[^\n]*/gm,'').replace(/"[^"\n]*"|'[^'\n]*'|“[^”\n]*”|‘[^’\n]*’/g,'');
 if(created<Date.parse(enabledAt)||now-created>86400000||created>now+30000||!(/^\/fix\s+\S/i.test(request.content.trim())||/(?:고쳐\s*(?:줘|주세요)|수정해\s*(?:줘|주세요)|해결해\s*(?:줘|주세요))(?:[.!?。]+(?=\s|$)|\s*$|[ \t]*\n)/.test(direct)))throw new Error('Not an eligible fresh fix request');
 const members=await mcp.call('list_channel_members',{channelId:policy.channelId});
 if(!Array.isArray(members)||!members.some(m=>m?.userId===request.userId&&m.isAgent===false))throw new Error('Request author is not a current human channel member');
 const binding:QaTeamsThreadBinding={workspaceId:policy.teamsWorkspaceId,channelId:policy.channelId,rootId,requestId:request.id,requestAuthorId:request.userId,requestCreatedAt:request.createdAt,requestDigest:digest(request.content)};
 await readQaTeamsThread(mcp,binding,policy,identities);
 return {binding,text:request.content};
}
export async function captureQaTeamsRequest(...args:Parameters<typeof captureQaTeamsRequestWithText>){return (await captureQaTeamsRequestWithText(...args)).binding;}
