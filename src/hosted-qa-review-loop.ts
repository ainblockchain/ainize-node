import {observeQaDeployment,type QaDeploymentProfile} from './hosted-qa-deployment.js';
import type {HostedQaRelease} from './hosted-qa-release.js';
/** Host background reconciliation; registration and checks are driven by verified publisher receipts. */
import {HostedQaReviewStore} from './hosted-qa-review-store.js';
import {HostedQaReviewCoordinator,type HostedReviewProfile,type HostedReviewReaders} from './hosted-qa-review-coordinator.js';
export class HostedQaReviewLoop {
 private running:Promise<void>|null=null;
 private profiles:Record<string,HostedReviewProfile>;
 constructor(private store:HostedQaReviewStore,private coordinator:HostedQaReviewCoordinator,profiles:Record<string,HostedReviewProfile>,private readers:HostedReviewReaders,private log:(message:string)=>void=()=>{},private release?:Pick<HostedQaRelease,'attempt'>,private deployments?:{profiles:Record<string,QaDeploymentProfile>;github:(path:string)=>Promise<any>}){this.profiles=structuredClone(profiles);}
 async drain(){if(this.running)await this.running;}
 tick():Promise<void>{
  if(this.running)return this.running;
  this.running=this.run().finally(()=>{this.running=null;});return this.running;
 }
 private async run(){
  for(const item of this.store.pendingPublications()){
   this.store.attemptedPublication(item.id);
   try{
    if(!Object.hasOwn(this.profiles,item.agentId))continue;
    const p=this.profiles[item.agentId],r=item.receipt;
    if(r.repository!==p.repository||!/^[a-f0-9]{40}$/.test(r.sha??'')||!/^[a-f0-9]{40}$/.test(r.base??'')||!/^[a-f0-9]{64}$/.test(r.candidateDigest??'')||!Number.isSafeInteger(r.number)||r.number<1||r.url!==`https://github.com/${p.repository}/pull/${r.number}`)throw new Error('Invalid host publication receipt');
    if(!this.store.current(item.agentId,item.jobId)){
     const snapshot=await this.readers.ainmem(item.agentId,item.jobId,p.databaseId);
     const lines=snapshot.body.split('\n');
     if(!lines.includes(`검토 PR: ${r.url}`)||!lines.includes(`검토 커밋: ${r.sha}`)||!lines.includes('상태: waiting / awaiting_approval'))throw new Error('Published candidate not yet displayed');
     await this.coordinator.register(item.agentId,{jobId:item.jobId,...(r.teamsRequest?{teamsRequest:r.teamsRequest}:{}),repository:p.repository,branch:p.branch,base:r.base,sha:r.sha,number:r.number,candidateDigest:r.candidateDigest,pageId:snapshot.pageId,databaseId:p.databaseId,workspaceId:p.policy.workspaceId,teamsWorkspaceId:p.policy.teamsWorkspaceId,channelId:p.policy.channelId,issuer:p.policy.issuer,orgId:p.policy.orgId},snapshot.body);
    }
    const current=this.store.current(item.agentId,item.jobId)!;
    const previous=this.store.releaseRecord(current);
    if(previous?.receipt?.state==='deployment_verified')continue;
    if(previous?.receipt?.state==='branch_updated'){
     if(this.deployments&&Object.hasOwn(this.deployments.profiles,item.agentId)){
      const observed=await observeQaDeployment(this.deployments.profiles[item.agentId],current,this.deployments.github);
      if(observed.state==='deployment_verified')this.store.releaseObserved(current,{...previous.receipt,...observed});
     }
     continue;
    }
    if(previous&&this.release){await this.release.attempt(item.agentId,item.jobId);continue;}
    const approval=await this.coordinator.check(item.agentId,item.jobId);
    if(approval&&this.release)await this.release.attempt(item.agentId,item.jobId);
   }catch{this.log('QA canonical review pending; no release authorized');}
  }
 }
}
