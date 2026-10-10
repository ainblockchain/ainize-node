import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateQaProfile } from '../src/hosted-qa-validator.js';
const profile={repository:'test/product',base:'a'.repeat(40),checkout:'/repo',image:'sha256:'+'b'.repeat(64),dependencyPath:'/seed/0',cwd:'.',gates:[{name:'test',argv:['yarn','test']}]};
const candidate={repository:profile.repository,base:profile.base,changes:{'sum.js':'a+b'}};
test('product validation requires immutable bindings and confines all paths',()=>{
 assert.doesNotThrow(()=>validateQaProfile(profile,candidate));
 assert.throws(()=>validateQaProfile({...profile,image:'latest'},candidate),/Immutable/);
 assert.throws(()=>validateQaProfile(profile,{...candidate,base:'c'.repeat(40)}),/binding/);
 for(const path of ['../escape','/root/x','a/../../x','a\\b','node_modules/x','.git/config','.env','.env.local']) assert.throws(()=>validateQaProfile(profile,{...candidate,changes:{[path]:'x'}}),/changes/);
 assert.throws(()=>validateQaProfile({...profile,dependencyPath:'/var/run/docker.sock'},candidate),/path/);
 assert.throws(()=>validateQaProfile({...profile,cwd:'../outside'},candidate),/path/);
 assert.throws(()=>validateQaProfile({...profile,timeoutMs:Infinity},candidate),/timeout/);
});
