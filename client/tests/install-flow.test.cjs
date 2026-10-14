const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {webcrypto}=require('node:crypto');
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(handler,{web=true,stored=new Map(),store=false}={}){
 const elements=new Map(),window=new EventTarget(),calls=[],profiles=[],selected=[];
 const html=fs.readFileSync(path.join(__dirname,'../ui/index.html'),'utf8');
 for(const match of html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)){
  const e=new EventTarget();Object.assign(e,{value:'',textContent:'',hidden:/\shidden\b/.test(match[0]),disabled:false,dataset:{},classList:{contains:()=>false,toggle(){},remove(){}},focus(){},setAttribute(){},scrollIntoView(){},replaceChildren(){},append(){},reset(){}});elements.set(match[1],e);
 }
 const el=id=>{assert(elements.has(id),'missing element '+id);return elements.get(id);};
 el('ssh-mode').value='password';el('install-ssh-port').value='22';
 window.__CLIENT_BRIDGE={web:true,core:{invoke:async(name,args)=>{if(name==='ssh_key_status')return {keys:[]};calls.push({name,args});if(name==='tailscale_status')return {state:'Running',peers:[]};return handler(name,args);}}};
 if(!web){window.__TAURI__=window.__CLIENT_BRIDGE;delete window.__CLIENT_BRIDGE;}
 if(store)window.Distribution={supports:async()=>false};
 const Runtime={invoke:(name,args)=>(window.__TAURI__||window.__CLIENT_BRIDGE).core.invoke(name,args),rememberComputer:(address,name)=>{let p=profiles.find(p=>p.address===address);if(!p){p={id:webcrypto.randomUUID(),address,name};profiles.push(p);}return p;},native:true,normalizeAddress:require('../ui/address.js'),profiles:()=>profiles,saveProfiles(){},select:async p=>selected.push(p)};
 const localStorage={getItem:key=>stored.get(key)||null,setItem:(key,value)=>stored.set(key,value)};
 const context=vm.createContext({window,localStorage,document:{getElementById:el,hidden:false,createElement:()=>({})},Runtime,Compatibility:require('../ui/compatibility.js'),Event,CustomEvent,URL,crypto:webcrypto,Option:class{},setTimeout});
 for(const file of ['tailnet.js','deploy.js','connect.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../ui',file),'utf8'),context);
 return {el,window,calls,profiles,selected,fire:(id,event='click')=>el(id).dispatchEvent(new Event(event,{cancelable:true}))};
}
test('started but unreachable service can reconnect without another SSH startup',async()=>{
 let reachable=false;
 const f=fixture(name=>{
  if(name==='ssh_probe')return {id:'plan',target:'test-pc',platform:'windows',arch:'amd64'};
  if(name==='ssh_start')return {address:'http://test-pc:8877',reachable:false,detail:'服务已启动但网络不可达'};
  if(name==='service_probe')return {state:reachable?'ready':'unavailable'};
  throw Error(name);
 });
 f.el('ssh-target').value='test-pc';f.el('ssh-password').value='secret';
 f.fire('ssh-form','submit');await flush();
 assert.equal(f.profiles.length,1);assert.equal(f.el('ssh-password').value,'');
 assert.equal(f.el('ssh-form').hidden,true);assert.equal(f.el('ssh-connect-retry').hidden,false);
 f.fire('ssh-connect-retry');await flush();assert.match(f.el('ssh-note').textContent,/连接已保存/);
 reachable=true;f.fire('ssh-connect-retry');await flush();
 assert.equal(f.selected[0].address,'http://test-pc:8877');assert.equal(f.calls.filter(c=>c.name==='ssh_start').length,1);
 f.fire('install-details-back');assert.equal(f.el('connect-computer-form').hidden,false);
 assert.equal(f.el('ssh-connect-retry').hidden,true);assert.equal(f.el('ssh-form').hidden,false);
});

