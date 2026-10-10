/** Opt-in server Docker contract check; no product repo or live agent is modified. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {runQaValidation} from '../src/hosted-qa-validator.js';
const exec=promisify(execFile);
test('separate package dependencies and gate directories execute in real isolated Docker containers',{skip:!process.env.AINIZE_QA_MULTI_SCOPE_IMAGE,timeout:180000},async()=>{
 const baseImage=process.env.AINIZE_QA_MULTI_SCOPE_IMAGE!;assert.match(baseImage,/^sha256:[a-f0-9]{64}$/);
 const root=await mkdtemp(join(tmpdir(),'qa-multi-scope-')),checkout=join(root,'repo'),context=join(root,'image');
 const tag='ainize-qa-scope-'+randomUUID(),baseTag=tag+'-base';
 try{
  await mkdir(checkout);await mkdir(context);
  for(const [scope,index] of [['frontend',0],['backend',1]] as const){
   const pkg=JSON.stringify({name:scope,version:'1.0.0'});
   await mkdir(join(checkout,scope));await writeFile(join(checkout,scope,'package.json'),pkg);await writeFile(join(checkout,scope,'value.txt'),scope);
   const seed=join(context,'seed','fixture_'+scope);await mkdir(join(seed,'node_modules','fixture-marker'),{recursive:true});await writeFile(join(seed,'package.json'),pkg);await writeFile(join(seed,'node_modules','fixture-marker','index.js'),`module.exports=${JSON.stringify(scope)};`);
  }
  await exec('git',['init','-q',checkout]);await exec('git',['-C',checkout,'add','.']);await exec('git',['-C',checkout,'-c','user.name=QA test','-c','user.email=qa@example.invalid','commit','-qm','fixture']);
  const base=(await exec('git',['-C',checkout,'rev-parse','HEAD'])).stdout.trim();
  await exec('docker',['tag',baseImage,baseTag]);await writeFile(join(context,'Dockerfile'),`FROM ${baseTag}\nCOPY seed /seed\n`);
  await exec('docker',['build','--network','none','-t',tag,context],{timeout:60000,maxBuffer:1024*1024});
  const image=(await exec('docker',['image','inspect',tag,'--format','{{.Id}}'])).stdout.trim();
  const profile={repository:'test/multi',base,checkout,image,dependencyPath:'/seed/fixture_frontend',cwd:'frontend',dependencies:[{cwd:'frontend',dependencyPath:'/seed/fixture_frontend'},{cwd:'backend',dependencyPath:'/seed/fixture_backend'}],gates:['frontend','backend'].map(scope=>({name:scope,cwd:scope,argv:['node','-e',`const a=require('assert/strict'),f=require('fs');a.equal(require('fixture-marker'),'${scope}');a.equal(f.readFileSync('../frontend/value.txt','utf8'),'fixed');a.equal(f.readFileSync('../backend/value.txt','utf8'),'backend');`]})),memory:'1g',timeoutMs:30000};
  const result=await runQaValidation(profile,{repository:profile.repository,base,changes:{'frontend/value.txt':'fixed'}});
  assert.equal(result.passed,true,JSON.stringify(result));assert.deepEqual(result.gates.map(g=>g.gate),['frontend','backend']);
 }finally{
  await exec('docker',['image','rm',tag,baseTag]).catch(()=>{});await rm(root,{recursive:true,force:true});
 }
});
