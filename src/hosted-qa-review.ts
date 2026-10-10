/** Host-side review checks. Inputs come from canonical adapters, never model metadata. No merge capability. */
import {createHash} from 'node:crypto';
import type {QaTeamsThreadBinding,readQaTeamsThread} from './hosted-qa-teams-thread.js';
export class QaReviewBaseChanged extends Error {
 constructor(readonly observedBase:string){super('Reviewed PR changed; base changed; revalidation required');}
}
export interface ReviewTarget {
 teamsRequest?:QaTeamsThreadBinding;
 jobId:string;repository:string;branch:string;base:string;sha:string;number:number;candidateDigest:string;
 pageId:string;databaseId:string;workspaceId:string;teamsWorkspaceId:string;channelId:string;issuer:string;orgId:string;
}
export interface ReviewSnapshot {
 jobId:string;databaseId:string;pageId:string;workspaceId:string;issuer:string;orgId:string;
 body:string;revision:number;digest:string;observedAt:string;truncated:boolean;approvalGranted:false;
 reviewers?:{subject:string}[];
 comments:{id:string;body:string;createdAt:string;authorId:string;subject:string}[];
}
export interface ReviewPresentation {target:ReviewTarget;body:string;bodyDigest:string;revision:number;digest:string;presentedAt:string;policyDigest?:string}
export interface ReviewPolicy {issuer:string;orgId:string;workspaceId:string;teamsWorkspaceId:string;channelId:string;approverSubjects:string[]}
export interface ReviewMember {subject:string;issuer:string;orgId:string;workspaceId:string;channelId:string;isAgent:boolean;active:boolean}
const hex40=(s:string)=>/^[a-f0-9]{40}$/.test(s);
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const time=(s:string)=>typeof s==='string'?Date.parse(s):NaN;
const literal=(s:string)=>typeof s==='string'&&/^(?:lgtm|배포해)$/i.test(s.trim());
function bound(target:ReviewTarget,snapshot:ReviewSnapshot){
 if(!target||!snapshot||!/^[-\w.]+\/[-\w.]+$/.test(target.repository)||!hex40(target.base)||!hex40(target.sha)||!Number.isSafeInteger(target.number)||target.number<1||!/^[a-f0-9]{64}$/.test(target.candidateDigest))throw new Error('Invalid review target');
 for(const field of ['jobId','databaseId','pageId','workspaceId','issuer','orgId'] as const)if(!target[field]||snapshot[field]!==target[field])throw new Error('Canonical review binding changed');
 if(typeof snapshot.body!=='string'||snapshot.body.length>16000||!Number.isSafeInteger(snapshot.revision)||snapshot.revision<0||!/^[a-f0-9]{64}$/.test(snapshot.digest)||!Number.isFinite(time(snapshot.observedAt))||snapshot.approvalGranted!==false||snapshot.truncated!==false||!Array.isArray(snapshot.comments))throw new Error('Invalid or incomplete review snapshot');
}
/** Capture after displaying the exact candidate. Persist this record on the host before soliciting approval. */
export function captureReview(target:ReviewTarget,snapshot:ReviewSnapshot,expectedBody:string):ReviewPresentation {
 bound(target,snapshot);
 const url=`https://github.com/${target.repository}/pull/${target.number}`;
 if(snapshot.body!==expectedBody||!expectedBody.includes(target.sha)||!expectedBody.includes(url))throw new Error('Reviewed candidate is not presented');
 return {target:structuredClone(target),body:expectedBody,bodyDigest:hash(expectedBody),revision:snapshot.revision,digest:snapshot.digest,presentedAt:snapshot.observedAt};
}
/** Re-read all sources for every release attempt. A returned decision is evidence, not reusable permission. */
export function verifyAinmemApproval(presentation:ReviewPresentation,policy:ReviewPolicy,snapshot:ReviewSnapshot,pr:any,members:ReviewMember[],now=Date.now()) {
 const target=presentation.target;bound(target,snapshot);
 for(const field of ['issuer','orgId','workspaceId','teamsWorkspaceId','channelId'] as const)if(policy[field]!==target[field])throw new Error('Review policy changed');
 if(!Array.isArray(policy.approverSubjects)||!policy.approverSubjects.length||policy.approverSubjects.some(s=>typeof s!=='string'||!s))throw new Error('Invalid administrator policy');
 if(!Number.isFinite(now)||time(snapshot.observedAt)>now+30000||now-time(snapshot.observedAt)>60000||!Number.isFinite(time(presentation.presentedAt))||time(snapshot.observedAt)<time(presentation.presentedAt))throw new Error('Stale review observation');
 if(snapshot.body!==presentation.body||hash(snapshot.body)!==presentation.bodyDigest||snapshot.revision!==presentation.revision||snapshot.digest!==presentation.digest)throw new Error('Review presentation changed');
 if(pr?.state!=='open'||pr.number!==target.number||pr.head?.sha!==target.sha||pr.head?.repo?.full_name!==target.repository||pr.base?.repo?.full_name!==target.repository||pr.base?.ref!==target.branch)throw new Error('Reviewed PR changed; revalidation required');
 if(typeof pr.base.sha!=='string'||!hex40(pr.base.sha))throw new Error('Invalid reviewed PR base');
 if(pr.base.sha!==target.base)throw new QaReviewBaseChanged(pr.base.sha);
 if(!Array.isArray(members))throw new Error('Canonical channel membership unavailable');
 const eligible=snapshot.comments.filter(comment=>{
  const created=time(comment.createdAt);
  return typeof comment.id==='string'&&!!comment.id&&typeof comment.authorId==='string'&&!!comment.authorId&&literal(comment.body)
   &&Number.isFinite(created)&&created>time(presentation.presentedAt)&&created<=time(snapshot.observedAt)
   &&policy.approverSubjects.includes(comment.subject)
   &&members.some(member=>member.subject===comment.subject&&member.issuer===policy.issuer&&member.orgId===policy.orgId&&member.workspaceId===policy.teamsWorkspaceId&&member.channelId===policy.channelId&&member.isAgent===false&&member.active===true);
 }).sort((a,b)=>time(a.createdAt)-time(b.createdAt)||a.id.localeCompare(b.id));
 const comment=eligible[0];if(!comment)return null;
 return {source:'ainmem' as const,jobId:target.jobId,pageId:target.pageId,commentId:comment.id,subject:comment.subject,issuer:policy.issuer,orgId:policy.orgId,repository:target.repository,number:target.number,sha:target.sha,candidateDigest:target.candidateDigest,presentationDigest:presentation.bodyDigest,approvedAt:comment.createdAt,checkedAt:snapshot.observedAt};
}
/** Host-held credential; redirects and public error bodies cannot leak it. */
export function ainmemReviewReader(origin:string,token:string,fetcher:typeof fetch=fetch){
 const url=new URL(origin);
 if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new Error('Invalid Ainmem origin');
 return async(jobId:string,databaseId:string,reviewerSubjects?:string[]):Promise<ReviewSnapshot>=>{
  if(!/^[-\w]{1,80}$/.test(jobId)||!/^[a-f0-9-]{36}$/i.test(databaseId))throw new Error('Invalid task locator');
  let query='';
  if(reviewerSubjects!==undefined){
   if(!Array.isArray(reviewerSubjects)||reviewerSubjects.length>100||reviewerSubjects.some(s=>typeof s!=='string'||!s||s.length>256||/[\r\n]/.test(s))||new Set(reviewerSubjects).size!==reviewerSubjects.length||JSON.stringify(reviewerSubjects).length>16000)throw new Error('Invalid reviewer subject filter');
   query='&reviewerSubjects='+encodeURIComponent(JSON.stringify(reviewerSubjects));
  }
  let response:Response;
  try{response=await fetcher(`${url.origin}/api/qa/tasks/${encodeURIComponent(jobId)}?databaseId=${encodeURIComponent(databaseId)}${query}`,{headers:{Authorization:`Bearer ${token}`},redirect:'error',signal:AbortSignal.timeout(10000)});}catch{throw new Error('Ainmem review read failed');}
  if(!response.ok)throw new Error('Ainmem review read refused');
  const raw=await response.text();if(Buffer.byteLength(raw)>512000)throw new Error('Ainmem review response too large');
  try{return JSON.parse(raw);}catch{throw new Error('Invalid Ainmem review response');}
 };
}

