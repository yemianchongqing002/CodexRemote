'use strict';
(async () => {
 if(window.Distribution && !await window.Distribution.supports("sshDeploy"))return;
 const el=id=>document.getElementById(id),invoke=Runtime.invoke;
 let busy=false,connectedProfile=null;
 const fields=['ssh-target','ssh-user','ssh-mode','ssh-password','ssh-port'];
 const hostKeyStore='cr-ssh-host-keys';
 function hostKeys(){try{const rows=JSON.parse(localStorage.getItem(hostKeyStore)||'[]');return Array.isArray(rows)?rows.filter(row=>typeof row.host==='string'&&typeof row.fingerprint==='string'):[];}catch{return [];}}
 function hostIdentity(){return {host:accountHost(),port:Number(el('ssh-port').value)||22};}
 function savedFingerprint(){const target=hostIdentity();return hostKeys().find(row=>row.host===target.host&&row.port===target.port)?.fingerprint||'';}
 function rememberFingerprint(value){const target=hostIdentity(),rows=hostKeys().filter(row=>row.host!==target.host||row.port!==target.port);rows.push({...target,fingerprint:value});localStorage.setItem(hostKeyStore,JSON.stringify(rows));renderHostKeys();}
 function renderHostKeys(){
  el('ssh-settings-keys').textContent=hostKeys().map(row=>`${row.host}:${row.port}\n${row.fingerprint}`).join('\n\n')||'此客户端尚未记录 SSH 主机指纹。';
 }
 renderHostKeys();
 const accountKey='cr-ssh-usernames';
 let managedKeys=[],keyBusy=false;
 async function refreshManagedKeys(){
  if(!window.__CLIENT_BRIDGE?.web){el('ssh-key-setup-form').hidden=true;el('ssh-managed-key-note').textContent='此原生版本使用本机已有的 SSH 密钥。自动创建和配置目前可在网页客户端中使用。';return;}
  try{const result=await invoke('ssh_key_status',{});managedKeys=result.keys||[];
   el('ssh-managed-key-list').textContent=managedKeys.length?managedKeys.map(row=>`${row.username}@${row.host}:${row.port} · 已验证免密连接\n私钥位置：${row.path}\n登录公钥指纹：${row.fingerprint}`).join('\n\n'):'尚未配置登录密钥。填写下方账号密码后创建。';
  }catch{el('ssh-managed-key-list').textContent='无法读取登录密钥，请确认网页客户端服务已更新。';}
 }
 function useManagedKey(){
  const user=el('ssh-user').value.trim(),host=accountHost(),port=Number(el('ssh-port').value)||22;
  if(managedKeys.some(row=>row.host.toLowerCase()===host&&row.port===port&&row.username===user)){el('ssh-mode').value='key';mode();}
 }
 for(const button of document.querySelectorAll?.('[data-open-settings]')||[])button.addEventListener('click',()=>{
  const address=Runtime.profile?.address;
  if(address){el('ssh-key-host').value=new URL(address).hostname;const rows=accounts();el('ssh-key-user').value=rows[el('ssh-key-host').value]||'';}
  void refreshManagedKeys();
 });
 el('ssh-key-setup-form').addEventListener('submit',async event=>{
  event.preventDefault();if(keyBusy)return;keyBusy=true;
  const fields=['ssh-key-host','ssh-key-user','ssh-key-port','ssh-key-password','ssh-key-create'];for(const id of fields)el(id).disabled=true;
  const host=el('ssh-key-host').value.trim().replace(/^\[|\]$/g,'').toLowerCase(),username=el('ssh-key-user').value.trim(),port=Number(el('ssh-key-port').value)||22;
  const rows=hostKeys(),saved=rows.find(row=>row.host===host&&row.port===port);
  const target={target:username+'@'+(host.includes(':')?'['+host+']':host),port,mode:'password',password:el('ssh-key-password').value,trustedFingerprint:saved?.fingerprint||''};
  el('ssh-key-progress').textContent='正在登录、配置公钥并验证免密连接…';
  try{
   let result;
   try{result=await invoke('ssh_key_setup',{target});}
   catch(error){
    const message=String(error.message||error),match=/^SSH_TRUST:(SHA256:[A-Za-z0-9+/]+)$/.exec(message);
    if(!match)throw error;
    if(saved&&saved.fingerprint!==match[1])throw Error('目标 SSH 身份发生变化，已停止配置');
    target.trustedFingerprint=match[1];localStorage.setItem(hostKeyStore,JSON.stringify([...rows.filter(row=>row.host!==host||row.port!==port),{host,port,fingerprint:match[1]}]));renderHostKeys();
    result=await invoke('ssh_key_setup',{target});
   }
   const users=accounts();Object.defineProperty(users,host,{value:username,enumerable:true,configurable:true});
   try{localStorage.setItem(accountKey,JSON.stringify(users));}catch{}
   el('ssh-key-progress').textContent='免密连接验证成功。以后连接这台电脑将自动使用该密钥。';
   await refreshManagedKeys();useManagedKey();
  }catch(error){el('ssh-key-progress').textContent='配置未完成：'+String(error.message||error);}
  finally{target.password='';el('ssh-key-password').value='';keyBusy=false;for(const id of fields)el(id).disabled=false;}
 });

 function accountHost(){return el('ssh-target').value.trim().split('@').pop().replace(/^\[|\]$/g,'').replace(/\.$/,'').toLowerCase();}
 function accounts(){try{const value=JSON.parse(localStorage.getItem(accountKey)||'{}');return value&&typeof value==='object'&&!Array.isArray(value)?value:{};}catch{return {};}}
 function accountNote(saved=false){
  el('ssh-account-note').textContent=saved?'用户名已记在'+(window.__CLIENT_BRIDGE?.web?'当前浏览器':'此设备')+'，下次连接此电脑会自动填入。密码不保存。':'用户名会按电脑保存在'+(window.__CLIENT_BRIDGE?.web?'当前浏览器':'此设备')+'，密码不保存。';
  el('ssh-account-forget').hidden=!Object.hasOwn(accounts(),accountHost());
 }
 function rememberAccount(){
  const host=accountHost(),user=el('ssh-user').value.trim()||el('ssh-target').value.trim().split('@').slice(0,-1).join('@');
  if(!host)return;
  const rows=accounts();delete rows[host];
  if(user)Object.defineProperty(rows,host,{value:user,enumerable:true,configurable:true,writable:true});
  try{localStorage.setItem(accountKey,JSON.stringify(Object.fromEntries(Object.entries(rows).slice(-100))));accountNote(!!user);}
  catch{el('ssh-account-note').textContent='本地存储不可用，用户名仅用于本次连接。';}
 }
 function restoreAccount(){
  const rows=accounts(),host=accountHost();
  el('ssh-user').value=!el('ssh-target').value.includes('@')&&Object.hasOwn(rows,host)&&typeof rows[host]==='string'?rows[host]:'';
  accountNote(!!el('ssh-user').value);useManagedKey();
 }
 el('ssh-user').addEventListener('change',()=>{rememberAccount();useManagedKey();});
 el('ssh-account-forget').addEventListener('click',()=>{if(busy)return;el('ssh-user').value='';const rows=accounts();delete rows[accountHost()];try{localStorage.setItem(accountKey,JSON.stringify(rows));accountNote();}catch{el('ssh-account-note').textContent='无法清除本地记录，请检查浏览器存储设置。';}});
 accountNote();

 el('ssh-deployment').hidden=false;
 if(window.__CLIENT_BRIDGE?.web)el('ssh-note').textContent='通过运行网页服务的电脑连接目标 SSH，启动目标电脑已安装的服务。';
 function lock(value){busy=value;window.dispatchEvent(new CustomEvent('cr-connection-busy',{detail:value}));for(const id of [...fields,'ssh-probe','add-computer-close','install-details-back','ssh-connect-retry'])el(id).disabled=value;}
 function resetConnection(){connectedProfile=null;el('ssh-connect-retry').hidden=true;el('ssh-form').hidden=false;el('ssh-password').value='';clear();}
 function clear(){el('ssh-preview').textContent='';}
 function mode(){
  const value=el('ssh-mode').value,web=!!window.__CLIENT_BRIDGE?.web;
  el('ssh-password-field').hidden=value!=='password';el('ssh-password').required=value==='password';
  el('ssh-mode-help').textContent=value==='tailscale'
   ?'当前使用 Tailscale 身份认证。双方需登录 Tailscale，目标需启用 Tailscale SSH。Windows 和图形版 macOS 目标请选择账号密码或 SSH 密钥。'
   :value==='key'?(web?'当前使用 SSH 密钥认证：密钥位于运行网页服务的电脑上，不在此浏览器中。':'当前使用 SSH 密钥认证：使用此设备已有的 SSH 密钥或 SSH agent。')
   :'当前使用账号密码认证。填写目标电脑的登录账号和 SSH 密码。';
  el('ssh-key-location').hidden=value!=='key';
  el('ssh-key-location').textContent=web
   ?'密钥来源：运行网页服务的账号所使用的 SSH agent，或该账号主目录中的 ~/.ssh/id_ed25519、~/.ssh/id_rsa。可在设置 → 连接管理 → 免密连接 中创建专用登录密钥并配置目标电脑；私钥保存在网页服务电脑的 ~/.config/codex-remote/ssh-keys，不发送到浏览器或目标电脑。'
   :'密钥来源：此设备的 SSH agent，或系统 SSH 配置中 IdentityFile 指定的文件（通常在用户主目录的 .ssh 文件夹）。当前不会自动生成、复制或另存私钥；私钥不会发送到目标电脑。加密私钥需先加入 SSH agent。';
  el('ssh-credential-privacy').textContent=value==='password'
   ?(web?'密码经运行网页服务的电脑用于本次 SSH 登录，不写入配置或日志。请仅使用你信任的网页客户端服务。':'密码仅在本次 SSH 登录过程中使用，不写入配置或日志。')
   :value==='key'?'认证通过密钥签名完成，不向目标发送私钥，密码不保存，用户名仅记在本地以便下次填写。':'此模式通过 Tailscale 身份认证，不使用账号密码或私钥；用户名仅记在本地以便下次填写。';
  el('ssh-trust-storage').textContent=web
   ?'SSH 主机指纹保存在当前浏览器，连接时自动核对，可在设置 → 连接管理 → 免密连接 中查看。首次连接自动记录；身份变化时停止连接。'
   :'SSH 主机指纹保存在客户端应用数据目录的 ssh_known_hosts，同时读取系统 ~/.ssh/known_hosts。本客户端首次记录的指纹可在设置 → 连接管理 → 免密连接 中查看。首次连接自动记录；身份变化时停止连接。';
  if(value!=='password')el('ssh-password').value='';
 }

 for(const id of fields)el(id).addEventListener('input',clear);
 el('ssh-mode').addEventListener('change',()=>{clear();mode();});mode();
 void refreshManagedKeys().then(useManagedKey);
 async function start(trustedFingerprint=''){
  if(busy||connectedProfile)return;clear();lock(true);el('ssh-note').textContent='1/3 正在连接电脑并识别系统…';
  try{
   const host=el('ssh-target').value.trim(),user=el('ssh-user').value.trim();
   if(user&&host.includes('@'))throw Error('地址中已有用户名，请清空单独的用户名，或只填写电脑地址。');
   const chosen=await invoke('ssh_probe',{target:{address:el('ssh-target').dataset.serviceAddress||undefined,target:user?`${user}@${host}`:host,port:el('ssh-port').value?Number(el('ssh-port').value):null,mode:el('ssh-mode').value,password:el('ssh-password').value,trustedFingerprint:trustedFingerprint||savedFingerprint()}});
   rememberAccount();
   el('ssh-password').value='';
   if(chosen.tailscaleState&&chosen.tailscaleState!=='Running')el('tailscale-note').textContent=chosen.tailscaleState==='NotInstalled'?'目标电脑未检测到 Tailscale。本次通过当前网络启动；要使用 Tailscale，请按下方说明在目标安装并登录，再重新检测。':'目标电脑的 Tailscale 尚未确认连接，请在目标打开应用并检查登录状态。本次继续使用当前网络启动。';
   el('ssh-preview').textContent=`${chosen.target} · ${chosen.platform==='darwin'?'macOS':'Windows'} ${chosen.arch}`;
   el('ssh-note').textContent='2/3 正在启动目标电脑已安装的服务，请保持客户端打开…';
   const result=await invoke('ssh_start',{id:chosen.id});
   const profile=Runtime.rememberComputer(result.address,chosen.target);
   connectedProfile=profile;el('ssh-form').hidden=true;el('ssh-connect-retry').hidden=false;
   window.dispatchEvent(new Event('cr-profiles-changed'));el('ssh-note').textContent='3/3 '+result.detail;
   if(result.reachable)await Runtime.select(profile);
  }catch(e){
   const message=String(e?.message||e);
   if(/^SSH_TRUST:SHA256:[A-Za-z0-9+/]+$/.test(message)){
    const received=message.slice('SSH_TRUST:'.length),saved=savedFingerprint();
    if((saved&&saved!==received)||trustedFingerprint){
     el('ssh-password').value='';el('ssh-note').textContent='SSH 主机身份发生变化，已停止连接。请在设置 → 连接管理 → 免密连接 中核对记录，并检查目标电脑。';
    }else{
     try{rememberFingerprint(received);}catch{el('ssh-note').textContent='无法在本地保存 SSH 主机指纹，请允许本地存储后重试。';return;}
     lock(false);return await start(received);
    }
   }else{el('ssh-password').value='';el('ssh-note').textContent=/All configured authentication methods failed/.test(message)?(el('ssh-mode').value==='key'?'SSH 密钥登录失败：运行客户端的电脑没有可用密钥，或目标账号未授权该密钥。请改用账号密码连接，或配置 SSH 密钥后重试。':el('ssh-mode').value==='password'?'SSH 账号密码登录失败：请核对目标电脑的用户名、登录密码和远程登录权限。':'Tailscale SSH 身份认证失败：请检查目标是否启用 Tailscale SSH，以及访问规则是否允许此账号。'):message;

   }
  }finally{lock(false);}
 }

 el('ssh-connect-retry').addEventListener('click',async()=>{
  if(busy||!connectedProfile)return;
  lock(true);el('ssh-note').textContent='正在检查目标服务…';
  try{
   const result=await invoke('service_probe',{address:connectedProfile.address});
   if(result.state==='ready'||result.state==='auth')await Runtime.select(connectedProfile);
   else el('ssh-note').textContent='连接已保存，但仍无法访问 '+connectedProfile.address+'。请检查目标电脑和网络后重试连接。';
  }catch(e){el('ssh-note').textContent='连接未成功：'+String(e?.message||e);}
  finally{lock(false);}
 });
 el('install-details-back').addEventListener('click',()=>{if(!busy)resetConnection();});

 el('ssh-target').addEventListener('input',()=>{restoreAccount();delete el('ssh-target').dataset.serviceAddress;});
 window.addEventListener('cr-start-service',()=>{
  const fixed=!!el('ssh-target').dataset.serviceAddress;
  el('ssh-deployment').classList.toggle('known-target',fixed);el('ssh-target').readOnly=fixed;
  resetConnection();restoreAccount();el('ssh-note').textContent='';
 });
 window.addEventListener('cr-add-computer',()=>{
  el('ssh-deployment').classList.remove('known-target');el('ssh-target').readOnly=false;delete el('ssh-target').dataset.serviceAddress;
  el('ssh-user').value='';resetConnection();accountNote();
 });
 el('add-computer-dialog').addEventListener('cancel',event=>{if(busy)event.preventDefault();});
 el('ssh-form').addEventListener('submit',event=>{event.preventDefault();start();});
})().catch(error=>{console.error("Deployment module unavailable",error);});
