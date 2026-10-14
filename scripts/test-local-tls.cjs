// End-to-end check against the real Go server. Build it first; no user services/configuration are touched.
const {spawn}=require('node:child_process'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net'),assert=require('node:assert/strict');
const {Trust}=require('../client/web/trust.cjs');
const binary=path.resolve(process.argv[2]||'.local/codex-remote-tls');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'codex-tls-integration-'));let child,supervisedConfig;
const exec=require('node:util').promisify(require('node:child_process').execFile);
const dial=(host,port)=>net.createConnection({host,port});let trust=new Trust(dial,path.join(temp,'client'));
async function start(name,port=0,supervise=false){
 const dir=path.join(temp,name);fs.mkdirSync(dir,{recursive:true});fs.mkdirSync(path.join(dir,'codex'),{recursive:true});
 supervisedConfig=supervise?path.join(dir,'token.supervisor.json'):null;
 child=spawn(binary,[...(supervise?['--supervise']:[]),'--listen',`127.0.0.1:${port}`,'--read-only','--codex-home',path.join(dir,'codex'),'--token-file',path.join(dir,'token')],{stdio:['ignore','pipe','pipe']});
 return await new Promise((resolve,reject)=>{let output='';const timer=setTimeout(()=>reject(Error('Server startup timed out: '+output)),10000);child.once('exit',c=>{clearTimeout(timer);reject(Error('Server exited '+c+': '+output));});for(const stream of [child.stdout,child.stderr])stream.on('data',b=>{output+=b;const m=output.match(/已启动：(https:\/\/127\.0\.0\.1:\d+)/);if(m){clearTimeout(timer);resolve(m[1]);}});});
}
async function stop(){if(supervisedConfig){await exec(binary,['--guardian-action=stop','--guardian-config',supervisedConfig],{timeout:20000});supervisedConfig=null;}if(child&&child.exitCode===null){const p=child;const done=new Promise(r=>p.once('exit',r));p.kill('SIGTERM');await done;}child=null;}
(async()=>{try{
 let address=await start('one');const port=Number(new URL(address).port);
 const get=()=>trust.fetch(address+'/api/version',{redirect:'manual'});
 assert.equal((await(await get()).json()).adapter,'desktop-rollout');const pin=trust.read(address);assert(pin);
 await trust.close();await stop();address=await start('one',port);
 assert.equal((await get()).status,200);assert.equal(trust.read(address),pin,'renewal keeps key');
 await trust.close();await stop();address=await start('two',port);
 await assert.rejects(get,e=>String(e.cause?.message||e.message).includes('TLS_IDENTITY_CHANGED'));
 assert.equal(trust.read(address),pin);
 await trust.reset(address,pin);assert.equal((await get()).status,200);assert.notEqual(trust.read(address),pin);
 const newPin=trust.read(address);await trust.close();trust=new Trust(dial,path.join(temp,'client'));assert.equal((await get()).status,200);assert.equal(trust.read(address),newPin);
 await trust.close();await stop();
 const freePort=await new Promise(r=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const p=server.address().port;server.close(()=>r(p));});});
 address=await start('supervised',freePort,true);assert.equal((await get()).status,200);
 await exec(binary,['--guardian-action=check','--guardian-config',supervisedConfig],{timeout:10000});
 console.log('PASS: real Go HTTPS, first trust, persistent trust, certificate renewal, changed-key rejection explicit reset and HTTPS guardian health');
}finally{await trust.close();await stop();fs.rmSync(temp,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1;});
