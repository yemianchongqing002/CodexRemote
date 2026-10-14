'use strict';
(() => {
 const el=id=>document.getElementById(id),invoke=Runtime.invoke;
 let peers=[],busy=false,generation=0,chosenAddress='';
 let resetTargetAddress='',resetFingerprint='';
 async function identityError(error){
  if(!String(error?.message||error).includes('TLS_IDENTITY_CHANGED'))return;
  resetTargetAddress=chosenAddress;resetFingerprint=await invoke('trust_fingerprint',{address:chosenAddress});
  if(resetFingerprint)el('trust-change').hidden=false;
 }
 el('trust-reset')?.addEventListener('click',async()=>{
  if(busy||!resetFingerprint||chosenAddress!==resetTargetAddress)return;
  lock(true);
  try{await invoke('reset_trust',{address:resetTargetAddress,expected:resetFingerprint});sessionStorage.removeItem('cr-client-active');location.reload();}
  catch(e){el('trust-reset-status').textContent=String(e?.message||e);}
  finally{lock(false);}
 });
 function showTarget(){
  const host=new URL(chosenAddress).hostname.replace(/^\[|\]$/g,'');
  const peer=peers.find(p=>p.address===host||p.dns===host);
  const saved=Runtime.profiles().find(row=>row.address===chosenAddress);
  const name=saved?.name||saved?.serviceName||peer?.name||peer?.dns||'';
  el('install-target').textContent=name&&name!==host?name+'（'+host+'）':host;
  el('install-target').hidden=false;el('connection-discovery-help').hidden=true;
 }
 function resetTarget(){el('install-target').hidden=true;el('connection-discovery-help').hidden=false;}
 function showCompatibility(result){
  const check=Compatibility.evaluate(result);
  if(check.compatible)return false;
  el('connect-computer-form').hidden=true;el('computer-install-guide').hidden=true;el('computer-install-details').hidden=true;
  el('compatibility-guide').hidden=false;el('add-computer-title').textContent=check.action==='unknown'?'版本检查未完成':'版本不兼容';
  showTarget();el('connect-computer-status').textContent='';
  el('compatibility-note').textContent=check.message;
  el('compatibility-client-help').hidden=check.action!=='client';
  return true;
 }
 window.addEventListener('cr-compatibility-required',event=>{
  el('computer-switcher').close();
  if(!el('add-computer-dialog').open)el('add-computer-dialog').showModal();
  window.dispatchEvent(new Event('cr-add-computer'));
  chosenAddress=event.detail.address;el('computer-address').value=chosenAddress;
  showCompatibility(event.detail.result);
 });

 // All existing-computer failures enter the same add-computer diagnostic flow.
 let recovering=false;
 window.ConnectionRecovery={async recover(profile,{error,verify=false,restarting=false}={}){
  if(!profile||error?.name==='AbortError'||error?.status===401)return;
  if(recovering||busy||el('add-computer-dialog').open)return;
  const activeId=Runtime.profile?.id,version=generation;
  const stale=()=>Runtime.profile?.id!==activeId||generation!==version||el('add-computer-dialog').open;
  recovering=true;
  try{
   if(verify){
    el('guardian-note').textContent='正在重新检查目标服务…';
    for(let i=0;i<(restarting?3:1);i++){
     if(restarting)await new Promise(resolve=>setTimeout(resolve,1000));
     if(stale())return;
     let result;
     try{result=await invoke('service_probe',{address:profile.address});}catch{}
     if(stale())return;
     if(['ready','auth'].includes(result?.state)){
      if(!Compatibility.evaluate(result).compatible){
       window.dispatchEvent(new CustomEvent('cr-compatibility-required',{detail:{address:profile.address,result}}));
      }else el('guardian-note').textContent='目标服务可以连接，请重新检查服务状态。';
      return;
     }
    }
   }
   if(stale())return;
   el('settings-dialog').close();el('computer-switcher').close();
   el('add-computer-dialog').showModal();
   window.dispatchEvent(new Event('cr-add-computer'));
   el('computer-address').value=profile.address;
   el('connect-computer-form').dispatchEvent(new Event('submit',{cancelable:true}));
  }finally{recovering=false;}
 }};

 function peerName(p){return (p.name||p.dns||p.address)+(p.isSelf?' · 本机':'');}
 function suggestions(){
  const input=el('computer-address'),list=el('computer-options'),query=input.dataset.selectedAddress?'':input.value.trim().toLowerCase();
  list.replaceChildren();
  const matches=peers.filter(p=>[p.name,p.dns,p.address].some(v=>v?.toLowerCase().includes(query)));
  list.hidden=busy||!matches.length;
  for(const p of matches){
   const item=document.createElement('li'),button=document.createElement('button'),name=document.createElement('span'),ip=document.createElement('span');
   const label=peerName(p)+'（'+p.address+'）';button.type='button';button.className='computer-suggestion';button.title=label;
   name.className='computer-suggestion-name';name.textContent=peerName(p);ip.className='computer-suggestion-ip';ip.textContent='（'+p.address+'）';
   button.append(name,ip);item.append(button);list.append(item);
   button.addEventListener('click',()=>{if(busy)return;input.value=label;input.dataset.selectedAddress=p.address;input.focus();list.hidden=true;});
  }
 }
 function lock(value){busy=value;window.dispatchEvent(new CustomEvent('cr-connection-busy',{detail:value}));if(value)el('computer-options').hidden=true;for(const id of ['computer-address','connect-computer-submit','add-computer-close','install-back','install-retry','install-ssh-port','install-ssh-retry','compatibility-retry','compatibility-back'])el(id).disabled=value;el('connect-computer-submit').textContent=value?'正在连接…':'连接';}
 window.addEventListener('cr-network-status',event=>{
  peers=event.detail.state==='Running'?event.detail.peers||[]:[];
  if(el('add-computer-dialog').open)suggestions();
 });
 window.addEventListener('cr-add-computer',()=>{
  resetTarget();if(el('trust-change'))el('trust-change').hidden=true;resetFingerprint='';el('compatibility-guide').hidden=true;
  delete el('computer-address').dataset.selectedAddress;el('computer-options').hidden=true;
  generation++;el('ssh-bootstrap-guide').hidden=true;el('install-ssh-check').hidden=true;el('install-ssh-port').value='22';peers=[];chosenAddress='';el('connect-computer-form').reset();el('computer-options').replaceChildren();el('connect-computer-status').textContent='';el('computer-install-guide').hidden=true;el('computer-install-details').hidden=true;el('connect-computer-form').hidden=false;el('add-computer-title').textContent='添加新电脑';lock(false);void ConnectionNetwork.refresh().catch(()=>{});
 });
 el('computer-address').addEventListener('input',()=>{delete el('computer-address').dataset.selectedAddress;suggestions();el('computer-install-guide').hidden=true;el('computer-install-details').hidden=true;el('connect-computer-status').textContent='';});
 el('computer-address').addEventListener('focus',suggestions);
 el('add-computer-dialog').addEventListener('cancel',event=>{if(busy)event.preventDefault();});
 el('connect-computer-form').addEventListener('submit',async event=>{
  event.preventDefault();if(busy)return;const version=generation;
  el('compatibility-guide').hidden=true;
  el('computer-install-guide').hidden=true;el('computer-install-details').hidden=true;
  el('ssh-bootstrap-guide').hidden=true;el('install-ssh-check').hidden=true;el('install-progress').textContent='';
  try{
   if(window.Distribution)await window.Distribution.ready;
   chosenAddress=Runtime.normalizeAddress(el('computer-address').dataset.selectedAddress||el('computer-address').value);lock(true);el('connect-computer-status').textContent='正在检查电脑上的服务…';
   const result=await invoke('service_probe',{address:chosenAddress});if(version!==generation)return;
   if(result.state==='ready'||result.state==='auth'){
    if(showCompatibility(result))return;
    const host=new URL(chosenAddress).hostname.replace(/^\[|\]$/g,'');
    const peer=peers.find(p=>p.address===host||p.dns===host);
    const profile=Runtime.rememberComputer(chosenAddress,result.name||peer?.name||host);
    window.dispatchEvent(new Event('cr-profiles-changed'));el('connect-computer-status').textContent='正在打开电脑…';await Runtime.select(profile,result);
   }else{
    el('connect-computer-status').textContent='暂未连接到服务，正在检查目标电脑的 SSH 是否可达…';
    el('connect-computer-form').hidden=true;el('add-computer-title').textContent='连接检查';
    el('computer-install-guide').hidden=false;showTarget();

    await detectSSH(version);

   }
  }catch(e){el('connect-computer-status').textContent=String(e?.message||e);await identityError(e);}finally{lock(false);}
 });
 function showSSH(port=22){
  if(!chosenAddress)return;
  const host=new URL(chosenAddress).hostname;showTarget();
  el('computer-install-guide').hidden=true;el('connect-computer-form').hidden=true;el('computer-install-details').hidden=false;
  el('ssh-target').value=host;el('ssh-target').dataset.serviceAddress=chosenAddress;el('ssh-port').value=String(port);
  el('add-computer-title').textContent='启动服务';
  el('connect-computer-status').textContent='SSH 可连接。请使用目标电脑的账号登录：'+host;
  window.dispatchEvent(new Event('cr-start-service'));
 }
 async function detectSSH(version=generation){
  if(window.Distribution && !await window.Distribution.supports('sshDeploy')){
   if(version!==generation)return;
   el('install-ssh-check').hidden=true;el('ssh-bootstrap-guide').hidden=true;
   el('target-client-install-note').textContent='请先在目标电脑安装并启动 Codex Remote 服务，再返回这里重试连接。';
   el('connect-computer-status').textContent='暂未连接到服务。请确认目标电脑上的服务已启动，地址正确且网络可达，然后重试。';
   return;
  }
  el('compatibility-guide').hidden=true;
  const port=Number(el('install-ssh-port').value||22);el('install-ssh-retry').disabled=true;
  el('ssh-bootstrap-guide').hidden=true;el('install-ssh-check').hidden=false;
  el('install-progress').textContent='正在检测目标 SSH…';
  try{
   const result=await invoke('ssh_status',{address:chosenAddress,port});if(version!==generation)return;
   el('install-progress').textContent='';
   if(result.state==='available'){showSSH(port);return;}
   el('connect-computer-status').textContent='服务和 SSH 均未连接，暂时无法远程启动。';
   const host=new URL(chosenAddress).hostname.replace(/^\[|\]$/g,''),peer=peers.find(p=>p.address===host||p.dns===host);
   el('ssh-bootstrap-guide').hidden=false;el('install-ssh-check').hidden=false;
   const windows=!peer?.os||peer.os.toLowerCase()==='windows';
   el('ssh-bootstrap-note').textContent=result.state==='closed'
    ?'目标 SSH 端口拒绝连接。请确认 SSH 已开启，并核对端口。'+(windows?'Windows 请在目标电脑开启 OpenSSH Server，完成后重新检测。':'macOS 请在目标电脑开启远程登录。')
    :result.state==='unavailable'?'目标端口未返回有效 SSH 标识。请确认填写的是 SSH 端口，然后重新检测。'
    :'目标 SSH 无法连接。请先确认电脑已开机、地址正确、两端处于可互通的局域网或 Tailscale 网络，并检查防火墙和 SSH 端口。连接恢复后重新检测。';

  }catch(e){if(version===generation){el('connect-computer-status').textContent='尚未确认 SSH 可连接，请检查后重试。';el('install-progress').textContent=String(e?.message||e);}}
  finally{el('install-ssh-retry').disabled=false;}
 }
 el('install-ssh-retry').addEventListener('click',()=>{if(busy)return;lock(true);void detectSSH().finally(()=>lock(false));});
 function retry(){if(busy)return;el('connect-computer-form').dispatchEvent(new Event('submit',{cancelable:true}));}
 el('install-retry').addEventListener('click',retry);
 function back(){if(busy)return;resetTarget();if(el('trust-change'))el('trust-change').hidden=true;resetFingerprint='';el('compatibility-guide').hidden=true;generation++;el('computer-install-guide').hidden=true;el('computer-install-details').hidden=true;el('connect-computer-form').hidden=false;el('add-computer-title').textContent='添加新电脑';el('connect-computer-status').textContent='';el('computer-address').focus();}
 el('compatibility-retry').addEventListener('click',retry);
 el('compatibility-back').addEventListener('click',back);
 el('install-back').addEventListener('click',back);
 el('install-details-back').addEventListener('click',back);
})();
