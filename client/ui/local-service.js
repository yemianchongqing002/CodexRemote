'use strict';
// Both native desktop channels use the same bundled-service startup path.
(() => {
 const button=document.getElementById('local-service-retry'),note=document.getElementById('local-service-note');
 let busy=false;
 async function start(){
  if(busy)return;busy=true;button.disabled=true;
  try{
   await Distribution.ready;
   if(!await Distribution.supports('localService'))return;
   await window.ClientConsentBoot;
   button.hidden=false;note.textContent='正在启动本机服务…';
   const result=await Runtime.invoke('local_service_start');
   const address=Runtime.normalizeAddress(result.address);
   const rows=Runtime.profiles(),previous=rows.find(row=>row.id==='local-computer');
   const row={...previous,id:'local-computer',address,name:previous?.name||'本机',serviceName:'本机服务'};
   const others=rows.filter(item=>item.id!==row.id);
   if(!previous&&others.length>=20)throw Error('连接列表已满，请先删除一个连接再启动本机服务');
   Runtime.saveProfiles([row,...others]);
   window.dispatchEvent(new Event('cr-profiles-changed'));
   note.textContent=result.notice||'本机服务已就绪，退出 App 时自动停止。';
   const active=sessionStorage.getItem('cr-client-active');
   if(!Runtime.hasConnection||(active===row.id&&previous?.address!==row.address)){
    await Runtime.select(row);
   }
  }catch(e){note.textContent=String(e?.message||e);}
  finally{busy=false;button.disabled=false;}
 }
 button.addEventListener('click',start);
 void start();
})();
