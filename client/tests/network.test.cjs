const {test}=require('node:test'),assert=require('node:assert/strict');
const {Network}=require('../web/network.cjs');
function fixture(system){const calls=[];const embedded={available:()=>true,close:()=>calls.push('close'),status:async()=>({BackendState:'Running',TailscaleIPs:['100.64.1.1']}),dial:async(host,port)=>{calls.push(['dial',host,port]);return 'socket';},fetch:async(url)=>{calls.push(['fetch',url]);return 'response';},login:async()=>calls.push('login')};let detections=0;const network=new Network({embedded,detect:async()=>{detections++;return system;}});return {network,calls,count:()=>detections};}
test('HTTP and SSH share route selection, switching outbound mode preserves inbound node',async()=>{
 const f=fixture({installed:true,state:'Running',peers:[],ips:[]});
 assert.equal((await f.network.status()).source,'system');
 await f.network.setMode('embedded');
 assert.equal(await f.network.fetch('http://100.64.1.2:8787/api/status'),'response');
 assert.equal(await f.network.dial('pc.example.ts.net',22),'socket');
 assert.equal((await f.network.route('192.168.1.2')).source,'system');
 await f.network.setMode('system');assert(!f.calls.includes('close'));
 f.network.close();assert(f.calls.includes('close'));
});
test('stopped installed Tailscale is not treated as missing; concurrent discovery is shared',async()=>{
 const f=fixture({installed:true,state:'Unavailable',peers:[],ips:[]});
 const values=await Promise.all([f.network.status(),f.network.status(),f.network.route('100.64.1.2')]);
 assert(values.every(v=>v.source==='system'));assert.equal(f.count(),1);
 await assert.rejects(f.network.login(),/系统/);
 await assert.rejects(f.network.setMode('unknown'),/无效/);
});
test('a missing system installation selects the embedded node',async()=>{
 const f=fixture({installed:false,state:'NotInstalled',peers:[],ips:[]});
 assert.equal((await f.network.status()).source,'embedded');await f.network.login();assert(f.calls.includes('login'));
});
