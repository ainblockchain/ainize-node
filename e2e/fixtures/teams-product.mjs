/** Operator image fixture: disposable loopback DB and apps for the Teams layout gate. */
import {spawn,spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,openSync,closeSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
const root=process.cwd(),temp=mkdtempSync(join(tmpdir(),'native-teams-e2e-'));
const pg='/usr/lib/postgresql/16/bin',children=[];
const env={PATH:process.env.PATH,HOME:tmpdir(),TMPDIR:tmpdir(),NEXT_TELEMETRY_DISABLED:'1',
 POSTGRES_URL:'postgresql://qa@127.0.0.1:5432/qa_layout',DATABASE_URL:'postgresql://qa@127.0.0.1:5432/qa_layout',
 JWT_SIGNING_KEY:randomBytes(48).toString('base64url'),CRON_SECRET:randomBytes(32).toString('base64url'),
 LLM_API_URL:'http://127.0.0.1:9',LLM_MODEL:'unused-test-model',BACKEND_URL:'http://127.0.0.1:4811',
 REALTIME_WS_URL:'ws://127.0.0.1:4811/realtime',NEXT_PUBLIC_APP_URL:'http://127.0.0.1:4810',
 PLAYWRIGHT_BASE_URL:'http://127.0.0.1:4810',PLAYWRIGHT_JSON_OUTPUT_FILE:join(temp,'report.json'),PLAYWRIGHT_BROWSERS_PATH:'/opt/qa-browsers'};
function run(argv,cwd=root){const r=spawnSync(argv[0],argv.slice(1),{cwd,env,stdio:'inherit',timeout:300000});if(r.status!==0)throw Error('Fixture command failed: '+argv[0]);}
function start(argv,cwd,port,name){const fd=openSync(join(temp,name+'.log'),'w',0o600);try{const p=spawn(argv[0],argv.slice(1),{cwd,env:{...env,PORT:String(port)},stdio:['ignore',fd,fd],detached:true});children.push(p);return p;}finally{closeSync(fd);}}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function ready(url,p){const deadline=Date.now()+180000;while(Date.now()<deadline){if(p.exitCode!==null||p.signalCode)throw Error('Fixture server exited');try{const r=await fetch(url,{signal:AbortSignal.timeout(2000)});if(r.ok)return;}catch{}await sleep(1000);}throw Error('Fixture readiness timeout');}
let pgStarted=false;
try{
 if(!root.startsWith('/tmp/')||process.getuid?.()===0)throw Error('Disposable non-root validation checkout required');
 run(['pnpm','--filter','@app/backend','build']);
 run([pg+'/initdb','-D',join(temp,'data'),'-U','qa','-A','trust','--no-locale','--encoding=UTF8']);
 run([pg+'/pg_ctl','-D',join(temp,'data'),'-l',join(temp,'postgres.log'),'-o',`-h 127.0.0.1 -p 5432 -k ${temp}`,'-w','start']);pgStarted=true;
 run([pg+'/createdb','-h','127.0.0.1','-U','qa','qa_layout']);
 run(['pnpm','exec','drizzle-kit','push','--force'],join(root,'backend'));
 const backend=start(['node','dist/main.js'],join(root,'backend'),4811,'backend');await ready('http://127.0.0.1:4811/health',backend);
 const web=start(['pnpm','exec','next','dev','--hostname','127.0.0.1','--port','4810'],join(root,'web'),4810,'web');await ready('http://127.0.0.1:4810',web);
 run(['pnpm','exec','playwright','test','e2e/layout-invariants.spec.ts','--workers=1','--retries=0','--reporter=json'],join(root,'web'));
 const report=JSON.parse(readFileSync(join(temp,'report.json'),'utf8')),s=report.stats;
 if(!s||s.expected<4||s.skipped||s.unexpected||s.flaky||report.errors?.length)throw Error('Layout tests must run without skips, failures or retries');
 console.log('QA_TEAMS_LAYOUT '+JSON.stringify(s));
}catch(error){
 for(const name of ['backend.log','web.log','postgres.log','report.json']){try{console.error(name+'\n'+readFileSync(join(temp,name),'utf8').slice(-16000));}catch{}}
 throw error;
}finally{
 for(const p of children.reverse()){if(p.exitCode===null&&!p.signalCode){try{process.kill(-p.pid,'SIGTERM');}catch{}await sleep(500);if(p.exitCode===null&&!p.signalCode){try{process.kill(-p.pid,'SIGKILL');}catch{}}}}
 if(pgStarted)spawnSync(pg+'/pg_ctl',['-D',join(temp,'data'),'-m','immediate','-w','stop'],{env,stdio:'ignore',timeout:10000});
 rmSync(temp,{recursive:true,force:true});
}
