const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {webcrypto}=require('node:crypto');
const source=fs.readFileSync(path.resolve(__dirname,'../ui/runtime.js'),'utf8');
function store(seed={}){const data=new Map(Object.entries(seed));return {data,get length(){return data.size;},key:i=>[...data.keys()][i]??null,getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,String(v)),removeItem:k=>data.delete(k)};}
function fixture({focusEvents=true,native=true,selected='machine-0001',local,handler}={}){
 const calls=[],handlers=new Map(),document=new EventTarget(),window=new EventTarget();document.hidden=false;document.querySelectorAll=()=>[];
 const profiles=[{id:'machine-0001',address:'http://100.100.100.1:8787',name:'One'},{id:'machine-0002',address:'http://100.100.100.2:8787',name:'Two'}];
 local ||= store({'cr-client-profiles':JSON.stringify(profiles)});
 const session=store(selected?{'cr-client-active':selected}:{});
 const location={origin:'http://localhost',host:'localhost',reload(){calls.push(['reload']);}};
 const invoke=async(name,args={})=>{calls.push([name,args]);if(handler){const result=handler(name,args);if(result!==undefined)return result;}if(name==='service_probe')return {state:'ready',release:{serverVersion:'1.0.0',clientMin:'1.0.0',clientMaxExclusive:'1.1.0'}};if(name==='activate')return {epoch:7,origin:args.address};if(name==='request')return {status:200,body:Buffer.from('{"ok":true}').toString('base64'),contentType:'application/json'};};
 if(native)window.__TAURI__={core:{invoke,Channel:class{onmessage=null;}},event:{listen:async(name,fn)=>handlers.set(name,fn)}};
 if(native&&!focusEvents)delete window.__TAURI__.event;
 const context=vm.createContext({ConsentStore:require('../ui/consent-store.js'),normalizeAddress:require('../ui/address.js'),window,document,location,Compatibility:require('../ui/compatibility.js'),CustomEvent,localStorage:local,sessionStorage:session,URL,Blob,Response,Headers,TextEncoder,Uint8Array,DOMException,EventTarget,Event,MessageEvent,crypto:webcrypto,btoa,atob,fetch:async(p,o)=>{calls.push(['fetch',p,o]);return new Response('{}');}});
 vm.runInContext(source+'\nglobalThis.runtime=Runtime;',context);
 return {r:context.runtime,calls,local,session,handlers,document,window};
}
test('saved machines do not connect until selected',async()=>{
 const f=fixture({selected:null});await f.r.ready;
 assert.equal(f.r.hasConnection,false);assert.equal(f.calls.length,0);
});
test('only selected origin is activated; draft scope and global preferences differ',async()=>{
 const a=fixture();await a.r.ready;
 a.r.storage('session').setItem('cr-drafts','draft-one');a.r.storage('local').setItem('cr-send-shortcut','ctrl-enter');
 const b=fixture({selected:'machine-0002',local:a.local});await b.r.ready;
 assert.equal(b.r.storage('session').getItem('cr-drafts'),null);
 assert.equal(b.r.storage('local').getItem('cr-send-shortcut'),'ctrl-enter');
 assert.equal(a.calls.filter(c=>c[0]==='activate').length,1);
 assert.equal(a.calls[0][1].address,'http://100.100.100.1:8787');
});
test('native requests keep credentials out of browser storage',async()=>{
 const f=fixture();await f.r.ready;
 const response=await f.r.request('/api/login',{method:'POST',body:JSON.stringify({token:'test-secret'})});
 assert.deepEqual(await response.json(),{ok:true});
 assert(!JSON.stringify([...f.local.data]).includes('test-secret'));
 assert(!f.calls.some(c=>c[0]==='fetch'));
});
test('pause aborts late responses and disallows background requests',async()=>{
 let finish;const f=fixture({handler:name=>name==='request'?new Promise(resolve=>{finish=resolve;}):undefined});await f.r.ready;
 const request=f.r.request('/api/status');await new Promise(resolve=>setImmediate(resolve));
 f.handlers.get('client-focus')({payload:false});
 finish({status:200,body:Buffer.from('{}').toString('base64'),contentType:'application/json'});
 await assert.rejects(request,e=>e.name==='AbortError');
 await assert.rejects(f.r.request('/api/status'),e=>e.name==='AbortError');
 assert(f.calls.some(c=>c[0]==='pause_network'));
});
test('switch saves old state before cancelling transport and reloading',async()=>{
 const f=fixture();await f.r.ready;let saved=false;
 f.window.addEventListener('cr-before-switch',()=>{saved=true;f.r.storage('session').setItem('cr-drafts','saved');});
 await f.r.select(f.r.profiles()[1]);
 assert(saved);assert.equal(f.session.getItem('cr-client-active'),'machine-0002');
 assert.equal(f.local.getItem('cr-client:machine-0001:cr-drafts'),'saved');
 const actions=f.calls.map(c=>c[0]);assert(actions.indexOf('pause_network')<actions.indexOf('deactivate'));assert.equal(actions.at(-1),'reload');
});
test('addresses cannot smuggle credentials or remote resource paths',()=>{
 const f=fixture({selected:null});
 for(const value of ['file:///tmp/a','https://secret@host','http://host/?token=x','http://host/api'])assert.throws(()=>f.r.normalizeAddress(value));
 assert.equal(f.r.normalizeAddress('http://100.100.100.1:8787/'),'http://100.100.100.1:8787');
});
test('missing client bridge fails instead of connecting to the web host as a service',()=>{
 assert.throws(()=>fixture({native:false}),/客户端桥接未加载/);
});

