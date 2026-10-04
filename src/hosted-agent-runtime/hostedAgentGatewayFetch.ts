/** Same authenticated gateway over a Unix socket, for hosts whose bridge ingress is blocked. */
import {request as httpRequest} from 'node:http';
import {Readable} from 'node:stream';
const nativeFetch:typeof fetch=globalThis.fetch.bind(globalThis);
export const hostedAgentGatewayFetch:typeof fetch=async(input,init)=>{
  const configured=process.env.AINIZE_GATEWAY_SOCKET;
  const socketPath=configured?.startsWith('b64:')?Buffer.from(configured.slice(4),'base64').toString():configured;
  const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);
  if(!socketPath||url.hostname!=='ainize-gateway')return nativeFetch(input,init);
  const request=new Request(input,init);
  const body=request.body?Buffer.from(await request.arrayBuffer()):null;
  return new Promise<Response>((resolve,reject)=>{
    const call=httpRequest({socketPath,path:url.pathname+url.search,method:request.method,headers:Object.fromEntries(request.headers),signal:request.signal},incoming=>{
      const headers=new Headers();for(const [name,value]of Object.entries(incoming.headers)){if(value!==undefined)for(const v of Array.isArray(value)?value:[value])headers.append(name,v);}
      const status=incoming.statusCode??502;
      resolve(new Response([204,205,304].includes(status)?null:Readable.toWeb(incoming) as ReadableStream,{status,headers}));
    });
    call.on('error',reject);if(body)call.write(body);call.end();
  });
};
