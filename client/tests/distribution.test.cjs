const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const {load,validate,prepare,buildArgs}=require('../../scripts/build-distribution.cjs');
const createServices=require('../ui/services.js');
test('Apple configurations exclude host modules and reject unimplemented SDKs',()=>{
 for(const id of ['ios-appstore','macos-appstore']){
  const p=load(id);assert.equal(p.capabilities.sshDeploy,false);
  for(const mutation of [p=>p.modules.ads='fake',p=>p.modules.billing='apple',p=>p.capabilities.sshDeploy=true,p=>p.platform='android',p=>p.modules.extra='disabled',p=>p.updates='external']){
   const invalid=structuredClone(p);mutation(invalid);assert.throws(()=>validate(invalid));
  }
 }
 assert.throws(()=>load('../tauri.conf'));
});
test('preparation removes stale assets, isolates profiles and disables signing',()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'codex-distribution-'));
 try{
  const ios=prepare('ios-appstore',temp),mac=prepare('macos-appstore',temp);
  assert.notEqual(ios.config.build.frontendDist,mac.config.build.frontendDist);
  for(const config of [ios.config,mac.config]){
   for(const directive of ['img-src','media-src']){
    const sources=config.app.security.csp.split(';').find(v=>v.trim().startsWith(directive)).trim().split(/\s+/);
    assert(sources.includes('https:'));assert(!sources.includes('http:'));assert(sources.includes('blob:'));
   }
   assert(config.app.security.csp.includes('connect-src ipc: http://ipc.localhost'));
  }
  assert.equal(mac.profile.capabilities.localService,true);
  assert.equal(ios.profile.capabilities.localService,false);
  assert.deepEqual(mac.config.build.features,['appstore','local-service']);
  assert.match(mac.config.bundle.macOS.files['MacOS/codex-remote-service'],/local-service-bundle/);
  assert.equal(mac.config.bundle.category,'DeveloperTool');
  assert.equal(mac.config.bundle.macOS.minimumSystemVersion,'12.0');
  assert(fs.readFileSync(mac.config.bundle.macOS.infoPlist,'utf8').includes('NSLocalNetworkUsageDescription'));
  assert.deepEqual(ios.config.bundle.resources,[]);assert.deepEqual(ios.config.bundle.externalBin,[]);
  assert.equal(ios.config.build.beforeBuildCommand,null);assert.deepEqual(ios.config.build.features,['appstore']);
  assert(!fs.existsSync(path.join(ios.output,'ui/deploy.js')));
  assert(!fs.readFileSync(path.join(ios.output,'ui/index.html'),'utf8').includes('src="/deploy.js"'));
  assert(fs.existsSync(path.join(ios.output,'ui/vendor/marked/marked.umd.js')));
  fs.writeFileSync(path.join(ios.output,'ui/stale-sdk.js'),'old');prepare('ios-appstore',temp);
  assert(!fs.existsSync(path.join(ios.output,'ui/stale-sdk.js')));
  assert(fs.existsSync(path.join(mac.output,'ui/index.html')));
  assert(buildArgs(ios.profile,ios.config).includes('--archive-only'));
  assert(buildArgs(mac.profile,mac.config).includes('--no-sign'));
  assert(buildArgs(mac.profile,mac.config).includes('universal-apple-darwin'));
  assert(!buildArgs(ios.profile,ios.config).includes('universal-apple-darwin'));
 }finally{fs.rmSync(temp,{recursive:true,force:true});}
});
test('disabled SDKs never claim a payment, reward, permission or entitlement',async()=>{
 const services=createServices(load('ios-appstore'));
 for(const [kind,names] of Object.entries({billing:['listOffers','purchase','restore','manageSubscription'],ads:['show'],analytics:['track'],push:['requestPermission']})){
  assert.equal(services[kind].capabilities.available,false);
  for(const name of names)assert.deepEqual(await services[kind][name]({}),{status:'unsupported',reason:'provider_disabled'});
 }
 assert.deepEqual(await services.entitlements.snapshot(),{status:'unconfigured',grants:[]});
 assert(Object.isFrozen(services));
});
function boot(invoke){
 const note={textContent:''},element={hidden:true,dataset:{distributionCapability:'sshDeploy'}};
 const window={},context=vm.createContext({window,Runtime:{invoke},createClientServices:createServices,document:{title:'',querySelectorAll:()=>[element],getElementById:()=>note}});
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../ui/distribution.js'),'utf8'),context);
 return {distribution:window.Distribution,note,element};
}
test('native build identity is immutable and unavailable identity never falls back to direct',async()=>{
 const p=load('ios-appstore'),f=boot(async name=>{assert.equal(name,'distribution_info');return p;});
 await f.distribution.ready;assert.equal(await f.distribution.supports('sshDeploy'),false);assert.equal(f.element.hidden,true);
 assert(Object.isFrozen(f.distribution.manifest.capabilities));
 const bad=boot(async()=>{throw Error('missing command');});
 await assert.rejects(bad.distribution.ready);assert.equal(bad.distribution.manifest,null);
 await assert.rejects(bad.distribution.supports('sshDeploy'));assert.match(bad.note.textContent,/分发配置加载失败/);
});
