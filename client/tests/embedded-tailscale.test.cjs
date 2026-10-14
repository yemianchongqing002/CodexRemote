const {test}=require('node:test'),assert=require('node:assert/strict'),net=require('node:net');
const {EmbeddedTailscale,tailnetHost}=require('../web/embedded-tailscale.cjs');
test('embedded transport selects only tailnet destinations',()=>{
 for(const h of ['100.64.0.1','100.127.255.255','fd7a:115c:a1e0::1','mac.tailnet.ts.net'])assert.ok(tailnetHost(h));
 for(const h of ['100.128.0.1','100.63.0.1','127.0.0.1','example.com'])assert.ok(!tailnetHost(h));
});
test('SSH banner probing can use an embedded dialer',async()=>{
 const server=net.createServer(s=>s.end('SSH-2.0-test\r\n'));await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{let destination;const result=await require('../web/ssh-bootstrap.cjs').sshStatus({address:'http://100.64.1.1:8787'},async(host,port)=>{destination={host,port};return net.createConnection({host:'127.0.0.1',port:server.address().port});});assert.deepEqual(destination,{host:'100.64.1.1',port:22});assert.equal(result.state,'available');}finally{await new Promise(r=>server.close(r));}
});
test('missing embedded binary fails clearly without falling through to system network',async()=>{
 const node=new EmbeddedTailscale({binary:'/nonexistent/codex-tailscale-host'});assert.equal(node.available(),false);await assert.rejects(node.start(),/编译/);await assert.rejects(node.dial('127.0.0.1',22),/仅连接/);node.close();
});
test('HTTP upload, cookies, binary and SSE use the authenticated embedded SOCKS channel',async()=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
 const seen=[];const target=http.createServer(async(req,res)=>{let body='';for await(const b of req)body+=b;seen.push({path:req.url,body,cookie:req.headers.cookie});if(req.url==='/events'){res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: live\n\n');}else{res.setHeader('Set-Cookie','test=ok; HttpOnly');res.end(Buffer.from([0,1,255]));}});
 await new Promise(r=>target.listen(0,'127.0.0.1',r));
 const destinations=[],sockets=new Set();
 const proxy=net.createServer(socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));let step=0,buf=Buffer.alloc(0);
  const parse=b=>{buf=Buffer.concat([buf,b]);
   if(step===0&&buf.length>=2&&buf.length>=2+buf[1]){buf=buf.subarray(2+buf[1]);socket.write(Buffer.from([5,2]));step=1;}
   if(step===1&&buf.length>=2){const u=buf[1];if(buf.length<3+u)return;const p=buf[2+u];if(buf.length<3+u+p)return;assert.equal(buf.subarray(2,2+u).toString(),'tsnet');assert.equal(buf.subarray(3+u,3+u+p).toString(),'p'.repeat(32));buf=buf.subarray(3+u+p);socket.write(Buffer.from([1,0]));step=2;}
   if(step===2&&buf.length>=5){let end,host;if(buf[3]===3){end=5+buf[4];if(buf.length<end+2)return;host=buf.subarray(5,end).toString();}else if(buf[3]===1){end=8;if(buf.length<10)return;host=[...buf.subarray(4,8)].join('.');}else throw Error('unexpected address family');destinations.push({host,port:buf.readUInt16BE(end)});buf=buf.subarray(end+2);step=3;socket.removeListener('data',parse);const remote=net.createConnection(target.address().port,'127.0.0.1',()=>{socket.write(Buffer.from([5,0,0,1,127,0,0,1,0,1]));if(buf.length)remote.write(buf);socket.pipe(remote).pipe(socket);});remote.on('error',()=>socket.destroy());socket.on('close',()=>remote.destroy());}
  };socket.on('data',parse);socket.on('error',()=>{});
 });await new Promise(r=>proxy.listen(0,'127.0.0.1',r));
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cr-embedded-test-')),binary=path.join(dir,'host');
 fs.writeFileSync(binary,'#!/usr/bin/env node\nconsole.log('+JSON.stringify(JSON.stringify({address:'127.0.0.1:'+proxy.address().port,proxy:'p'.repeat(32),api:'a'.repeat(32)}))+');process.stdin.resume();process.stdin.on("end",()=>process.exit());\n',{mode:0o700});
 const embedded=new EmbeddedTailscale({binary,dir:path.join(dir,'state')});
 try{const r=await embedded.fetch('http://computer.test.ts.net:8787/upload',{method:'POST',body:'payload',headers:{Cookie:'session=private'}});assert.deepEqual(Buffer.from(await r.arrayBuffer()),Buffer.from([0,1,255]));assert.equal(r.headers.getSetCookie()[0],'test=ok; HttpOnly');const events=await embedded.fetch('http://100.64.0.2:8787/events');assert.equal(await events.text(),'data: live\n\n');assert.deepEqual(destinations.map(v=>v.host),['computer.test.ts.net','100.64.0.2']);assert.equal(seen[0].body,'payload');assert.equal(seen[0].cookie,'session=private');}finally{embedded.close();for(const s of sockets)s.destroy();await new Promise(r=>proxy.close(r));await new Promise(r=>target.close(r));fs.rmSync(dir,{recursive:true,force:true});}
});
