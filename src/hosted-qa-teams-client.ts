/** Read-only host MCP client for canonical release checks. No model access to this token. */
import {randomUUID} from 'node:crypto';
import type {TeamsReviewMcp} from './hosted-qa-teams-review.js';
export function teamsReviewClient(origin:string,token:string,request:typeof fetch=fetch):TeamsReviewMcp {
 const url=new URL(origin);if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new Error('Invalid Teams origin');
 return {async call(name,args){
  if(!['list_channels','list_channel_members'].includes(name))throw new Error('Read-only Teams review operation required');
  let session:string|null=null;
  async function rpc(method:string,params:unknown,notify=false):Promise<any>{
   const id=randomUUID();let response:Response;
   try{response=await request(`${url.origin}/api/mcp`,{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2025-03-26',...(session?{'Mcp-Session-Id':session}:{})},body:JSON.stringify({jsonrpc:'2.0',...(notify?{}:{id}),method,params})});}catch{throw new Error('Teams review connection failed');}
   if(!response.ok){await response.body?.cancel();throw new Error('Teams review refused');}
   session=response.headers.get('Mcp-Session-Id')??session;
   if(notify){await response.body?.cancel();return;}
   const raw=await response.text();if(Buffer.byteLength(raw)>4*1024*1024)throw new Error('Teams review response too large');
   try{
    const replies=response.headers.get('content-type')?.includes('text/event-stream')?raw.replaceAll('\r\n','\n').split('\n\n').map(event=>event.split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n')).filter(Boolean).map(text=>JSON.parse(text)):[JSON.parse(raw)];
    const reply=replies.find(r=>r?.id===id);if(!reply||reply.error||!Object.hasOwn(reply,'result'))throw new Error();return reply.result;
   }catch{throw new Error('Invalid Teams review response');}
  }
  await rpc('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'ainize-qa-review',version:'1'}});
  await rpc('notifications/initialized',{},true);
  const result=await rpc('tools/call',{name,arguments:args});
  try{if(result?.isError)throw new Error();const text=result?.content?.find((p:any)=>p.type==='text')?.text;if(typeof text!=='string')throw new Error();return JSON.parse(text);}catch{throw new Error('Invalid Teams review tool result');}
 }};
}
