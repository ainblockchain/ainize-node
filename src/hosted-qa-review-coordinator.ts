import {createHash} from 'node:crypto';
/** Host-owned orchestration; no gateway route accepts reviewer identities or approval verdicts. */
import {captureReview,verifyAinmemApproval,type ReviewTarget,type ReviewSnapshot,type ReviewPolicy} from './hosted-qa-review.js';
import {readTeamsReviewMembers,type TeamsReviewMcp} from './hosted-qa-teams-review.js';
import {HostedQaReviewStore} from './hosted-qa-review-store.js';
export interface HostedReviewProfile {repository:string;branch:string;databaseId:string;policy:ReviewPolicy;identities:Record<string,string>}
export interface HostedReviewReaders {
 ainmem(agentId:string,jobId:string,databaseId:string):Promise<ReviewSnapshot>;
 github(repository:string,number:number):Promise<unknown>;
 teams(agentId:string):TeamsReviewMcp;
}
const canonical=(value:unknown):unknown=>value&&typeof value==='object'?Array.isArray(value)?value.map(canonical):Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,canonical(v)])):value;
const policyDigest=(profile:HostedReviewProfile)=>createHash('sha256').update(JSON.stringify(canonical(profile))).digest('hex');
export class HostedQaReviewCoordinator {
 private profiles:Record<string,HostedReviewProfile>;
 constructor(private store:HostedQaReviewStore,profiles:Record<string,HostedReviewProfile>,private readers:HostedReviewReaders){this.profiles=structuredClone(profiles);}
 private profile(agentId:string){if(!Object.hasOwn(this.profiles,agentId))throw new Error('Review agent is not configured');return this.profiles[agentId];}
 private checkTarget(agentId:string,t:ReviewTarget){
  const p=this.profile(agentId);
  if(t.repository!==p.repository||t.branch!==p.branch||t.databaseId!==p.databaseId)throw new Error('Review product binding mismatch');
  for(const field of ['issuer','orgId','workspaceId','teamsWorkspaceId','channelId'] as const)if(t[field]!==p.policy[field])throw new Error('Review scope mismatch');
  return p;
 }
 /** Caller supplies the host's published candidate and exact report body, never model-provided authority. */
 async register(agentId:string,raw:ReviewTarget,body:string){
  const target=structuredClone(raw);this.checkTarget(agentId,target);
  const generation=this.store.current(agentId,target.jobId)?.generation??0;
  const snapshot=await this.readers.ainmem(agentId,target.jobId,target.databaseId);
  return this.store.bind(agentId,{...captureReview(target,snapshot,body),policyDigest:policyDigest(this.profile(agentId))},generation);
 }
 async check(agentId:string,jobId:string,now?:number){
  this.profile(agentId);const current=this.store.current(agentId,jobId);if(!current)throw new Error('No presented review');
  const t=current.presentation.target,p=this.checkTarget(agentId,t);
  if(current.presentation.policyDigest!==policyDigest(p))throw new Error('Administrator policy changed; present review again');
  // Fresh external reads on every call, including after a previously positive observation.
  const [pr,members]=await Promise.all([this.readers.github(t.repository,t.number),readTeamsReviewMembers(this.readers.teams(agentId),p.policy,p.identities)]);
  const snapshot=await this.readers.ainmem(agentId,jobId,t.databaseId);
  const decision=verifyAinmemApproval(current.presentation,p.policy,snapshot,pr,members,now);
  if(!decision)return null;
  return this.store.observe(current,decision);
 }
}
