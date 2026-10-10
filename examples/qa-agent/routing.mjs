/** Shared-channel routing after canonical Teams verification. Never pass webhook text here. */
import {createHash} from 'node:crypto';

export function requestedRepositoryRoute(text) {
  const request=text.trim().replace(/^\/fix\s+/i,'');
  const match=/^(api|ainize-node|백엔드|web|ainize-web|웹)(?=\s|:|：|$)/i.exec(request);
  return match ? /^(api|ainize-node|백엔드)$/i.test(match[1]) ? 'api' : 'web' : null;
}

/** One DB/transaction for both repositories. Existing jobs are the durable routing record.
 * Does not authorize coding, publication or release; those still need a matching host capability.
 */
export function enqueueSharedTeamsRequest(jobs,config,verified) {
  const id=value=>typeof value==='string'&&/^[a-zA-Z0-9-]{1,80}$/.test(value);
  if(!config||!id(config.service)||!id(config.workspaceId)||!id(config.channelId))throw new Error('Invalid shared channel');
  const routes=config.routes;
  if(!routes||Object.keys(routes).sort().join(',')!=='api,web')throw new Error('Both shared repositories required');
  for(const route of Object.values(routes)){
    if(!id(route?.service)||!/^[-\w.]+\/[-\w.]+$/.test(route?.repository??'')||!/^[a-f0-9]{40}$/.test(route?.baseCommit??''))throw new Error('Invalid repository route');
  }
  if(routes.web.repository===routes.api.repository||routes.web.service===routes.api.service)throw new Error('Duplicate repository route');
  if(!verified||verified.workspaceId!==config.workspaceId||verified.channelId!==config.channelId||!id(verified.messageId)||!id(verified.parentId)||typeof verified.text!=='string'||!verified.text.trim())throw new Error('Canonical request scope mismatch');
  return jobs.transaction(()=>{
    const rows=jobs.db.prepare("SELECT * FROM jobs WHERE json_extract(input,'$.teams.workspaceId')=? AND json_extract(input,'$.teams.channelId')=? AND (json_extract(input,'$.teams.messageId')=? OR json_extract(input,'$.teams.parentId')=?)")
      .all(verified.workspaceId,verified.channelId,verified.messageId,verified.parentId).map(row=>jobs.decode(row));
    const inChannel=job=>job.input.teams?.workspaceId===verified.workspaceId&&job.input.teams?.channelId===verified.channelId;
    const sameMessage=rows.filter(job=>inChannel(job)&&job.input.teams.messageId===verified.messageId);
    if(sameMessage.length>1)throw new Error('Multiple historical requests; reconciliation required');
    const thread=rows.filter(job=>inChannel(job)&&job.input.teams.parentId===verified.parentId);
    const repositories=new Set(thread.map(job=>job.input.repository));
    if(repositories.size>1)throw new Error('Ambiguous shared thread; reconciliation required');
    const routeFor=job=>Object.entries(routes).find(([,route])=>route.repository===job.input.repository&&route.service===job.input.service)?.[0];
    if(thread.some(job=>!routeFor(job)))throw new Error('Historical route changed; reconciliation required');
    if(sameMessage.length){
      const prior=sameMessage[0];
      if(!routeFor(prior)||prior.input.teams.parentId!==verified.parentId||prior.input.text!==verified.text)throw new Error('Canonical request changed; reconciliation required');
      // No base/profile refresh or checkpoint write on re-delivery, even after a completed release.
      return prior;
    }
    const requested=requestedRepositoryRoute(verified.text),owner=thread.length?routeFor(thread[0]):null;
    if(owner&&requested&&owner!==requested)throw new Error('Different repository requires a new thread');
    const route=owner??requested??'web',selected=routes[route];
    const teams={workspaceId:verified.workspaceId,channelId:verified.channelId,parentId:verified.parentId,messageId:verified.messageId};
    const key='teams:'+createHash('sha256').update(JSON.stringify([config.service,teams.workspaceId,teams.channelId,teams.parentId,teams.messageId])).digest('hex');
    return jobs.insert(key,{service:selected.service,route,repository:selected.repository,base:selected.baseCommit,text:verified.text,teams});
  });
}
