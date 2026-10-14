/* Versions describe software releases, never the chat-store revision. */
const Compatibility=(()=>{
 const clientVersion='1.0.0',serverMin='1.0.0',serverMaxExclusive='1.1.0';
 function parse(v){if(typeof v!=='string'||!/^\d+\.\d+\.\d+$/.test(v))return null;const parts=v.split('.').map(Number);return parts.every(Number.isSafeInteger)?parts:null;}
 function compare(a,b){const x=parse(a),y=parse(b);if(!x||!y)throw Error('版本格式无效');for(let i=0;i<3;i++)if(x[i]!==y[i])return x[i]<y[i]?-1:1;return 0;}
 function evaluate(result){
  const info=result.release;
  const base={clientVersion,serverVersion:info?.serverVersion||'未知',action:'unknown',compatible:false};
  if(!info)return {...base,action:result.releaseState==='unsupported'?'server':'unknown',message:result.releaseState==='unsupported'?'目标服务未提供软件版本信息，请在目标电脑更新 Codex Remote 客户端并启动服务。':'无法读取目标服务版本，请重新检测；暂不连接或启动服务。'};
  if(![info.serverVersion,info.clientMin,info.clientMaxExclusive].every(parse)||compare(info.clientMin,info.clientMaxExclusive)>=0)return {...base,message:'目标服务返回的兼容范围无效，请检查服务版本后重试。'};
  const range=`${info.clientMin} ≤ 客户端版本 < ${info.clientMaxExclusive}`;
  const details=`当前客户端 ${clientVersion}；目标服务 ${info.serverVersion}；目标支持 ${range}。`;
  const needClient=compare(clientVersion,info.clientMin)<0||compare(info.serverVersion,serverMaxExclusive)>=0;
  const needServer=compare(clientVersion,info.clientMaxExclusive)>=0||compare(info.serverVersion,serverMin)<0;
  if(needClient&&needServer)return {...base,message:details+' 双方兼容范围冲突，请确认配套版本后再连接。'};
  if(needClient)return {...base,action:'client',message:details+' 当前客户端版本过旧，请更新正在使用的网页或桌面客户端。'};
  if(needServer)return {...base,action:'server',message:details+' 目标服务版本过旧，请在目标电脑更新 Codex Remote 客户端并启动服务。'};
  return {...base,compatible:true,action:'none',message:details+' 版本兼容。'};
 }
 return {clientVersion,serverMin,serverMaxExclusive,evaluate,compare};
})();
if(typeof module!=='undefined'&&module.exports)module.exports=Compatibility;
