const {test}=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const {start,endpoint,origin}=require('../web/server.cjs');
test('web client proxies only selected APIs, isolates cookies and enforces local origin',async()=>{
 const seen=[];const target=http.createServer((req,res)=>{seen.push(req.headers.cookie||'');res.setHeader('Content-Type','application/json');if(req.url==='/api/login')res.setHeader('Set-Cookie','session=private; HttpOnly');res.end(JSON.stringify({adapter:'desktop-rollout'}));});
 await new Promise(r=>target.listen(0,'127.0.0.1',r));const app=await start();
 try{
  const js=await (await fetch(app.url+'/client-adapter.js')).text();const key=JSON.parse(js.match(/window.__CLIENT_WEB_KEY=("[^"]+")/)[1]);
  const sid=crypto.randomUUID(),other=crypto.randomUUID();
  const rpc=async(name,args={},session=sid,valid=true)=>fetch(app.url+'/bridge',{method:'POST',headers:{'Content-Type':'application/json','Origin':valid?app.url:'https://evil.test','X-Client-Key':key,'X-Client-Session':session},body:JSON.stringify({name,args})});
  const address='http://127.0.0.1:'+target.address().port;
  assert.equal((await rpc('activate',{address},sid,false)).status,403);
  const stale=await fetch(app.url+'/bridge',{method:'POST',headers:{'Content-Type':'application/json',Origin:app.url,'X-Client-Key':'expired','X-Client-Session':sid},body:JSON.stringify({name:'activate',args:{address}})});
  assert.equal(stale.status,409);assert.equal((await stale.json()).code,'CLIENT_RESTARTED');
  const active=await(await rpc('activate',{address})).json();
  await rpc('request',{epoch:active.epoch,path:'/api/login',method:'POST',body:Buffer.from('{}').toString('base64')});
  await rpc('request',{epoch:active.epoch,path:'/api/status'});assert.equal(seen.at(-1),'session=private');
  const a2=await(await rpc('activate',{address},other)).json();await rpc('request',{epoch:a2.epoch,path:'/api/status'},other);assert.equal(seen.at(-1),'');
  assert.equal((await rpc('request',{epoch:active.epoch,path:'/private'})).status,400);
  await rpc('pause_network',{epoch:active.epoch});assert.equal((await rpc('request',{epoch:active.epoch,path:'/api/status'})).status,400);
  await rpc('forget_connection',{address});
  assert.equal((await rpc('request',{epoch:a2.epoch,path:'/api/status'},other)).status,400);
  const again=await(await rpc('activate',{address})).json();
  await rpc('request',{epoch:again.epoch,path:'/api/status'});assert.equal(seen.at(-1),'');
  assert.equal((await rpc('ssh_probe',{})).status,400);
  assert.throws(()=>origin('http://user:password@localhost'));assert.throws(()=>endpoint(address,'/api/../secret','GET'));
  const html=await(await fetch(app.url)).text();assert.ok(html.includes('/client-adapter.js'));assert.ok(html.includes('computer-switcher'));
 }finally{await new Promise(r=>app.server.close(r));await new Promise(r=>target.close(r));}
});
test('Tailscale includes self first and avoids duplicates even if Self.Online is false',()=>{
 const {reduceStatus}=require('../web/network.cjs');
 const result=reduceStatus({BackendState:'Running',TailscaleIPs:['100.64.1.1'],Self:{HostName:'My Mac',Online:false},Peer:{self:{HostName:'Duplicate',TailscaleIPs:['100.64.1.1']},other:{HostName:'Other',Online:true,TailscaleIPs:['100.64.1.2']}}});
 assert.equal(result.peers.length,2);assert.equal(result.peers[0].name,'My Mac');assert.equal(result.peers[0].isSelf,true);assert.equal(result.peers[0].online,true);assert.equal(result.peers[0].address,'100.64.1.1');
});