/** Combine canonical Teams replies with current SSO eligibility and the exact Ainmem review. */
export function verifyTeamsApproval(presentation:ReviewPresentation,original:QaTeamsThreadBinding,policy:ReviewPolicy,snapshot:ReviewSnapshot,pr:unknown,thread:Awaited<ReturnType<typeof readQaTeamsThread>>,now=Date.now()) {
 // Validate the review even when no eligible Teams reply exists.
 verifyAinmemApproval(presentation,policy,{...snapshot,comments:[]},pr,thread.members,now);
 if(thread.source!=='teams'||thread.approvalGranted!==false||original.workspaceId!==policy.teamsWorkspaceId||original.channelId!==policy.channelId||Object.keys(original).some(k=>original[k as keyof QaTeamsThreadBinding]!==thread.binding[k as keyof QaTeamsThreadBinding]))throw new Error('Original Teams request binding changed');
 if(!Number.isFinite(time(thread.observedAt))||time(thread.observedAt)>time(snapshot.observedAt)||now-time(thread.observedAt)>60000||time(thread.observedAt)<time(presentation.presentedAt))throw new Error('Stale Teams approval observation');
 if(!Array.isArray(snapshot.reviewers)||snapshot.reviewers.length>100||snapshot.reviewers.some(r=>!r||typeof r.subject!=='string'||!r.subject)||new Set(snapshot.reviewers.map(r=>r.subject)).size!==snapshot.reviewers.length)throw new Error('Current SSO reviewer evidence required');
 const active=new Set(snapshot.reviewers.map(r=>r.subject));
 const comments=thread.comments.filter(c=>active.has(c.subject)&&time(c.createdAt)<=time(thread.observedAt));
 const decision=verifyAinmemApproval(presentation,policy,{...snapshot,comments},pr,thread.members,now);
 return decision?{...decision,source:'teams' as const,commentId:`teams:${original.rootId}:${decision.commentId}`,threadId:original.rootId,requestId:original.requestId}:null;
}
