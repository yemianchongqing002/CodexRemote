async function json(response){let size=0,parts=[];for await(const chunk of response.body){size+=chunk.length;if(size>1024*1024)throw Error('服务响应过大');parts.push(chunk);}return JSON.parse(Buffer.concat(parts).toString());}
async function serviceProbe(address,fetch=globalThis.fetch){
 const result={address,state:'unreachable',name:'',release:null,releaseState:'unknown'};
 const get=path=>fetch(address+path,{redirect:'manual',signal:AbortSignal.timeout(5000)});
 try{
  const response=await get('/api/status');
  if(response.status===401)result.state='auth';
  else if(response.ok){const body=await json(response);if(body.adapter==='desktop-rollout'){result.state='ready';result.name=body.connectionName||body.hostName||'';result.release=body.release||null;result.releaseState=result.release?'available':'unsupported';}else result.state='other';}
  else result.state='other';
 }catch(e){if(String(e.cause?.message||e.message).includes('TLS_IDENTITY_CHANGED'))throw Error(e.cause?.message||e.message);return result;}
 if(result.state==='auth'){
  try{const response=await get('/api/version');
   if(response.status===404)result.releaseState='unsupported';
   else if(response.ok){const body=await json(response);if(body.adapter==='desktop-rollout'&&body.release){result.release=body.release;result.releaseState='available';}}
  }catch{ /* An unreadable current protocol response is not a successful probe. */ }
 }
 return result;
}
module.exports={serviceProbe};
