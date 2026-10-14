const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {createDeployment,targetConfig}=require('../web/deploy.cjs');
const target={target:'tester@100.64.10.11',mode:'password',password:'example-secret',address:'http://100.64.10.11:8877'};
test('deployment validates the selected host, port and fixed auth modes',()=>{
 assert.equal(targetConfig(target).servicePort,'8877');
 for(const patch of [{target:'-oProxyCommand=bad'},{target:'user@host;whoami'},{address:'http://another-host:8787'},{address:'ftp://100.64.10.11'},{port:0},{mode:'command'}])assert.throws(()=>targetConfig({...target,...patch}));
});
test('starts an existing service without reading bundles or uploading files',async()=>{
 let script='',closed=0;
 const client={end(){closed++;},sftp(){throw Error('Must never upload');}};
 const deployment=createDeployment({connectSSH:async()=>client,run:async(c,command,input)=>{
  if(command.startsWith('uname'))return 'Darwin\narm64\n';
  script=input;return 'CODEX_REMOTE_READY\n';
 },check:async address=>{assert.equal(address,target.address);return true;}});
 const preview=await deployment.probe(target);
 const result=await deployment.start(preview.id);
 assert.equal(result.reachable,true);assert.equal(closed,1);
 assert.match(script,/127.0.0.1 8877/);assert.match(script,/launchctl kickstart/);
 assert(!script.includes('kickstart -k'));assert(!script.includes('__STAGE__'));
 await assert.rejects(()=>deployment.start(preview.id),/失效/);
 deployment.close();
});
test('SSH rejects untrusted host before password authentication',async()=>{
 const {Server}=require('ssh2');const hostKeys=[crypto.generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs1',format:'pem'})];let passwordAttempts=0;
 const server=new Server({hostKeys},client=>{client.on('error',()=>{});client.on('authentication',ctx=>{if(ctx.method==='password')passwordAttempts++;ctx.reject();});});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const deployment=createDeployment();
 try{
  await assert.rejects(()=>deployment.probe({target:'tester@127.0.0.1',port:server.address().port,mode:'password',password:'must-not-send'}),/SSH_TRUST:SHA256:/);
  assert.equal(passwordAttempts,0);
 }finally{deployment.close();await new Promise(r=>server.close(r));}
});
test('Windows platform detection ignores successful PowerShell progress stderr but preserves failure diagnostics',async()=>{
 const {EventEmitter}=require('node:events');
 let fail=false;
 const client={end(){},exec(command,callback){
  const stream=new EventEmitter();stream.stderr=new EventEmitter();stream.close=()=>{};
  stream.end=()=>queueMicrotask(()=>{
   if(command.startsWith('uname')){stream.stderr.emit('data',Buffer.from('uname not found'));stream.emit('close',1);return;}
   stream.emit('data',Buffer.from('Windows\r\nAMD64\r\n'));
   stream.stderr.emit('data',Buffer.from(fail?'diagnostic failure':'#< CLIXML\r\n<Objs><Obj S="progress">Preparing modules</Obj></Objs>'));
   stream.emit('close',fail?1:0);
  });callback(null,stream);
 }};
 const deployment=createDeployment({connectSSH:async()=>client});
 try{
  const result=await deployment.probe(target);assert.equal(result.platform,'windows');assert.equal(result.arch,'amd64');
  fail=true;await assert.rejects(()=>deployment.probe(target),/diagnostic failure/);
 }finally{deployment.close();}
});
