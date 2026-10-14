const {chromium}=require('playwright'),assert=require('node:assert/strict');
const {start}=require('../client/tests/preview-server.cjs');
(async()=>{
 const app=await start(),browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH});
 try{
  const page=await browser.newPage();await page.goto(app.url+'/?view=chat');await page.locator('#app').waitFor();
  await page.evaluate(async()=>{
   window.syncMode='ready';window.liveDelay=0;window.catalogDelay=0;
   window.syncAPI=async path=>{
    if(path==='/api/models'){await new Promise(r=>setTimeout(r,window.catalogDelay));return {models:[{model:'sync-model',supportedReasoningEfforts:['medium','high'].map(reasoningEffort=>({reasoningEffort,description:''})),serviceTiers:[{id:'priority'}]}]};}
    await new Promise(r=>setTimeout(r,window.liveDelay));
    if(window.syncMode==='fail')throw new Error('同步测试失败');
    return {permissionSelection:{agentMode:'full-access',source:'desktop-preference',canChange:false},model:'sync-model',...(window.syncMode==='missing'?{}:{effort:'medium'}),fast:false,approvalPolicy:'never',approvalsReviewer:'user',activePermissionProfile:{id:':danger-full-access'},sandboxPolicy:{type:'dangerFullAccess'},approvals:[]};
   };
   ModelPicker.update({threadId:'sync-test',enabled:true,api:window.syncAPI});
   LiveControls.update({threadId:'sync-test',enabled:true,auto:false,api:window.syncAPI});
   await LiveControls.refresh(true);
  });
  await page.waitForFunction(()=>!document.getElementById('live-refresh').disabled);
  async function draft(){
   await page.locator('#model-picker-open').click();await page.locator('#model-efforts button[aria-label="高"]').click();await page.locator('#model-fast').click();await page.keyboard.press('Escape');
   assert.equal((await page.evaluate(()=>ModelPicker.snapshot('sync-test'))).effort,'high');
  }
  async function sync(){await page.locator('#live-refresh').click();await page.waitForFunction(()=>!document.getElementById('live-refresh').hasAttribute('aria-busy'));}
  for(const delays of [[40,0],[0,40]]){
   await page.evaluate(([live,catalog])=>{window.liveDelay=live;window.catalogDelay=catalog;},delays);
   await draft();await page.evaluate(()=>LiveControls.refresh());
   assert.equal((await page.evaluate(()=>ModelPicker.snapshot('sync-test'))).effort,'high');
   await sync();assert.equal(await page.evaluate(()=>ModelPicker.snapshot('sync-test')),undefined);
   assert.match(await page.locator('#model-picker-open').textContent(),/中/);
   await page.locator('#model-picker-open').click();await page.locator('#model-efforts button[aria-label="中"]').waitFor();assert.equal(await page.locator('#model-effort-name').textContent(),'中');assert.equal(await page.locator('#model-fast').getAttribute('aria-pressed'),'false');await page.keyboard.press('Escape');
   assert.equal(await page.evaluate(()=>JSON.parse(Runtime.storage('session').getItem('cr-model-drafts')).some(([id])=>id==='sync-test')),false);
  }
  for(const mode of ['fail','missing']){
   await page.evaluate(()=>{window.syncMode='ready';});await draft();await page.evaluate(mode=>{window.syncMode=mode;},mode);await sync();
   assert.equal((await page.evaluate(()=>ModelPicker.snapshot('sync-test'))).effort,'high');assert.equal(await page.locator('#live-status').isVisible(),true);
  }
  await page.evaluate(async()=>{
   window.syncMode='ready';window.liveDelay=60;
   window.oldSync=LiveControls.refresh(true,{discardDraft:true});
   ModelPicker.update({threadId:'other-thread',enabled:true,api:window.syncAPI});
   LiveControls.update({threadId:'other-thread',enabled:true,auto:false,api:window.syncAPI});
   await window.oldSync;
  });
  assert.equal((await page.evaluate(()=>ModelPicker.snapshot('sync-test'))).effort,'high');
  await page.evaluate(async()=>{
   LiveControls.update({threadId:'unowned-thread',enabled:true,auto:false,api:async()=>{throw Error('桌面尚未接管这个聊天；请在目标电脑打开该聊天后重试（桌面返回：no-client-found）');}});
   await LiveControls.refresh(true);
  });
  assert.equal(await page.locator('#live-status').isVisible(),false);
  assert.equal(await page.locator('#live-status').textContent(),'');
  assert.equal(await page.locator('#permission-select').isVisible(),false);
  console.log('Manual sync restores desktop effort/Fast and clears persisted drafts in both response orders; polling, failures, incomplete data and stale responses preserve drafts.');
 }finally{await browser.close();await new Promise(r=>app.server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
