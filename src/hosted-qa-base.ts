/** Host-owned job bases. Preparing a new request never rebases an existing candidate or approval. */
import {createHash,randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdirSync,lstatSync,readFileSync,writeFileSync,renameSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {validateQaProfile,type QaValidationProfile,type QaCandidate} from './hosted-qa-validator.js';

const exec=promisify(execFile);
const fullSha=(s:unknown):s is string=>typeof s==='string'&&/^[a-f0-9]{40}$/.test(s);
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
export interface QaBaseProfile {validation:QaValidationProfile;branch:string}
export interface QaBaseSource {
  /** Must read the operator-bound repository/branch from its authoritative remote. */
  head(repository:string,branch:string):Promise<string>;
  /** Import that exact object and verify dependencies against the image's original pinned base. */
  prepare(profile:QaValidationProfile,base:string):Promise<void>;
}

/** Read/fetch Git objects only. No checkout, hooks, repository scripts or package installation. */
export async function prepareQaCheckout(profile:QaValidationProfile,base:string,token?:string) {
  if(!fullSha(base))throw new Error('Invalid remote base');
  if(token!==undefined&&(!token||/[\r\n]/.test(token)))throw new Error('Invalid Git fetch credential');
  // The credential remains in the host child environment, never argv, the Git URL, or an agent mount.
  const auth=token?{GIT_CONFIG_COUNT:'1',GIT_CONFIG_KEY_0:'http.https://github.com/.extraheader',GIT_CONFIG_VALUE_0:`Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`} : {};
  const git=async(args:string[])=>(await exec('git',['-C',profile.checkout,...args],{timeout:60000,maxBuffer:16*1024*1024,env:{...process.env,...auth,GIT_TERMINAL_PROMPT:'0'}})).stdout;
  // Fetch only the operator-bound GitHub repository, never a URL found in model input or .git/config.
  let present=false;
  try{present=(await git(['rev-parse','--verify',`${base}^{commit}`])).trim()===base;}catch{/* Missing objects are fetched below. */}
  if(!present)await git(['-c','core.hooksPath=/dev/null','fetch','--no-tags','--no-recurse-submodules',
    `https://github.com/${profile.repository}.git`,base]);
  if((await git(['rev-parse',`${base}^{commit}`])).trim()!==base)throw new Error('Fetched base mismatch');
  const changed=(await git(['diff','--no-ext-diff','--no-textconv','--name-only','-z',profile.base,base])).split('\0').filter(Boolean);
  // A lock/config/vendor change needs a rebuilt operator image, not a silent install in a gate.
  const dependencyPath=(path:string)=>path.split('/').some(part=>
    /^(package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|yarn\.lock|\.npmrc|\.yarnrc(?:\.yml)?|\.pnpmfile\.cjs|vendor|patches|\.yarn)$/.test(part));
  if(changed.some(dependencyPath))throw new Error('Dependency image refresh required');
}

export class HostedQaBases {
  private profiles:Record<string,QaBaseProfile>;
  private active=new Map<string,Promise<QaValidationProfile>>();
  private failures=new Map<string,number>();
  constructor(private root:string,profiles:Record<string,QaBaseProfile>,private source:QaBaseSource,
    private requireIntake:(agentId:string,jobId:string)=>void) {
    this.profiles=structuredClone(profiles);
    mkdirSync(root,{recursive:true,mode:0o700});
    const st=lstatSync(root);
    if(!st.isDirectory()||st.isSymbolicLink()||(st.mode&0o077)!==0)throw new Error('QA bases must be private');
    for(const p of Object.values(this.profiles)){
      if(!/^[-\w/]+$/.test(p.branch))throw new Error('Invalid base branch');
      validateQaProfile(p.validation,{repository:p.validation.repository,base:p.validation.base,changes:{'qa-base-check':'binding'}});
    }
  }
  private binding(agentId:string,jobId:string){
    if(!Object.hasOwn(this.profiles,agentId)||!/^[-\w]{1,128}$/.test(jobId))throw new Error('Unknown QA base binding');
    const policy=this.profiles[agentId],key=hash([agentId,jobId]);
    return {policy,key,file:join(this.root,`${key}.json`),policyDigest:hash(policy)};
  }
  configured(agentId:string){return Object.hasOwn(this.profiles,agentId);}
  /** Bounded gateway polling; responses expose the immutable identity, never host paths or gate commands. */
  submit(agentId:string,jobId:string){
    this.requireIntake(agentId,jobId);
    const {key}=this.binding(agentId,jobId),prior=this.read(agentId,jobId);
    if(prior)return {state:'done',result:{repository:prior.repository,base:prior.base}};
    for(const [k,at] of this.failures)if(Date.now()-at>60000)this.failures.delete(k);
    if(this.failures.has(key))return {state:'failed'};
    if(this.active.has(key))return {state:'running'};
    if(this.failures.size>=2000)throw new Error('QA base failure capacity reached');
    void this.prepare(agentId,jobId).catch(()=>{this.failures.set(key,Date.now());});
    return {state:'running'};
  }
  private read(agentId:string,jobId:string):QaValidationProfile|undefined {
    const {policy,file,policyDigest}=this.binding(agentId,jobId);
    try{
      const st=lstatSync(file);
      if(!st.isFile()||st.isSymbolicLink()||(st.mode&0o077)!==0||st.size>65536)throw new Error('Invalid QA base record');
      const record=JSON.parse(readFileSync(file,'utf8'));
      if(record.agentId!==agentId||record.jobId!==jobId||record.policyDigest!==policyDigest||!fullSha(record.base))throw new Error('QA base policy changed; reconciliation required');
      return {...structuredClone(policy.validation),base:record.base};
    }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  }
  /** Job identity is durable: retries/restarts return its original base even if main has moved. */
  prepare(agentId:string,jobId:string):Promise<QaValidationProfile> {
    this.requireIntake(agentId,jobId);
    const {policy,key,file,policyDigest}=this.binding(agentId,jobId);
    const prior=this.read(agentId,jobId);if(prior)return Promise.resolve(prior);
    const running=this.active.get(key);if(running)return running.then(p=>structuredClone(p));
    if(this.active.size>=16||readdirSync(this.root).length>=2000)throw new Error('QA base capacity reached');
    const run=(async()=>{
      const base=await this.source.head(policy.validation.repository,policy.branch);
      if(!fullSha(base))throw new Error('Invalid remote base');
      await this.source.prepare(structuredClone(policy.validation),base);
      // A revoked/deleted intake while remote reads were pending must not acquire a base.
      this.requireIntake(agentId,jobId);
      const temp=join(this.root,`${key}.${randomUUID()}.tmp`);
      writeFileSync(temp,JSON.stringify({agentId,jobId,policyDigest,base}),{mode:0o600,flag:'wx'});
      renameSync(temp,file);
      return {...structuredClone(policy.validation),base};
    })().finally(()=>this.active.delete(key));
    this.active.set(key,run);return run.then(p=>structuredClone(p));
  }
  /** Resolve only a prepared job's profile; arbitrary caller-supplied base SHAs are not authority. */
  requireProfile(agentId:string,jobId:string,candidate:QaCandidate):QaValidationProfile {
    this.requireIntake(agentId,jobId);
    const profile=this.read(agentId,jobId);
    if(!profile)throw new Error('Job base has not been prepared');
    validateQaProfile(profile,candidate);return profile;
  }
  async drain(){await Promise.allSettled(this.active.values());}
}
