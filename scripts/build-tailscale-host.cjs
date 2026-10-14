const {spawnSync}=require('node:child_process'),path=require('node:path'),fs=require('node:fs');
const root=path.resolve(__dirname,'..'),target=`macos-${process.arch==='arm64'?'arm64':'x64'}`;
if(process.platform!=='darwin')throw Error('网页内嵌网络预览目前支持 macOS');
const dir=path.join(root,'.local/libtailscale-build',target);
if(!fs.existsSync(path.join(dir,'libtailscale.a')))throw Error('请先运行 scripts/build-libtailscale.cjs '+target);
const result=spawnSync('clang',[path.join(__dirname,'libtailscale-host.c'),path.join(__dirname,'tailscale-forward.c'),'-I',dir,path.join(dir,'libtailscale.a'),'-framework','CoreFoundation','-framework','Security','-lresolv','-o',path.join(dir,'tailscale-host')],{stdio:'inherit'});
if(result.status)process.exit(result.status);
