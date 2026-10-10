/** Host-side product checks. Never mount the Docker socket or release credentials into agent/code containers. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, lstat, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
const exec = promisify(execFile);
// Bump when execution semantics change so old receipts cannot authorize a new validator policy.
export const QA_VALIDATOR_VERSION = '3-multiple-dependency-scopes';
export interface QaValidationProfile {
  repository: string; base: string; checkout: string; image: string;
  dependencyPath: string; cwd: string; dependencies?:{cwd:string;dependencyPath:string}[]; gates: { name: string; argv: string[]; cwd?:string }[];
  timeoutMs?: number; memory?: string; workspaceMiB?: number;
}
export interface QaCandidate { repository: string; base: string; changes: Record<string, string> }
const canonical = (value: unknown): unknown => value && typeof value === 'object'
  ? Array.isArray(value) ? value.map(canonical) : Object.fromEntries(Object.entries(value).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0).map(([k,v]) => [k,canonical(v)])) : value;
const pathSafe = (path: string) => !!path && path.length <= 500 && !/[\\\x00-\x1f]/.test(path)
  && path.split('/').every(p => p && p !== '.' && p !== '..' && p !== '.git' && p !== 'node_modules');
export function qaCandidateDigest(candidate: QaCandidate) {
  return createHash('sha256').update(JSON.stringify(canonical(candidate))).digest('hex');
}
export function validateQaProfile(profile: QaValidationProfile, candidate: QaCandidate) {
  if(!candidate||typeof candidate!=='object'||Array.isArray(candidate)||Object.keys(candidate).sort().join(',')!=='base,changes,repository'
    ||!candidate.changes||typeof candidate.changes!=='object'||Array.isArray(candidate.changes))throw new Error('Invalid candidate shape');
  if (!/^[\w.-]+\/[\w.-]+$/.test(profile.repository) || !/^[a-f0-9]{40}$/.test(profile.base)
    || candidate.repository !== profile.repository || candidate.base !== profile.base) throw new Error('Candidate/profile binding mismatch');
  if (!/^sha256:[a-f0-9]{64}$/.test(profile.image)) throw new Error('Immutable validation image required');
  if (!/^\/seed(?:\/[a-zA-Z0-9_-]+)*$/.test(profile.dependencyPath) || (profile.cwd !== '.' && !pathSafe(profile.cwd))) throw new Error('Invalid validation path');
  const scopes=profile.dependencies??[{cwd:profile.cwd,dependencyPath:profile.dependencyPath}];
  if(!Array.isArray(scopes)||!scopes.length||scopes.length>16||new Set(scopes.map(s=>s?.cwd)).size!==scopes.length||scopes.some(s=>!s||(s.cwd!=='.'&&!pathSafe(s.cwd))||!/^\/seed(?:\/[a-zA-Z0-9_-]+)*$/.test(s.dependencyPath))||!scopes.some(s=>s.cwd===profile.cwd&&s.dependencyPath===profile.dependencyPath))throw new Error('Invalid dependency scopes');
  if(profile.gates.some(g=>g.cwd!==undefined&&!scopes.some(s=>s.cwd===g.cwd)))throw new Error('Gate working directory is outside dependency scopes');
  if (!profile.gates.length || profile.gates.length > 16 || new Set(profile.gates.map(g => g.name)).size !== profile.gates.length
    || profile.gates.some(g => !/^[a-z][a-z0-9_-]{0,31}$/.test(g.name) || !g.argv.length || g.argv.some(a => typeof a !== 'string' || a.includes('\0')))) throw new Error('Invalid product gates');
  const entries = Object.entries(candidate.changes);
  if (!entries.length || entries.length > 40 || entries.some(([p,c]) => !pathSafe(p) || p.split('/').some(part => /^\.env(?:\.|$)/.test(part)) || typeof c !== 'string' || c.includes('\0') || Buffer.byteLength(c) > 1024*1024)
    || Buffer.byteLength(JSON.stringify(candidate.changes)) > 2*1024*1024) throw new Error('Invalid candidate changes');
  if (profile.timeoutMs !== undefined && (!Number.isSafeInteger(profile.timeoutMs) || profile.timeoutMs < 1000 || profile.timeoutMs > 1800000)) throw new Error('Invalid validation timeout');
  if (profile.memory !== undefined && !/^[1-8]g$/.test(profile.memory)) throw new Error('Invalid memory limit');
  if(profile.workspaceMiB!==undefined&&(!Number.isSafeInteger(profile.workspaceMiB)||profile.workspaceMiB<512||profile.workspaceMiB>Number.parseInt(profile.memory??'4g')*1024))throw new Error('Invalid workspace size');
}
async function rejectLinks(root: string) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if ((await lstat(path)).isSymbolicLink()) throw new Error('Snapshot symlinks require explicit support');
    if (entry.isDirectory()) await rejectLinks(path);
  }
}
const bootstrap = `
const fs=require('node:fs'),cp=require('node:child_process');
const p=JSON.parse(fs.readFileSync('/input/profile.json','utf8'));
fs.mkdirSync('/tmp/work',{recursive:true});
fs.cpSync('/input/source','/tmp/work',{recursive:true});
for(const scope of p.dependencies){
const project='/tmp/work/'+scope.cwd;
if(!fs.existsSync(project+'/package.json'))throw new Error('Dependency scope has no package manifest');
for(const file of ['package.json','yarn.lock','package-lock.json','pnpm-lock.yaml']) {
 const source=project+'/'+file,seed=scope.dependencyPath+'/'+file;
 if(fs.existsSync(source) && (!fs.existsSync(seed)||!fs.readFileSync(source).equals(fs.readFileSync(seed)))) {
  console.error('Dependency snapshot mismatch: '+file);process.exit(1);
 }
}
// Keep package paths inside the disposable checkout: TypeScript declaration inference follows realpaths.
// Preserve relative .bin links so compilers resolve the copied dependency tree.
fs.cpSync(scope.dependencyPath+'/node_modules',project+'/node_modules',{recursive:true,verbatimSymlinks:true});
}
const r=cp.spawnSync(p.argv[0],p.argv.slice(1),{cwd:'/tmp/work/'+p.cwd,stdio:'inherit',env:{PATH:'/usr/local/bin:/usr/bin:/bin',HOME:'/tmp',TMPDIR:'/tmp',CI:'1',NEXT_TELEMETRY_DISABLED:'1'}});
if(r.status!==0){
 let memoryEvents=null;try{memoryEvents=fs.readFileSync('/sys/fs/cgroup/memory.events','utf8');}catch{}
 console.error('QA_RESOURCE_EVIDENCE '+JSON.stringify({status:r.status,signal:r.signal,memoryEvents}));
}
process.exit(r.status===null?1:r.status);
`;
export interface QaGateEvidence {passed:boolean;stdout:string;stderr:string}
export async function runQaValidation(profile: QaValidationProfile, candidate: QaCandidate,
  evidence?:(gate:string,output:QaGateEvidence)=>void|Promise<void>) {
  // Freeze the exact input before any asynchronous checkout/container operation.
  profile = structuredClone(profile); candidate = structuredClone(candidate);
  validateQaProfile(profile, candidate);
  const candidateDigest = qaCandidateDigest(candidate);
  const uid = process.getuid?.() ?? 1000, gid = process.getgid?.() ?? 1000;
  if (uid === 0) throw new Error('Run validation host under a non-root account');
  const dir = await mkdtemp(join(tmpdir(), 'ainize-qa-validation-'));
  const source = join(dir,'source'); const results = [];
  try {
    const resolved = (await exec('git',['-C',profile.checkout,'rev-parse',`${profile.base}^{commit}`],{timeout:10000})).stdout.trim();
    if (resolved !== profile.base) throw new Error('Base commit resolution mismatch');
    const tree = (await exec('git',['-C',profile.checkout,'ls-tree','-r','-z',profile.base],{timeout:10000,maxBuffer:16*1024*1024})).stdout;
    for (const entry of tree.split('\0').filter(Boolean)) {
      const split=entry.indexOf('\t');
      if (split<0 || !/^100(644|755) blob /.test(entry) || !pathSafe(entry.slice(split+1))) throw new Error('Unsupported Git snapshot entry');
    }
    const archive = await exec('git',['-C',profile.checkout,'archive','--format=tar',profile.base],{encoding:'buffer',timeout:30000,maxBuffer:200*1024*1024});
    await writeFile(join(dir,'source.tar'),archive.stdout); await mkdir(source);
    await exec('tar',['-xf',join(dir,'source.tar'),'-C',source],{timeout:30000});
    await rejectLinks(source);
    for (const [path, content] of Object.entries(candidate.changes)) {
      const pieces=path.split('/');pieces.pop();if(pieces.length)await mkdir(join(source,...pieces),{recursive:true});
      await writeFile(join(source,path),content);
    }
    for (const gate of profile.gates) {
      await writeFile(join(dir,'profile.json'),JSON.stringify({dependencies:profile.dependencies??[{cwd:profile.cwd,dependencyPath:profile.dependencyPath}],cwd:gate.cwd??profile.cwd,argv:gate.argv}));
      // Only non-secret exported Git source and fixed gate config are visible in the mount.
      const name=`ainize-qa-validation-${randomUUID()}`;
      let passed=false, stdout='',stderr='';
      try {
        const output=await exec('docker',['run','--rm','--name',name,'--network','none','--read-only','--user',`${uid}:${gid}`,
          '--cap-drop','ALL','--security-opt','no-new-privileges','--memory',profile.memory??'4g','--cpus','2','--pids-limit','256',
          '--tmpfs',`/tmp:rw,exec,nosuid,nodev,size=${(profile.workspaceMiB??2048)*1024*1024}`,'--mount',`type=bind,src=${dir},dst=/input,readonly`,
          '--entrypoint','node',profile.image,'-e',bootstrap],{timeout:profile.timeoutMs??300000,maxBuffer:4*1024*1024});
        // Retain bounded private evidence on success too: an exit code alone cannot show skipped tests.
        stdout=output.stdout;stderr=output.stderr;
        passed=true;
      } catch (error) {
        // Private validation evidence only. Callers must not copy arbitrary product logs to public cards.
        const failure=error as {stdout?:string;stderr?:string};
        stdout=failure.stdout??'';stderr=failure.stderr??'';
      }
      finally { await exec('docker',['rm','-f',name],{timeout:15000}).catch(()=>{}); }
      await evidence?.(gate.name,{passed,stdout,stderr});
      // Reserve room for both streams so a long error stack cannot hide the test summary.
      const diagnostics=`[stdout]\n${stdout.slice(-5900)}\n[stderr]\n${stderr.slice(-5900)}`;
      results.push({gate:gate.name,passed,summary:passed?'Product gate passed':'Product gate failed or timed out',diagnostics});
      if(!passed)break;
    }
    return {repository:candidate.repository,base:candidate.base,candidateDigest,gates:results,passed:results.length===profile.gates.length&&results.every(r=>r.passed)};
  } finally {await rm(dir,{recursive:true,force:true});}
}
