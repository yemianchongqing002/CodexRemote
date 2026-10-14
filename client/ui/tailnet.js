'use strict';
// Shared discovery state. The computer picker and network settings never probe independently.
const ConnectionNetwork = (() => {
 const el = id => document.getElementById(id);
 let status = null, pending = null, revision = 0, changing = false, connecting = false;
 const controls = ['tailscale-mode','tailscale-refresh','tailscale-setup'];
 function lock() {for(const id of controls) el(id).disabled = connecting || changing || !!pending;}
 function publish(value) {
  status = value;
  const embedded = value.source === 'embedded', running = value.state === 'Running';
  el('tailscale-mode').hidden = !value.embeddedAvailable;
  el('tailscale-mode').textContent = embedded ? '使用系统网络' : '使用内嵌网络';
  el('tailscale-setup').hidden = running || value.state === 'Unsupported';
  el('tailscale-setup').textContent = embedded ? (value.authUrl ? '打开登录页' : '登录 Tailscale') : value.installed ? '打开 Tailscale' : '安装 Tailscale';
  const messages = {
   Unsupported:'请使用系统网络连接，并输入目标电脑的 IP 或主机名。',
   NotInstalled:'未检测到 Tailscale，请安装或使用内嵌网络。',
   NeedsLogin:'请登录自己的 Tailscale 账号。',
   NeedsMachineAuth:'请在 Tailscale 管理页面批准此设备。',
   Stopped:'系统 Tailscale 已停止，请打开并启用连接。',
   Unavailable:'无法读取系统 Tailscale 状态，请检查应用是否已启动。',
   Starting:'正在连接 Tailscale，请稍后重新检查。',
  };
  el('tailscale-note').textContent = running
   ? `${embedded ? '内嵌' : '系统'}网络已连接${value.ips?.[0] ? ' · '+value.ips[0] : ''}。请在上方选择电脑。`
   : messages[value.state] || '网络尚未就绪，请重新检查。';
  window.dispatchEvent(new CustomEvent('cr-network-status',{detail:value}));
  return value;
 }
 function refresh() {
  if(pending) return pending;
  const current = revision;
  pending = (async()=>{
   if(window.Distribution && !await window.Distribution.supports('systemDiscovery'))return {state:'Unsupported',source:'system',embeddedAvailable:false,peers:[],ips:[]};
   return Runtime.invoke('tailscale_status');
  })().then(value => {
   if(current === revision) publish(value);
   return value;
  }).catch(error => {
   if(current === revision) {publish({...status,state:'Unavailable',peers:[]});el('tailscale-note').textContent=String(error?.message||error);}
   throw error;
  }).finally(()=>{if(current === revision){pending=null;lock();}});
  lock();return pending;
 }
 async function changeMode() {
  if(changing || connecting) return;
  changing = true;revision++;pending = null;lock();
  try {publish(await Runtime.invoke('tailscale_mode',{mode:status?.source==='embedded' ? 'system' : 'embedded'}));}
  catch(error) {el('tailscale-note').textContent=String(error?.message||error);}
  finally {changing=false;lock();}
 }
 async function login() {
  if(changing || connecting) return;
  if(status?.source !== 'embedded') {
   if(!status?.installed)return Runtime.invoke('open_link',{url:'https://tailscale.com/download'});
   await Runtime.invoke('tailscale_open');
   el('tailscale-note').textContent=window.__CLIENT_BRIDGE?.web?'已打开网页服务所在电脑上的 Tailscale，请启用连接后点击“重新检查”。':'已打开 Tailscale，请启用连接后点击“重新检查”。';
   return;
  }
  if(status.authUrl) return Runtime.invoke('open_link',{url:status.authUrl});
  changing=true;lock();const current=revision;
  try {
   await Runtime.invoke('tailscale_login');
   for(let i=0;i<15 && current===revision && el('add-computer-dialog').open;i++) {
    await new Promise(resolve=>setTimeout(resolve,1000));
    const next=await refresh();if(next.authUrl || next.state==='Running')break;
   }
  } finally {changing=false;lock();}
 }
 el('tailscale-mode').addEventListener('click',changeMode);
 el('tailscale-refresh').addEventListener('click',()=>void refresh().catch(()=>{}));
 el('tailscale-setup').addEventListener('click',()=>void login().catch(error=>{el('tailscale-note').textContent=String(error?.message||error);}));
 el('tailnet-settings').addEventListener('toggle',()=>{if(el('tailnet-settings').open)void refresh().catch(()=>{});});
 window.addEventListener('focus',()=>{if(!document.hidden&&el('add-computer-dialog').open)void refresh().catch(()=>{});});
 window.addEventListener('cr-connection-busy',event=>{connecting=event.detail;lock();});
 return {refresh};
})();
