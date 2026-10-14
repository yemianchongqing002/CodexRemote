// Remote service startup accepts credentials and a target, never caller-supplied commands.
const {Client}=require('ssh2'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {createKeyStore,authorizationScript}=require('./ssh-keys.cjs');
const managedKeys=createKeyStore();
const root=path.resolve(__dirname,'../src-tauri');
const powershell=s=>'powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand '+Buffer.from(s,'utf16le').toString('base64');
function targetConfig(t={}){
 const raw=String(t.target||'');
 if(!/^[a-zA-Z0-9._@:\[\]-]{1,200}$/.test(raw)||raw.startsWith('-')||raw.split('@').length!==2)throw Error('请填写目标电脑地址和 SSH 用户名');
 const [username,rawHost]=raw.split('@'),host=rawHost.replace(/^\[|\]$/g,'');
 if(!username||!host||host.startsWith('-'))throw Error('目标电脑地址无效');
 const port=t.port??22;
 if(!Number.isInteger(port)||port<1||port>65535)throw Error('SSH 端口无效');
 if(!['password','key','tailscale'].includes(t.mode))throw Error('未知 SSH 登录方式');
 const url=new URL(t.address||`https://${host.includes(':')?'['+host+']':host}:8787`);
 if(!['http:','https:'].includes(url.protocol)||url.hostname.replace(/^\[|\]$/g,'').toLowerCase()!==host.toLowerCase()||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw Error('连接目标必须与所选电脑地址一致');
 if(t.mode==='password'&&(!t.password||typeof t.password!=='string'))throw Error('请输入 SSH 登录密码');
 if(t.mode==='tailscale'&&(!/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host)&&!host.startsWith('fd7a:115c:a1e0:')))throw Error('Tailscale SSH 请填写目标的 Tailscale IP');
 if(t.mode==='tailscale'&&port!==22)throw Error('Tailscale SSH 使用端口 22');
 return {host,username,port,mode:t.mode,address:url.origin,servicePort:url.port||(url.protocol==='https:'?'443':'80'),password:t.password,trustedFingerprint:t.trustedFingerprint||''};
}
function remote(client,command,input='',timeout=25000){return new Promise((resolve,reject)=>{
 let channel,output='',errors='',bytes=0,done=false;
 const finish=(err,result)=>{if(done)return;done=true;clearTimeout(timer);if(err)channel?.close();err?reject(err):resolve(result);};
 const timer=setTimeout(()=>finish(Error('SSH 操作超时，结果未确认，请核对目标电脑')),timeout);
 client.exec(command,(err,stream)=>{
  if(err)return finish(err);channel=stream;if(done){stream.close();return;}
  const collect=(b,stderr=false)=>{bytes+=b.length;if(stderr)errors+=b.toString();else output+=b.toString();if(bytes>65536)finish(Error('SSH 输出超出限制'));};
  stream.on('data',b=>collect(b));stream.stderr.on('data',b=>collect(b,true));stream.on('error',e=>finish(e));
  stream.on('close',code=>finish(code===0?null:Error('目标电脑操作失败：'+(output+'\n'+errors).slice(-3000)),output));stream.end(input);
 });
});}
function connect(t,known,sock){return new Promise((resolve,reject)=>{
 const client=new Client();let trustError;
 const key=t.host+':'+t.port;
 const config={sock,host:t.host,port:t.port,username:t.username,readyTimeout:20000,keepaliveInterval:10000,keepaliveCountMax:2,
  hostVerifier:bytes=>{const fp='SHA256:'+crypto.createHash('sha256').update(bytes).digest('base64').replace(/=+$/,'');
   if(known.has(key)&&known.get(key)!==fp){trustError=Error('SSH 主机身份已变化，未发送登录凭据');return false;}
   if(!known.has(key)&&t.trustedFingerprint!==fp){trustError=Error('SSH_TRUST:'+fp);return false;}
   known.set(key,fp);return true;
  }};
 if(t.mode==='password'){config.password=t.password;config.authHandler=['password'];}
 else if(t.mode==='tailscale')config.authHandler=['none'];
 else{
  const methods=[];
  const managed=t.managedKeyPath||managedKeys.file(t);
  if(fs.existsSync(managed))methods.push({type:'publickey',username:t.username,key:fs.readFileSync(managed)});
  if(!t.managedKeyOnly&&process.env.SSH_AUTH_SOCK)methods.push({type:'agent',username:t.username,agent:process.env.SSH_AUTH_SOCK});
  for(const name of (t.managedKeyOnly?[]:['id_ed25519','id_rsa'])){const file=path.join(os.homedir(),'.ssh',name);if(fs.existsSync(file))methods.push({type:'publickey',username:t.username,key:fs.readFileSync(file)});}
  config.authHandler=methods;
 }
 client.on('error',e=>{reject(trustError||Error('SSH 连接失败：'+e.message));client.end();});
 client.once('ready',()=>resolve(client));client.connect(config);
});}
function createDeployment({bundleRoot=root,keyStore=managedKeys,connectSSH=connect,run=remote,check=async address=>['ready','auth'].includes((await require('./service-probe.cjs').serviceProbe(address)).state)}={}){
 const plans=new Map(),known=new Map();let busy=false;
 function dispose(p){clearTimeout(p.timer);p.client.end();}
 return {
  async setupKey(input){
   if(busy)throw Error('已有 SSH 操作正在进行');busy=true;let client,verified;
   try{
    const t=targetConfig({...input,mode:'password'});
    client=await connectSSH(t,known);t.password=undefined;
    let output;try{output=await run(client,'uname -s && uname -m');}catch{}
    let platform='darwin';
    if(!/^Darwin\s+(arm64|x86_64)\s*$/.test(output||'')){
     output=await run(client,powershell('Write-Output Windows'));
     if(output.trim()!=='Windows')throw Error('密钥配置仅支持 macOS 和 Windows');platform='windows';
    }
    const key=keyStore.ensure(t),script=authorizationScript(platform,key.publicKey);
    await run(client,platform==='darwin'?'/bin/sh -s':powershell('[Console]::InputEncoding = [System.Text.UTF8Encoding]::new(); & ([ScriptBlock]::Create([Console]::In.ReadToEnd()))'),script);
    verified=await connectSSH({...t,mode:'key',managedKeyOnly:true,managedKeyPath:key.path},known);
    const confirmation=await run(verified,platform==='darwin'?'printf CODEX_REMOTE_KEY_OK':powershell('Write-Output CODEX_REMOTE_KEY_OK'));
    if(confirmation.trim()!=='CODEX_REMOTE_KEY_OK')throw Error('密钥登录后的命令验证失败');
    return keyStore.mark(t,key);
   }finally{client?.end();verified?.end();busy=false;}
  },
  async probe(input){
   if(busy)throw Error('已有 SSH 操作正在进行');busy=true;let client;
   try{
    const t=targetConfig(input);client=await connectSSH(t,known);t.password=undefined;
    let output;try{output=await run(client,'uname -s && uname -m');}catch{}
    if(!/^Darwin\s+(arm64|x86_64)\s*$/.test(output||''))output=await run(client,powershell('Write-Output Windows; Write-Output $env:PROCESSOR_ARCHITECTURE'));
    const match=/^(Darwin|Windows)\s+(arm64|x86_64|ARM64|AMD64)\s*$/.exec(output.trim());
    if(!match)throw Error('远程启动仅支持 macOS/Windows 的 x64 和 ARM64');
    const platform=match[1]==='Darwin'?'darwin':'windows',arch=/arm64/i.test(match[2])?'arm64':'amd64';
    const id=crypto.randomUUID();
    for(const p of plans.values())dispose(p);plans.clear();
    const p={client,t,platform,arch};p.timer=setTimeout(()=>{plans.delete(id);dispose(p);},600000);p.timer.unref();plans.set(id,p);client=null;
    return {id,target:input.target,platform,arch,address:t.address};
   }finally{client?.end();busy=false;}
  },
  async start(id){
   if(busy)throw Error('已有 SSH 操作正在进行');const p=plans.get(id);if(!p)throw Error('连接检查已失效，请重新连接');plans.delete(id);clearTimeout(p.timer);busy=true;
   try{
    const script=fs.readFileSync(path.join(bundleRoot,'src',p.platform==='windows'?'start-windows.ps1':'start-macos.sh'),'utf8').replaceAll('__PORT__',p.t.servicePort);
    const command=p.platform==='windows'?powershell('[Console]::InputEncoding = [System.Text.UTF8Encoding]::new(); & ([ScriptBlock]::Create([Console]::In.ReadToEnd()))'):'/bin/sh -s';
    const output=await run(p.client,command,script,45000);
    if(!output.split(/\r?\n/).some(l=>l.trim()==='CODEX_REMOTE_READY'))throw Error('启动未确认，请检查目标电脑客户端');
    const reachable=await check(p.t.address);
    return {address:p.t.address,reachable,detail:reachable?'已连接目标电脑上的服务':'目标服务已启动，但网页服务无法直连，请检查目标端口和防火墙'};
   }finally{dispose(p);busy=false;}
  },
  close(){for(const p of plans.values())dispose(p);plans.clear();}
 };
}
module.exports={connect,createDeployment,targetConfig,powershell};
