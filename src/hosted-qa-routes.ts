/** One authenticated Teams agent, multiple operator-owned repository capabilities.
 * Only independently captured canonical request text selects a scope. No caller scope hint is accepted.
 */
import {createHash} from 'node:crypto';
import {HostedQaReviewStore,type QaRepositoryRoutes,type QaRoutedIntake,type QaHistoricalRoute} from './hosted-qa-review-store.js';
import {captureQaTeamsRequestWithText} from './hosted-qa-teams-thread.js';
import type {HostedReviewProfile} from './hosted-qa-review-coordinator.js';
import type {TeamsReviewMcp} from './hosted-qa-teams-review.js';
export type QaSharedProfiles=Record<string,{web:string;api:string}>;
const canonical=(v:any):any=>v&&typeof v==='object'?Array.isArray(v)?v.map(canonical):Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
export class HostedQaRoutes {
 private owners:Record<string,{routes:QaRepositoryRoutes;digest:string;profile:HostedReviewProfile}>=Object.create(null);
 private scopes=new Set<string>();
 private active=new Map<string,Promise<unknown>>();
 private failed=new Map<string,number>();
 constructor(private store:HostedQaReviewStore,raw:QaSharedProfiles,profiles:Record<string,HostedReviewProfile>,private teams:(scope:string)=>TeamsReviewMcp){
  for(const [owner,selection] of Object.entries(structuredClone(raw))){
   if(!/^[-\w]{1,128}$/.test(owner)||!selection||Object.keys(selection).sort().join(',')!=='api,web')throw new Error('Invalid shared QA profile');
   const routes={} as QaRepositoryRoutes;
   for(const route of ['web','api'] as const){
    const scope=selection[route],p=Object.hasOwn(profiles,scope)?profiles[scope]:undefined;
    if(typeof scope!=='string'||!/^[-\w]{1,128}$/.test(scope)||scope===owner||this.scopes.has(scope)||!p?.intakeEnabledAt)throw new Error('Shared QA scope must be unique and require intake');
    routes[route]={scope,repository:p.repository};this.scopes.add(scope);
   }
   const web=profiles[selection.web],api=profiles[selection.api];
   const common=(p:HostedReviewProfile)=>canonical({policy:p.policy,identities:p.identities,databaseId:p.databaseId,intakeEnabledAt:p.intakeEnabledAt});
   if(web.repository===api.repository||JSON.stringify(common(web))!==JSON.stringify(common(api)))throw new Error('Shared QA channel and approval policy must match');
   this.owners[owner]={routes,digest:createHash('sha256').update(JSON.stringify(canonical({routes,branches:{web:web.branch,api:api.branch},common:common(web)}))).digest('hex'),profile:structuredClone(web)};
  }
  if(Object.keys(this.owners).some(owner=>this.scopes.has(owner)))throw new Error('Shared QA owner cannot be an internal scope');
 }
 configured(id:string){return Object.hasOwn(this.owners,id);}
 /** Offline operator entry only; no gateway endpoint exposes historical intake. */
 importHistory(owner:string,items:{archive:any;fingerprint:string}[]){
  if(!this.configured(owner)||!Array.isArray(items)||items.length>10000)throw new Error('Invalid route migration');
  const policy=this.owners[owner];
  const records:QaHistoricalRoute[]=items.map(({archive:raw,fingerprint})=>{
   const archive=structuredClone(raw),job=archive?.job,payload=job?.payload;
   if(!archive||archive.kind!=='legacy-job-v1'||createHash('sha256').update(JSON.stringify(archive)).digest('hex')!==fingerprint||!/^[-\w]{1,80}$/.test(job?.id??'')||!/^[-\w]{1,80}$/.test(job?.message_id??'')||payload?.message_id!==job.message_id||!/^[-\w]{1,80}$/.test(payload?.parent_id??'')||archive.workspaceId!==policy.profile.policy.teamsWorkspaceId||archive.channelId!==policy.profile.policy.channelId)throw new Error('Invalid historical route evidence');
   const route=(['web','api'] as const).find(key=>policy.routes[key].repository===archive.repository);
   if(!route)throw new Error('Historical repository is outside shared profile');
   return {jobId:job.id,...policy.routes[route],route,policyDigest:policy.digest,archiveDigest:fingerprint,workspaceId:archive.workspaceId,channelId:archive.channelId,rootId:payload.parent_id,requestId:job.message_id};
  });
  return this.store.importHistoricalRoutes(owner,records);
 }
 /** Called only at the authenticated gateway boundary, never by the host review loop. */
 resolve(owner:string,jobId:unknown){
  if(this.scopes.has(owner))throw new Error('Internal QA scope cannot be called directly');
  if(!this.configured(owner))return owner;
  if(typeof jobId!=='string'||!/^[-\w]{1,80}$/.test(jobId))throw new Error('Shared QA operation requires a job');
  const record=this.store.routedIntake(owner,jobId);
  if(!record)throw new Error('Canonical shared intake required');
  this.check(owner,record);
  return record.scope;
 }
 private check(owner:string,record:QaRoutedIntake){
  const policy=this.owners[owner],route=policy.routes[record.route];
  if(record.policyDigest!==policy.digest||!route||route.scope!==record.scope||route.repository!==record.repository)throw new Error('Shared QA policy changed; reconciliation required');
 }
 submit(owner:string,raw:any){
  if(!this.configured(owner))throw new Error('Shared QA agent not configured');
  const input=structuredClone(raw),policy=this.owners[owner];
  if(!input||Object.keys(input).sort().join(',')!=='jobId,locator'||typeof input.jobId!=='string'||!/^[-\w]{1,80}$/.test(input.jobId)||!input.locator||Object.keys(input.locator).some(k=>!['messageId','parentId'].includes(k))||typeof input.locator.messageId!=='string')throw new Error('Invalid shared intake');
  const prior=this.store.routedIntake(owner,input.jobId);
  if(prior){
   this.check(owner,prior);
   if(prior.binding.requestId!==input.locator.messageId||prior.binding.rootId!==(input.locator.parentId??input.locator.messageId))throw new Error('Intake locator changed');
   return {state:'done',result:{...prior.binding,repository:prior.repository,route:prior.route}};
  }
  const key=JSON.stringify([owner,input]);
  for(const [k,at] of this.failed)if(Date.now()-at>60000)this.failed.delete(k);
  if(this.failed.has(key))return {state:'failed'};
  if(this.active.has(key))return {state:'running'};
  if(this.active.size>=100||this.failed.size>=1000)throw new Error('Shared intake busy');
  const p=policy.profile;
  const task=captureQaTeamsRequestWithText(this.teams(policy.routes.web.scope),p.policy,p.identities,input.locator,p.intakeEnabledAt!)
   .then(({binding,text})=>this.store.registerRoutedIntake(owner,input.jobId,policy.routes,policy.digest,binding,text));
  this.active.set(key,task);
  void task.catch(()=>{this.failed.set(key,Date.now());}).finally(()=>this.active.delete(key));
  return {state:'running'};
 }
 async drain(){await Promise.allSettled(this.active.values());}
}

