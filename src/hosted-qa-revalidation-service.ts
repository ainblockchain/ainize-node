/** Bounded host adapter: a prepared base is not returned until the review ledger records it. */
import {createHash} from 'node:crypto';
import type {HostedQaBases,QaRevalidationReceipt} from './hosted-qa-base.js';
import type {HostedQaReviewStore} from './hosted-qa-review-store.js';
type Status={state:'running'}|{state:'failed'}|{state:'done';result:QaRevalidationReceipt};
export class HostedQaRevalidationService {
 private entries=new Map<string,{status:Status;task:Promise<void>;finished?:number}>();
 constructor(private bases:HostedQaBases,private reviews:HostedQaReviewStore){}
 submit(agentId:string,raw:unknown):Status {
  const input=structuredClone(raw) as {jobId:string;previousBase:string;sequence:number;sourceDigest:string};
  if(!input||Object.keys(input).sort().join(',')!=='jobId,previousBase,sequence,sourceDigest'
   ||typeof input.jobId!=='string'||!/^[-\w]{1,80}$/.test(input.jobId))throw new Error('Invalid revalidation request');
  const {jobId,...request}=input;
  // Cached results never bypass current intake, invalidation or release checks.
  this.reviews.authorizeRevalidation(agentId,jobId,request);
  const key=createHash('sha256').update(JSON.stringify([agentId,jobId,request.previousBase,request.sequence,request.sourceDigest])).digest('hex');
  for(const [key,entry] of this.entries)if(entry.finished&&Date.now()-entry.finished>60000)this.entries.delete(key);
  const prior=this.entries.get(key);
  if(prior){
   if(prior.status.state==='failed')this.entries.delete(key); // The durable agent bounds subsequent attempts.
   return structuredClone(prior.status);
  }
  if(this.entries.size>=1000)throw new Error('Revalidation capacity reached');
  const entry:{status:Status;task:Promise<void>;finished?:number}={status:{state:'running'},task:Promise.resolve()};
  this.entries.set(key,entry);
  entry.task=Promise.resolve().then(()=>this.bases.prepareRevalidation(agentId,jobId,request)).then(result=>{
   this.reviews.commitRevalidationBase(agentId,result);
   entry.status={state:'done',result};
  }).catch(()=>{entry.status={state:'failed'};}).finally(()=>{entry.finished=Date.now();});
  return {state:'running'};
 }
 async drain(){await Promise.allSettled(Array.from(this.entries.values(),entry=>entry.task));}
}
