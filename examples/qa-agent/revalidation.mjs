/** A host receipt must precede the local attempt switch. Failures never wake the old candidate. */
export async function advanceHostedRevalidation({jobs,claim,ctx}) {
 const {job,lease}=claim,prior=job.checkpoint.priorAttempt;
 if(job.state!=='running'||job.checkpoint.stage!=='needs_revalidation'||job.checkpoint.holdReason!=='base_changed'||!prior)throw new Error('Job is not awaiting revalidation');
 try {
  jobs.renew(job.id,lease,60000);
  if(!ctx.qa?.revalidate)throw new Error('Host revalidation unavailable');
  const response=await ctx.qa.revalidate(job.id,{previousBase:job.input.base,sequence:prior.sequence,sourceDigest:prior.sourceDigest,...(job.checkpoint.revalidationCandidateDigest?{candidateDigest:job.checkpoint.revalidationCandidateDigest}:{})});
  if(response?.state==='running'||response?.state==='busy')return jobs.finish(job.id,lease,'waiting',job.checkpoint);
  if(response?.state!=='done')throw new Error('Host revalidation incomplete');
  return jobs.bindRevalidation(job.id,lease,response.result);
 } catch {
  const failures=(job.checkpoint.revalidationFailures??0)+1;
  return jobs.finish(job.id,lease,'waiting',{...job.checkpoint,revalidationFailures:failures,
   ...(failures>=3?{holdReason:'revalidation_preparation_failed'}:{})});
 }
}
