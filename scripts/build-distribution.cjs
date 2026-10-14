'use strict';
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),client=path.join(root,'client');
const providers=Object.freeze({billing:['disabled'],ads:['disabled'],analytics:['disabled'],push:['disabled']});
function validate(profile){
 const keys=['schemaVersion','id','platform','channel','branding','modules','capabilities','updates'];
 if(Object.keys(profile).some(k=>!keys.includes(k))||profile.schemaVersion!==1)throw Error('Unsupported distribution schema');
 if(!['ios','macos'].includes(profile.platform)||profile.id!==`${profile.platform}-appstore`||profile.channel!=='appstore'||profile.updates!=='store')throw Error('Unsupported platform/channel combination');
 if(!profile.branding||Object.keys(profile.branding).join()!=='productName'||typeof profile.branding.productName!=='string'||!profile.branding.productName.trim())throw Error('Invalid branding');
 if(!profile.modules||Object.keys(profile.modules).sort().join()!==Object.keys(providers).sort().join())throw Error('Invalid SDK modules');
 for(const [kind,values] of Object.entries(providers))if(!values.includes(profile.modules[kind]))throw Error(`SDK adapter not implemented: ${kind}/${profile.modules[kind]}`);
 const capabilities=['sshDeploy','systemDiscovery','embeddedTailscale','serverBundles','localService'];
 if(!profile.capabilities||Object.keys(profile.capabilities).sort().join()!==capabilities.sort().join()||Object.entries(profile.capabilities).some(([k,v])=>v!==(['serverBundles','localService'].includes(k)&&profile.platform==='macos')))throw Error('Unsupported App Store capabilities');
 return profile;
}
function load(id){
 if(!['ios-appstore','macos-appstore'].includes(id))throw Error('Choose ios-appstore or macos-appstore');
 const profile=validate(JSON.parse(fs.readFileSync(path.join(client,'distributions',id+'.json'),'utf8')));
 if(profile.id!==id)throw Error('Distribution identity mismatch');return profile;
}
function configuration(profile,output){
 const config={productName:profile.branding.productName,build:{features:profile.platform==='macos'?['appstore','local-service']:['appstore'],frontendDist:path.join(output,'ui'),beforeBuildCommand:profile.platform==='macos'?`node ${JSON.stringify(path.join(root,'scripts/bundle-local-service.cjs'))}`:null},bundle:{resources:[],externalBin:[],targets:profile.platform==='macos'?['app']:'all'}};
 // External media must stay encrypted, including redirects enforced by WebKit CSP.
 const base=JSON.parse(fs.readFileSync(path.join(client,'src-tauri/tauri.conf.json'),'utf8'));
 config.app={security:{csp:base.app.security.csp.replace(/(img-src|media-src)([^;]*)/g,(_,name,sources)=>name+sources.replace(/\shttp:/g,''))}};
 if(profile.platform==='ios'){
  config.bundle.iOS={infoPlist:path.join(client,'distributions','ios-appstore.Info.plist')};
 }
 if(profile.platform==='macos'){
  config.bundle.category='DeveloperTool';
  config.bundle.macOS={minimumSystemVersion:'12.0',bundleVersion:'1.0.7',files:{'MacOS/codex-remote-service':path.join(client,'src-tauri/local-service-bundle/codex-remote-service'),'Resources/PrivacyInfo.xcprivacy':path.join(client,'distributions','PrivacyInfo.xcprivacy')},entitlements:path.join(client,'distributions','macos-appstore.entitlements'),infoPlist:path.join(client,'distributions','macos-appstore.Info.plist')};
 }
 return config;
}
function prepare(id,base=path.join(root,'.local','distributions')){
 const profile=load(id),output=path.join(base,id),ui=path.join(output,'ui');
 fs.mkdirSync(output,{recursive:true});
 // Only replace our generated frontend, never the shared source or other profiles.
 fs.rmSync(ui,{recursive:true,force:true});
 fs.cpSync(path.join(client,'ui'),ui,{recursive:true,filter:source=>!['deploy.js','vendor'].includes(path.basename(source))});
 fs.cpSync(path.join(root,'internal/server/web/vendor'),path.join(ui,'vendor'),{recursive:true});
 const index=path.join(ui,'index.html');
 fs.writeFileSync(index,fs.readFileSync(index,'utf8').replace('  <script src="/deploy.js" defer></script>\n','').replace('</head>','  <style>[data-distribution-capability="sshDeploy"]{display:none!important}</style>\n</head>'));
 const config=configuration(profile,output);fs.writeFileSync(path.join(output,'tauri.conf.json'),JSON.stringify(config,null,2)+'\n');
 return {profile,output,config};
}
function buildArgs(profile,config){
 const args=profile.platform==='ios'?['ios','build','--no-sign','--archive-only','--ci']:[ 'build','--target','universal-apple-darwin','--no-sign','--ci'];
 return [...args,'--config',JSON.stringify(config)];
}
if(require.main===module){
 try{
  const [id,action='--check',...extra]=process.argv.slice(2);
  if(extra.length||!['--check','--prepare','--build'].includes(action))throw Error('Usage: node scripts/build-distribution.cjs <ios-appstore|macos-appstore> [--check|--prepare|--build]');
  const profile=load(id);
  if(action==='--check'){console.log(JSON.stringify({profile,features:['appstore'],signed:false},null,2));}
  else{
   const {output,config}=prepare(id);console.log(`Prepared ${id}: ${output}`);
   if(action==='--build'){
    if(process.platform!=='darwin')throw Error('Apple builds require macOS and Xcode');
    const result=spawnSync(process.execPath,[path.join(client,'node_modules/@tauri-apps/cli/tauri.js'),...buildArgs(profile,config)],{cwd:client,stdio:'inherit',env:{...process.env,CODEX_DISTRIBUTION:id,APPLE_SIGNING_IDENTITY:'-',CARGO_TARGET_DIR:path.join(output,'target')}});
    if(result.error)throw result.error;process.exitCode=result.status??1;
   }
  }
 }catch(error){console.error(error.message);process.exitCode=1;}
}
module.exports={validate,load,prepare,configuration,buildArgs};
