import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {HostedQaPublisher,qaGitHubClient,type QaGitHub} from '../src/hosted-qa-publication.js';
const base='a'.repeat(40),baseTree='b'.repeat(40),newTree='c'.repeat(40);
const candidate={repository:'test/product',base,changes:{'run.sh':'echo fixed\n','new.txt':'한글'}};
const hash=(s:string)=>createHash('sha1').update(s).digest('hex');
function remote(){
 const state={refs:new Map<string,string>(),prs:[] as any[],writes:[] as any[],lostRef:false,lostPr:false,corrupt:false,stale:false,commit:''};
 let entries:any[]=[];
 const github:QaGitHub=async(method,path,body:any)=>{
  if(method==='POST')state.writes.push({path,body});
  if(path.includes('/git/ref/heads/')){const branch=decodeURIComponent(path.split('/heads/')[1]);return branch==='main'?{object:{sha:state.stale?'d'.repeat(40):base}}:state.refs.has(branch)?{object:{sha:state.refs.get(branch)}}:null;}
  if(path.endsWith('/git/commits/'+base))return {sha:base,tree:{sha:baseTree},committer:{date:'2026-10-10T00:00:00Z'}};
  if(path.includes('/git/trees/')&&method==='GET')return {truncated:false,tree:path.includes(baseTree)?[{path:'run.sh',mode:'100755',type:'blob',sha:'e'.repeat(40)}]:state.corrupt?[]:entries};
  if(path.endsWith('/git/trees')){entries=body.tree.map((e:any)=>({path:e.path,mode:e.mode,type:e.type,sha:hash(`blob ${Buffer.byteLength(e.content)}\0${e.content}`)}));return {sha:newTree};}
  if(path.endsWith('/git/commits')){state.commit=hash(JSON.stringify(body));return {sha:state.commit,tree:{sha:body.tree},parents:body.parents.map((sha:string)=>({sha}))};}
  if(path.endsWith('/git/refs')){state.refs.set(body.ref.slice(11),body.sha);if(state.lostRef){state.lostRef=false;throw Error('lost ref response');}return {};}
  if(path.includes('/pulls?'))return state.prs;
  if(path.endsWith('/pulls')){assert.equal(body.draft,true);state.prs.push({number:7,state:'open',head:{sha:state.commit,ref:body.head,repo:{full_name:'test/product'}},base:{ref:body.base,repo:{full_name:'test/product'}}});if(state.lostPr){state.lostPr=false;throw Error('lost PR response');}return state.prs[0];}
  throw Error('Unexpected request '+path);
 };
 const publisher=()=>new HostedQaPublisher({agent:{repository:'test/product',branch:'main'}},{requirePassed:()=>({} as any)},github);
 return {state,publisher};
}
test('publication preserves modes and reuses the same commit, branch and PR after response loss and host restart',async()=>{
 const {state,publisher}=remote();state.lostRef=true;state.lostPr=true;
 const first=await publisher().publish('agent','job-1',candidate);
 const again=await publisher().publish('agent','job-1',candidate);
 assert.deepEqual(again,first);assert.equal(state.refs.size,1);assert.equal(state.prs.length,1);
 assert.equal(state.writes.filter(w=>w.path.endsWith('/git/refs')).length,1);
 assert.equal(state.writes.filter(w=>w.path.endsWith('/pulls')).length,1);
 assert.equal(state.writes.find(w=>w.path.endsWith('/git/trees')).body.tree.find((e:any)=>e.path==='run.sh').mode,'100755');
 assert.equal(first.url,'https://github.com/test/product/pull/7');
 assert.ok(state.writes.every(w=>!w.path.includes('/merge')));
});
test('rejects stale base, mismatched tree, changed candidate branch and closed PR',async()=>{
 const stale=remote();stale.state.stale=true;await assert.rejects(stale.publisher().publish('agent','job',candidate),/Base changed/);assert.equal(stale.state.writes.length,0);
 const corrupt=remote();corrupt.state.corrupt=true;await assert.rejects(corrupt.publisher().publish('agent','job',candidate),/differs/);assert.equal(corrupt.state.refs.size,0);
 const changed=remote();const result=await changed.publisher().publish('agent','job',candidate);changed.state.refs.set(result.branch,'f'.repeat(40));await assert.rejects(changed.publisher().publish('agent','job',candidate),/refusing overwrite/);
 const closed=remote();await closed.publisher().publish('agent','job',candidate);closed.state.prs[0].state='closed';await assert.rejects(closed.publisher().publish('agent','job',candidate),/binding changed/);assert.equal(closed.state.prs.length,1);
});
test('missing host evidence and unconfigured agents cannot make GitHub writes',async()=>{
 let calls=0;const publisher=new HostedQaPublisher({agent:{repository:'test/product',branch:'main'}},{requirePassed:()=>{throw Error('no passing host validation');}},async()=>{calls++;});
 assert.throws(()=>publisher.publish('agent','job',candidate),/no passing/);
 await assert.rejects(publisher.publish('other','job',candidate),/not configured/);assert.equal(calls,0);
});
test('GitHub transport refuses redirects and does not expose response secrets',async()=>{
 const client=qaGitHubClient('private',async(url,init)=>{assert.equal(url,'https://api.github.com/repos/test/product/pulls');assert.equal(init?.redirect,'error');return new Response('secret diagnostic',{status:403});});
 await assert.rejects(client('POST','/repos/test/product/pulls',{}),error=>String(error)==='Error: QA GitHub request failed (403)');
});
