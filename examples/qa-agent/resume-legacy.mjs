/** Offline operator cutover only. Never exposed to agent input or the model. */
import {createHash} from 'node:crypto';
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Only requests with no old candidate can start a fresh native attempt here.
 * Published/coded/merged work must go through candidate reconciliation instead.
 * verify and prepare are host-owned adapters, not model-supplied receipts.
 */
export async function resumeUnpublishedLegacy({jobs,checkpoints,jobId,verify,prepare,ainmemOrigin}) {
 const original=jobs.get(jobId),cp=original?.checkpoint;
 if(original?.state!=='waiting'||cp?.stage!=='legacy_reconciliation'||cp.holdReason!=='legacy_import'
   ||cp.legacy?.jobId!==jobId)throw new Error('Historical job is not awaiting cutover');
 const archive=checkpoints.load(cp.legacy),details=archive.job?.details;
 if(archive.kind!=='legacy-job-v1'||digest(archive)!==cp.legacyFingerprint||archive.job.id!==jobId
   ||archive.repository!==original.input.repository||archive.job.payload?.text!==original.input.text
   ||archive.workspaceId!==original.input.teams?.workspaceId||archive.channelId!==original.input.teams?.channelId
   ||archive.job.message_id!==original.input.teams?.messageId||archive.job.payload.parent_id!==original.input.teams?.parentId
   ||!['blocked','interrupted','awaiting_approval'].includes(archive.job.status))throw new Error('Historical archive changed');
 if(!details||['code_sha','pr_main','pr_develop','superseded_by','superseded_pr','approval','release','deployment']
   .some(key=>details[key]!=null))throw new Error('Existing candidate requires reconciliation');
 // Pin the old page before queuing; no missing/malformed archive page may create a new card.
 const origin=new URL(ainmemOrigin);
 const url=new URL(details.kanban_url);
 if(origin.protocol!=='https:'||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash
   ||url.origin!==origin.origin||url.protocol!=='https:'||url.username||url.password||url.search||url.hash
   ||!/^\/p\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(url.pathname))throw new Error('Historical task page required');
 const expected=digest(original);
 const evidence=await verify(archive,cp.legacyFingerprint);
 const b=evidence?.binding,t=original.input.teams;
 if(evidence?.jobId!==jobId||evidence.repository!==original.input.repository||evidence.archiveDigest!==cp.legacyFingerprint
   ||evidence.text!==original.input.text||b?.workspaceId!==t.workspaceId||b.channelId!==t.channelId
   ||b.requestId!==t.messageId||b.rootId!==t.parentId||b.requestDigest!==createHash('sha256').update(original.input.text).digest('hex'))throw new Error('Historical intake receipt mismatch');
 const base=await prepare(jobId);
 if(base?.repository!==original.input.repository||!/^[a-f0-9]{40}$/.test(base?.base??''))throw new Error('Prepared historical base mismatch');
 // Recheck live author membership after potentially slow host preparation too.
 const fresh=await verify(archive,cp.legacyFingerprint);
 if(digest(fresh)!==digest(evidence))throw new Error('Historical intake changed during preparation');
 return jobs.transaction(()=>{
  if(digest(jobs.get(jobId))!==expected)throw new Error('Historical job changed during preparation');
  // Retain immutable archive and canonical-page source, never copy old approvals or code state.
  const checkpoint={hostIntake:true,hostBase:true,legacy:cp.legacy,legacyFingerprint:cp.legacyFingerprint,
    historicalResume:{archiveDigest:cp.legacyFingerprint,base:base.base}};
  jobs.db.prepare("UPDATE jobs SET input=?,checkpoint=?,state='queued',lease=NULL,expires=NULL,updated=? WHERE id=?")
   .run(JSON.stringify({...original.input,base:base.base}),JSON.stringify(checkpoint),jobs.now(),jobId);
  return jobs.get(jobId);
 });
}
