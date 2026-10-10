/** Offline operator verification for an imported unfinished job. No gateway exposes this path. */
import {createHash} from 'node:crypto';
import {readQaTeamsThread,type QaTeamsThreadBinding} from './hosted-qa-teams-thread.js';
import type {HostedReviewProfile} from './hosted-qa-review-coordinator.js';
import type {TeamsReviewMcp} from './hosted-qa-teams-review.js';
const id=(value:unknown):value is string=>typeof value==='string'&&/^[-\w]{1,80}$/.test(value);
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');

export async function verifyHistoricalQaIntake(mcp:TeamsReviewMcp,rawProfile:HostedReviewProfile,
 rawArchive:unknown,archiveDigest:string,now=Date.now()) {
 const profile=structuredClone(rawProfile),archive=structuredClone(rawArchive) as any;
 const encoded=JSON.stringify(archive);
 if(typeof encoded!=='string'||Buffer.byteLength(encoded)>4*1024*1024||digest(encoded)!==archiveDigest
  ||archive?.kind!=='legacy-job-v1'||archive.repository!==profile.repository
  ||archive.workspaceId!==profile.policy.teamsWorkspaceId||archive.channelId!==profile.policy.channelId)throw new Error('Historical archive binding mismatch');
 const job=archive.job,payload=job?.payload;
 if(!id(job?.id)||!id(job.message_id)||payload?.message_id!==job.message_id||!id(payload.parent_id)
  ||!id(payload.sender_id)||typeof payload.text!=='string'||!payload.text.trim()||payload.text.length>20000
  ||!['blocked','interrupted','awaiting_approval'].includes(job.status))throw new Error('Historical job is not an unfinished request');
 // Legacy timestamps are Unix seconds. Do not substitute the import time or job execution time.
 const created=typeof payload.created_at==='number'&&Number.isFinite(payload.created_at)
  ? Math.round(payload.created_at*1000) : typeof payload.created_at==='string'?Date.parse(payload.created_at):NaN;
 if(!Number.isSafeInteger(created)||created<0||!Number.isFinite(now)||created>now+30000)throw new Error('Historical message timestamp required');
 const direct=payload.text.replace(/```[\s\S]*?```|`[^`\n]*`/g,'').replace(/^\s*>[^\n]*/gm,'')
  .replace(/"[^"\n]*"|'[^'\n]*'|“[^”\n]*”|‘[^’\n]*’/g,'');
 if(!(/^\/fix\s+\S/i.test(payload.text.trim())||/(?:고쳐\s*(?:줘|주세요)|수정해\s*(?:줘|주세요)|해결해\s*(?:줘|주세요))(?:[.!?。]+(?=\s|$)|\s*$|[ \t]*\n)/.test(direct)))throw new Error('Historical message is not a fix request');
 const binding:QaTeamsThreadBinding={workspaceId:archive.workspaceId,channelId:archive.channelId,
  rootId:payload.parent_id,requestId:job.message_id,requestAuthorId:payload.sender_id,
  requestCreatedAt:new Date(created).toISOString(),requestDigest:digest(payload.text)};
 // Re-read the root's channel and complete thread; changed/deleted messages fail closed.
 await readQaTeamsThread(mcp,binding,profile.policy,profile.identities);
 const members=await mcp.call('list_channel_members',{channelId:profile.policy.channelId});
 if(!Array.isArray(members)||!members.some(member=>member?.userId===binding.requestAuthorId&&member.isAgent===false))throw new Error('Historical request author is no longer a human channel member');
 return {jobId:job.id,repository:archive.repository,archiveDigest,binding,text:payload.text};
}
