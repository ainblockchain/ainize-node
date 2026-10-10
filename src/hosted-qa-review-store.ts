/** Private host ledger. Approval observations are audit evidence, never cached release authority. */
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,lstatSync,openSync,closeSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import type {ReviewPresentation,verifyAinmemApproval} from './hosted-qa-review.js';
type Approval=NonNullable<ReturnType<typeof verifyAinmemApproval>>;
export interface StoredReview {agentId:string;jobId:string;generation:number;key:string;presentation:ReviewPresentation}
const json=(value:unknown)=>{const raw=JSON.stringify(value);if(Buffer.byteLength(raw)>64000)throw new Error('Review record too large');return raw;};
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
   CREATE TABLE IF NOT EXISTS reviews(agent_id TEXT NOT NULL,job_id TEXT NOT NULL,generation INTEGER NOT NULL,key TEXT NOT NULL,presentation TEXT NOT NULL,PRIMARY KEY(agent_id,job_id,generation));
   CREATE TABLE IF NOT EXISTS review_publications(id INTEGER PRIMARY KEY AUTOINCREMENT,agent_id TEXT NOT NULL,job_id TEXT NOT NULL,receipt TEXT NOT NULL,last_attempt INTEGER NOT NULL DEFAULT 0,UNIQUE(agent_id,job_id));
   CREATE TABLE IF NOT EXISTS review_observations(agent_id TEXT NOT NULL,job_id TEXT NOT NULL,generation INTEGER NOT NULL,comment_id TEXT NOT NULL,checked_at TEXT NOT NULL,evidence TEXT NOT NULL,PRIMARY KEY(agent_id,job_id,generation,comment_id,checked_at));`);
 }
 enqueuePublication(agentId:string,jobId:string,receipt:unknown){
  if(!/^[-\w]{1,128}$/.test(agentId)||!/^[-\w]{1,80}$/.test(jobId))throw new Error('Invalid publication identity');
  const value=json(receipt);
  this.transaction(()=>{
   const prior=this.db.prepare('SELECT receipt FROM review_publications WHERE agent_id=? AND job_id=?').get(agentId,jobId);
   if(prior){if(prior.receipt!==value)throw new Error('Published job changed; explicit reconciliation required');return;}
   if(Number(this.db.prepare('SELECT count(*) AS n FROM review_publications').get()!.n)>=10000)throw new Error('Publication review capacity reached');
   this.db.prepare('INSERT INTO review_publications(agent_id,job_id,receipt) VALUES(?,?,?)').run(agentId,jobId,value);
  });
 }
 pendingPublications(limit=5){
  return this.db.prepare('SELECT * FROM review_publications ORDER BY last_attempt,id LIMIT ?').all(limit).map(r=>({id:Number(r.id),agentId:String(r.agent_id),jobId:String(r.job_id),receipt:JSON.parse(String(r.receipt))}));
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
   if(prior?.key===key)return prior; // Preserve the first server observation across replay/restart.
   if((prior?.generation??0)!==expectedGeneration)throw new Error('Review changed while capturing presentation');
   if(prior&&Date.parse(p.presentedAt)<=Date.parse(prior.presentation.presentedAt))throw new Error('New review must have a later observation');
   if(Number(this.db.prepare('SELECT count(*) AS n FROM reviews').get()!.n)>=10000)throw new Error('Review ledger capacity reached');
   const generation=(prior?.generation??0)+1;
   this.db.prepare('INSERT INTO reviews VALUES(?,?,?,?,?)').run(agentId,jobId,generation,key,json(p));
   return {agentId,jobId,generation,key,presentation:p};
  });
 }
 observe(expected:StoredReview,evidence:Approval){
  return this.transaction(()=>{
   const current=this.current(expected.agentId,expected.jobId);
   if(!current||current.generation!==expected.generation||current.key!==expected.key)throw new Error('Review changed while checking approval');
   const p=current.presentation,t=p.target;
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