test('web bridge needs no fake native focus subscription',async()=>{
 const f=fixture({focusEvents:false});
 await f.r.ready;
 assert.equal((await f.r.request('/api/status')).status,200);
 f.document.hidden=true;
 f.document.dispatchEvent(new Event('visibilitychange'));
 assert(f.calls.some(([name])=>name==='pause_network'));
});
test('incompatible saved machine does not switch or discard the active connection',async()=>{
 const f=fixture({handler:name=>name==='service_probe'?{state:'ready',releaseState:'unsupported'}:undefined});await f.r.ready;
 let warning;f.window.addEventListener('cr-compatibility-required',e=>warning=e.detail);
 await assert.rejects(()=>f.r.select(f.r.profiles()[1]),/目标电脑更新/);
 assert.equal(warning.address,'http://100.100.100.2:8787');
 assert.equal(f.session.getItem('cr-client-active'),'machine-0001');
 assert(!f.calls.some(c=>['pause_network','deactivate','reload'].includes(c[0])));
});

const tick=()=>new Promise(resolve=>setImmediate(resolve));
const audioResponse=()=>({status:200,body:Buffer.from('ID3fixture').toString('base64'),contentType:'audio/mpeg'});
function mediaElement(){const el=new EventTarget();el.isConnected=true;return el;}
test('background media cancellation preserves player and resumes download',async()=>{
 let finish,attempts=0;const f=fixture({handler:name=>name==='request'?(++attempts===1?new Promise(resolve=>{finish=resolve;}):audioResponse()):undefined});
 await f.r.ready;const el=mediaElement();let errors=0;el.addEventListener('error',()=>errors++);
 f.r.setMedia(el,'/api/media?test=resume');await tick();
 f.handlers.get('client-focus')({payload:false});finish(audioResponse());await tick();
 assert.equal(errors,0);assert.equal(el.src,undefined);
 assert.equal(f.calls.find(([name])=>name==='pause_network')[1].epoch,7);
 f.handlers.get('client-focus')({payload:true});await tick();await tick();
 assert.equal(attempts,2);assert.match(el.src,/^blob:/);assert.equal(errors,0);
 el.isConnected=false;f.r.sweepMedia();
});
test('media failure exposes HTTP reason and can be retried',async()=>{
 let attempts=0;const f=fixture({handler:name=>name==='request'?(++attempts===1?{status:404,body:'',contentType:'text/plain'}:audioResponse()):undefined});
 await f.r.ready;const el=mediaElement();let reason;el.addEventListener('error',e=>reason=e.detail.message);
 f.r.setMedia(el,'/api/media?test=missing');await tick();assert.match(reason,/找不到此附件/);
 f.r.setMedia(el,'/api/media?test=missing');await tick();assert.match(el.src,/^blob:/);
 el.isConnected=false;f.r.sweepMedia();
});
test('media resumes even when cancelled response arrives after focus returns',async()=>{
 let finish,attempts=0;const f=fixture({handler:name=>name==='request'?(++attempts===1?new Promise(resolve=>{finish=resolve;}):audioResponse()):undefined});
 await f.r.ready;const el=mediaElement();let errors=0;el.addEventListener('error',()=>errors++);
 f.r.setMedia(el,'/api/media?test=race');await tick();
 f.handlers.get('client-focus')({payload:false});f.handlers.get('client-focus')({payload:true});await tick();
 finish(audioResponse());await tick();await tick();assert.equal(attempts,2);assert.match(el.src,/^blob:/);assert.equal(errors,0);
 el.isConnected=false;f.r.sweepMedia();
});