for(const web of [true,false])for(const state of ['unreachable','closed','unavailable','error'])test(`${web?'web':'native'} blocks SSH login when connectivity is ${state}, then checks the corrected port`,async()=>{
 let available=false;
 const f=fixture((name,args)=>{
  if(name==='service_probe')return {state:'unreachable'};
  if(name==='ssh_status'){
   if(available){assert.equal(args.port,2222);return {state:'available'};}
   if(state==='error')throw Error('检测失败');
   return {state};
  }
  throw Error('Unexpected authentication/install call: '+name);
 },{web});
 f.el('computer-address').value='test-pc';f.fire('connect-computer-form','submit');await flush();
 assert.equal(f.el('computer-install-details').hidden,true);
 assert.equal(f.el('install-ssh-check').hidden,false);
 assert.deepEqual(f.calls.map(c=>c.name),['service_probe','ssh_status']);
 available=true;f.el('install-ssh-port').value='2222';f.fire('install-ssh-retry');await flush();
 assert.equal(f.el('computer-install-details').hidden,false);assert.equal(f.el('ssh-port').value,'2222');
});

test('a running service opens directly without checking SSH',async()=>{
 const f=fixture(name=>{assert.equal(name,'service_probe');return {state:'ready',name:'PC',release:{serverVersion:'1.0.0',clientMin:'1.0.0',clientMaxExclusive:'1.1.0'}};});
 f.el('computer-address').value='test-pc';f.fire('connect-computer-form','submit');await flush();
 assert.equal(f.selected.length,1);assert.equal(f.calls.length,1);
});
test('SSH check locks navigation and returning from login preserves the address and clears secrets',async()=>{
 let finish;
 const f=fixture(name=>{
  if(name==='service_probe')return {state:'unavailable'};
  if(name==='ssh_status')return new Promise(resolve=>{finish=resolve;});
  throw Error(name);
 });
 f.window.dispatchEvent(new Event('cr-add-computer'));
 f.el('computer-address').value='test-pc:8877';f.fire('connect-computer-form','submit');await flush();
 for(const id of ['install-back','install-retry','install-ssh-port'])assert.equal(f.el(id).disabled,true,id);
 f.fire('install-back');assert.equal(f.el('connect-computer-form').hidden,true);
 finish({state:'available'});await flush();
 assert.equal(f.el('computer-install-details').hidden,false);
 assert.equal(f.el('ssh-target').dataset.serviceAddress,'https://test-pc:8877');
 f.el('ssh-password').value='secret';f.fire('install-details-back');
 assert.equal(f.el('computer-install-details').hidden,true);assert.equal(f.el('computer-address').value,'test-pc:8877');assert.equal(f.el('ssh-password').value,'');
});
for(const [result,action] of [[{state:'ready',releaseState:'unsupported'},'server'],[{state:'auth',release:{serverVersion:'1.1.0',clientMin:'1.1.0',clientMaxExclusive:'1.2.0'}},'client'],[{state:'ready',releaseState:'unknown'},'unknown']])test(`version ${action} guidance blocks opening a machine until resolved`,async()=>{
 const f=fixture(name=>{if(name==='service_probe')return result;if(name==='ssh_status')return {state:'available'};throw Error(name);});
 f.el('computer-address').value='test-pc:8877';f.fire('connect-computer-form','submit');await flush();
 assert.equal(f.el('compatibility-guide').hidden,false);assert.equal(f.profiles.length,0);assert.equal(f.selected.length,0);
 assert.equal(f.el('compatibility-client-help').hidden,action!=='client');
 assert.deepEqual(f.calls.map(c=>c.name),['service_probe']);
});

test('SSH usernames persist per host, survive reload, and can be forgotten without storing passwords',()=>{
 const stored=new Map(),f=fixture(()=>{}, {stored});
 f.el('ssh-target').value='100.64.10.10';f.el('ssh-user').value='demo-user';f.el('ssh-password').value='not-for-storage';f.fire('ssh-user','change');
 assert.equal(JSON.parse(stored.get('cr-ssh-usernames'))['100.64.10.10'],'demo-user');
 assert(!JSON.stringify([...stored]).includes('not-for-storage'));
 const next=fixture(()=>{}, {stored});next.el('ssh-target').value='100.64.10.10';next.el('ssh-target').dataset.serviceAddress='http://100.64.10.10:8787';
 next.window.dispatchEvent(new Event('cr-start-service'));
 assert.equal(next.el('ssh-user').value,'demo-user');
 next.el('ssh-target').value='100.64.10.15';next.fire('ssh-target','input');assert.equal(next.el('ssh-user').value,'');
 next.el('ssh-target').value='100.64.10.10';next.fire('ssh-target','input');assert.equal(next.el('ssh-user').value,'demo-user');
 next.fire('ssh-account-forget');assert.equal(next.el('ssh-user').value,'');assert.deepEqual(JSON.parse(stored.get('cr-ssh-usernames')),{});
});

