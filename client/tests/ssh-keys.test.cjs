const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {Server,utils}=require('ssh2');
const {createKeyStore,authorizationScript}=require('../web/ssh-keys.cjs');
const {createDeployment}=require('../web/deploy.cjs');
test('managed keys are private, per account, reusable, and list only public metadata',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'cr-keys-')),store=createKeyStore(root),t={host:'host',port:22,username:'user'};
 try{
  const a=store.ensure(t),b=store.ensure(t);assert.equal(a.publicKey,b.publicKey);assert.notEqual(store.ensure({...t,username:'other'}).publicKey,a.publicKey);
  assert.equal(fs.statSync(a.path).mode&0o777,0o600);assert.equal(fs.statSync(root).mode&0o777,0o700);
  assert.equal(store.list().length,0);store.mark(t,a);assert.equal(store.list().length,1);assert(!JSON.stringify(store.list()).includes('PRIVATE KEY'));
  assert.match(authorizationScript('darwin',a.publicKey),/authorized_keys/);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('password bootstrap verifies a separate managed-key SSH connection before recording success',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'cr-key-connect-')),keyStore=createKeyStore(root);
 const serverKey=utils.generateKeyPairSync('ed25519');let authorized=null,passwords=0,keys=0;
 const server=new Server({hostKeys:[serverKey.private]},client=>{
  client.on('error',()=>{});client.on('authentication',ctx=>{
   if(ctx.method==='password'&&ctx.password==='fixture-secret'){passwords++;return ctx.accept();}
   if(ctx.method==='publickey'&&authorized&&ctx.key.data.equals(authorized.getPublicSSH())){
    if(!ctx.signature||authorized.verify(ctx.blob,ctx.signature,ctx.hashAlgo)){keys++;return ctx.accept();}
   }
   ctx.reject();
  });
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const parsed=utils.parseKey(serverKey.private),fingerprint='SHA256:'+crypto.createHash('sha256').update(parsed.getPublicSSH()).digest('base64').replace(/=+$/,'');
 const deployment=createDeployment({keyStore,run:async(client,command,input)=>{
  if(command.startsWith('uname'))return 'Darwin\narm64\n';
  if(command==='/bin/sh -s'){assert(!input.includes('PRIVATE KEY'));const pub=Buffer.from(/key=\$\(printf '%s' '([^']+)'/.exec(input)[1],'base64').toString().trim();authorized=utils.parseKey(pub);return '';}
  return 'CODEX_REMOTE_KEY_OK';
 }});
 try{
  const result=await deployment.setupKey({target:'tester@127.0.0.1',port:server.address().port,mode:'password',password:'fixture-secret',trustedFingerprint:fingerprint});
  assert.equal(result.username,'tester');assert.equal(passwords,1);assert(keys>0);assert.equal(keyStore.list().length,1);
 }finally{deployment.close();await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true});}
});
