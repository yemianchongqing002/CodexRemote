// Reproducible native library build. Does not start a node or log in to Tailscale.
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const lock=require('../third_party/libtailscale/source.json');
const target=process.argv[2]||'macos-arm64';
const targets={
 'macos-arm64':{GOOS:'darwin',GOARCH:'arm64'},
 'macos-x64':{GOOS:'darwin',GOARCH:'amd64'},
 'ios-arm64':{GOOS:'ios',GOARCH:'arm64',wrapper:'clangwrap-ios.sh'},
 'ios-sim-arm64':{GOOS:'ios',GOARCH:'arm64',wrapper:'clangwrap-ios-sim-arm.sh'},
};
if(!targets[target]||process.platform!=='darwin')throw Error('当前构建脚本支持在 macOS 构建 macos-arm64、macos-x64、ios-arm64、ios-sim-arm64');
const checkout=path.join(root,'third_party','libtailscale','source');
function run(command,args,options={}){
 const r=spawnSync(command,args,{stdio:'inherit',...options});
 if(r.error)throw r.error;if(r.status!==0)throw Error(`${command} failed (${r.status})`);
}
if(!fs.existsSync(path.join(checkout,'go.mod')))throw Error('缺少 vendored libtailscale 源码');
const config=targets[target],out=path.join(root,'.local','libtailscale-build',target);
fs.mkdirSync(out,{recursive:true});
const env={...process.env,GOTOOLCHAIN:lock.goToolchain,CGO_ENABLED:'1',GOOS:config.GOOS,GOARCH:config.GOARCH};
if(config.wrapper)env.CC=path.join(checkout,'swift','script',config.wrapper);
run(process.env.GO_BINARY||'go',['build','-trimpath','-buildmode=c-archive','-o',path.join(out,'libtailscale.a')],{cwd:checkout,env});
fs.copyFileSync(path.join(checkout,'tailscale.h'),path.join(out,'tailscale.h'));
fs.copyFileSync(path.join(checkout,'LICENSE'),path.join(out,'LICENSE'));
console.log(out);
