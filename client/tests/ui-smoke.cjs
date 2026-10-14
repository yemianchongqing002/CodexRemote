// Headless DOM/layout checks only; does not build Go, Rust or Tauri.
const {start}=require('./preview-server.cjs');
const {spawn}=require('node:child_process'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const out=path.resolve(__dirname,'../../.local/client-preview');fs.mkdirSync(out,{recursive:true});
const browser=process.argv[2]||'C:/Program Files/Google/Chrome/Application/chrome.exe';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 const {server,url}=await start();
 const profile=fs.mkdtempSync(path.join(out,'profile-'));
 const child=spawn(browser,['--headless=new','--no-first-run','--no-default-browser-check','--disable-gpu','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{windowsHide:true,stdio:'ignore'});
 let ws;
 try{
  const portFile=path.join(profile,'DevToolsActivePort');for(let i=0;i<100&&!fs.existsSync(portFile);i++)await delay(100);
  const port=fs.readFileSync(portFile,'utf8').split('\n')[0];const targets=await (await fetch('http://127.0.0.1:'+port+'/json')).json();
  ws=new WebSocket(targets.find(t=>t.type==='page').webSocketDebuggerUrl);await new Promise((r,j)=>{ws.addEventListener('open',r,{once:true});ws.addEventListener('error',j,{once:true});});
  let serial=0;const waiting=new Map(),errors=[];
  ws.addEventListener('message',event=>{const message=JSON.parse(event.data);if(message.id){const pending=waiting.get(message.id);waiting.delete(message.id);if(message.error)pending.reject(Error(message.error.message));else pending.resolve(message.result);}else if(message.method==='Runtime.exceptionThrown')errors.push(message.params.exceptionDetails.text+': '+(message.params.exceptionDetails.exception?.description||''));});
  const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++serial;waiting.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});
  const evaluate=async expression=>(await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true})).result.value;
  await call('Runtime.enable');await call('Page.enable');
  for(const [name,width,height,view] of [['store-desktop',1100,800,'connections'],['store-mobile',390,844,'connections'],['reconnect-failure',390,844,'chat'],['reconnect-auth',1100,800,'chat'],['service-recovery-restored',1100,800,'chat'],['service-recovery-check',1100,800,'chat'],['service-recovery-restart',390,844,'chat'],['recovery-desktop',1100,800,'connections'],['recovery-mobile',390,844,'connections'],['network-desktop',1100,800,'connections'],['network-mobile',390,844,'connections'],['delete-desktop',1100,800,'connections'],['delete-mobile',390,844,'connections'],['about-desktop',1100,800,'chat'],['about-mobile',390,844,'chat'],['compatibility-desktop',1100,800,'connections'],['compatibility-mobile',390,844,'connections'],['connections-desktop',1100,800,'connections'],['computer-picker-desktop',1100,800,'connections'],['computer-picker-mobile',320,568,'connections'],['settings-desktop',1100,900,'chat'],['settings-mobile',390,844,'chat'],['settings-small',320,568,'chat'],['chat-mobile',390,844,'chat'],['models-desktop',1100,800,'chat'],['models-mobile',320,568,'chat']].filter(([name])=>!process.env.UI_SMOKE_FILTER||name.startsWith(process.env.UI_SMOKE_FILTER))){
   await call('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:width<700});
   await call('Page.navigate',{url:url+'/?view='+view+(name.startsWith('store-')?'&store=1':'')});
   let ready=false;for(let i=0;i<80;i++){ready=await evaluate(view==='chat'?"!!document.querySelector('#messages .message')":"!!document.querySelector('#connections-list .connection-card')");if(ready)break;await delay(100);}
   assert(ready,name+' did not load');
   assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true,name+' horizontal overflow');
   if(view!=='chat')assert.equal(await evaluate('window.__networkCalls.length'),0,'machine list started network requests');
   if(name.startsWith('store-')){
    await evaluate("document.querySelector('#connections-screen [data-privacy]').click()");
    assert.equal(await evaluate("document.getElementById('privacy-dialog').open"),true);
    assert.equal(await evaluate("document.getElementById('privacy-dialog').scrollWidth<=innerWidth"),true);
    await evaluate("document.querySelector('#privacy-dialog button').click()");
    assert.equal(await evaluate("document.getElementById('privacy-dialog').open"),false);
    assert.equal(await evaluate("Distribution.ready.then(()=>Runtime.normalizeAddress('example.test'))"),'https://example.test:8787');

    assert.equal(await evaluate("Distribution.ready.then(()=>Distribution.manifest.capabilities.sshDeploy)"),false);
    assert.equal(await evaluate("document.querySelector('[data-distribution-capability=sshDeploy]').hidden"),true);
    await evaluate("(()=>{const original=window.__TAURI__.core.invoke;window.__forbiddenCalls=[];window.__TAURI__.core.invoke=async(n,a)=>{if(n.startsWith('ssh_')||n.startsWith('tailscale_')){window.__forbiddenCalls.push(n);throw Error('Store command excluded');}if(n==='service_probe')return {state:'unreachable'};return original(n,a);};document.getElementById('add-computer').click();document.getElementById('computer-address').value='100.100.100.9';document.getElementById('connect-computer-form').requestSubmit();})()");await delay(200);
    assert.equal(await evaluate("document.getElementById('install-ssh-check').hidden"),true);
    assert.match(await evaluate("document.getElementById('connect-computer-status').textContent"),/服务已启动/);
    assert.deepEqual(await evaluate('window.__forbiddenCalls'),[]);
    assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true);
    const screenshot=await call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(screenshot.data,'base64'));continue;
   }
   if(name.startsWith('reconnect-')){
    await evaluate("loggedOut();loginAuthentication(false)");
    if(name.endsWith('auth'))await evaluate("(()=>{const invoke=window.__TAURI__.core.invoke;window.__TAURI__.core.invoke=async(n,a)=>n==='request'&&a.path==='/api/status'?{status:401,body:btoa('{}'),contentType:'application/json'}:invoke(n,a);})()");
    else await evaluate("(()=>{const invoke=window.__TAURI__.core.invoke;window.__TAURI__.core.invoke=async(n,a)=>n==='service_probe'?{state:'unreachable'}:n==='ssh_status'?{state:'available'}:invoke(n,a);})()");
    await evaluate("document.getElementById('login-form').dispatchEvent(new Event('submit',{cancelable:true}))");await delay(250);
    assert.equal(await evaluate("document.getElementById('add-computer-dialog').open"),!name.endsWith('auth'));
    if(name.endsWith('auth'))assert.equal(await evaluate("document.getElementById('login-error').textContent"),'请检查访问口令后重试。');
    else{
     assert.equal(await evaluate("document.getElementById('computer-install-details').hidden"),false);
     assert.equal(await evaluate("document.getElementById('ssh-target').dataset.serviceAddress"),'http://100.100.100.1:8787');
    }
    assert.equal(await evaluate('Runtime.profiles().length'),2);continue;
   }
   if(name.startsWith('service-recovery-')){
    await evaluate("(()=>{const invoke=window.__TAURI__.core.invoke;window.__restoreProbe=async(n,a)=>{if(n==='request'&&a.path.startsWith('/api/guardian/'))throw Error('fetch failed');return invoke(n,a);};window.__TAURI__.core.invoke=async(n,a)=>{if(n==='request'&&a.path.startsWith('/api/guardian/'))throw Error('fetch failed');if(n==='service_probe')return {state:'unreachable'};if(n==='ssh_status')return {state:'available'};return invoke(n,a);};loadConnectionName({connectionName:'目标电脑',hostName:'目标电脑',managed:true});document.querySelector('[data-open-settings]').click();showSettingsPage('connection');})()");
    if(name.endsWith('restored'))await evaluate("window.__TAURI__.core.invoke=window.__restoreProbe");
    if(name.endsWith('restart')||name.endsWith('restored'))await evaluate("document.getElementById('guardian-restart').click();document.getElementById('guardian-restart-accept').click()");
    else await evaluate("document.getElementById('guardian-status').click()");
    if(name.endsWith('restored')){
     await delay(1400);
     assert.equal(await evaluate("document.getElementById('add-computer-dialog').open"),false);
     assert.equal(await evaluate("document.getElementById('guardian-note').textContent"),'目标服务可以连接，请重新检查服务状态。');continue;
    }
    for(let i=0;i<50;i++){if(await evaluate("document.getElementById('add-computer-dialog').open"))break;await delay(100);}
    await delay(100);
    assert.equal(await evaluate("document.getElementById('settings-dialog').open"),false);
    assert.equal(await evaluate("document.getElementById('add-computer-dialog').open"),true);
    assert.equal(await evaluate("document.getElementById('computer-install-details').hidden"),false);
    assert.equal(await evaluate("document.getElementById('ssh-target').dataset.serviceAddress"),'http://100.100.100.1:8787');
    assert.equal(await evaluate('Runtime.profiles().length'),2);
    continue;
   }
   if(name.startsWith('recovery-')){
    await evaluate("(()=>{const invoke=window.__TAURI__.core.invoke;window.__TAURI__.core.invoke=async(n,a)=>n==='service_probe'||n==='ssh_status'?{state:'unreachable'}:invoke(n,a);document.querySelector('.connection-open').click();})()");await delay(150);
    assert.equal(await evaluate("document.getElementById('add-computer-dialog').open"),true);
    assert.equal(await evaluate("document.getElementById('add-computer-title').textContent"),'连接检查');
    assert.equal(await evaluate("document.getElementById('install-target').textContent"),'办公室 Windows（100.100.100.1）');
    assert.equal(await evaluate("document.getElementById('connection-discovery-help').hidden"),true);
    assert.equal(await evaluate('Runtime.profiles().length'),2);
    const shot=await call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(shot.data,'base64'));
    await evaluate("(()=>{const invoke=window.__TAURI__.core.invoke;window.__TAURI__.core.invoke=async(n,a)=>n==='ssh_status'?{state:'available'}:invoke(n,a);document.getElementById('install-ssh-retry').click();})()");await delay(150);
    assert.equal(await evaluate("document.getElementById('computer-install-details').hidden"),false);
    assert.equal(await evaluate("document.getElementById('ssh-target').dataset.serviceAddress"),'http://100.100.100.1:8787');
    assert.equal(await evaluate("document.getElementById('add-computer-title').textContent"),'启动服务');
    continue;
   }
   if(name.startsWith('network-')){
    await evaluate(`(()=>{let source='system';const previous=window.__TAURI__.core.invoke;window.__TAURI__.core.invoke=async(n,a)=>{if(n==='tailscale_mode'){source=a.mode==='embedded'?'embedded':'system';return {source,embeddedAvailable:true,state:source==='embedded'?'NeedsLogin':'Running',ips:[],peers:[],installed:true};}if(n==='tailscale_status')return {source,embeddedAvailable:true,state:source==='embedded'?'NeedsLogin':'Running',ips:[],peers:[],installed:true};return previous(n,a);};document.getElementById('add-computer').click();document.getElementById('tailnet-settings').open=true;})()`);
    await delay(150);
    assert.equal(await evaluate("document.getElementById('tailscale-mode').hidden"),false);
    await evaluate("document.getElementById('tailscale-mode').click()");await delay(150);
    assert.equal(await evaluate("document.getElementById('tailscale-setup').textContent"),'登录 Tailscale');
    assert.equal(await evaluate("document.getElementById('tailscale-mode').textContent"),'使用系统网络');
    assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true,name+' overflow');
   }
   if(name.startsWith('delete-')){
    await evaluate("window.confirm=()=>{throw Error('Native confirm must not be used');};document.querySelector('#connections-list .computer-delete').click()");
    await delay(50);
    assert.equal(await evaluate("document.querySelectorAll('dialog[open]').length"),0);
    assert.equal(await evaluate('Runtime.profiles().length'),1);
    assert.equal(await evaluate("Runtime.profiles()[0].id"),'preview-home-mac');
    assert.equal(await evaluate("document.querySelectorAll('#connections-list .connection-card').length"),1);
    await evaluate("document.querySelector('[data-connections]').click();document.querySelector('#computer-switcher-list .computer-delete').click()");await delay(50);
    assert.equal(await evaluate('Runtime.profiles().length'),0);
    assert.equal(await evaluate('window.__networkCalls.length'),0);
    continue;
   }
   if(name.startsWith('about-')){
    await evaluate("loadConnectionName({connectionName:'办公室 Windows',hostName:'OFFICE-PC',version:'chat-revision-not-a-release',release:{serverVersion:'0.2.7'}});document.querySelector('[data-open-settings]').click();document.querySelector('[data-settings-page=about]').click()");
    assert.equal(await evaluate("document.getElementById('about-client-version').textContent"),'1.0.0');
    assert.equal(await evaluate("document.getElementById('about-server-version').textContent"),'0.2.7');
    assert.equal(await evaluate("document.getElementById('about-machine').textContent.includes('100.100.100.1:8787')"),true);
    assert.equal(await evaluate("document.getElementById('settings-dialog').scrollWidth<=document.getElementById('settings-dialog').clientWidth"),true);
    const shot=await call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(shot.data,'base64'));
    await evaluate("loadConnectionName({connectionName:'办公室 Windows'});document.querySelector('[data-open-settings]').click()");
    assert.equal(await evaluate("document.getElementById('about-server-version').textContent"),'服务未提供版本信息');
    await evaluate("loggedOut()");assert.equal(await evaluate("document.getElementById('about-server-version').textContent"),'未连接');
    continue;
   }
   if(name.startsWith('compatibility-')){
    await evaluate("(()=>{const original=window.__TAURI__.core.invoke;window.__compatResult={state:'ready',releaseState:'unsupported'};window.__TAURI__.core.invoke=async(n,a)=>{if(n==='service_probe')return window.__compatResult;if(n==='ssh_status')return {state:'available'};if(n==='ssh_probe'||n==='ssh_start')throw Error('Unexpected SSH authentication');return original(n,a);};document.getElementById('add-computer').click();document.getElementById('computer-address').value='100.64.10.15:8877';document.getElementById('connect-computer-form').requestSubmit();})()");await delay(100);
    assert.equal(await evaluate("document.getElementById('compatibility-guide').hidden"),false);
    assert.equal(await evaluate("document.getElementById('compatibility-upgrade')"),null);
    const shot=await call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(shot.data,'base64'));
    await evaluate("document.getElementById('compatibility-back').click();window.__compatResult={state:'ready',release:{serverVersion:'1.1.0',clientMin:'1.1.0',clientMaxExclusive:'1.2.0'}};document.getElementById('connect-computer-form').requestSubmit()");await delay(100);
    assert.equal(await evaluate("document.getElementById('compatibility-client-help').hidden"),false);
    assert.equal(await evaluate("document.getElementById('compatibility-note').textContent.includes('1.1.0')"),true);
    assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true);
    const newer=await call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,name+'-client.png'),Buffer.from(newer.data,'base64'));
    continue;
   }
   if(name.startsWith('computer-picker-')){
    await evaluate(`(()=>{const original=window.__TAURI__.core.invoke;window.__TAURI__.core.invoke=async(n,a)=>{if(n==='tailscale_status')return {state:'Running',peers:[{name:'demo-user 的 Mac mini',address:'100.64.10.14',isSelf:true},{name:"demo-user’s MacBook Pro",address:'100.64.10.10'},{name:'PJW-demo-user',address:'100.64.10.11'}]};if(n==='service_probe'){window.__pickedAddress=a.address;throw Error('预览连接检查');}return original(n,a);};document.getElementById('add-computer').click();})()`);
    await delay(100);
    assert.equal(await evaluate("document.querySelectorAll('.computer-suggestion').length"),3);
    assert.equal(await evaluate("document.getElementById('computer-address').hasAttribute('list')"),false);
    assert.equal(await evaluate("[...document.querySelectorAll('.computer-suggestion')].every(b=>{const [n,ip]=b.children;return Math.abs(n.getBoundingClientRect().y-ip.getBoundingClientRect().y)<1&&b.scrollWidth<=b.clientWidth;})"),true,'name and IP must share one row without overflow');
    const shot=await call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(shot.data,'base64'));
    await evaluate("document.querySelectorAll('.computer-suggestion')[1].click()");
    assert.equal(await evaluate("document.getElementById('computer-address').value"),'demo-user’s MacBook Pro（100.64.10.10）');
    await evaluate("document.getElementById('connect-computer-form').requestSubmit()");await delay(100);
    assert.equal(await evaluate('window.__pickedAddress'),'https://100.64.10.10:8787');
    await evaluate("(()=>{const input=document.getElementById('computer-address');input.value='PJW';input.dispatchEvent(new Event('input'));})()");
    assert.equal(await evaluate("document.querySelectorAll('.computer-suggestion').length"),1);
    assert.equal(await evaluate("document.getElementById('computer-address').dataset.selectedAddress"),undefined);
    assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true);
    await evaluate("(()=>{window.__CLIENT_BRIDGE={web:true};const previous=window.__TAURI__.core.invoke;window.__TAURI__.core.invoke=async(n,a)=>n==='service_probe'||n==='ssh_status'?{state:'unreachable'}:previous(n,a);const input=document.getElementById('computer-address');input.value='100.64.10.11';input.dispatchEvent(new Event('input'));document.getElementById('connect-computer-form').requestSubmit();})()");await delay(100);
    assert.equal(await evaluate("document.getElementById('install-package-open')"),null);
    assert.equal(await evaluate("document.getElementById('connection-discovery-help').hidden"),true);
    assert.equal(await evaluate("document.getElementById('install-target').textContent"),'PJW-demo-user（100.64.10.11）');
    assert.equal(await evaluate("document.getElementById('install-target').compareDocumentPosition(document.getElementById('connect-computer-status')) & Node.DOCUMENT_POSITION_FOLLOWING"),4);
    assert.equal(await evaluate("(()=>{const d=document.getElementById('add-computer-dialog');return d.scrollWidth<=d.clientWidth})()"),true);
    const installShot=await call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,name.replace('computer-picker','connection-check')+'.png'),Buffer.from(installShot.data,'base64'));
    continue;
   }
   if(name.startsWith('settings-')){
    await evaluate("loadConnectionName({connectionName:'demo-user的Mac mini',hostName:'demo-user的Mac mini',managed:true});document.querySelector('[data-open-settings]').click()");
    assert.equal(await evaluate("document.querySelector('[data-settings-view=home]').hidden"),false);
    assert.equal(await evaluate("document.getElementById('ssh-key-host').getClientRects().length"),0);
    for(const page of ['home','connection','alias','ssh','fingerprints','about']){
     if(page!=='home')await evaluate(`showSettingsPage('${page}')`);
     assert.equal(await evaluate("document.getElementById('settings-dialog').scrollWidth<=document.getElementById('settings-dialog').clientWidth"),true,name+' '+page+' overflow');
     const shot=await call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,name+'-'+page+'.png'),Buffer.from(shot.data,'base64'));
    }
    await evaluate("window.confirm=()=>{throw Error('Native confirm is unavailable');};showSettingsPage('connection');document.getElementById('guardian-restart').click()");
    assert.equal(await evaluate("document.getElementById('guardian-restart-confirm').hidden"),false);
    assert.equal(await evaluate("window.__networkCalls.filter(x=>x==='/api/guardian/restart').length"),0);
    await evaluate("document.getElementById('guardian-restart-cancel').click()");
    assert.equal(await evaluate("document.getElementById('guardian-restart-confirm').hidden"),true);
    await evaluate("document.getElementById('guardian-restart').click();document.getElementById('guardian-restart-accept').click()");
    await delay(50);
    assert.equal(await evaluate("window.__networkCalls.filter(x=>x==='/api/guardian/restart').length"),1);
    assert.equal(await evaluate("document.getElementById('guardian-note').textContent.includes('已接收')"),true);
    await evaluate("showSettingsPage('alias');document.getElementById('connection-name-input').value='我的工作电脑';document.getElementById('connection-name-save').click()");
    assert.equal(await evaluate('Runtime.profile.name'),'我的工作电脑');
    await evaluate("document.getElementById('settings-back').click()");
    assert.equal(await evaluate("document.getElementById('settings-title').textContent"),'连接管理');
    await evaluate("document.getElementById('settings-back').click();document.getElementById('mode').value='manual';document.getElementById('mode').dispatchEvent(new Event('change'))");
    assert.equal(await evaluate("localStorage.getItem('codex-remote-mode')"),'manual');
    await evaluate("document.getElementById('settings-close').click();document.querySelector('[data-open-settings]').click()");
    assert.equal(await evaluate("document.getElementById('settings-title').textContent"),'设置');
    continue;
   }
   if(view==='chat')assert.equal(await evaluate("document.getElementById('reader-connection-name').textContent"),'办公室 Windows');
   if(name.startsWith('models-')){
    assert.equal(await evaluate("window.__networkCalls.filter(p=>p==='/api/models').length"),0,'model catalog polled before opening');
    await evaluate("document.getElementById('model-picker-open').click()");
    for(let i=0;i<80;i++){if(await evaluate("document.getElementById('model-select').options.length===3"))break;await delay(100);}
    await evaluate("(()=>{const s=document.getElementById('model-select');s.value='example-deep';s.dispatchEvent(new Event('change'));document.getElementById('model-fast').click();})()");
    assert.equal(await evaluate("document.querySelectorAll('#model-efforts button').length"),6);
    assert.equal(await evaluate("(()=>{const r=document.getElementById('model-dialog').getBoundingClientRect();return r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight})()"),true,'model popover outside viewport');
    assert.equal(await evaluate("document.getElementById('model-apply')===null"),true);
    assert.equal(await evaluate('window.__settingsUpdates.length'),0);
    assert.equal(await evaluate("document.getElementById('model-picker-open').textContent.includes('示例推理模型')"),true,await evaluate("JSON.stringify({label:document.getElementById('model-picker-open').textContent,disabled:document.getElementById('model-fast').disabled,selected:document.getElementById('model-select').value})"));
   }
   if(name==='chat-mobile'){
    const mediaPath='C:\\Users\\fixture\\.config\\codex-remote\\outbox.jsonl.queue.images\\image.png';
    await evaluate(`(()=>{const box=document.createElement('div');box.id='media-regression';document.getElementById('messages').append(box);Rich.render(box,${JSON.stringify('![clipboard](<'+mediaPath+'>)')},{thread:'fixture',message:'image-message'});box.querySelector('.media-load').click();})()`);
    for(let i=0;i<40;i++){if(await evaluate("document.querySelector('#media-regression img')?.naturalWidth>0"))break;await delay(100);}
    assert.equal(await evaluate("document.querySelector('#media-regression img')?.naturalWidth>0"),true,'Windows clipboard image did not load');
    assert.equal(await evaluate("new URL(window.__networkCalls.find(p=>p.startsWith('/api/media?')),'http://fixture').searchParams.get('path')"),mediaPath,'Markdown corrupted Windows path');
    await evaluate("document.getElementById('media-regression').remove()");
   }
   const image=await call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(image.data,'base64'));
   if(name.startsWith('models-')){
    await evaluate("(()=>{const s=document.getElementById('model-select');s.value='example-light';s.dispatchEvent(new Event('change'));})()");
    assert.equal(await evaluate("document.getElementById('model-fast').disabled"),true);
    await evaluate("document.getElementById('model-close').click()");
    const send=async text=>{await evaluate(`(()=>{const p=document.getElementById('prompt');p.value=${JSON.stringify(text)};p.dispatchEvent(new Event('input'));document.getElementById('composer').requestSubmit();})()`);await delay(250);};
    await send('first');
    assert.deepEqual(await evaluate('window.__sends[0].modelSettings'),{model:'example-light',effort:'low',fast:false});
    await send('second');
    assert.equal(await evaluate("Object.hasOwn(window.__sends[1],'modelSettings')"),false,'unchanged settings sent again');
    await evaluate("previewThread.status='active';previewThread.activeTurnId='turn-preview';sync()");await delay(150);
    assert.equal(await evaluate("document.getElementById('send').dataset.action"),'stop');
    await evaluate("document.getElementById('send').click()");await delay(150);
    assert.deepEqual(await evaluate('window.__stops[0]'),{threadId:'fixture',turnId:'turn-preview'});
    assert.equal(await evaluate("document.getElementById('send').dataset.action"),'send');
   }
  }
  assert.deepEqual(errors,[]);if(process.env.UI_SMOKE_FILTER)console.log('UI scenarios passed: '+process.env.UI_SMOKE_FILTER+'; screenshots: '+out);else console.log('Shared UI: connections, mobile settings/chat, desktop/mobile model picker, Fast capabilities, local model drafts, per-message settings, unchanged omission, pinned turn stop, Windows clipboard media paths and image decode, no idle model queries or JS exceptions; screenshots: '+out);
  // finally closes the socket and process; Browser.close can close before replying.
 }finally{if(ws)ws.close();child.kill();server.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
