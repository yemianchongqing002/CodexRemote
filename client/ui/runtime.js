/* Shared platform boundary. Browser cookies stay in the browser; app cookies stay in Rust. */
const Runtime = (() => {
 const bridge=window.__TAURI__||window.__CLIENT_BRIDGE;
 if(!bridge?.core)throw Error('客户端桥接未加载，请通过网页客户端服务或原生 App 打开。');
 const invoke=async(name,args={})=>{if(!['distribution_info','open_link','pause_network','cancel_request','close_stream','deactivate'].includes(name))await window.ClientConsentBoot;return bridge.core.invoke(name,args);};
 const globalKeys=new Set(['codex-remote-mode','cr-send-shortcut','cr-open-position']);
 let profile=null,epoch=0,generation=0,paused=false,ready=Promise.resolve(),mediaBytes=0;
 let mediaQueue=Promise.resolve();const resources=new Map(),elements=new Map();
 const aborted=()=>new DOMException('操作已暂停','AbortError');
 function profiles(){try{const rows=JSON.parse(localStorage.getItem('cr-client-profiles')||'[]');return Array.isArray(rows)?rows.filter(p=>{try{return p && typeof p.id==='string' && /^[a-zA-Z0-9-]{8,64}$/.test(p.id) && normalizeAddress(p.address)===p.address;}catch{return false;}}).slice(0,20):[];}catch{return [];}}
 const id=sessionStorage.getItem('cr-client-active');profile=profiles().find(p=>p.id===id)||null;
 function storage(kind){
  const base=localStorage;
  const key=k=>globalKeys.has(k)?k:`cr-client:${profile?.id||'none'}:${k}`;
  return {getItem:k=>base.getItem(key(k)),setItem:(k,v)=>{if(!deleting)base.setItem(key(k),v);},removeItem:k=>base.removeItem(key(k))};
 }
 function saveProfiles(rows){localStorage.setItem('cr-client-profiles',JSON.stringify(rows));}
 let deleting=false;
 function connectionAddress(value){return normalizeAddress(value,{secure:true});}
 async function forgetComputer(row){
  if(!profiles().some(p=>p.id===row.id&&p.address===row.address))throw Error('连接已被移除');
  const active=profile?.id===row.id;
  if(active)deleting=true;
  try{
   if(active)await pause();
   await invoke('forget_connection',{address:row.address});
   window.ClientConsent?.forget(row.address);
   for(const base of [localStorage,sessionStorage]){
    const keys=Array.from({length:base.length},(_,i)=>base.key(i));
    for(const key of keys)if(key?.startsWith(`cr-client:${row.id}:`))base.removeItem(key);
   }
   saveProfiles(profiles().filter(p=>p.id!==row.id));
   if(sessionStorage.getItem('cr-client-active')===row.id)sessionStorage.removeItem('cr-client-active');
   if(active){clearMedia();location.reload();}
  }catch(e){deleting=false;if(active)await resume().catch(()=>{});throw e;}
 }
 function rememberComputer(value,name){
  const address=connectionAddress(value),rows=profiles();
  const existing=rows.find(row=>row.address===address);if(existing)return existing;
  if(rows.length>=20)throw Error('电脑列表已满，请先删除不再使用的电脑');
  const row={id:crypto.randomUUID(),address,name:'',serviceName:name||new URL(address).hostname};
  rows.push(row);saveProfiles(rows);return row;
 }
 function rename(value){const rows=profiles(),item=rows.find(p=>p.id===profile?.id);if(!item)throw Error('连接已被移除');item.name=value;saveProfiles(rows);profile=item;}
 function recordStatus(status){
  if(!profile)return;
  try{const rows=profiles();const item=rows.find(p=>p.id===profile.id);if(item){if(item.name===item.machine||item.name===item.serviceName||item.name===new URL(item.address).hostname)item.name='';item.lastConnected=Date.now();item.machine=status.hostName||'';item.serviceName=status.connectionName||'';saveProfiles(rows);profile=item;}}catch{}
 }
 function sweepMedia(){
  for(const [el,resource] of elements)if(!el.isConnected){resource.refs.delete(el);elements.delete(el);}
  for(const [key,resource] of resources)if(!resource.refs.size && resource.url){URL.revokeObjectURL(resource.url);mediaBytes-=resource.size;resources.delete(key);}
 }
 function clearMedia(){for(const resource of resources.values())if(resource.url)URL.revokeObjectURL(resource.url);resources.clear();elements.clear();mediaBytes=0;}
 async function pause(){
  paused=true;generation++;
  await invoke('pause_network',{epoch}).catch(()=>{});
 }
 async function resume(){
  if(!profile||document.hidden)return;
  await invoke('resume_network',{epoch});paused=false;
  for(const [el,resource] of [...elements])if(resource.failed&&el.isConnected)setMedia(el,resource.path);
 }
 if(profile){
  ready=invoke('activate',{address:normalizeAddress(profile.address)}).then(active=>{epoch=active.epoch;if(document.hidden)return pause();});
 }
 function bytes64(bytes){let result='';for(let i=0;i<bytes.length;i+=16384)result+=String.fromCharCode(...bytes.subarray(i,i+16384));return btoa(result);}
 async function request(path,options={}){
  await ready;
  if(!profile)throw Error('请先选择电脑');
  if(paused||document.hidden||options.signal?.aborted)throw aborted();
  const current=generation,requestId=crypto.randomUUID();
  let permission=null;
  if(window.ClientConsent&&ConsentStore.sensitive(path,options.method)){
   try{
   const response=await request('/api/privacy');
   if(!response.ok)throw Error('服务器未提供数据接收方说明，请更新服务器并配置隐私信息；本次内容没有发送。');
   const disclosure=await response.json();
   permission=await window.ClientConsent.authorize(profile.address,disclosure);
   const target=new URL(path,'https://local.invalid');target.searchParams.set('consentRevision',disclosure.revision);path=target.pathname+target.search;
   }catch(error){error.status=403;throw error;}
  }
  let body=null;
  if(options.body instanceof Blob)body=bytes64(new Uint8Array(await options.body.arrayBuffer()));
  else if(options.body!=null)body=bytes64(new TextEncoder().encode(options.body));
  if(options.signal?.aborted||paused||current!==generation)throw aborted();
  const cancel=()=>{void invoke('cancel_request',{requestId}).catch(()=>{});};
  options.signal?.addEventListener('abort',cancel,{once:true});
  try{
   if(permission!==null){try{window.ClientConsent.assertCurrent(permission);}catch(error){error.status=403;throw error;}}
   const response=await invoke('request',{epoch,requestId,path,method:options.method||'GET',body,contentType:new Headers(options.headers||{}).get('Content-Type')||'application/json'});
   if(current!==generation||paused||options.signal?.aborted)throw aborted();
   const bytes=Uint8Array.from(atob(response.body),c=>c.charCodeAt(0));
   return new Response(bytes,{status:response.status,headers:{'Content-Type':response.contentType}});
  }catch(e){if(current!==generation||paused||options.signal?.aborted||(e?.message||String(e))==='cancelled')throw aborted();throw e instanceof Error?e:Error(String(e));}
  finally{options.signal?.removeEventListener('abort',cancel);}
 }
 function events(path){
  const target=new EventTarget(),streamId=crypto.randomUUID(),current=generation;let closed=false;
  const result={onopen:null,onerror:null,addEventListener:(...args)=>target.addEventListener(...args),close(){closed=true;void invoke('close_stream',{streamId}).catch(()=>{});}};
  void ready.then(()=>{
   if(closed||paused||document.hidden||current!==generation)return;
   const channel=new bridge.core.Channel();
   channel.onmessage=message=>{
    if(closed||paused||current!==generation)return;
    if(message.kind==='open')result.onopen?.();
    else target.dispatchEvent(new MessageEvent(message.event,{data:message.data}));
   };
   return invoke('stream',{epoch,streamId,channel});
  }).catch(()=>{if(!closed&&!paused&&current===generation)result.onerror?.();});
  return result;
 }
 async function checkedMediaURL(path,{preview=false}={}){
  if(window.Distribution)await window.Distribution.ready;
  if(window.Distribution?.manifest?.channel==='appstore'){
   const url=new URL(path,location.origin);
   const localPreview=preview&&(url.protocol==='blob:'||/^data:image\//i.test(path));
   if(url.protocol!=='https:'&&!localPreview)throw Error('商店版仅支持 HTTPS 外部媒体，请使用提供有效证书的 HTTPS 地址。');
   if(url.username||url.password)throw Error('媒体地址不能包含登录凭据');
  }
  return path;
 }
 function serviceMediaPath(path){
  if(profile&&/^https?:\/\//i.test(path)){
   const u=new URL(path);
   if(!u.username&&!u.password&&!u.hash&&u.origin===profile.address&&['/api/media','/api/upload-image'].includes(u.pathname))return u.pathname+u.search;
  }
  return path;
 }
 function setMedia(el,path){
  path=serviceMediaPath(path);
  if(!path.startsWith('/api/')){
   void checkedMediaURL(path,{preview:true}).then(url=>{if(el.isConnected)el.src=url;}).catch(error=>el.dispatchEvent(new CustomEvent('error',{detail:{message:error.message}})));
   return;
  }
  const key=profile?.id+':'+path,current=generation;
  const old=elements.get(el);if(old)old.refs.delete(el);
  let resource=resources.get(key);
  if(!resource){
   resource={refs:new Set(),url:null,size:0,path,failed:false};resources.set(key,resource);
   resource.promise=mediaQueue.then(async()=>{
    if(current!==generation||paused||!resource.refs.size)throw aborted();
    const response=await request(path);
    if(!response.ok)throw Error(response.status===401?'登录已过期，请重新连接电脑':response.status===404?'目标电脑找不到此附件，或消息中的附件引用已失效':response.status===415?'服务器不支持此媒体格式或文件超过大小限制':`媒体请求失败（HTTP ${response.status}），请重试`);
    const blob=await response.blob();
    if(current!==generation||paused)throw aborted();
    if(!/^(image|video|audio)\//.test(blob.type)&&blob.type!=='application/ogg')throw Error('不支持的媒体类型');
    sweepMedia();if(mediaBytes+blob.size>64*1024*1024)throw Error('媒体较大，请关闭其他媒体后重试');
    resource.size=blob.size;resource.url=URL.createObjectURL(blob);mediaBytes+=blob.size;return resource.url;
   });
   mediaQueue=resource.promise.catch(()=>{});
  }
  resource.refs.add(el);elements.set(el,resource);
  resource.promise.then(url=>{if(el.isConnected&&current===generation&&elements.get(el)===resource)el.src=url;else sweepMedia();}).catch(error=>{
   resource.failed=true;if(resources.get(key)===resource)resources.delete(key);
   if(!el.isConnected||elements.get(el)!==resource)return;
   // A background cancellation is temporary: keep the player for resume().
   if(error.name==='AbortError'){
    if(!paused&&!document.hidden&&current!==generation)setMedia(el,path);
    return;
   }
   el.dispatchEvent(new CustomEvent('error',{detail:{message:error.message||'媒体下载失败，请检查目标电脑连接后重试'}}));
  });
 }
 async function downloadMedia(path,raw){
  path=serviceMediaPath(path);
  if(!path.startsWith('/api/')){await checkedMediaURL(path);await invoke('open_link',{url:path});return '已打开原始媒体，可在该页面保存';}
  const response=await request(path);
  if(!response.ok)throw Error(`媒体请求失败（HTTP ${response.status}）`);
  const blob=await response.blob();
  if(!/^(audio|video)\//.test(blob.type)&&blob.type!=='application/ogg')throw Error('返回内容不是音频或视频');
  let filename=raw.split(/[?#]/)[0].split(/[\\/]/).pop()||'media';
  try{filename=decodeURIComponent(filename);}catch{}
  filename=filename.replace(/[<>:"/\\|?*\x00-\x1f]/g,'_');
  if(window.__TAURI__){
   const saved=await invoke('save_media',{filename,body:bytes64(new Uint8Array(await blob.arrayBuffer()))});
   return '已保存到：'+saved;
  }
  const url=URL.createObjectURL(blob),link=document.createElement('a');
  link.href=url;link.download=filename;document.body.append(link);link.click();link.remove();
  setTimeout(()=>URL.revokeObjectURL(url),60000);return '已交给浏览器下载';
 }
 async function checkCompatibility(address,result){
  if(result!==undefined&&result.address!==address)throw Error('服务检查结果与所选电脑不一致');
  if(result===undefined)result=await invoke('service_probe',{address});
  if(!['ready','auth'].includes(result.state))throw Error('目标服务暂时无法连接，请检查网络和监听地址');
  const check=Compatibility.evaluate(result);
  if(!check.compatible){
   window.dispatchEvent(new CustomEvent('cr-compatibility-required',{detail:{address,result}}));
   throw Error(check.message);
  }
  return result;
 }
 async function select(next,result){
  if(next)await checkCompatibility(next.address,result);
  window.dispatchEvent(new Event('cr-before-switch'));
  await pause();await invoke('deactivate');
  if(next)sessionStorage.setItem('cr-client-active',next.id);else sessionStorage.removeItem('cr-client-active');
  location.reload();
 }
  document.addEventListener('visibilitychange',()=>{
   if(document.hidden){void pause();}
   else void ready.then(resume).then(()=>window.dispatchEvent(new Event('cr-visibilitychange'))).catch(()=>{});
  });
  window.addEventListener('pagehide',()=>{void pause();clearMedia();});
  if(bridge.event?.listen)void bridge.event.listen('client-focus',event=>{
   if(!event.payload){void pause();window.dispatchEvent(new Event('cr-visibilitychange'));}
   else void ready.then(resume).then(()=>window.dispatchEvent(new Event('cr-visibilitychange'))).catch(()=>{});
  });
  document.addEventListener('click',event=>{const link=event.target.closest?.('a[href]');if(link&&/^https?:/.test(link.href)){event.preventDefault();void invoke('open_link',{url:link.href}).catch(()=>{});}});
 return {invoke,ready,profiles,saveProfiles,rememberComputer,rename,normalizeAddress:connectionAddress,forgetComputer,storage,request,events,setMedia,downloadMedia,sweepMedia,select,recordStatus,checkCompatibility,
  get profile(){return profile;},get hasConnection(){return !!profile;},get hidden(){return document.hidden||paused;},
  get origin(){return profile?.address||'';},get host(){return profile?new URL(profile.address).host:'未选择电脑';}};
})();