test('native media download saves exact bytes with a filename, not a remote path',async()=>{
 const f=fixture({handler:(name,args)=>{
  if(name==='request')return audioResponse();
  if(name==='save_media')return '/Downloads/试听.mp3';
 }});await f.r.ready;
 assert.match(await f.r.downloadMedia('/api/media?test=download','/private/audio/%E8%AF%95%E5%90%AC.mp3'),/已保存到/);
 const saved=f.calls.find(([name])=>name==='save_media')[1];
 assert.equal(saved.filename,'试听.mp3');assert.equal(Buffer.from(saved.body,'base64').toString(),'ID3fixture');
});
test('failed media download never saves an error response',async()=>{
 const f=fixture({handler:name=>name==='request'?{status:404,body:'',contentType:'text/plain'}:undefined});await f.r.ready;
 await assert.rejects(f.r.downloadMedia('/api/media?test=missing','/audio.mp3'),/404/);
 assert(!f.calls.some(([name])=>name==='save_media'));
});
test('adding a machine has one canonical address and reuses its verified probe',async()=>{
 const f=fixture({selected:null});
 const a=f.r.rememberComputer('100.64.1.3','Office');
 assert.equal(a.address,'https://100.64.1.3:8787');
 assert.equal(f.r.rememberComputer('https://100.64.1.3:8787','Again').id,a.id);
 const result={address:a.address,state:'ready',release:{serverVersion:'1.0.0',clientMin:'1.0.0',clientMaxExclusive:'1.1.0'}};
 await f.r.select(a,result);assert(!f.calls.some(c=>c[0]==='service_probe'));
 assert.equal(f.session.getItem('cr-client-active'),a.id);
 const other=fixture({selected:null});await assert.rejects(()=>other.r.select(a,{...result,address:'http://other:8787'}),/不一致/);
 assert(!other.calls.some(c=>c[0]==='deactivate'));
});

test('computer display name refreshes automatic names and preserves personal aliases',()=>{
 const f=fixture();
 const rows=f.r.profiles();rows[0].name='192.168.1.2';rows[0].machine='192.168.1.2';f.r.saveProfiles(rows);
 f.r.recordStatus({hostName:'我的 Mac',connectionName:'我的 Mac'});
 assert.equal(f.r.profile.name,'');assert.equal(f.r.profile.serviceName,'我的 Mac');
 f.r.rename('办公室');f.r.recordStatus({hostName:'新的电脑名称',connectionName:'新的电脑名称'});
 assert.equal(f.r.profile.name,'办公室');
 const added=f.r.rememberComputer('100.64.1.9','另一台电脑');
 assert.equal(added.name,'');assert.equal(added.serviceName,'另一台电脑');
});

test('addresses default to local TLS port while explicit legacy HTTP stays available',()=>{
 const f=fixture({selected:null});f.window.Distribution={manifest:{channel:'appstore'}};
 assert.equal(f.r.normalizeAddress('example.test'),'https://example.test:8787');
 assert.equal(f.r.normalizeAddress('example.test:8443'),'https://example.test:8443');
 assert.equal(f.r.rememberComputer('http://example.test:8787').address,'http://example.test:8787');
 assert.equal(f.r.rememberComputer('example.test').address,'https://example.test:8787');
});
test('forget active connection clears its data and blocks pagehide draft resurrection',async()=>{
 const f=fixture();await f.r.ready;
 f.r.storage().setItem('cr-drafts','private draft');
 f.local.setItem('cr-client:machine-0002:cr-drafts','other draft');
 f.session.setItem('cr-client:machine-0001:legacy','legacy');
 f.local.setItem('cr-send-shortcut','ctrl-enter');
 await f.r.forgetComputer(f.r.profiles()[0]);
 f.r.storage().setItem('cr-drafts','late save');
 assert.equal(f.local.getItem('cr-client:machine-0001:cr-drafts'),null);
 assert.equal(f.session.getItem('cr-client:machine-0001:legacy'),null);
 assert.equal(f.local.getItem('cr-client:machine-0002:cr-drafts'),'other draft');
 assert.equal(f.local.getItem('cr-send-shortcut'),'ctrl-enter');
 assert.equal(f.session.getItem('cr-client-active'),null);
 assert.equal(f.r.profiles().length,1);
 assert.equal(f.calls.at(-1)[0],'reload');
 assert(f.calls.some(c=>c[0]==='forget_connection'));
});
test('forget inactive connection preserves active work without reload',async()=>{
 const f=fixture();await f.r.ready;
 f.r.storage().setItem('cr-drafts','keep');
 f.local.setItem('cr-client:machine-0002:cr-drafts','delete');
 await f.r.forgetComputer(f.r.profiles()[1]);
 assert.equal(f.r.storage().getItem('cr-drafts'),'keep');
 assert.equal(f.local.getItem('cr-client:machine-0002:cr-drafts'),null);
 assert.equal(f.session.getItem('cr-client-active'),'machine-0001');
 assert(!f.calls.some(c=>c[0]==='reload'||c[0]==='pause_network'));
});
test('failed native forgetting retains connection and its drafts',async()=>{
 const f=fixture({handler:name=>{if(name==='forget_connection')throw Error('transport failure');}});
 await f.r.ready;f.r.storage().setItem('cr-drafts','keep');
 await assert.rejects(f.r.forgetComputer(f.r.profiles()[0]),/transport failure/);
 assert.equal(f.r.profiles().length,2);
 assert.equal(f.r.storage().getItem('cr-drafts'),'keep');
 f.r.storage().setItem('cr-drafts','still writable');
 assert.equal(f.r.storage().getItem('cr-drafts'),'still writable');
 assert(!f.calls.some(c=>c[0]==='reload'));
});

