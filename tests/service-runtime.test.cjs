const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');

test('service runtime uses same-origin HTTP, native browser storage and direct media',async()=>{
 const requests=[],localStorage={},sessionStorage={},document={hidden:false};
 const context=vm.createContext({localStorage,sessionStorage,document,location:{origin:'http://service:8787',host:'service:8787'},fetch:async(...args)=>{requests.push(args);return {ok:true};},EventSource:class{constructor(path){this.path=path;}}});
 vm.runInContext(fs.readFileSync('internal/server/web/runtime.js','utf8')+'\nglobalThis.runtime=Runtime;',context);
 const runtime=context.runtime;
 assert.equal(runtime.storage('local'),localStorage);
 assert.equal(runtime.storage('session'),sessionStorage);
 const signal=new AbortController().signal;
 assert.equal((await runtime.request('/api/status',{signal})).ok,true);
 assert.equal(requests[0][0],'/api/status');
 assert.equal(requests[0][1].credentials,'same-origin');
 assert.equal(requests[0][1].signal,signal);
 assert.equal(runtime.events('/api/events').path,'/api/events');
 const media={};runtime.setMedia(media,'/api/media?id=1');assert.equal(media.src,'/api/media?id=1');
 document.hidden=true;assert.equal(runtime.hidden,true);
 assert.equal(runtime.origin,'http://service:8787');
});
