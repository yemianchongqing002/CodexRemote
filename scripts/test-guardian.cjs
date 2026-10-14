// Runs an already built Windows service with isolated data and a loopback listener.
// It never compiles or contacts a Codex desktop.
const fs=require('node:fs'),path=require('node:path'),net=require('node:net'),crypto=require('node:crypto');
const {spawn,spawnSync,execFileSync}=require('node:child_process');
const assert=require('node:assert/strict');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const exe=path.resolve(process.argv[2]||'dist/server-windows-x64/codex-remote.exe');
const dir=fs.mkdtempSync(path.resolve('.local')+path.sep+'guardian-test-');
const home=path.join(dir,'home');fs.mkdirSync(home);
const configPath=path.join(dir,'token.supervisor.json');
const token=crypto.randomBytes(24).toString('hex');fs.writeFileSync(path.join(dir,'token'),token,{mode:0o600});
function alive(pid){try{process.kill(pid,0);return true;}catch{return false;}}
function killOwned(pid){
 execFileSync('powershell.exe',['-NoProfile','-Command',
  '$p=Get-CimInstance Win32_Process -Filter "ProcessId = $env:GUARDIAN_TEST_PID"; if ($p) { if ($p.ExecutablePath -ne $env:GUARDIAN_TEST_EXE) { throw "Unexpected executable" }; Stop-Process -Id $p.ProcessId -Force }'],
 {windowsHide:true,env:{...process.env,GUARDIAN_TEST_PID:String(pid),GUARDIAN_TEST_EXE:exe},stdio:'pipe'});
}
async function until(fn,ms=220000){const end=Date.now()+ms;let last;while(Date.now()<end){try{const result=await fn();if(result)return result;}catch(e){last=e;}await delay(1000);}throw last||Error('Timed out');}
function stopPair(){execFileSync(exe,['--guardian-action=stop','--guardian-config='+configPath],{windowsHide:true,stdio:'pipe',timeout:190000});}
(async()=>{
 const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const port=s.address().port;s.close(()=>resolve(port));});});
 const base=`http://127.0.0.1:${port}`;
 const log=fs.openSync(path.join(dir,'server.log'),'w');
 const parent=spawn(exe,['--tls=false','--require-token','--supervise=true','--read-only','--listen',`127.0.0.1:${port}`,'--codex-home',home,'--token-file',path.join(dir,'token')],{windowsHide:true,stdio:['ignore',log,log]});
 let cookie='',child=0;
 const request=(route,method='GET',body)=>fetch(base+route,{method,headers:{Cookie:cookie,'Content-Type':'application/json'},body,signal:AbortSignal.timeout(4000)});
 const status=async()=>{const r=await request('/api/guardian/status');assert.equal(r.status,200);return r.json();};
 const ready=async(previous=0,previousB=0)=>until(async()=>{const s=await status();return s.phase==='running'&&s.pid!==previous&&s.guardianPid!==previousB?s:false;});
 try{
  await until(async()=>{const r=await request('/');return r.status===200;});
  assert.equal((await request('/api/guardian/restart','POST')).status,401);
  const login=await request('/api/login','POST',JSON.stringify({token}));assert.equal(login.status,200);cookie=login.headers.get('set-cookie').split(';')[0];
  const first=await ready();child=first.pid;assert.equal(first.guardianPid,parent.pid);
  const config=JSON.parse(fs.readFileSync(configPath,'utf8'));
  assert.equal(config.service.listen,`127.0.0.1:${port}`);assert(!('args' in config));
  assert.equal((await request('/api/status')).status,200);
  assert.equal((await request('/internal/guardian/stop','POST')).status,404);
  assert.equal((await request('/api/guardian/restart','POST')).status,202);
  const second=await ready(child);assert(alive(parent.pid));assert(!alive(child));child=second.pid;
  console.log('PASS: authenticated restart replaces only the service child');
  config.service.name='Reloaded from file';
  fs.writeFileSync(configPath+'.tmp',JSON.stringify(config),{mode:0o600});fs.renameSync(configPath+'.tmp',configPath);
  killOwned(parent.pid);
  const third=await ready(child,parent.pid);assert(!alive(child));child=third.pid;
  assert.equal((await (await request('/api/status')).json()).connectionName,'Reloaded from file');
  console.log('PASS: A revives B; every new B replaces A and reloads the config');
  killOwned(child);
  child=(await ready(child)).pid;
  console.log('PASS: B recovers A after consecutive health failures');
  const beforeRepair=await ready();
  killOwned(beforeRepair.guardianPid);killOwned(child);
  await until(()=>!alive(beforeRepair.guardianPid)&&!alive(child),10000);
  assert.equal(spawnSync(exe,['--guardian-action=check','--guardian-config='+configPath],{windowsHide:true,timeout:20000}).status,1);
  execFileSync(exe,['--guardian-action=repair','--guardian-config='+configPath],{windowsHide:true,stdio:'pipe',timeout:190000});
  const repaired=await ready(child,beforeRepair.guardianPid);child=repaired.pid;
  console.log('PASS: external repair starts B after both roles exit');
  stopPair();await until(()=>!alive(child)&&!alive(repaired.guardianPid),10000);
  await delay(35000);
  assert(!alive(child)&&!alive(repaired.guardianPid));
  for(const action of ['check','repair']) {
   assert.equal(spawnSync(exe,['--guardian-action='+action,'--guardian-config='+configPath],{windowsHide:true,timeout:20000}).status,2);
  }
  assert.equal(JSON.parse(fs.readFileSync(configPath+'.run/session.json','utf8')).running,false);
  console.log('PASS: explicit stop does not revive either role');
 }finally{
  if(fs.existsSync(configPath+'.run/session.json')) {
   try{stopPair();}catch{
    const file=configPath+'.run/session.json',s=JSON.parse(fs.readFileSync(file,'utf8'));s.running=false;fs.writeFileSync(file,JSON.stringify(s),{mode:0o600});
    for(const role of ['A','B']){const record=configPath+'.run/'+role+'.json';if(fs.existsSync(record)){const {pid}=JSON.parse(fs.readFileSync(record,'utf8'));if(alive(pid))killOwned(pid);}}
   }
  }
  if(parent.pid&&alive(parent.pid))killOwned(parent.pid);
  fs.closeSync(log);
 }
})().catch(e=>{console.error(e);process.exitCode=1;});
