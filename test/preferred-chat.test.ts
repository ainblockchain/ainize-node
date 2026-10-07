import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { openaiSurfaceRouter } from '../src/openai-surface.js';
import { preferredChatPeers, preferredChatPlayground } from '../src/preferred-chat.js';
test('invalid peer configuration fails visibly',()=>assert.throws(()=>preferredChatPeers('{"qwen":"not-an-address"}')));
test('pinned bare models and playground retain long inputs and tools; missing peer never falls back',async()=>{
 const peer='0x'+'2'.repeat(40),seen:any[]=[];let available=true;
 const peers={target:(_k:any,_m:any,node:any)=>available&&node===peer?{model:'qwen',address:peer,endpoint:'http://peer'}:null,relayChat:async(_t:any,b:any,res:any)=>{seen.push(b);res.json({ok:true});},models:()=>[]};
 const app=express();app.use(express.json({limit:'25mb'}));
 app.use(preferredChatPlayground({routes:{qwen:peer},peers:()=>peers,fetch:async(_p:any,b:any)=>{seen.push(b);if(b.stream) return new Response('data: '+JSON.stringify({id:'test',object:'chat.completion.chunk',created:1,model:'qwen',choices:[{index:0,delta:{content:'answer'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});return Response.json({choices:[{message:{content:'answer'},finish_reason:'stop'}]});}} as any));
 app.use(openaiSurfaceRouter({node:'0x'+'1'.repeat(40),preferredChatPeers:{qwen:peer},keys:{addressForKey:()=> 'caller'},registry:{backendForModel:()=>({modality:'chat'}),listModels:()=>[]},gates:new Map(),market:{chat:()=>{throw Error('local must not run')}},peerModels:peers} as any));
 app.post('/api/chat',(_req,res)=>res.json({legacy:true}));
 const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
 const base=`http://127.0.0.1:${(server.address() as any).port}`;
 const post=(p:string,b:any)=>fetch(base+p,{method:'POST',headers:{authorization:'Bearer test','content-type':'application/json'},body:JSON.stringify(b)});
 try{
 const body={model:'qwen',messages:[{role:'user',content:'x'.repeat(100000)}],max_tokens:220000,tools:[{type:'function',function:{name:'lookup',parameters:{type:'object'}}}],tool_choice:'required'};
 assert.equal((await post('/v1/chat/completions',body)).status,200);assert.deepEqual(seen[0],body);
 const playground=await post('/api/chat',{...body,model:undefined,mode:'base',patch_ids:[]});assert.equal(playground.status,200);assert.equal((await playground.json()).base.content,'answer');assert.equal(seen[1].messages[0].content.length,100000);assert.deepEqual(seen[1].tools,body.tools);
 assert.deepEqual(await (await post('/api/chat',{mode:'patched',patch_ids:['p']})).json(),{legacy:true});
 const streamed=await post('/api/chat',{mode:'base',patch_ids:[],stream:true,messages:[{role:'user',content:'hi'}]});
 const frames=await streamed.text();assert.match(frames,/event: ainize.result/);assert.match(frames,/"content":"answer"/);assert.match(frames,/data: \[DONE\]/);
 available=false;
 assert.equal((await post('/v1/chat/completions',{model:'qwen',messages:[{role:'user',content:'hi'}]})).status,404);
 assert.equal((await post('/api/chat',{mode:'base',patch_ids:[],messages:[{role:'user',content:'hi'}]})).status,503);
 assert.equal(seen.length,3);
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});

/**
 * The peer path used to drop `thinking`, so the peer rendered the chat template with reasoning ON. On a long
 * prompt the reasoning channel ate the whole budget and `content` came back "" with finish_reason "length" —
 * AINA stored blank assistant messages. Both paths must mean the same thing by the flag.
 */
test('thinking reaches the peer as enable_thinking, and an explicit kwargs wins',async()=>{
 const peer='0x'+'3'.repeat(40),seen:any[]=[];
 const peers={target:()=>({model:'qwen',address:peer,endpoint:'http://peer'}),models:()=>[]};
 const app=express();app.use(express.json());
 app.use(preferredChatPlayground({routes:{qwen:peer},peers:()=>peers as any,
  fetch:async(_p:any,b:any)=>{seen.push(b);return Response.json({choices:[{message:{content:'a'},finish_reason:'stop'}]});}} as any));
 const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
 const base=`http://127.0.0.1:${(server.address() as any).port}`;
 const post=(b:any)=>fetch(base+'/api/chat',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)});
 const ask={mode:'base',patch_ids:[],messages:[{role:'user',content:'hi'}]};
 try{
  await post(ask);
  assert.deepEqual(seen[0].chat_template_kwargs,{enable_thinking:false},'the documented default must hold on the peer path');
  await post({...ask,thinking:false});
  assert.deepEqual(seen[1].chat_template_kwargs,{enable_thinking:false});
  await post({...ask,thinking:true});
  assert.deepEqual(seen[2].chat_template_kwargs,{enable_thinking:true},'asking for reasoning must still reach the peer');
  await post({...ask,thinking:false,chat_template_kwargs:{enable_thinking:true,extra:1}});
  assert.deepEqual(seen[3].chat_template_kwargs,{enable_thinking:true,extra:1},'an explicit kwargs outranks the flag');
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});
