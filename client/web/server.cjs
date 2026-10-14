require('../../scripts/sync-client-vendor.cjs').syncClientVendor();
// Local management-client host. It does not serve or create Codex conversations itself.
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {Network,systemStatus}=require('./network.cjs');
const {serviceProbe}=require('./service-probe.cjs');
const web=path.resolve(__dirname,'../ui');
const allowed={GET:new Set(['privacy','status','models','guardian/status','threads','thread','thread/live','send-status','queue','media','upload-image','events']),POST:new Set(['login','logout','thread/interrupt','thread/approval','thread/permissions','guardian/restart','send','upload-image','upload-file','queue/cancel','queue/steer','thread/create'])};
function origin(input){const u=new URL(input);if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw Error('请输入完整电脑地址');return u.origin;}
function endpoint(base,p,method){if(typeof p!=='string'||!p.startsWith('/api/')||p.includes('\\')||p.includes('#')||p.includes('..')||!allowed[method]?.has(p.split('?')[0].slice(5)))throw Error('不支持的服务接口');const u=new URL(p,base);if(u.origin!==base)throw Error('无效接口地址');return u;}
async function bytes(stream,max){let size=0,parts=[];for await(const part of stream){size+=part.length;if(size>max)throw Error('数据超过客户端限制');parts.push(part);}return Buffer.concat(parts);}
function start({port=0,host="127.0.0.1",restoreEmbedded=false}={}){return new Promise((resolve,reject)=>{
 const network=new Network({restore:restoreEmbedded});
 const probe=address=>serviceProbe(address,network.fetch.bind(network));
 function deployment(){const d=require('./deploy.cjs');return d.createDeployment({connectSSH:async(t,k)=>d.connect(t,k,await network.dial(t.host,t.port)),check:async address=>['ready','auth'].includes((await probe(address)).state)});}
 const key=crypto.randomBytes(32).toString('hex'),sessions=new Map();let localOrigin;
 const server=http.createServer(async(req,res)=>{
  const json=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
  try{
   if(req.headers.host!==new URL(localOrigin).host){json(403,{error:'客户端访问地址不匹配'});return;}
   if(req.url==='/bridge'){
    if(req.method!=='POST'||req.headers.origin!==localOrigin){json(403,{error:'请求不是来自当前客户端页面，请通过客户端地址重新打开。'});return;}
    if(req.headers['x-client-key']!==key){json(409,{code:'CLIENT_RESTARTED',error:'客户端已重启，当前页面已过期。请刷新页面后重试。'});return;}
    const id=req.headers['x-client-session'];if(typeof id!=='string'||!/^[a-f0-9-]{36}$/.test(id))throw Error('无效客户端会话');
    let s=sessions.get(id);if(!s){if(sessions.size>=100)throw Error('客户端标签页过多');s={epoch:0,origin:null,cookies:new Map(),controllers:new Map(),paused:false};sessions.set(id,s);}
    const {name,args:a={}}=JSON.parse((await bytes(req,12*1024*1024)).toString());
    const cancel=()=>{for(const c of s.controllers.values())c.abort();s.controllers.clear();};
    if(name==='trust_fingerprint'){json(200,network.trust.read(origin(a.address)));return;}
    if(name==='reset_trust'){const target=origin(a.address);await network.trust.reset(target,a.expected);for(const session of sessions.values()){session.cookies.delete(target);if(session.origin===target){for(const c of session.controllers.values())c.abort();session.controllers.clear();session.origin=null;session.epoch++;session.paused=true;}}json(200,{});return;}
    if(name==='forget_connection'){const target=origin(a.address);for(const session of sessions.values()){session.cookies.delete(target);if(session.origin===target){for(const c of session.controllers.values())c.abort();session.controllers.clear();session.origin=null;session.epoch++;session.paused=true;}}json(200,{});return;}
    if(name==='activate'){cancel();s.origin=origin(a.address);s.epoch++;s.paused=false;json(200,{epoch:s.epoch,origin:s.origin});return;}
    if(['pause_network','deactivate','resume_network'].includes(name)){
     if(a.epoch===s.epoch){if(name==='resume_network')s.paused=false;else{cancel();s.paused=true;if(name==='deactivate')s.origin=null;}}json(200,{});return;
    }
    if(name==='cancel_request'){s.controllers.get(a.requestId)?.abort();json(200,{});return;}
    if(name==='service_probe'){
     json(200,await probe(origin(a.address)));return;
    }
    if(name==='ssh_key_status'){json(200,{keys:require('./ssh-keys.cjs').createKeyStore().list(),location:require('./ssh-keys.cjs').createKeyStore().root});return;}
    if(name==='ssh_key_setup'){s.deployment??=deployment();json(200,await s.deployment.setupKey(a.target));return;}
    if(name==='ssh_status'){json(200,await require('./ssh-bootstrap.cjs').sshStatus(a,network.dial.bind(network)));return;}
    if(name==='tailscale_mode'){const status=await network.setMode(a.mode);for(const session of sessions.values()){for(const c of session.controllers.values())c.abort();session.deployment?.close();session.deployment=null;session.cookies.clear();session.origin=null;session.epoch++;}json(200,status);return;}
    if(name==='tailscale_open'){json(200,await require('./system-apps.cjs').openTailscale());return;}
    if(name==='tailscale_login'){json(200,await network.login());return;}
    if(name==='tailscale_status'){json(200,await network.status());return;}
    if(name==='ssh_probe'||name==='ssh_start'){s.deployment??=deployment();json(200,name==='ssh_probe'?await s.deployment.probe(a.target):await s.deployment.start(a.id));return;}
    if(!['request','stream'].includes(name))throw Error('不支持的客户端操作');
    if(!s.origin||a.epoch!==s.epoch||s.paused)throw Error('cancelled');
    const stream=name==='stream',method=stream?'GET':a.method||'GET',url=endpoint(s.origin,stream?'/api/events':a.path,method),target=s.origin;
    const controller=new AbortController(),requestId=stream?a.streamId:a.requestId;s.controllers.set(requestId,controller);
    res.on('close',()=>controller.abort());const timer=stream?null:setTimeout(()=>{console.warn('[request] timed out',{path:a.path});controller.abort();},60000);
    try{
     const headers={};if(s.cookies.has(target))headers.Cookie=s.cookies.get(target);if(method==='POST')headers['Content-Type']=a.contentType||'application/json';
     const upstream=await network.fetch(url,{method,headers,body:method==='POST'&&a.body?Buffer.from(a.body,'base64'):undefined,redirect:'manual',signal:controller.signal});
     if(controller.signal.aborted||a.epoch!==s.epoch||s.origin!==target)throw Error('cancelled');
     const cookie=upstream.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');if(cookie)s.cookies.set(target,cookie);
     if(stream){if(!upstream.ok)throw Error('事件订阅失败');res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store'});res.flushHeaders();for await(const chunk of upstream.body){if(!res.write(chunk))await new Promise(r=>res.once('drain',r));}res.end();}
     else{const body=upstream.body?await bytes(upstream.body,32*1024*1024):Buffer.alloc(0);json(200,{status:upstream.status,body:body.toString('base64'),contentType:upstream.headers.get('Content-Type')||'application/octet-stream'});}
    }finally{clearTimeout(timer);s.controllers.delete(requestId);}return;
   }
   if(req.method!=='GET'){json(405,{error:'不支持的方法'});return;}
   let file=path.resolve(web,'.'+(req.url==='/'?'/index.html':new URL(req.url,localOrigin).pathname));
   if(!file.startsWith(web+path.sep)){json(404,{});return;}
   let content;
   if(req.url==='/client-adapter.js'){file='adapter.js';content=`window.__CLIENT_WEB_KEY=${JSON.stringify(key)};\n`+fs.readFileSync(path.join(__dirname,'adapter.js'),'utf8');}
   else{content=fs.readFileSync(file);if(path.extname(file)==='.html')content=content.toString().replace('<script src="/runtime.js"','<script src="/client-adapter.js" defer></script><script src="/runtime.js"');}
   res.writeHead(200,{'Content-Type':({'.js':'text/javascript','.css':'text/css','.html':'text/html','.svg':'image/svg+xml','.png':'image/png'})[path.extname(file)]||'application/octet-stream','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data: https: http:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'self'"});res.end(content);
  }catch(e){if(res.headersSent)res.destroy();else json(400,{error:e.name==='AbortError'?'cancelled':e.message});}
 });server.on('close',()=>{network.close();for(const s of sessions.values())s.deployment?.close();});server.on('error',reject);server.listen(port,host,()=>{localOrigin='http://'+(host.includes(':')?'['+host+']':host)+':'+server.address().port;resolve({server,url:localOrigin});});
});}
module.exports={start,origin,endpoint};
if(require.main===module)(async()=>{
 let host=process.env.CLIENT_WEB_HOST||'127.0.0.1';
 if(process.argv.includes('--tailscale')){const status=await systemStatus();host=status.ips.find(ip=>ip.includes('.'));if(status.state!=='Running'||!host)throw Error('请先启动并登录 Tailscale，再运行网页客户端');}
 const {url}=await start({port:Number(process.env.CLIENT_WEB_PORT||4173),host,restoreEmbedded:true});console.log('Codex 管理客户端：'+url);
})().catch(e=>{console.error(e.message);process.exitCode=1;});