test('first SSH fingerprint is remembered and startup continues without confirmation',async()=>{
 const stored=new Map();let probes=0,installs=0;
 const f=fixture((name,args)=>{
  if(name==='ssh_probe'){probes++;if(!args.target.trustedFingerprint)throw Error('SSH_TRUST:SHA256:abcdef');assert.equal(args.target.trustedFingerprint,'SHA256:abcdef');return {id:'plan',target:'user@host',platform:'darwin',arch:'arm64'};}
  if(name==='ssh_start'){installs++;return {address:'http://host:8787',reachable:false,detail:'installed'};}
 },{stored});
 f.el('ssh-target').value='host';f.el('ssh-user').value='user';f.el('ssh-password').value='secret';f.fire('ssh-form','submit');await flush();
 assert.equal(probes,2);assert.equal(installs,1);
 assert.match(f.el('ssh-settings-keys').textContent,/SHA256:abcdef/);
 assert(!f.el('ssh-preview').textContent.includes('SHA256'));
});
test('changed SSH identity blocks automatic trust',async()=>{
 const stored=new Map([['cr-ssh-host-keys',JSON.stringify([{host:'host',port:22,fingerprint:'SHA256:original'}])]]);let installs=0;
 const f=fixture(name=>{if(name==='ssh_probe')throw Error('SSH_TRUST:SHA256:changed');if(name==='ssh_start')installs++;},{stored});
 f.el('ssh-target').value='host';f.el('ssh-user').value='user';f.fire('ssh-form','submit');await flush();
 assert.equal(installs,0);assert.match(f.el('ssh-note').textContent,/身份发生变化/);
 assert.equal(JSON.parse(stored.get('cr-ssh-host-keys'))[0].fingerprint,'SHA256:original');
});

test('store client can connect without invoking SSH or host discovery',async()=>{
 let ready=false;
 const f=fixture(name=>{assert.equal(name,'service_probe');return ready?{state:'ready',name:'PC',release:{serverVersion:'1.0.0',clientMin:'1.0.0',clientMaxExclusive:'1.1.0'}}:{state:'unreachable'};},{web:false,store:true});
 f.el('computer-address').value='test-pc';f.fire('connect-computer-form','submit');await flush();
 assert.deepEqual(f.calls.map(c=>c.name),['service_probe']);
 assert.equal(f.el('install-ssh-check').hidden,true);assert.equal(f.el('computer-install-details').hidden,true);
 assert.match(f.el('connect-computer-status').textContent,/服务已启动/);
 f.window.dispatchEvent(new Event('cr-add-computer'));await flush();
 assert(!f.calls.some(c=>c.name==='tailscale_status'));
 ready=true;f.el('computer-address').value='test-pc';f.fire('connect-computer-form','submit');await flush();
 assert.equal(f.selected.length,1);
});

test('changed TLS identity blocks selection and offers explicit reset',async()=>{
 const f=fixture(name=>{if(name==='service_probe')throw Error('TLS_IDENTITY_CHANGED');if(name==='trust_fingerprint')return 'saved-public-key';throw Error(name);},{store:true});
 f.el('computer-address').value='test-pc';f.fire('connect-computer-form','submit');await flush();await flush();
 assert.equal(f.el('trust-change').hidden,false);assert.equal(f.selected.length,0);
 assert.deepEqual(f.calls.map(c=>c.name),['service_probe','trust_fingerprint']);
 f.window.dispatchEvent(new Event('cr-add-computer'));assert.equal(f.el('trust-change').hidden,true);
});