type QaCapabilities=Pick<import('./hosted-agent-gateway.js').HostedAgentGatewayDeps,'qaRevalidation'|'qaIntake'|'qaBase'|'qaValidation'|'qaPublication'|'qaStatus'>;
/** Apply the same authenticated job scope to every gateway capability. */
export function scopedQaCapabilities(routes:HostedQaRoutes|undefined,services:QaCapabilities):QaCapabilities {
 if(!routes)return services;
 return {
  qaIntake:services.qaIntake?(id,input)=>routes.configured(id)?routes.submit(id,input):services.qaIntake!(routes.resolve(id,undefined),input):undefined,
  qaRevalidation:services.qaRevalidation?(id,input)=>services.qaRevalidation!(routes.resolve(id,(input as {jobId?:unknown})?.jobId),input):undefined,
  qaBase:services.qaBase?(id,job)=>services.qaBase!(routes.resolve(id,job),job):undefined,
  qaStatus:services.qaStatus?(id,job)=>services.qaStatus!(routes.resolve(id,job),job):undefined,
  qaValidation:services.qaValidation?(id,input)=>services.qaValidation!(routes.resolve(id,(input as {jobId?:unknown})?.jobId),input):undefined,
  qaPublication:services.qaPublication?(id,input)=>services.qaPublication!(routes.resolve(id,(input as {jobId?:unknown})?.jobId),input):undefined,
 };
}
