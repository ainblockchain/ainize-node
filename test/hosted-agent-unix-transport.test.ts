import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {hostedAgentGatewayFetch} from '../src/hosted-agent-runtime/hostedAgentGatewayFetch.js';
import {hostedAgentTextPartsOf,hostedAgentTextOf} from '../src/hosted-agent-runtime/hostedAgentExecutor.js';
test('Unix gateway preserves request headers, JSON body, and streamed reply',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'ainize-uds-'));const socket=join(dir,'gateway.sock');
 const server=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;assert.equal(req.headers.authorization,'Bearer scoped-token');assert.equal(req.url,'/t/test/v1/chat/completions?stream=1');assert.deepEqual(JSON.parse(body),{model:'pinned',stream:true});res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: first\n\n');setImmediate(()=>res.end('data: [DONE]\n\n'));});
 const previous=process.env.AINIZE_GATEWAY_SOCKET;
 try{await new Promise<void>(resolve=>server.listen(socket,resolve));process.env.AINIZE_GATEWAY_SOCKET='b64:'+Buffer.from(socket).toString('base64');const response=await hostedAgentGatewayFetch('http://ainize-gateway/t/test/v1/chat/completions?stream=1',{method:'POST',headers:{authorization:'Bearer scoped-token','content-type':'application/json'},body:JSON.stringify({model:'pinned',stream:true})});assert.equal(response.status,200);assert.equal(await response.text(),'data: first\n\ndata: [DONE]\n\n');}finally{if(previous===undefined)delete process.env.AINIZE_GATEWAY_SOCKET;else process.env.AINIZE_GATEWAY_SOCKET=previous;await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(dir,{recursive:true,force:true});}
});
test('compatibility input retains original text parts and whitespace',()=>{const message={parts:[{kind:'text',text:'  first  '},{content:{$case:'text',value:'second'}},{kind:'file',file:{uri:'https://example.test'}}]};assert.deepEqual(hostedAgentTextPartsOf(message),['  first  ','second']);assert.equal(hostedAgentTextOf(message),'first  \nsecond');});
