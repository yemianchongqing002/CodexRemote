// Own node identity, separate from the user's system Tailscale. Never expose LocalAPI credentials.
const {spawn,execFileSync}=require('node:child_process'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),tls=require('node:tls');
const {SocksClient}=require('socks'),{Agent,fetch}=require('undici');
function tailnetHost(host){host=host.replace(/^\[|\]$/g,'').toLowerCase();return /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host)||host.startsWith('fd7a:115c:a1e0:')||host.endsWith('.ts.net');}
function embeddedHostname(raw){
 if(raw===undefined){
  if(process.platform==='darwin')try{raw=execFileSync('/usr/sbin/scutil',['--get','LocalHostName'],{encoding:'utf8',timeout:2000}).trim();}catch{}
  raw||=os.hostname();
 }
 const base=String(raw).trim().toLowerCase().replace(/\.local$/,'').replace(/[^a-z0-9-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,54).replace(/-+$/,'')||'device';
 return base+'-inclient';
}
class EmbeddedTailscale {
 constructor({binary=path.resolve(__dirname,`../../.local/libtailscale-build/macos-${process.arch==='arm64'?'arm64':'x64'}/tailscale-host`),dir=path.join(os.homedir(),'.config/codex-remote/embedded-tailscale-web')}={}){this.binary=binary;this.dir=dir;}
 available(){return fs.existsSync(this.binary);}
 async start(){
  if(this.pending)return this.pending;
  this.pending=(async()=>{
   if(!this.available())throw Error('请先编译内嵌网络：node scripts/build-tailscale-host.cjs');
   fs.mkdirSync(this.dir,{recursive:true,mode:0o700});fs.chmodSync(this.dir,0o700);
   const child=this.child=spawn(this.binary,[this.dir,embeddedHostname()],{stdio:['pipe','pipe','ignore']});
   this.credentials=await new Promise((resolve,reject)=>{let text='',done=false;const finish=(err,v)=>{if(done)return;done=true;clearTimeout(timer);err?reject(err):resolve(v);};const timer=setTimeout(()=>{child.kill();finish(Error('内嵌网络启动超时'));},20000);
    child.once('error',()=>finish(Error('无法启动内嵌网络')));child.once('exit',()=>{if(this.child===child){this.credentials=null;this.pending=null;this.agent?.destroy();}finish(Error('内嵌网络已退出'));});
    child.stdout.on('data',b=>{text+=b;if(text.length>4096){child.kill();finish(Error('内嵌网络返回无效数据'));}else if(text.includes('\n')){try{const v=JSON.parse(text.split('\n')[0]);if(!/^127\.0\.0\.1:\d+$/.test(v.address)||v.proxy?.length!==32||v.api?.length!==32)throw Error();finish(null,v);}catch{child.kill();finish(Error('内嵌网络初始化失败'));}}});
   });
   this.agent=new Agent({connect:(opts,cb)=>{this.dial(opts.hostname,Number(opts.port)||(opts.protocol==='https:'?443:80)).then(socket=>{if(opts.protocol==='https:'){const secure=tls.connect({socket,servername:opts.hostname});secure.once('secureConnect',()=>cb(null,secure));secure.once('error',cb);}else cb(null,socket);},cb);}});
  })().catch(e=>{this.pending=null;throw e;});return this.pending;
 }
 async api(endpoint,method='GET',body){await this.start();const c=this.credentials;if(!c)throw Error('内嵌网络已退出');const r=await globalThis.fetch(`http://${c.address}/localapi/v0/${endpoint}`,{method,headers:{'Sec-Tailscale':'localapi',Authorization:'Basic '+Buffer.from(':'+c.api).toString('base64'),'Content-Type':'application/json'},body,signal:AbortSignal.timeout(10000),redirect:'error'});if(!r.ok)throw Error('内嵌网络操作失败 ('+r.status+')');return r;}
 async status(){return (await this.api('status')).json();}
 async login(){await this.api('start','POST','{}');await this.api('login-interactive','POST');return {started:true};}
 async dial(host,port){if(!tailnetHost(host))throw Error('内嵌网络仅连接 Tailscale IP 或完整 .ts.net 名称');await this.start();const c=this.credentials;if(!c)throw Error('内嵌网络已退出');const [ip,p]=c.address.split(':');const {socket}=await SocksClient.createConnection({command:'connect',proxy:{host:ip,port:Number(p),type:5,userId:'tsnet',password:c.proxy},destination:{host:host.replace(/^\[|\]$/g,''),port},timeout:10000});return socket;}
 async fetch(url,options){await this.start();return fetch(url,{...options,dispatcher:this.agent});}
 close(){this.agent?.destroy();this.child?.stdin.end();this.child=null;this.credentials=null;this.pending=null;this.agent=null;}
}
module.exports={EmbeddedTailscale,tailnetHost,embeddedHostname};
