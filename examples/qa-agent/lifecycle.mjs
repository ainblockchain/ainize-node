/** Poll host-owned release evidence under a separate lease so awaiting approvals do not block coding. */
export async function advanceHostedLifecycle({jobs,claim,checkpoints,ctx}){
 const {job,lease}=claim,published=job.checkpoint.published;
 if(job.state!=='running'||!['awaiting_approval','awaiting_deployment'].includes(job.checkpoint.stage)||!published)throw new Error('Job is not awaiting host lifecycle');
 jobs.renew(job.id,lease,60000);
 const status=await ctx.qa.status(job.id);
 if(status?.state==='unknown')return jobs.finish(job.id,lease,'waiting',job.checkpoint);
 if(status?.jobId!==job.id||status.repository!==job.input.repository||status.base!==job.input.base||status.sha!==published.sha||status.candidateDigest!==published.candidateDigest)throw new Error('Host lifecycle binding changed');
 if(status.state==='requires_revalidation'){
  if(!/^[a-f0-9]{40}$/.test(status.observedBase??'')||status.observedBase===job.input.base)throw new Error('Invalid changed base evidence');
  return jobs.parkForRevalidation(job.id,lease,status.observedBase);
 }
 if(['awaiting_presentation','awaiting_approval','release_pending'].includes(status.state))return jobs.finish(job.id,lease,'waiting',job.checkpoint);
 if(status.state==='branch_updated')return jobs.finish(job.id,lease,'waiting',{...job.checkpoint,stage:'awaiting_deployment'});
 if(status.state!=='deployment_verified'||status.deploymentVerified!==true||!/^[a-f0-9]{40}$/.test(status.servingCommit??'')||!/^[a-f0-9]{40}$/.test(status.mergeCommit??''))throw new Error('Incomplete deployment evidence');
 const deployment=checkpoints.save(job.id,{kind:'deployment',repository:status.repository,candidateSha:status.sha,candidateDigest:status.candidateDigest,mergeCommit:status.mergeCommit,servingCommit:status.servingCommit,featureRegressionVerified:false});
 return jobs.finish(job.id,lease,'completed',{...job.checkpoint,stage:'deployed',deployment,servingCommit:status.servingCommit});
}
