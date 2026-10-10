/** Host-verified intake, independent of the coding agent's asserted author, content or authority. */
import {HostedQaReviewStore} from './hosted-qa-review-store.js';
import {captureQaTeamsRequest} from './hosted-qa-teams-thread.js';
import type {HostedReviewProfile} from './hosted-qa-review-coordinator.js';
import type {TeamsReviewMcp} from './hosted-qa-teams-review.js';
import {verifyHistoricalQaIntake} from './hosted-qa-historical-intake.js';
export class HostedQaIntake {
 private active=new Map<string,Promise<unknown>>();
 private failed=new Map<string,number>();
 private profiles:Record<string,HostedReviewProfile>;
 constructor(private store:HostedQaReviewStore,profiles:Record<string,HostedReviewProfile>,private teams:(id:string)=>TeamsReviewMcp){this.profiles=structuredClone(profiles);}
 /** Offline cutover tool only. Every retry re-reads canonical messages and current membership. */
 async importHistorical(agentId:string,archive:unknown,fingerprint:string){
  const profile=Object.hasOwn(this.profiles,agentId)?this.profiles[agentId]:null;
  if(!profile?.intakeEnabledAt)throw new Error('Native intake disabled');
  const evidence=await verifyHistoricalQaIntake(this.teams(agentId),profile,archive,fingerprint);
  return this.store.registerHistoricalIntake(agentId,evidence);
 }
 submit(agentId:string,raw:any){
  const input=structuredClone(raw);
  if(!input||Object.keys(input).sort().join(',')!=='jobId,locator'||typeof input.jobId!=='string'||!/^[-\w]{1,80}$/.test(input.jobId)||!input.locator||Object.keys(input.locator).some(k=>!['messageId','parentId'].includes(k))||typeof input.locator.messageId!=='string')throw new Error('Invalid intake request');
  const profile=Object.hasOwn(this.profiles,agentId)?this.profiles[agentId]:null;
  if(!profile?.intakeEnabledAt)throw new Error('Native intake disabled');
  const prior=this.store.intake(agentId,input.jobId);
  if(prior){
   if(prior.workspaceId!==profile.policy.teamsWorkspaceId||prior.channelId!==profile.policy.channelId||prior.requestId!==input.locator.messageId||prior.rootId!==(input.locator.parentId??input.locator.messageId))throw new Error('Intake locator changed');
   return {state:'done',result:prior};
  }
  const key=JSON.stringify([agentId,input]);
  for(const [k,at] of this.failed)if(Date.now()-at>60000)this.failed.delete(k);
  if(this.failed.has(key))return {state:'failed'};
  if(this.active.has(key))return {state:'running'};
  if(this.active.size>=100||this.failed.size>=1000)throw new Error('Intake busy');
  const task=captureQaTeamsRequest(this.teams(agentId),profile.policy,profile.identities,input.locator,profile.intakeEnabledAt)
   .then(binding=>this.store.registerIntake(agentId,input.jobId,binding));
  this.active.set(key,task);
  // Failed reads leave no durable intake; later polls can retry without releasing or coding.
  void task.catch(()=>{this.failed.set(key,Date.now());}).finally(()=>this.active.delete(key));
  return {state:'running'};
 }
 async drain(){await Promise.allSettled(this.active.values());}
}
