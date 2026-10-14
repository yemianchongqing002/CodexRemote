'use strict';
function normalizeAddress(value,{secure=true}={}){
  let raw=value.trim();
  if(!raw||/\s/.test(raw))throw Error('请输入电脑的 IP 或主机名');
  if(!/^https?:\/\//i.test(raw)){
   if(raw.includes('://'))throw Error('仅支持 HTTP/HTTPS 地址');
   if((raw.match(/:/g)||[]).length>1&&!raw.startsWith('['))raw='['+raw+']';
   const input=new URL((secure?'https://':'http://')+raw);if(!input.port)input.port='8787';raw=input.href;
  }
  const u=new URL(raw);
  if(!['http:','https:'].includes(u.protocol)||!u.hostname||u.username||u.password||u.search||u.hash||u.pathname!=='/')throw Error('地址只填写协议、主机和端口，例如 http://100.100.100.100:8787');

  return u.origin;
 }
if(typeof module!=='undefined')module.exports=normalizeAddress;
