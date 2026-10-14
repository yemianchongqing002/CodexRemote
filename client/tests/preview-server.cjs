require('../../scripts/sync-client-vendor.cjs').syncClientVendor();
// Isolated shared-UI preview. No real service, token, chat or native command is used.
const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const web=path.resolve(__dirname,'../ui');
const shim=`<script>
localStorage.setItem('cr-client-profiles',JSON.stringify([{id:'preview-office',name:'办公室 Windows',address:'http://100.100.100.1:8787',lastConnected:Date.now()-600000},{id:'preview-home-mac',name:'家里的 Mac',address:'http://100.100.100.2:8787'}]));
const previewView=new URLSearchParams(location.search).get('view');
if(previewView==='chat'){sessionStorage.setItem('cr-client-active','preview-office');localStorage.setItem('cr-client:preview-office:cr-view',JSON.stringify({selected:'fixture'}));}else sessionStorage.removeItem('cr-client-active');
window.__networkCalls=[];
window.__settingsUpdates=[];window.__sends=[];window.__stops=[];
const previewThread={id:'fixture',title:'跨平台客户端体验',project:'CodexRemote',projectPath:'/workspace/CodexRemote',source:'desktop',version:'1',status:'idle',updated:new Date().toISOString(),count:2};
window.__TAURI__={core:{Channel:class{},invoke:async(name,args={})=>{
 if(name==='distribution_info')return {schemaVersion:1,id:'preview-direct',channel:new URLSearchParams(location.search).has('store')?'appstore':'direct',branding:{productName:'Codex Remote Client'},modules:{billing:'disabled',ads:'disabled',analytics:'disabled',push:'disabled'},capabilities:{sshDeploy:!new URLSearchParams(location.search).has('store'),systemDiscovery:!new URLSearchParams(location.search).has('store'),embeddedTailscale:false}};
 if(name==='service_probe')return {state:'ready',release:{serverVersion:'1.0.0',clientMin:'1.0.0',clientMaxExclusive:'1.1.0'}};
 if(name==='activate')return {epoch:1,origin:args.address};
 if(name!=='request')return;
 window.__networkCalls.push(args.path);
 let data={};
 if(args.path==='/api/status')data={connectionName:'办公室 Windows',hostName:'OFFICE-PC',sendingEnabled:true};
 else if(args.path.startsWith('/api/thread/live?'))data={permissionSelection:{agentMode:'auto',source:'desktop-preference',canChange:false,reason:'请在 Codex 中修改后点击同步'},model:'example-deep',effort:'medium',approvals:[],approvalPolicy:'on-request',approvalsReviewer:'user',activePermissionProfile:{id:':workspace'},sandboxPolicy:{type:'workspaceWrite'}};
 else if(args.path.startsWith('/api/upload-file?'))data={id:'a'.repeat(64)+'.file.txt'};
 else if(args.path==='/api/models')data={models:[{model:'example-deep',displayName:'示例推理模型',supportedReasoningEfforts:['low','medium','high','xhigh','max','ultra'].map(reasoningEffort=>({reasoningEffort,description:'示例思考深度'})),defaultReasoningEffort:'medium',serviceTiers:[{id:'priority',description:'更快响应，增加用量'}]},{model:'example-light',displayName:'示例轻量模型',supportedReasoningEfforts:[{reasoningEffort:'low',description:'轻量推理'}],defaultReasoningEffort:'low',serviceTiers:[]}]};
 else if(args.path==='/api/send'){const body=JSON.parse(atob(args.body));window.__sends.push(body);data={...body,status:'queued'};}
 else if(args.path==='/api/thread/interrupt'){window.__stops.push(JSON.parse(atob(args.body)));previewThread.status='interrupted';delete previewThread.activeTurnId;data={stopped:true};}
 else if(args.path.startsWith('/api/media?'))return {status:200,body:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',contentType:'image/png'};
 else if(args.path==='/api/threads')data={threads:[previewThread]};
 else if(args.path.startsWith('/api/thread?'))data={thread:previewThread,messages:[{id:'one',seq:1,role:'user',text:'切换电脑时保留草稿和阅读位置。',timestamp:new Date().toISOString()},{id:'two',seq:2,role:'assistant',text:'只同步当前电脑。关闭客户端后，已提交的队列继续在电脑运行。',timestamp:new Date().toISOString()}],cursor:'2',before:''};
 else if(args.path.startsWith('/api/queue'))data={entries:[]};
 return {status:200,body:btoa(unescape(encodeURIComponent(JSON.stringify(data)))),contentType:'application/json'};
}},event:{listen:async()=>{}}};
document.addEventListener('DOMContentLoaded',()=>{if(previewView==='settings')document.querySelector('[data-open-settings]').click();});
</script>`;
function start(){return new Promise(resolve=>{
 const server=http.createServer((req,res)=>{
  const pathname=new URL(req.url,'http://localhost').pathname;
  const file=path.resolve(web,'.'+(pathname==='/'?'/index.html':pathname));
  if(!file.startsWith(web+path.sep)){res.writeHead(404).end();return;}
  try{let data=fs.readFileSync(file);if(pathname==='/')data=Buffer.from(data.toString().replace('<script src="/vendor/marked/marked.umd.js"',shim+'<script src="/vendor/marked/marked.umd.js"'));
   const type={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml'}[path.extname(file)]||'application/octet-stream';res.writeHead(200,{'Content-Type':type});res.end(data);
  }catch{res.writeHead(404).end();}
 });server.listen(0,'127.0.0.1',()=>resolve({server,url:'http://127.0.0.1:'+server.address().port}));
});}
module.exports={start};
if(require.main===module)start().then(({url})=>console.log(url));
