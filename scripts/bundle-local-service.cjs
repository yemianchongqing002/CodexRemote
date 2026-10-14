'use strict';
// A single universal macOS helper is shared by direct and Store packaging.
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),out=path.join(root,'client/src-tauri/local-service-bundle');
function run(program,args,env={}){const r=spawnSync(program,args,{cwd:root,env:{...process.env,...env},stdio:'inherit'});if(r.error)throw r.error;if(r.status!==0)throw Error(`${program} failed (${r.status})`);}
function build(){
 if(process.platform!=='darwin')throw Error('macOS local helper requires macOS');
 fs.mkdirSync(out,{recursive:true});
 for(const arch of ['arm64','amd64'])run(process.env.GO_BINARY||'go',['build','-trimpath','-ldflags=-s -w','-o',path.join(out,arch),'./cmd/codex-remote'],{GOOS:'darwin',GOARCH:arch,CGO_ENABLED:'0'});
 run('lipo',['-create',path.join(out,'arm64'),path.join(out,'amd64'),'-output',path.join(out,'codex-remote-service')]);
 fs.chmodSync(path.join(out,'codex-remote-service'),0o755);
}
if(require.main===module){try{build();}catch(e){console.error(e.message);process.exitCode=1;}}
module.exports={build};
