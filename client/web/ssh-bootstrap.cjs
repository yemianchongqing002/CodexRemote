const net=require('node:net');
function sshStatus({address,port=22},dial){
 const url=new URL(address),host=url.hostname.replace(/^\[|\]$/g,'');
 if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw Error('目标地址无效');
 if(!Number.isInteger(port)||port<1||port>65535)throw Error('SSH 端口无效');
 return (async()=>{
 let socket;try{socket=dial?await dial(host,port):net.createConnection({host,port});}catch{return {state:'unreachable',port};}
 return new Promise(resolve=>{
  let text='',done=false;
  const finish=state=>{if(done)return;done=true;clearTimeout(timer);socket.destroy();resolve({state,port});};
  const timer=setTimeout(()=>finish('unreachable'),4500);
  socket.on('data',chunk=>{text+=chunk.toString('ascii');if(text.split(/\r?\n/).some(line=>/^SSH-(2\.0|1\.99)-[^\r\n]+$/.test(line)))finish('available');else if(text.length>8192)finish('unavailable');});
  socket.on('error',e=>finish(e.code==='ECONNREFUSED'?'closed':'unreachable'));
  socket.on('end',()=>finish('unavailable'));
 });
 })();
}
module.exports={sshStatus};
