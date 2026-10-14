// Build server payloads bundled with the native client. No local runtime data is copied.
const {spawnSync}=require('node:child_process');
const {mkdirSync}=require('node:fs');
const {resolve,join}=require('node:path');
const root=resolve(__dirname,'..'),dest=join(root,'client/src-tauri/server-bundles');
for(const [os,arch] of [['windows','amd64'],['windows','arm64'],['darwin','amd64'],['darwin','arm64']]){
 const dir=join(dest,os+'-'+arch);mkdirSync(dir,{recursive:true});
 const result=spawnSync(process.env.GO_BINARY||'go',['build','-trimpath','-ldflags=-s -w','-o',join(dir,os==='windows'?'codex-remote.exe':'codex-remote'),'./cmd/codex-remote'],{cwd:root,env:{...process.env,GOOS:os,GOARCH:arch,CGO_ENABLED:'0'},stdio:'inherit'});
 if(result.error||result.status!==0){console.error(result.error?.message||'Server bundle build failed');process.exit(1);}
}

if(process.platform==='darwin')require('./bundle-local-service.cjs').build();
