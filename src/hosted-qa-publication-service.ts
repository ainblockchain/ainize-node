/** Bounded asynchronous gateway adapter. Remote refs/PRs are the durable retry authority. */
import {createHash} from 'node:crypto';
import type {HostedQaPublisher} from './hosted-qa-publication.js';
import type {QaCandidate} from './hosted-qa-validator.js';
type Status={state:'running'}|{state:'done';result:unknown}|{state:'failed'};
export class HostedQaPublicationService {
 private entries=new Map<string,{status:Status;finishedAt?:number}>();
 constructor(private publisher:HostedQaPublisher,private onPublished?:(agentId:string,jobId:string,result:unknown,candidate:QaCandidate)=>void,private beforePublish?:(agentId:string,jobId:string)=>void){}
 submit(agentId:string,raw:unknown):Status {
  const input=structuredClone(raw) as {jobId:string;candidate:QaCandidate};
  if(!input||Object.keys(input).sort().join(',')!=='candidate,jobId'||typeof input.jobId!=='string'||!/^[-\w]{1,128}$/.test(input.jobId))throw new Error('Invalid publication request');
  const key=createHash('sha256').update(JSON.stringify([agentId,input])).digest('hex');
  for(const [k,v] of this.entries)if(v.finishedAt&&Date.now()-v.finishedAt>60000)this.entries.delete(k);
  const prior=this.entries.get(key);if(prior)return prior.status;
  if(this.entries.size>=1000)throw new Error('Publication capacity reached');
  this.beforePublish?.(agentId,input.jobId);
  const task=this.publisher.publish(agentId,input.jobId,input.candidate);
  const entry:{status:Status;finishedAt?:number}={status:{state:'running'}};
  this.entries.set(key,entry);
  void task.then(result=>{this.onPublished?.(agentId,input.jobId,result,input.candidate);entry.status={state:'done',result};}).catch(()=>{entry.status={state:'failed'};}).finally(()=>{entry.finishedAt=Date.now();});
  return entry.status;
 }
}
