const {test}=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const compatibility=require('../ui/compatibility.js');
const release={serverVersion:'1.0.0',clientMin:'1.0.0',clientMaxExclusive:'1.1.0'};
test('checks both version ranges and distinguishes which side needs an upgrade',()=>{
 for(const [patch,action] of [[{},'none'],[{serverVersion:'0.1.9'},'server'],[{clientMin:'0.1.0',clientMaxExclusive:'1.0.0'},'server'],[{serverVersion:'1.1.0',clientMin:'1.1.0',clientMaxExclusive:'1.2.0'},'client'],[{clientMin:'1.0.1'},'client'],[{clientMin:'bad'},'unknown'],[{serverVersion:'0.1.0',clientMin:'1.1.0',clientMaxExclusive:'1.2.0'},'unknown']])assert.equal(compatibility.evaluate({release:{...release,...patch}}).action,action);
 assert.equal(compatibility.evaluate({releaseState:'unsupported'}).action,'server');
 assert.equal(compatibility.evaluate({releaseState:'unknown'}).action,'unknown');
 assert.equal(compatibility.compare('0.10.0','0.2.0'),1);
});
test('client package and native version match the compatibility version',()=>{
 const fs=require('node:fs'),path=require('node:path');
 assert.equal(require('../package.json').version,compatibility.clientVersion);
 assert.equal(require('../src-tauri/tauri.conf.json').version,compatibility.clientVersion);
 assert.match(fs.readFileSync(path.join(__dirname,'../src-tauri/Cargo.toml'),'utf8'),new RegExp('version = "'+compatibility.clientVersion.replaceAll('.','\\.')+'"'));
});
test('probe reads versions before auth, distinguishes legacy and unreadable metadata',async()=>{
 const {serviceProbe}=require('../web/service-probe.cjs');let mode='auth',seen=[];
 const server=http.createServer((req,res)=>{
  seen.push(req.url);res.setHeader('Content-Type','application/json');
  if(req.url==='/api/status'){
   if(mode==='auth'||mode==='broken'){res.writeHead(401).end('{}');return;}
   res.end(JSON.stringify({adapter:'desktop-rollout',...(mode==='ready'?{release}:{})}));return;
  }
  if(mode==='unsupported'){res.writeHead(404).end('{}');return;}
  if(mode==='broken'){res.writeHead(500).end('{}');return;}
  res.end(JSON.stringify({adapter:'desktop-rollout',release}));
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{
  const address='http://127.0.0.1:'+server.address().port;
  let result=await serviceProbe(address);assert.equal(result.state,'auth');assert.deepEqual(result.release,release);assert.deepEqual(seen,['/api/status','/api/version']);
  mode='ready';seen=[];result=await serviceProbe(address);assert.equal(result.releaseState,'available');assert.deepEqual(seen,['/api/status']);
  mode='unsupported';seen=[];assert.equal((await serviceProbe(address)).releaseState,'unsupported');assert.deepEqual(seen,['/api/status']);
  mode='broken';assert.equal((await serviceProbe(address)).releaseState,'unknown');
 }finally{await new Promise(r=>server.close(r));}
});

test('1.0 client respects the compatibility ceiling declared by a 0.2 server',()=>{
 assert.equal(compatibility.evaluate({release:{serverVersion:'0.2.0',clientMin:'0.2.0',clientMaxExclusive:'0.3.0'}}).action,'server');
});
