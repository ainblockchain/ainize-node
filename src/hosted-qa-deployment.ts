/** Read-only serving revision verification. A successful branch update alone is not deployment. */
import type {StoredReview} from './hosted-qa-review-store.js';
export interface QaDeploymentProfile {repository:string;branch:string;url:string;revisionPath:string[];healthy:{path:string[];equals:string|boolean}[]}
const sha=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value);
function at(value:any,path:string[]):unknown {
 for(const key of path){if(value===null||typeof value!=='object'||!Object.hasOwn(value,key))return undefined;value=value[key];}return value;
}
export function validateDeploymentProfile(profile:QaDeploymentProfile){
 const url=new URL(profile.url);
 if(url.protocol!=='https:'||url.username||url.password||url.hash||!/^[-\w.]+\/[-\w.]+$/.test(profile.repository)||!/^[-\w/]+$/.test(profile.branch))throw new Error('Invalid deployment binding');
 const path=(p:unknown)=>Array.isArray(p)&&p.length>0&&p.length<=8&&p.every(k=>typeof k==='string'&&/^[a-zA-Z0-9_-]{1,80}$/.test(k)&&!['__proto__','constructor','prototype'].includes(k));
 if(!path(profile.revisionPath)||!Array.isArray(profile.healthy)||!profile.healthy.length||profile.healthy.length>16||profile.healthy.some(c=>!path(c.path)||!['string','boolean'].includes(typeof c.equals)))throw new Error('Explicit health and revision checks required');
}
export async function observeQaDeployment(profile:QaDeploymentProfile,review:StoredReview,github:(path:string)=>Promise<any>,request:typeof fetch=fetch){
 profile=structuredClone(profile);review=structuredClone(review);validateDeploymentProfile(profile);
 const t=review.presentation.target;
 if(profile.repository!==t.repository||profile.branch!==t.branch||!sha(t.sha)||!Number.isSafeInteger(t.number)||t.number<1)throw new Error('Deployment target mismatch');
 const api=`/repos/${profile.repository}`,pr=await github(`${api}/pulls/${t.number}`);
 if(pr?.number!==t.number||pr.head?.sha!==t.sha||pr.head?.repo?.full_name!==t.repository||pr.base?.ref!==t.branch||pr.base?.repo?.full_name!==t.repository)throw new Error('Published PR changed');
 if(pr.merged!==true)return {state:'awaiting_merge_evidence' as const};
 if(!sha(pr.merge_commit_sha)||!Number.isFinite(Date.parse(pr.merged_at)))throw new Error('Incomplete GitHub merge evidence');
 let response:Response;
 try{response=await request(profile.url,{redirect:'error',cache:'no-store',headers:{'Cache-Control':'no-cache'},signal:AbortSignal.timeout(10000)});}catch{throw new Error('Deployment health unavailable');}
 if(!response.ok)throw new Error('Deployment health failed');
 const text=await response.text();if(Buffer.byteLength(text)>256000)throw new Error('Deployment response too large');
 let health;try{health=JSON.parse(text);}catch{throw new Error('Deployment response is not JSON');}
 if(profile.healthy.some(c=>at(health,c.path)!==c.equals))throw new Error('Deployment health checks failed');
 const revision=at(health,profile.revisionPath);
 if(typeof revision!=='string'||!/^[a-f0-9]{7,40}$/.test(revision))throw new Error('Serving commit unavailable');
 const commit=await github(`${api}/commits/${revision}`);
 if(!sha(commit?.sha)||!commit.sha.startsWith(revision))throw new Error('Serving commit did not resolve');
 for(const expected of new Set([t.sha,pr.merge_commit_sha])){
  const comparison=await github(`${api}/compare/${expected}...${commit.sha}`);
  if(!['ahead','identical'].includes(comparison?.status)||comparison.behind_by!==0||comparison.base_commit?.sha!==expected||comparison.merge_base_commit?.sha!==expected) return {state:'awaiting_deployment' as const,servingCommit:commit.sha};
 }
 return {state:'deployment_verified' as const,repository:t.repository,branch:t.branch,sha:t.sha,mergeCommit:pr.merge_commit_sha,servingCommit:commit.sha,url:profile.url,observedAt:new Date().toISOString(),deploymentVerified:true,featureRegressionVerified:false};
}
