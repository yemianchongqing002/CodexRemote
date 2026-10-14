// Cross-build a Windows x64 SSH bootstrap MSI on macOS/Linux with wixl.
const {spawnSync}=require('node:child_process'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),out=path.join(root,'dist','ssh-setup');
fs.mkdirSync(out,{recursive:true});
function run(binary,args,env={}){const r=spawnSync(binary,args,{cwd:root,env:{...process.env,...env},stdio:'inherit'});if(r.error||r.status!==0)throw r.error||Error(binary+' failed: '+r.status);}
const exe=path.join(out,'codex-remote.exe'),msi=path.join(out,'CodexRemote-EnableSSH-x64.msi');
run(process.env.GO_BINARY||'go',['build','-trimpath','-ldflags=-s -w','-o',exe,'./cmd/codex-remote'],{GOOS:'windows',GOARCH:'amd64',CGO_ENABLED:'0'});
run(process.env.WIXL_BINARY||'wixl',['-a','x64','-D','BinaryPath='+exe,'-o',msi,'packaging/windows/ssh-bootstrap.wxs']);
console.log(msi);
