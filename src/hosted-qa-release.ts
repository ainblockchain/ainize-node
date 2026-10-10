/** Exact candidate fast-forward for explicitly configured unprotected branches. Never force-push. */
import {qaCandidateDigest,type QaCandidate} from './hosted-qa-validator.js';
import type {HostedQaReviewCoordinator} from './hosted-qa-review-coordinator.js';
import {HostedQaReviewStore} from './hosted-qa-review-store.js';
export type QaReleaseGitHub=(method:'GET'|'PATCH',path:string,body?:unknown)=>Promise<any>;
export interface QaReleaseProfile {repository:string;branch:string;mode:'fast-forward-unprotected'}
export class HostedQaRelease {
 private profiles:Record<string,QaReleaseProfile>;
 private active=new Map<string,Promise<unknown>>();
 constructor(private store:HostedQaReviewStore,private coordinator:Pick<HostedQaReviewCoordinator,'check'>,profiles:Record<string,QaReleaseProfile>,private github:QaReleaseGitHub,private requireValidation:(agentId:string,candidate:QaCandidate)=>unknown){this.profiles=structuredClone(profiles);}
 attempt(agentId:string,jobId:string):Promise<unknown>{
  const key=JSON.stringify([agentId,jobId]),pending=this.active.get(key);if(pending)return pending;
  const run=this.run(agentId,jobId).finally(()=>this.active.delete(key));this.active.set(key,run);return run;
 }
 private async run(agentId:string,jobId:string){
  if(!Object.hasOwn(this.profiles,agentId))throw new Error('Release is not configured');
  const profile=this.profiles[agentId],review=this.store.current(agentId,jobId);if(!review)throw new Error('No reviewed candidate');
  const t=review.presentation.target;
  if(profile.mode!=='fast-forward-unprotected'||profile.repository!==t.repository||profile.branch!==t.branch||!/^[-\w.]+\/[-\w.]+$/.test(t.repository)||!/^[-\w/]+$/.test(t.branch))throw new Error('Release scope mismatch');
  const api=`/repos/${t.repository}`,branch=encodeURIComponent(t.branch),ref=`${api}/git/ref/heads/${branch}`;
  const initial=await this.github('GET',ref);
  const previous=this.store.releaseRecord(review);
  if(initial?.object?.sha===t.sha&&previous){
   const receipt={sha:t.sha,branch:t.branch,repository:t.repository,observedAt:new Date().toISOString(),state:'branch_updated',deploymentVerified:false};
   this.store.releaseObserved(review,receipt);return receipt;
  }
  if(initial?.object?.sha!==t.base)throw new Error('Release base changed; reconcile and revalidate');
  // Do not use an administrative token to bypass a repository's PR/status/review rules.
  const branchInfo=await this.github('GET',`${api}/branches/${branch}`);
  if(branchInfo?.name!==t.branch||branchInfo.protected!==false)throw new Error('Protected branch requires a repository-specific merge adapter');
  // GitHub's protected=false list explicitly includes both classic protections and rulesets.
  // Unlike the administration endpoints, it also works for private repositories on free plans.
  let unprotected=false;
  for(let page=1;page<=20;page++){
   const rows=await this.github('GET',`${api}/branches?protected=false&per_page=100&page=${page}`);
   if(!Array.isArray(rows))throw new Error('Branch protection observation unavailable');
   if(rows.some(row=>row?.name===t.branch&&row.protected===false)){unprotected=true;break;}
   if(rows.length<100)break;
  }
  if(!unprotected)throw new Error('Protected branch or incomplete branch observation');
  const commit=await this.github('GET',`${api}/git/commits/${t.sha}`);
  // A single direct child plus force:false cannot overwrite a concurrently advanced branch.
  if(commit?.sha!==t.sha||commit.parents?.length!==1||commit.parents[0]?.sha!==t.base)throw new Error('Candidate is not the validated direct child');
  const published=this.store.publication(agentId,jobId);
  if(!published?.candidate||published.sha!==t.sha||published.candidateDigest!==t.candidateDigest||qaCandidateDigest(published.candidate)!==t.candidateDigest)throw new Error('Original validated candidate unavailable');
  this.requireValidation(agentId,published.candidate);
  const approval=await this.coordinator.check(agentId,jobId);
  if(!approval)return {state:'awaiting_approval'};
  if(approval.generation!==review.generation||approval.sha!==t.sha)throw new Error('Review changed before release');
  this.store.releaseIntent(review,approval);
  try{await this.github('PATCH',`${api}/git/refs/heads/${branch}`,{sha:t.sha,force:false});}
  catch(error){const observed=await this.github('GET',ref);if(observed?.object?.sha!==t.sha)throw error;}
  const observed=await this.github('GET',ref);
  if(observed?.object?.sha!==t.sha)throw new Error('Release outcome requires reconciliation');
  const receipt={sha:t.sha,branch:t.branch,repository:t.repository,observedAt:new Date().toISOString(),state:'branch_updated',deploymentVerified:false};
  this.store.releaseObserved(review,receipt);return receipt;
 }
}
export function qaReleaseGitHubClient(token:string,request:typeof fetch=fetch):QaReleaseGitHub {
 return async(method,path,body)=>{
  if(!path.startsWith('/repos/')||/[\r\n#]/.test(path))throw new Error('Invalid release API path');
  let response:Response;
  try{response=await request(`https://api.github.com${path}`,{method,redirect:'error',signal:AbortSignal.timeout(30000),headers:{Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});}catch{throw new Error('Release transport failed; reconcile remote state');}
  if(method==='GET'&&response.status===404)return null;
  if(!response.ok)throw new Error(`GitHub release refused (${response.status})`);
  return response.json();
 };
}