test('store media blocks HTTP load and external download but allows HTTPS and local previews',async()=>{
 const f=fixture({selected:null});f.window.Distribution={ready:Promise.resolve(),manifest:{channel:'appstore'}};
 for(const path of ['http://example.test/a.png','//example.test/a.mp4','http://example.test/a.mp3']){
  const el=mediaElement();let error;el.addEventListener('error',e=>error=e.detail.message);
  f.r.setMedia(el,path);await tick();assert.equal(el.src,undefined);assert.match(error,/HTTPS/);
  await assert.rejects(f.r.downloadMedia(path,path),/HTTPS/);
 }
 assert(!f.calls.some(c=>c[0]==='open_link'));
 for(const path of ['https://example.test/a.png','blob:http://localhost/preview','data:image/png;base64,AA==']){
  const el=mediaElement();f.r.setMedia(el,path);await tick();assert.equal(el.src,path);
 }
 await f.r.downloadMedia('https://example.test/a.mp3','a.mp3');
 assert.equal(f.calls.at(-1)[1].url,'https://example.test/a.mp3');
});
test('media waits for distribution identity before assigning a URL',async()=>{
 const f=fixture({selected:null});let resolve;
 f.window.Distribution={ready:new Promise(r=>resolve=r),manifest:null};
 const el=mediaElement();let error;el.addEventListener('error',e=>error=e.detail.message);
 f.r.setMedia(el,'http://example.test/a.png');await tick();assert.equal(el.src,undefined);
 f.window.Distribution.manifest={channel:'appstore'};resolve();await tick();
 assert.equal(el.src,undefined);assert.match(error,/HTTPS/);
});

test('same-origin absolute API media uses authenticated transport, not external HTTP',async()=>{
 const f=fixture({handler:name=>name==='request'?audioResponse():undefined});await f.r.ready;
 f.window.Distribution={ready:Promise.resolve(),manifest:{channel:'appstore'}};
 const el=mediaElement();f.r.setMedia(el,f.r.origin+'/api/media?thread=a');await tick();
 assert.match(el.src,/^blob:/);assert.equal(f.calls.find(c=>c[0]==='request')[1].path,'/api/media?thread=a');
 el.isConnected=false;f.r.sweepMedia();
});

test('startup consent blocks probing until explicitly resolved',async()=>{
 const f=fixture({selected:null});let permit;f.window.ClientConsentBoot=new Promise(resolve=>{permit=resolve;});
 const pending=f.r.checkCompatibility('http://100.100.100.1:8787');await new Promise(resolve=>setImmediate(resolve));assert(!f.calls.some(c=>c[0]==='service_probe'));permit();await pending;assert(f.calls.some(c=>c[0]==='service_probe'));
});
test('denied AI consent never serializes or uploads an attachment',async()=>{
 const f=fixture();f.window.ClientConsent={authorize:async()=>{throw Error('denied');}};
 await assert.rejects(f.r.request('/api/upload-file?name=test',{method:'POST',body:new Blob(['private'])}),/denied/);
 assert.deepEqual(f.calls.filter(c=>c[0]==='request').map(c=>c[1].path),['/api/privacy']);
});
test('confirmed writes are bound to the exact disclosure revision',async()=>{
 const revision='a'.repeat(64),f=fixture({handler:(name,args)=>name==='request'&&args.path==='/api/privacy'?{status:200,body:Buffer.from(JSON.stringify({revision})).toString('base64'),contentType:'application/json'}:undefined});
 let verified=false;f.window.ClientConsent={authorize:async(origin,data)=>{assert.equal(data.revision,revision);return 3;},assertCurrent:n=>{assert.equal(n,3);verified=true;}};
 await f.r.request('/api/send',{method:'POST',body:'{"text":"test"}'});assert(verified);
 assert.equal(f.calls.filter(c=>c[0]==='request').at(-1)[1].path,'/api/send?consentRevision='+revision);
});
test('revocation during body preparation prevents transmission',async()=>{
 const f=fixture();f.window.ClientConsent={authorize:async()=>1,assertCurrent:()=>{throw Error('revoked');}};
 await assert.rejects(f.r.request('/api/send',{method:'POST',body:'private'}),/revoked/);assert(!f.calls.some(c=>c[0]==='request'&&c[1].method==='POST'));
});
