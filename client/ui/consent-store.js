'use strict';
(function(root){
 function create(storage,version){
  const key='cr-consent-v1';
  function read(){try{const r=JSON.parse(storage.getItem(key));return r?.version===version&&r.accepted===true?r:null;}catch{return null;}}
  function write(r){storage.setItem(key,JSON.stringify(r));}
  return {
   read,
   accept(ai){write({version,accepted:true,ai:ai===true,acceptedAt:new Date().toISOString(),recipients:{}});},
   allows(origin,revision){const r=read();return !!(r?.ai&&r.recipients?.[origin]?.revision===revision);},
   grant(origin,revision){const r=read();if(!r?.ai)throw Error('请先开启 AI 数据共享许可');r.recipients||={};r.recipients[origin]={revision,at:new Date().toISOString()};write(r);},
   forget(origin){const r=read();if(r?.recipients){delete r.recipients[origin];write(r);}},
   revoke(){const r=read();if(r){r.ai=false;r.recipients={};write(r);}},
   reset(){storage.removeItem(key);}
  };
 }
 function sensitive(path,method){return !['GET','HEAD'].includes((method||'GET').toUpperCase())&&['/api/send','/api/thread/create','/api/upload-image','/api/upload-file','/api/queue/steer','/api/thread/approval'].includes(path.split('?')[0]);}
 const api={create,sensitive};if(typeof module==='object'&&module.exports)module.exports=api;else root.ConsentStore=api;
})(globalThis);
