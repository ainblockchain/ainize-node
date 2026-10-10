/** Private host ledger. Approval observations are audit evidence, never cached release authority. */
import type {QaTeamsThreadBinding} from './hosted-qa-teams-thread.js';
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,lstatSync,openSync,closeSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import type {ReviewPresentation,verifyAinmemApproval,verifyTeamsApproval} from './hosted-qa-review.js';
import type {QaRevalidationRequest} from './hosted-qa-base.js';
type Approval=NonNullable<ReturnType<typeof verifyAinmemApproval>|ReturnType<typeof verifyTeamsApproval>>;
export interface QaRepositoryRoutes {web:{scope:string;repository:string};api:{scope:string;repository:string}}
export interface QaRoutedIntake {scope:string;repository:string;route:'web'|'api';policyDigest:string;binding:QaTeamsThreadBinding}
export interface QaHistoricalRoute {jobId:string;scope:string;repository:string;route:'web'|'api';policyDigest:string;archiveDigest:string;workspaceId:string;channelId:string;rootId:string;requestId:string}
export interface StoredReview {agentId:string;jobId:string;generation:number;key:string;presentation:ReviewPresentation}
const json=(value:unknown,limit=64000)=>{const raw=JSON.stringify(value);if(Buffer.byteLength(raw)>limit)throw new Error('Review record too large');return raw;};
const fingerprint=(p:ReviewPresentation)=>createHash('sha256').update(json([Object.entries(p.target).sort(([a],[b])=>a.localeCompare(b)),p.body,p.bodyDigest,p.revision,p.digest,p.policyDigest??null])).digest('hex');
export class HostedQaReviewStore {
 private db:DatabaseSync;
 constructor(root:string){
  mkdirSync(root,{recursive:true,mode:0o700});const dir=lstatSync(root);
  if(!dir.isDirectory()||dir.isSymbolicLink()||(dir.mode&0o077)!==0)throw new Error('Review ledger must be private');
  const file=join(root,'reviews.sqlite3');
  try{closeSync(openSync(file,'wx',0o600));}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
  const st=lstatSync(file);if(!st.isFile()||st.isSymbolicLink()||(st.mode&0o077)!==0)throw new Error('Invalid review ledger');
  this.db=new DatabaseSync(file);
  this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
   CREATE TABLE IF NOT EXISTS review_intakes(agent_id TEXT NOT NULL,job_id TEXT NOT NULL,request_key TEXT NOT NULL,binding TEXT NOT NULL,PRIMARY KEY(agent_id,job_id),UNIQUE(agent_id,request_key));
   CREATE TABLE IF NOT EXISTS review_routes(owner_id TEXT NOT NULL,job_id TEXT NOT NULL,record TEXT NOT NULL,PRIMARY KEY(owner_id,job_id));
   CREATE TABLE IF NOT EXISTS review_historical_routes(owner_id TEXT NOT NULL,job_id TEXT NOT NULL,record TEXT NOT NULL,PRIMARY KEY(owner_id,job_id));
   CREATE TABLE IF NOT EXISTS review_base_changes(agent_id TEXT NOT NULL,job_id TEXT NOT NULL,generation INTEGER NOT NULL,review_key TEXT NOT NULL,observed_base TEXT NOT NULL,PRIMARY KEY(agent_id,job_id,generation));
   CREATE TABLE IF NOT EXISTS review_revalidations(agent_id TEXT NOT NULL,job_id TEXT NOT NULL,sequence INTEGER NOT NULL,record TEXT NOT NULL,PRIMARY KEY(agent_id,job_id,sequence));
   CREATE TABLE IF NOT EXISTS reviews(agent_id TEXT NOT NULL,job_id TEXT NOT NULL,generation INTEGER NOT NULL,key TEXT NOT NULL,presentation TEXT NOT NULL,PRIMARY KEY(agent_id,job_id,generation));
   CREATE TABLE IF NOT EXISTS review_releases(agent_id TEXT NOT NULL,job_id TEXT NOT NULL,generation INTEGER NOT NULL,intent TEXT NOT NULL,receipt TEXT,PRIMARY KEY(agent_id,job_id,generation));
   CREATE TABLE IF NOT EXISTS review_publications(id INTEGER PRIMARY KEY AUTOINCREMENT,agent_id TEXT NOT NULL,job_id TEXT NOT NULL,receipt TEXT NOT NULL,last_attempt INTEGER NOT NULL DEFAULT 0,UNIQUE(agent_id,job_id));
   CREATE TABLE IF NOT EXISTS review_observations(agent_id TEXT NOT NULL,job_id TEXT NOT NULL,generation INTEGER NOT NULL,comment_id TEXT NOT NULL,checked_at TEXT NOT NULL,evidence TEXT NOT NULL,PRIMARY KEY(agent_id,job_id,generation,comment_id,checked_at));`);
 }
 /** Permanent invalidation of this generation, even if the branch later moves back. */
 baseChange(expected:StoredReview):string|null {
  const row=this.db.prepare('SELECT review_key,observed_base FROM review_base_changes WHERE agent_id=? AND job_id=? AND generation=?').get(expected.agentId,expected.jobId,expected.generation);
  if(row&&row.review_key!==expected.key)throw new Error('Review invalidation binding changed');
  return row?String(row.observed_base):null;
 }
 invalidateBase(expected:StoredReview,observedBase:string){
  if(!/^[a-f0-9]{40}$/.test(observedBase)||observedBase===expected.presentation.target.base)throw new Error('Invalid changed base');
  this.transaction(()=>{
   const current=this.current(expected.agentId,expected.jobId);
   if(!current||current.generation!==expected.generation||current.key!==expected.key)throw new Error('Review changed during base observation');
   if(this.releaseRecord(current)?.receipt)throw new Error('Release already observed');
   this.db.prepare('INSERT OR IGNORE INTO review_base_changes VALUES(?,?,?,?,?)').run(expected.agentId,expected.jobId,expected.generation,expected.key,observedBase);
  });
 }
 releaseIntent(expected:StoredReview,approval:Approval){
  this.observe(expected,approval);
  return this.transaction(()=>{
   const current=this.current(expected.agentId,expected.jobId);
   if(!current||current.generation!==expected.generation||current.key!==expected.key)throw new Error('Review changed before release');
   if(approval.source==='teams'&&current.presentation.target.teamsRequest)this.assertUnambiguousThread(expected.agentId,expected.jobId,current.presentation.target.teamsRequest);
   const prior=this.releaseRecord(expected);
   if(prior)return prior;
   const intent={target:current.presentation.target,approval,reviewKey:current.key};
   this.db.prepare('INSERT INTO review_releases(agent_id,job_id,generation,intent) VALUES(?,?,?,?)').run(expected.agentId,expected.jobId,expected.generation,json(intent));
   return {intent,receipt:null};
  });
 }
 /** Reserve an invalidated review for a new coding attempt. Historical publications and review
  * keys are immutable evidence, not release authority. Safe to repeat before/after host I/O.
  */
 authorizeRevalidation(agentId:string,jobId:string,request:QaRevalidationRequest):void {
  if(!request||Object.keys(request).sort().join(',')!=='previousBase,sequence,sourceDigest'
   ||typeof request.previousBase!=='string'||!/^[a-f0-9]{40}$/.test(request.previousBase)
   ||!Number.isSafeInteger(request.sequence)||request.sequence<1||request.sequence>20
   ||typeof request.sourceDigest!=='string'||!/^[a-f0-9]{64}$/.test(request.sourceDigest))throw new Error('Invalid revalidation request');
  this.transaction(()=>{
   const intake=this.intake(agentId,jobId),publication=this.publication(agentId,jobId),review=this.current(agentId,jobId);
   if(!intake||!publication||!review||publication.base!==request.previousBase
    ||['repository','base','sha','candidateDigest'].some(key=>publication[key]!==review.presentation.target[key as keyof typeof review.presentation.target])
    ||!publication.teamsRequest||!review.presentation.target.teamsRequest
    ||json(publication.teamsRequest)!==json(intake)||json(review.presentation.target.teamsRequest)!==json(intake)||!this.baseChange(review))throw new Error('Invalidated published review required');
   // Even an intent without a receipt can already be merging remotely. Never race it.
   if(this.releaseRecord(review))throw new Error('Release reconciliation required before revalidation');
   const rows=this.revalidationHistory(agentId,jobId),prior=rows.at(-1);
   if(prior?.request.sequence===request.sequence){
    if(json(prior.request)!==json(request)||prior.reviewKey!==review.key||prior.generation!==review.generation
      ||json(prior.publication)!==json(publication))throw new Error('Revalidation reservation changed');
    return;
   }
   if(request.sequence!==rows.length+1)throw new Error('Revalidation sequence changed');
   if(prior?.generation===review.generation)throw new Error('Review already reserved for revalidation');
   const record={request:structuredClone(request),generation:review.generation,reviewKey:review.key,
    publication,observedBase:this.baseChange(review)};
   this.db.prepare('INSERT INTO review_revalidations VALUES(?,?,?,?)').run(agentId,jobId,request.sequence,json(record,4*1024*1024));
  });
 }
 revalidationHistory(agentId:string,jobId:string):Array<{request:QaRevalidationRequest;generation:number;reviewKey:string;publication:any;observedBase:string}> {
  return this.db.prepare('SELECT record FROM review_revalidations WHERE agent_id=? AND job_id=? ORDER BY sequence').all(agentId,jobId).map(row=>JSON.parse(String(row.record)));
 }
 releaseRecord(expected:StoredReview):{intent:any;receipt:any}|null {
  const row=this.db.prepare('SELECT intent,receipt FROM review_releases WHERE agent_id=? AND job_id=? AND generation=?').get(expected.agentId,expected.jobId,expected.generation);
  return row?{intent:JSON.parse(String(row.intent)),receipt:row.receipt?JSON.parse(String(row.receipt)):null}:null;
 }
 releaseObserved(expected:StoredReview,receipt:unknown){
  if(!this.releaseRecord(expected))throw new Error('No release intent');
  this.db.prepare('UPDATE review_releases SET receipt=? WHERE agent_id=? AND job_id=? AND generation=?').run(json(receipt),expected.agentId,expected.jobId,expected.generation);
 }
 enqueuePublication(agentId:string,jobId:string,receipt:unknown){
  if(!/^[-\w]{1,128}$/.test(agentId)||!/^[-\w]{1,80}$/.test(jobId))throw new Error('Invalid publication identity');
  const value=json(receipt,3*1024*1024);
  this.transaction(()=>{
   const prior=this.db.prepare('SELECT receipt FROM review_publications WHERE agent_id=? AND job_id=?').get(agentId,jobId);
   if(prior){if(prior.receipt!==value)throw new Error('Published job changed; explicit reconciliation required');return;}
   if(Number(this.db.prepare('SELECT count(*) AS n FROM review_publications').get()!.n)>=10000)throw new Error('Publication review capacity reached');
   this.db.prepare('INSERT INTO review_publications(agent_id,job_id,receipt) VALUES(?,?,?)').run(agentId,jobId,value);
  });
 }
 assertUnambiguousThread(agentId:string,jobId:string,binding:QaTeamsThreadBinding){
  // The Teams thread is shared authority even when repositories have distinct host scopes.
  const rows=this.db.prepare("SELECT agent_id,job_id FROM review_publications WHERE NOT (agent_id=? AND job_id=?) AND json_extract(receipt,'$.teamsRequest.workspaceId')=? AND json_extract(receipt,'$.teamsRequest.channelId')=? AND json_extract(receipt,'$.teamsRequest.rootId')=?").all(agentId,jobId,binding.workspaceId,binding.channelId,binding.rootId);
  for(const row of rows){
   const review=this.current(String(row.agent_id),String(row.job_id));
   if(!review||this.releaseRecord(review)?.receipt?.state!=='deployment_verified')throw new Error('Ambiguous Teams approval; use the canonical task page');
  }
 }
 intake(agentId:string,jobId:string):QaTeamsThreadBinding|null {
  const row=this.db.prepare('SELECT binding FROM review_intakes WHERE agent_id=? AND job_id=?').get(agentId,jobId);return row?JSON.parse(String(row.binding)):null;
 }
 routedIntake(owner:string,jobId:string):QaRoutedIntake|null {
  const row=this.db.prepare('SELECT record FROM review_routes WHERE owner_id=? AND job_id=?').get(owner,jobId);
  return row?JSON.parse(String(row.record)):null;
 }
 /** Operator migration evidence only. Never creates a verified intake, review or release record. */
 importHistoricalRoutes(owner:string,records:QaHistoricalRoute[]){
  return this.transaction(()=>{
   let imported=0,unchanged=0;
   for(const record of records){
    const value=json(record),prior=this.db.prepare('SELECT record FROM review_historical_routes WHERE owner_id=? AND job_id=?').get(owner,record.jobId);
    if(prior){if(prior.record!==value)throw new Error('Historical route changed; reconciliation required');unchanged++;continue;}
    if(this.routedIntake(owner,record.jobId))throw new Error('Job already has a live intake');
    if(Number(this.db.prepare('SELECT count(*) AS n FROM review_historical_routes').get()!.n)>=10000)throw new Error('Historical route capacity reached');
    this.db.prepare('INSERT INTO review_historical_routes VALUES(?,?,?)').run(owner,record.jobId,value);imported++;
   }
   return {imported,unchanged};
  });
 }
 registerRoutedIntake(owner:string,jobId:string,routes:QaRepositoryRoutes,policyDigest:string,binding:QaTeamsThreadBinding,text:string):QaRoutedIntake {
  if(!/^[-\w]{1,128}$/.test(owner)||!/^[-\w]{1,80}$/.test(jobId)||createHash('sha256').update(text).digest('hex')!==binding.requestDigest)throw new Error('Invalid routed intake');
  return this.transaction(()=>{
   const prior=this.routedIntake(owner,jobId);
   if(prior){if(prior.policyDigest!==policyDigest||json(prior.binding)!==json(binding))throw new Error('Routed intake changed');return prior;}
   const rows=this.db.prepare("SELECT agent_id,job_id,binding FROM review_intakes WHERE json_extract(binding,'$.workspaceId')=? AND json_extract(binding,'$.channelId')=? AND (json_extract(binding,'$.rootId')=? OR json_extract(binding,'$.requestId')=?)").all(binding.workspaceId,binding.channelId,binding.rootId,binding.requestId);
   let inherited:'web'|'api'|undefined;
   const history=this.db.prepare("SELECT owner_id,record FROM review_historical_routes WHERE json_extract(record,'$.workspaceId')=? AND json_extract(record,'$.channelId')=? AND (json_extract(record,'$.rootId')=? OR json_extract(record,'$.requestId')=?)").all(binding.workspaceId,binding.channelId,binding.rootId,binding.requestId);
   for(const row of history){
    const old:QaHistoricalRoute=JSON.parse(String(row.record));
    if(old.requestId===binding.requestId)throw new Error('Historical request requires reconciliation, not fresh intake');
    if(row.owner_id!==owner||old.policyDigest!==policyDigest||routes[old.route]?.scope!==old.scope||routes[old.route]?.repository!==old.repository||inherited&&inherited!==old.route)throw new Error('Ambiguous historical thread route');
    inherited=old.route;
   }
   for(const row of rows){
    const original:QaTeamsThreadBinding=JSON.parse(String(row.binding));
    if(original.requestId===binding.requestId)throw new Error('Original request already assigned; reconciliation required');
    const route=(Object.keys(routes) as ('web'|'api')[]).find(key=>routes[key].scope===row.agent_id);
    if(!route||inherited&&inherited!==route)throw new Error('Ambiguous historical thread route');
    const previous=this.routedIntake(owner,String(row.job_id));
    if(!previous||previous.policyDigest!==policyDigest||previous.scope!==row.agent_id||previous.repository!==routes[route].repository)throw new Error('Historical route policy changed; reconciliation required');
    inherited=route;
   }
   const prefix=/^(api|ainize-node|백엔드|web|ainize-web|웹)(?=\s|:|：|$)/i.exec(text.trim().replace(/^\/fix\s+/i,''));
   const requested=prefix?(/^(api|ainize-node|백엔드)$/i.test(prefix[1])?'api':'web'):undefined;
   if(inherited&&requested&&inherited!==requested)throw new Error('Different repository requires a new thread');
   const route=inherited??requested??'web',selected=routes[route];
   if(Number(this.db.prepare('SELECT count(*) AS n FROM review_intakes').get()!.n)>=10000)throw new Error('Intake capacity reached');
   this.db.prepare('INSERT INTO review_intakes VALUES(?,?,?,?)').run(selected.scope,jobId,json([binding.workspaceId,binding.channelId,binding.requestId]),json(binding));
   const record={...selected,route,policyDigest,binding};
   this.db.prepare('INSERT INTO review_routes VALUES(?,?,?)').run(owner,jobId,json(record));
   return structuredClone(record);
  });
 }
 registerIntake(agentId:string,jobId:string,binding:QaTeamsThreadBinding){
  if(!/^[-\w]{1,128}$/.test(agentId)||!/^[-\w]{1,80}$/.test(jobId))throw new Error('Invalid intake identity');
  const value=json(binding),key=json([binding.workspaceId,binding.channelId,binding.requestId]);
  return this.transaction(()=>{
   const existing=this.intake(agentId,jobId);
   if(existing){if(json(existing)!==value)throw new Error('Original intake changed');return existing;}
   if(Number(this.db.prepare('SELECT count(*) AS n FROM review_intakes').get()!.n)>=10000)throw new Error('Intake capacity reached');
   this.db.prepare('INSERT INTO review_intakes VALUES(?,?,?,?)').run(agentId,jobId,key,value);return structuredClone(binding);
  });
 }
 lifecycle(agentId:string,jobId:string){
  if(!/^[-\w]{1,80}$/.test(jobId))throw new Error('Invalid job identifier');
  const published=this.publication(agentId,jobId);if(!published)return {state:'unknown'};
  const review=this.current(agentId,jobId),release=review?this.releaseRecord(review):null;
  const receipt=release?.receipt;
  if(review){
   const target=review.presentation.target;
   if(['repository','base','sha','candidateDigest'].some(key=>target[key as keyof typeof target]!==published[key]))throw new Error('Lifecycle review binding changed');
  }
  if(receipt&&(receipt.repository!==published.repository||receipt.sha!==published.sha))throw new Error('Lifecycle release binding changed');
  const observedBase=review?this.baseChange(review):null;
  const state=receipt?.state==='deployment_verified'?'deployment_verified':receipt?.state==='branch_updated'?'branch_updated':observedBase?'requires_revalidation':release?'release_pending':review?'awaiting_approval':'awaiting_presentation';
  return {jobId,repository:published.repository,base:published.base,sha:published.sha,candidateDigest:published.candidateDigest,state,...(state==='requires_revalidation'?{observedBase}:{}),
   ...(state==='deployment_verified'?{servingCommit:receipt.servingCommit,mergeCommit:receipt.mergeCommit,deploymentVerified:true,featureRegressionVerified:false}: {})};
 }
 publication(agentId:string,jobId:string){const row=this.db.prepare('SELECT receipt FROM review_publications WHERE agent_id=? AND job_id=?').get(agentId,jobId);return row?JSON.parse(String(row.receipt)):null;}
 pendingPublications(limit=5){
  return this.db.prepare(`SELECT p.* FROM review_publications p WHERE NOT EXISTS (
   SELECT 1 FROM reviews r JOIN review_releases l
    ON l.agent_id=r.agent_id AND l.job_id=r.job_id AND l.generation=r.generation
   WHERE r.agent_id=p.agent_id AND r.job_id=p.job_id
    AND r.generation=(SELECT max(latest.generation) FROM reviews latest WHERE latest.agent_id=p.agent_id AND latest.job_id=p.job_id)
    AND json_extract(l.receipt,'$.state')='deployment_verified'
    AND json_extract(l.receipt,'$.repository')=json_extract(p.receipt,'$.repository')
    AND json_extract(l.receipt,'$.sha')=json_extract(p.receipt,'$.sha')
   ) ORDER BY p.last_attempt,p.id LIMIT ?`).all(limit).map(r=>({id:Number(r.id),agentId:String(r.agent_id),jobId:String(r.job_id),receipt:JSON.parse(String(r.receipt))}));
 }
 attemptedPublication(id:number){this.db.prepare('UPDATE review_publications SET last_attempt=(SELECT coalesce(max(last_attempt),0)+1 FROM review_publications) WHERE id=?').run(id);}
 close(){this.db.close();}
 private transaction<T>(run:()=>T):T {this.db.exec('BEGIN IMMEDIATE');try{const result=run();this.db.exec('COMMIT');return result;}catch(e){this.db.exec('ROLLBACK');throw e;}}
 current(agentId:string,jobId:string):StoredReview|null {
  const row=this.db.prepare('SELECT * FROM reviews WHERE agent_id=? AND job_id=? ORDER BY generation DESC LIMIT 1').get(agentId,jobId);
  return row?{agentId,jobId,generation:Number(row.generation),key:String(row.key),presentation:JSON.parse(String(row.presentation))}:null;
 }
 bind(agentId:string,presentation:ReviewPresentation,expectedGeneration:number):StoredReview {
  const p=structuredClone(presentation),jobId=p.target.jobId;
  if(!/^[-\w]{1,128}$/.test(agentId)||!/^[-\w]{1,80}$/.test(jobId)||!Number.isFinite(Date.parse(p.presentedAt)))throw new Error('Invalid review identity');
  const key=fingerprint(p);
  return this.transaction(()=>{
   const prior=this.current(agentId,jobId);
   const reserved=this.revalidationHistory(agentId,jobId).at(-1);
   if(reserved&&reserved.generation===prior?.generation)throw new Error('Prior review is reserved for revalidation');
   if(prior?.key===key)return prior; // Preserve the first server observation across replay/restart.
   if((prior?.generation??0)!==expectedGeneration)throw new Error('Review changed while capturing presentation');
   if(prior&&Date.parse(p.presentedAt)<=Date.parse(prior.presentation.presentedAt))throw new Error('New review must have a later observation');
   if(Number(this.db.prepare('SELECT count(*) AS n FROM reviews').get()!.n)>=10000)throw new Error('Review ledger capacity reached');
   if(p.target.teamsRequest){
    const binding=p.target.teamsRequest;
    const others=this.db.prepare('SELECT r.* FROM reviews r WHERE NOT (agent_id=? AND job_id=?) AND generation=(SELECT max(generation) FROM reviews latest WHERE latest.agent_id=r.agent_id AND latest.job_id=r.job_id)').all(agentId,jobId);
    for(const row of others){
     const other:StoredReview={agentId:String(row.agent_id),jobId:String(row.job_id),generation:Number(row.generation),key:String(row.key),presentation:JSON.parse(String(row.presentation))};
     const original=other.presentation.target.teamsRequest;
     if(original&&original.workspaceId===binding.workspaceId&&original.channelId===binding.channelId&&original.rootId===binding.rootId&&this.releaseRecord(other)?.receipt?.state!=='deployment_verified')throw new Error('Another review is awaiting approval in this thread');
    }
   }
   const generation=(prior?.generation??0)+1;
   this.db.prepare('INSERT INTO reviews VALUES(?,?,?,?,?)').run(agentId,jobId,generation,key,json(p));
   return {agentId,jobId,generation,key,presentation:p};
  });
 }
 observe(expected:StoredReview,evidence:Approval){
  return this.transaction(()=>{
   const current=this.current(expected.agentId,expected.jobId);
   if(!current||current.generation!==expected.generation||current.key!==expected.key)throw new Error('Review changed while checking approval');
   if(this.baseChange(current))throw new Error('Review base changed; revalidation required');
   const p=current.presentation,t=p.target;
   if(evidence.source==='teams'&&(!t.teamsRequest||evidence.threadId!==t.teamsRequest.rootId||evidence.requestId!==t.teamsRequest.requestId))throw new Error('Approval thread binding mismatch');
   if(evidence.source==='teams'&&t.teamsRequest)this.assertUnambiguousThread(expected.agentId,expected.jobId,t.teamsRequest);
   if(evidence.jobId!==t.jobId||evidence.pageId!==t.pageId||evidence.sha!==t.sha||evidence.repository!==t.repository||evidence.number!==t.number||evidence.candidateDigest!==t.candidateDigest||evidence.presentationDigest!==p.bodyDigest||evidence.issuer!==t.issuer||evidence.orgId!==t.orgId||!(Date.parse(evidence.approvedAt)>Date.parse(p.presentedAt))||!(Date.parse(evidence.checkedAt)>=Date.parse(evidence.approvedAt)))throw new Error('Approval observation binding mismatch');
   const prior=this.db.prepare('SELECT evidence FROM review_observations WHERE agent_id=? AND job_id=? AND generation=? AND comment_id=? LIMIT 1').get(expected.agentId,expected.jobId,expected.generation,evidence.commentId);
   if(prior){
    const {checkedAt:_old,...old}=JSON.parse(String(prior.evidence));const {checkedAt:_new,...fresh}=evidence;
    if(json(old)!==json(fresh))throw new Error('Canonical approval comment changed');
    return {...structuredClone(evidence),generation:current.generation};
   }
   if(Number(this.db.prepare('SELECT count(*) AS n FROM review_observations').get()!.n)>=100000)throw new Error('Review observation capacity reached');
   this.db.prepare('INSERT OR IGNORE INTO review_observations VALUES(?,?,?,?,?,?)').run(expected.agentId,expected.jobId,expected.generation,evidence.commentId,evidence.checkedAt,json(evidence));
   return {...structuredClone(evidence),generation:current.generation};
  });
 }
}
