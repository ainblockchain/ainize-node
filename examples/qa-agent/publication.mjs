/** Publish only a host-validated candidate; persist the exact PR/SHA before waiting for approval. */
import {candidateDigest} from './validation.mjs';
export async function advanceHostedPublication({jobs,claim,checkpoints,ctx}) {
 const {job,lease}=claim;
 if(job.state!=='running'||job.checkpoint.stage!=='needs_publication'||job.checkpoint.coding?.jobId!==job.id||job.checkpoint.validation?.jobId!==job.id)throw new Error('Job is not awaiting publication');
 const coding=checkpoints.load(job.checkpoint.coding), validation=checkpoints.load(job.checkpoint.validation);
 const candidate={repository:coding.repository,base:coding.commit,changes:coding.changes};
 const digest=candidateDigest(candidate);
 if(candidate.repository!==job.input.repository||candidate.base!==job.input.base||!validation.passed||validation.candidateDigest!==digest)throw new Error('Publication candidate mismatch');
 if(!ctx.qa?.publish)throw new Error('Host publication capability unavailable');
 jobs.renew(job.id,lease,60000);
 const reply=await ctx.qa.publish(job.id,candidate);
 if(reply?.state==='running')return jobs.finish(job.id,lease,'queued',job.checkpoint);
 if(reply?.state==='failed')return jobs.finish(job.id,lease,'waiting',{...job.checkpoint,holdReason:'host_publication_failed'});
 const result=reply?.result;
 if(reply?.state!=='done'||result?.repository!==candidate.repository||result.base!==candidate.base||result.candidateDigest!==digest||!/^[a-f0-9]{40}$/.test(result.sha??'')||!Number.isSafeInteger(result.number)||result.number<1||result.url!==`https://github.com/${candidate.repository}/pull/${result.number}`)throw new Error('Host publication receipt mismatch');
 const published={repository:result.repository,base:result.base,candidateDigest:digest,sha:result.sha,number:result.number,url:result.url};
 const publication=checkpoints.save(job.id,{kind:'publication',...published});
 return jobs.finish(job.id,lease,'waiting',{...job.checkpoint,publication,published,stage:'awaiting_approval'});
}
