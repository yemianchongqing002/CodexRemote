const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require('node:path').join(__dirname,'../ui/local-service.js'),'utf8');
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function fixture({supported=true,rows=[],active=null,address='https://127.0.0.1:23456',fail=false}={}){
 let consent;const gate=new Promise(resolve=>consent=resolve),calls=[],selected=[];
 const elements={'local-service-retry':{hidden:true,addEventListener(_name,fn){this.click=fn;}},'local-service-note':{textContent:''}};
 const current=rows.find(r=>r.id===active);
 const context={Distribution:{ready:Promise.resolve(),supports:async()=>supported},window:{ClientConsentBoot:gate,dispatchEvent(){}},Event:class{},document:{getElementById:id=>elements[id]},sessionStorage:{getItem:()=>active},Runtime:{hasConnection:!!current,normalizeAddress:v=>v,profiles:()=>rows,saveProfiles:v=>rows=v,invoke:async name=>{calls.push(name);if(fail)throw Error('service failed');return {address,notice:''};},select:async row=>selected.push(row)}};
 vm.runInNewContext(source,context);
 return {consent,calls,selected,elements,rows:()=>rows};
}
test('bundled service waits for consent and is not started on unsupported platforms',async()=>{
 const f=fixture();await flush();assert.equal(f.calls.length,0);f.consent();await flush();assert.deepEqual(f.calls,['local_service_start']);assert.equal(f.selected[0].id,'local-computer');
 const no=fixture({supported:false});no.consent();await flush();assert.equal(no.calls.length,0);
});
test('local port refresh preserves alias and does not take over a remote selection',async()=>{
 const f=fixture({active:'remote-computer',rows:[{id:'remote-computer',address:'https://example.test:8787'},{id:'local-computer',address:'https://127.0.0.1:11111',name:'我的 Mac'}]});
 f.consent();await flush();assert.equal(f.selected.length,0);assert.equal(f.rows().length,2);assert.equal(f.rows()[0].name,'我的 Mac');assert.equal(f.rows()[0].address,'https://127.0.0.1:23456');
});
test('restart reconnects an active local profile and launch failure never creates a fake connection',async()=>{
 const f=fixture({active:'local-computer',rows:[{id:'local-computer',address:'https://127.0.0.1:11111'}]});f.consent();await flush();assert.equal(f.selected.length,1);
 const failed=fixture({fail:true});failed.consent();await flush();assert.equal(failed.selected.length,0);assert.equal(failed.rows().length,0);assert.equal(failed.elements['local-service-note'].textContent,'service failed');assert.equal(failed.elements['local-service-retry'].disabled,false);
});
