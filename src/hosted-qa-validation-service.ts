/** Operator-bound validation capability. No agent-supplied commands, images or checkout paths. */
import { mkdirSync, lstatSync, readFileSync, writeFileSync, renameSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { QA_VALIDATOR_VERSION, runQaValidation, validateQaProfile, qaCandidateDigest, type QaCandidate, type QaValidationProfile } from './hosted-qa-validator.js';
type Result = Awaited<ReturnType<typeof runQaValidation>>;
export type QaValidationStatus = { state: 'running' | 'busy' } | { state: 'done'; result: Result } | { state: 'failed' };
class InvalidValidationEvidence extends Error {}
type SavedStatus = QaValidationStatus | {state:'failed';attempts:number;retryAt:number};
export class HostedQaValidationService {
  private readonly running = new Set<string>();
  constructor(private root: string, private profiles: Record<string,QaValidationProfile>,
    private run: typeof runQaValidation = runQaValidation,
    private resolveProfile?: (agentId:string,jobId:string|undefined,candidate:QaCandidate)=>QaValidationProfile|undefined,
    private now:()=>number=Date.now) {
    this.profiles=structuredClone(profiles);
    mkdirSync(root,{recursive:true,mode:0o700});
    const st=lstatSync(root);
    if(!st.isDirectory()||st.isSymbolicLink()||(st.mode&0o077)!==0)throw new Error('QA validation state must be private');
  }
  private binding(agentId:string, raw:unknown, jobId?:string) {
    if(!Object.hasOwn(this.profiles,agentId))throw new Error('QA validation is not configured for this agent');
    const candidate=structuredClone(raw) as QaCandidate;
    const profile=this.resolveProfile?.(agentId,jobId,candidate)??this.profiles[agentId]!;
    validateQaProfile(profile,candidate);
    const key=createHash('sha256').update(JSON.stringify([QA_VALIDATOR_VERSION,agentId,profile,qaCandidateDigest(candidate)])).digest('hex');
    const file=join(this.root,`${key}.json`);
    return {profile,candidate,key,file};
  }
  private readReceipt(file:string, profile:QaValidationProfile, candidate:QaCandidate):SavedStatus|undefined {
    try {
      const st=lstatSync(file);
      if(!st.isFile()||st.isSymbolicLink()||st.size>1024*1024||(st.mode&0o077)!==0)throw new Error('Invalid QA validation receipt');
      const saved=JSON.parse(readFileSync(file,'utf8')) as SavedStatus;
      if(saved.state==='failed'){
        if('attempts' in saved && (!Number.isSafeInteger(saved.attempts)||saved.attempts<1||saved.attempts>3||!Number.isSafeInteger(saved.retryAt)||saved.retryAt<0))throw new Error('Invalid QA retry receipt');
        if('retryAt' in saved && !('attempts' in saved))throw new Error('Invalid QA retry receipt');
        return saved;
      }
      if(saved.state!=='done')throw new Error('Invalid QA validation state');
      this.checkResult(saved.result,profile,candidate);
      return saved;
    } catch(error) {if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  }
  private checkResult(result:Result, profile:QaValidationProfile, candidate:QaCandidate) {
    if(!result||result.repository!==candidate.repository||result.base!==candidate.base||
      result.candidateDigest!==qaCandidateDigest(candidate)||typeof result.passed!=='boolean'||
      !Array.isArray(result.gates)||!result.gates.length||result.gates.length>profile.gates.length||
      result.gates.some((gate,i)=>!gate||gate.gate!==profile.gates[i]!.name||typeof gate.passed!=='boolean'||
        (i<result.gates.length-1&&!gate.passed))||
      result.passed!==(result.gates.length===profile.gates.length&&result.gates.every(g=>g.passed))||
      (!result.passed&&result.gates.at(-1)?.passed))throw new Error('Invalid QA validation result binding');
  }
  /** Host-only publication precondition: reads durable evidence without starting any execution. */
  requirePassed(agentId:string, raw:unknown, jobId?:string):Result {
    const {profile,candidate,file}=this.binding(agentId,raw,jobId);
    const saved=this.readReceipt(file,profile,candidate);
    if(saved?.state!=='done'||!saved.result.passed)throw new Error('Candidate has no passing host validation');
    return saved.result;
  }
  submit(agentId:string, raw:unknown):QaValidationStatus {
    let jobId:string|undefined;
    if(raw && typeof raw==='object' && !Array.isArray(raw) && Object.hasOwn(raw,'candidate')){
      const input=raw as {jobId:string;candidate:unknown};
      if(Object.keys(input).sort().join(',')!=='candidate,jobId'||typeof input.jobId!=='string'||!/^[-\w]{1,128}$/.test(input.jobId))throw new Error('Invalid job validation request');
      jobId=input.jobId;raw=input.candidate;
    }
    const {profile,candidate,key,file}=this.binding(agentId,raw,jobId);
    const saved=this.readReceipt(file,profile,candidate);
    if(saved?.state==='done')return saved;
    if(saved?.state==='failed'&&(!('attempts' in saved)||saved.attempts>=3))return {state:'failed'};
    if(saved?.state==='failed'&&'retryAt' in saved&&this.now()<saved.retryAt)return {state:'busy'};
    const attempts=saved?.state==='failed'&&'attempts' in saved?saved.attempts+1:1;
    if(this.running.has(key))return {state:'running'};
    if(this.running.size)return {state:'busy'};
    if(!saved&&readdirSync(this.root).length>=1000)throw new Error('QA validation receipt capacity reached');
    this.running.add(key);
    const save=(status:SavedStatus)=>{
      const temp=join(this.root,`${key}.${randomUUID()}.tmp`);
      writeFileSync(temp,JSON.stringify(status),{mode:0o600,flag:'wx'});renameSync(temp,file);
    };
    void Promise.resolve().then(()=>this.run(profile,candidate,(gate,output)=>{
      if(!profile.gates.some(g=>g.name===gate))throw new InvalidValidationEvidence('Unknown QA evidence gate');
      let directory=this.root;
      for(const part of ['logs',key]){
        directory=join(directory,part);
        try{mkdirSync(directory,{mode:0o700});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
        const st=lstatSync(directory);
        if(!st.isDirectory()||st.isSymbolicLink()||(st.mode&0o077)!==0)throw new InvalidValidationEvidence('QA logs must be private');
      }
      const bounded=(text:string)=>{const bytes=Buffer.from(text);return bytes.length<=1024*1024?bytes:Buffer.concat([bytes.subarray(0,512*1024),Buffer.from('\n[private log truncated]\n'),bytes.subarray(-512*1024)]);};
      for(const stream of ['stdout','stderr'] as const){
        const target=join(directory,`${gate}.${stream}.log`),temp=join(directory,`${gate}.${stream}.${randomUUID()}.tmp`);
        writeFileSync(temp,bounded(output[stream]),{mode:0o600,flag:'wx'});renameSync(temp,target);
      }
    }))
      .then(result=>{
        // Invalid receipts are terminal; they must never be accepted by retrying a malformed result.
        try{this.checkResult(result,profile,candidate);}catch{save({state:'failed'});return;}
        save({state:'done',result});
      })
      .catch(error=>save(error instanceof InvalidValidationEvidence?{state:'failed'}:{state:'failed',attempts,retryAt:this.now()+30000}))
      .catch(()=>{/* Receipt persistence failure permits a later safe validation retry. */})
      .finally(()=>this.running.delete(key));
    return {state:'running'};
  }
}
