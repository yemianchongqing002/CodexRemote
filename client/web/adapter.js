/* Browser-only platform adapter. UI and state remain in the shared frontend. */
(() => {
 // HTTP over a tailnet is not a browser secure context. Random bytes remain available.
 if(!crypto.randomUUID)crypto.randomUUID=()=>{const bytes=crypto.getRandomValues(new Uint8Array(16));bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;const hex=Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;};
 const key=window.__CLIENT_WEB_KEY;delete window.__CLIENT_WEB_KEY;
 let session=sessionStorage.getItem('cr-web-session');if(!session){session=crypto.randomUUID();sessionStorage.setItem('cr-web-session',session);}
 let epoch=0;const streams=new Map();
 async function rpc(name,args={},signal){
  const response=await fetch('/bridge',{method:'POST',headers:{'Content-Type':'application/json','X-Client-Key':key,'X-Client-Session':session},body:JSON.stringify({name,args:{epoch,...args}}),signal});
  if(!response.ok){const e=await response.json();throw Error(e.error||'客户端连接失败');}return response;
 }
 async function invoke(name,args={}){
  if(name==='open_link'){
   const url=args.url;
   if(!/^https?:\/\//.test(url))throw Error('不支持的链接');window.open(url,'_blank','noopener,noreferrer');return;
  }
  if(name==='stream'){
   const controller=new AbortController();streams.set(args.streamId,controller);
   try{
    const response=await rpc('stream',{epoch:args.epoch,streamId:args.streamId},controller.signal);args.channel.onmessage?.({kind:'open'});
    const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
    while(true){const {value,done}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true}).replace(/\r\n/g,'\n');if(buffer.length>2*1024*1024)throw Error('事件过大');let end;while((end=buffer.indexOf('\n\n'))>=0){const block=buffer.slice(0,end);buffer=buffer.slice(end+2);let event='message',data=[];for(const line of block.split('\n')){if(line.startsWith('event:'))event=line.slice(6).trim();if(line.startsWith('data:'))data.push(line.slice(5).replace(/^ /,''));}if(data.length)args.channel.onmessage?.({kind:'event',event,data:data.join('\n')});}}
   }finally{streams.delete(args.streamId);}return;
  }
  if(name==='close_stream'){streams.get(args.streamId)?.abort();return;}
  if(name==='pause_network'||name==='deactivate'){for(const c of streams.values())c.abort();streams.clear();}
  const result=await (await rpc(name,args)).json();if(name==='activate')epoch=result.epoch;return result;
 }
 window.__CLIENT_BRIDGE={core:{invoke,Channel:class{onmessage=null;}},web:true};
})();
