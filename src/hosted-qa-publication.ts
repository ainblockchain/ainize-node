/** Host-only GitHub publication. No merge capability or credentials are exposed to the model. */
import {createHash} from 'node:crypto';
import {qaCandidateDigest, type QaCandidate} from './hosted-qa-validator.js';
import type {HostedQaValidationService} from './hosted-qa-validation-service.js';
export type QaGitHub = (method:'GET'|'POST',path:string,body?:unknown)=>Promise<any>;
export interface QaPublicationProfile {repository:string;branch:string}
const sha=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value);
const blob=(value:string)=>createHash('sha1').update(`blob ${Buffer.byteLength(value)}\0`).update(value).digest('hex');
export function qaGitHubClient(token:string,request:typeof fetch=fetch):QaGitHub {
 return async(method,path,body)=>{
  if(!path.startsWith('/repos/')||/[\r\n#]/.test(path))throw new Error('Invalid GitHub API path');
  const response=await request(`https://api.github.com${path}`,{method,redirect:'error',signal:AbortSignal.timeout(30000),headers:{Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  if(method==='GET'&&response.status===404)return null;
  if(!response.ok)throw new Error(`QA GitHub request failed (${response.status})`);
  return response.json();
 };
}
export class HostedQaPublisher {
 private readonly profiles:Record<string,QaPublicationProfile>;
 private readonly active=new Map<string,Promise<unknown>>();
 constructor(profiles:Record<string,QaPublicationProfile>,private validation:Pick<HostedQaValidationService,'requirePassed'>,private github:QaGitHub){
  this.profiles=structuredClone(profiles);
  for(const p of Object.values(this.profiles))if(!/^[\w.-]+\/[\w.-]+$/.test(p.repository)||!/^[-\w/]+$/.test(p.branch))throw new Error('Invalid publication profile');
 }
 publish(agentId:string,jobId:string,raw:QaCandidate):Promise<any>{
  if(!Object.hasOwn(this.profiles,agentId)||!/^[-\w]{1,128}$/.test(jobId))return Promise.reject(new Error('Publication is not configured'));
  const candidate=structuredClone(raw);
  // This reads the host receipt; caller-supplied verdicts cannot authorize publication.
  this.validation.requirePassed(agentId,candidate);
  const profile=this.profiles[agentId];
  if(candidate.repository!==profile.repository)throw new Error('Publication repository mismatch');
  const digest=qaCandidateDigest(candidate);
  const key=createHash('sha256').update(JSON.stringify([agentId,jobId,digest])).digest('hex');
  const existing=this.active.get(key);if(existing)return existing;
  const run=this.perform(profile,candidate,key,digest).finally(()=>this.active.delete(key));
  this.active.set(key,run);return run;
 }
 private async perform(profile:QaPublicationProfile,candidate:QaCandidate,key:string,digest:string){
  const api=`/repos/${profile.repository}`, branch=`ainize-qa/${key}`, github=this.github;
  const head=await github('GET',`${api}/git/ref/heads/${encodeURIComponent(profile.branch)}`);
  if(head?.object?.sha!==candidate.base)throw new Error('Base changed; revalidation required');
  const base=await github('GET',`${api}/git/commits/${candidate.base}`);
  if(base?.sha!==candidate.base||!sha(base.tree?.sha)||typeof base.committer?.date!=='string'||!Number.isFinite(Date.parse(base.committer.date)))throw new Error('Invalid base commit');
  const source=await github('GET',`${api}/git/trees/${base.tree.sha}?recursive=1`);
  if(source?.truncated!==false||!Array.isArray(source.tree))throw new Error('Incomplete base tree');
  const expected=new Map<string,{path:string;mode:string;type:string;sha:string}>();
  for(const entry of source.tree){
   if(entry.type==='tree')continue;
   if(entry.type!=='blob'||!['100644','100755'].includes(entry.mode)||!sha(entry.sha)||typeof entry.path!=='string'||expected.has(entry.path))throw new Error('Unsupported base tree');
   expected.set(entry.path,{path:entry.path,mode:entry.mode,type:'blob',sha:entry.sha});
  }
  const changes=Object.entries(candidate.changes).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([path,content])=>{
   const mode=expected.get(path)?.mode??'100644';expected.set(path,{path,mode,type:'blob',sha:blob(content)});
   return {path,mode,type:'blob',content};
  });
  const tree=await github('POST',`${api}/git/trees`,{base_tree:base.tree.sha,tree:changes});
  if(!sha(tree?.sha))throw new Error('Invalid created tree');
  const actual=await github('GET',`${api}/git/trees/${tree.sha}?recursive=1`);
  const entries=actual?.tree?.filter((e:any)=>e.type!=='tree');
  if(actual?.truncated!==false||!Array.isArray(entries)||entries.length!==expected.size||new Set(entries.map((e:any)=>e.path)).size!==expected.size||entries.some((e:any)=>{const want=expected.get(e.path);return !want||want.sha!==e.sha||want.mode!==e.mode||want.type!==e.type;}))throw new Error('Published tree differs from validated candidate');
  // Fixed metadata makes repeated commit creation content-addressed, including after a lost response.
  const identity={name:'Ainize QA',email:'qa@ainize.ai',date:base.committer.date};
  const commit=await github('POST',`${api}/git/commits`,{message:`QA candidate ${key}\n\nCandidate-Digest: ${digest}`,tree:tree.sha,parents:[candidate.base],author:identity,committer:identity});
  if(!sha(commit?.sha)||commit.tree?.sha!==tree.sha||commit.parents?.length!==1||commit.parents[0].sha!==candidate.base)throw new Error('Invalid candidate commit');
  const refPath=`${api}/git/ref/heads/${encodeURIComponent(branch)}`;
  let ref=await github('GET',refPath);
  if(!ref){
   try{await github('POST',`${api}/git/refs`,{ref:`refs/heads/${branch}`,sha:commit.sha});}
   catch(error){ref=await github('GET',refPath);if(ref?.object?.sha!==commit.sha)throw error;}
   ref=await github('GET',refPath);
  }
  if(ref?.object?.sha!==commit.sha)throw new Error('Candidate branch was changed; refusing overwrite');
  const query=`${api}/pulls?state=all&head=${encodeURIComponent(profile.repository.split('/')[0]+':'+branch)}&base=${encodeURIComponent(profile.branch)}&per_page=100`;
  let prs=await github('GET',query);
  if(!Array.isArray(prs))throw new Error('Invalid PR listing');
  if(prs.length===0){
   try{await github('POST',`${api}/pulls`,{title:`QA candidate ${key.slice(0,12)}`,head:branch,base:profile.branch,draft:true,body:`Validated candidate: ${digest}\n\nAwaiting review and administrator approval.`});}
   catch(error){prs=await github('GET',query);if(!Array.isArray(prs)||prs.length!==1)throw error;}
   prs=await github('GET',query);
  }
  if(prs.length!==1)throw new Error('Ambiguous candidate PR');
  const pr=prs[0];
  if(pr.state!=='open'||pr.head?.sha!==commit.sha||pr.head?.ref!==branch||pr.head?.repo?.full_name!==profile.repository||pr.base?.ref!==profile.branch||pr.base?.repo?.full_name!==profile.repository||!Number.isSafeInteger(pr.number)||pr.number<1)throw new Error('Candidate PR binding changed');
  const currentBase=await github('GET',`${api}/git/ref/heads/${encodeURIComponent(profile.branch)}`);
  const currentHead=await github('GET',refPath);
  if(currentBase?.object?.sha!==candidate.base||currentHead?.object?.sha!==commit.sha)throw new Error('Publication changed during reconciliation; revalidation required');
  return {repository:profile.repository,base:candidate.base,candidateDigest:digest,sha:commit.sha,branch,number:pr.number,url:`https://github.com/${profile.repository}/pull/${pr.number}`};
 }
}
