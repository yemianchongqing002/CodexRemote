'use strict';
// Native identity comes only from the compiled Rust manifest. Web is a separate local development host.
window.Distribution=(()=>{
 const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
 let manifest=null,services=null;
 const web={schemaVersion:1,id:'web-local',platform:'web',channel:'local',branding:{productName:'Codex Remote Client'},modules:{billing:'disabled',ads:'disabled',analytics:'disabled',push:'disabled'},capabilities:{sshDeploy:true,systemDiscovery:true,embeddedTailscale:false,serverBundles:false},updates:'manual'};
 const ready=(window.__CLIENT_BRIDGE?.web?Promise.resolve(web):Runtime.invoke('distribution_info')).then(value=>{
  if(value?.schemaVersion!==1||!value.capabilities||typeof value.branding?.productName!=='string')throw Error('无法读取应用分发配置');
  services=createClientServices(value);manifest=freeze(value);
  document.title=manifest.branding.productName;
  for(const element of document.querySelectorAll('[data-distribution-capability]'))element.hidden=!manifest.capabilities[element.dataset.distributionCapability];
  if(manifest.channel==='appstore'){
   const input=document.getElementById('computer-address');if(input)input.placeholder='电脑 IP 或 https://电脑地址:8787';
   const help=document.getElementById('connection-network-help');if(help)help.textContent='新版服务默认使用 HTTPS 和本地证书，首次连接自动信任并保存身份。输入电脑 IP 即可，无需域名或修改 VPN 设置。旧服务可显式填写 HTTP 地址（协议本身不加密）。';
  }
  return manifest;
 });
 // Failure is visible and optional modules stay closed; never fall back to a more permissive channel.
 void ready.catch(()=>{const note=document.getElementById('connections-note');if(note)note.textContent='应用分发配置加载失败，请重新安装客户端。';});
 return Object.freeze({ready,async supports(capability){await ready;return manifest.capabilities[capability]===true;},get manifest(){return manifest;},get services(){return services;}});
})();
