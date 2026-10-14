'use strict';
// TLS authenticates possession of the private key; TOFU binds its SPKI to an origin.
const tls=require('node:tls'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {X509Certificate,createHash}=require('node:crypto');
const {Agent,fetch}=require('undici');
class Trust {
 constructor(dial,dir=path.join(os.homedir(),'.config','codex-remote-client','trust')){this.dial=dial;this.dir=dir;this.agents=new Map();this.generation=0;}
 file(origin){return path.join(this.dir,createHash('sha256').update(origin).digest('hex')+'.json');}
 read(origin){try{return JSON.parse(fs.readFileSync(this.file(origin),'utf8')).pin;}catch(e){if(e.code==='ENOENT')return null;throw Error('服务器身份记录损坏，连接已阻止');}}
 check(origin,pin){
  const old=this.read(origin);if(old&&old!==pin)throw Error('TLS_IDENTITY_CHANGED：服务器身份已变化，连接已阻止');
  if(!old){fs.mkdirSync(this.dir,{recursive:true,mode:0o700});try{fs.writeFileSync(this.file(origin),JSON.stringify({pin}),{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST')throw e;if(this.read(origin)!==pin)throw Error('TLS_IDENTITY_CHANGED：服务器身份已变化');}}
 }
 async reset(origin,expected){if(this.read(origin)!==expected)throw Error('身份记录已变化');this.generation++;await this.close();fs.unlinkSync(this.file(origin));}
 async close(){const agents=[...this.agents.values()];this.agents.clear();await Promise.all(agents.map(a=>a.destroy()));}
 fetch(url,options){
  const u=new URL(url),origin=u.origin;let agent=this.agents.get(origin);
  if(!agent){
   agent=new Agent({connect:(opts,callback)=>{
    const generation=this.generation;let done=false,socket;
    const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);if(error)socket?.destroy();callback(error,value);};
    const timer=setTimeout(()=>finish(Error('TLS connection timed out')),8000);
    void (async()=>{
     const raw=await this.dial(u.hostname.replace(/^\[|\]$/g,''),Number(u.port||443));
     if(done){raw.destroy();return;}
     socket=tls.connect({socket:raw,servername:require('node:net').isIP(u.hostname.replace(/^\[|\]$/g,''))?undefined:u.hostname,rejectUnauthorized:false,minVersion:'TLSv1.2',ALPNProtocols:['http/1.1']});
     socket.once('error',e=>finish(e));
     socket.once('secureConnect',()=>{try{
      if(generation!==this.generation)throw Error('身份已重置，请重新连接');
      const cert=new X509Certificate(socket.getPeerCertificate().raw);
      if(Date.now()<Date.parse(cert.validFrom)||Date.now()>Date.parse(cert.validTo))throw Error('服务器证书过期或尚未生效');
      const pin=createHash('sha256').update(cert.publicKey.export({type:'spki',format:'der'})).digest('hex');
      this.check(origin,pin);finish(null,socket);
     }catch(e){finish(e);}});
    })().catch(e=>finish(e));
   }});this.agents.set(origin,agent);
  }
  return fetch(url,{...options,dispatcher:agent}).catch(e=>{if(String(e.cause?.message||e.message).includes("TLS_IDENTITY_CHANGED"))throw Error(e.cause?.message||e.message);throw e;});
 }
}
module.exports={Trust};
