/** Operator-bound validation capability. No agent-supplied commands, images or checkout paths. */
import { mkdirSync, lstatSync, readFileSync, writeFileSync, renameSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { runQaValidation, validateQaProfile, qaCandidateDigest, type QaCandidate, type QaValidationProfile } from './hosted-qa-validator.js';
type Result = Awaited<ReturnType<typeof runQaValidation>>;
export type QaValidationStatus = { state: 'running' | 'busy' } | { state: 'done'; result: Result } | { state: 'failed' };
export class HostedQaValidationService {
  private readonly running = new Set<string>();
  constructor(private root: string, private profiles: Record<string,QaValidationProfile>,
    private run: typeof runQaValidation = runQaValidation) {
    this.profiles=structuredClone(profiles);
    mkdirSync(root,{recursive:true,mode:0o700});
    const st=lstatSync(root);
    if(!st.isDirectory()||st.isSymbolicLink()||(st.mode&0o077)!==0)throw new Error('QA validation state must be private');
  }
  submit(agentId:string, raw:unknown):QaValidationStatus {
    if(!Object.hasOwn(this.profiles,agentId))throw new Error('QA validation is not configured for this agent');
    const profile=this.profiles[agentId]!;
    const candidate=structuredClone(raw) as QaCandidate;
    validateQaProfile(profile,candidate);
    const key=createHash('sha256').update(JSON.stringify([agentId,profile,qaCandidateDigest(candidate)])).digest('hex');
    const file=join(this.root,`${key}.json`);
    try {
      const st=lstatSync(file);
      if(!st.isFile()||st.isSymbolicLink()||st.size>1024*1024||(st.mode&0o077)!==0)throw new Error('Invalid QA validation receipt');
      const saved=JSON.parse(readFileSync(file,'utf8')) as QaValidationStatus;
      if(saved.state!=='done'&&saved.state!=='failed')throw new Error('Invalid QA validation state');
      return saved;
    } catch(error) {if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    if(this.running.has(key))return {state:'running'};
    if(this.running.size)return {state:'busy'};
    if(readdirSync(this.root).length>=1000)throw new Error('QA validation receipt capacity reached');
    this.running.add(key);
    const save=(status:QaValidationStatus)=>{
      const temp=join(this.root,`${key}.${randomUUID()}.tmp`);
      writeFileSync(temp,JSON.stringify(status),{mode:0o600,flag:'wx'});renameSync(temp,file);
    };
    void Promise.resolve().then(()=>this.run(profile,candidate))
      .then(result=>save({state:'done',result}),()=>save({state:'failed'}))
      .catch(()=>{/* Receipt persistence failure permits a later safe validation retry. */})
      .finally(()=>this.running.delete(key));
    return {state:'running'};
  }
}
