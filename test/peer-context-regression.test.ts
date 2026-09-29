import {test} from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {openaiSurfaceRouter} from '../src/openai-surface.js';
test('remote long context and tool turns pass through while local limits remain',async()=>{
 const seen:any[]=[]; const app=express();app.use(express.json({limit:'25mb'}));
 app.use(openaiSurfaceRouter({node:'0x'+'1'.repeat(40),keys:{addressForKey:()=> 'caller'},registry:{backendForModel:()=>null},gates:new Map(),market:{},peerModels:{target:(_k:any,m:string)=>m==='remote'?{model:m,address:'peer',endpoint:'http://peer'}:null,relayChat:async(_t:any,b:any,res:any)=>{seen.push(b);res.json({ok:true});},models:()=>[]}} as any));
 const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
 const url=`http://127.0.0.1:${(server.address() as any).port}/v1/chat/completions`;
 const post=(b:any)=>fetch(url,{method:'POST',headers:{authorization:'Bearer test','content-type':'application/json'},body:JSON.stringify(b)});
 try{
 const body={model:'remote',max_tokens:220000, messages:[{role:'user',content:'x'.repeat(100000)},{role:'assistant',content:null,tool_calls:[{id:'a',type:'function',function:{name:'lookup',arguments:'{}'}}]},{role:'tool',tool_call_id:'a',content:'ok'}],tools:[{type:'function',function:{name:'lookup',parameters:{type:'object'}}}],chat_template_kwargs:{enable_thinking:false}};
 assert.equal((await post(body)).status,200);assert.deepEqual(seen[0],body);
 assert.equal((await post({...body,max_tokens:-1})).status,400);
 assert.equal((await post({...body,messages:[]})).status,400);
 assert.equal((await post({...body,model:'local'})).status,400);
 assert.equal((await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})).status,401);
 assert.equal(seen.length,1);
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});
