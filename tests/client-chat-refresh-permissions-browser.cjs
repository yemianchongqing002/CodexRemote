const {chromium}=require('playwright'),assert=require('node:assert/strict');
const {start}=require('../client/tests/preview-server.cjs');
(async()=>{
 const app=await start(),browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH});
 try{
  const page=await browser.newPage();await page.goto(app.url+'/?view=chat');await page.locator('#app').waitFor();await page.waitForFunction(()=>!document.getElementById('live-refresh').disabled);
  await page.evaluate(async()=>{
   state.mode='manual';renderComposer();window.desktopReviewer='user';window.liveReads=0;
   const original=window.__TAURI__.core.invoke;
   window.__TAURI__.core.invoke=async(name,args)=>{
    if(name==='request'&&args.path.startsWith('/api/thread/live?')){
     window.liveReads++;await new Promise(r=>setTimeout(r,100));
     return {status:200,contentType:'application/json',body:btoa(JSON.stringify({permissionSelection:{agentMode:window.desktopReviewer==='user'?'auto':'guardian-approvals',source:'desktop-preference',canChange:false},approvalPolicy:'on-request',permissionVersion:'a'.repeat(64),activePermissionProfile:{id:':workspace'},sandboxPolicy:{type:'workspaceWrite'},approvalsReviewer:window.desktopReviewer,model:'example-deep',effort:'medium',approvals:[]}))};
    }
    return original(name,args);
   };
   await LiveControls.refresh();
  });
  assert.equal(await page.locator('#permission-trigger-label').textContent(),'请求批准');
  await page.evaluate(()=>{window.desktopReviewer='guardian_subagent';window.liveReads=0;});
  await page.locator('#chat-refresh').dblclick();await page.waitForFunction(()=>!document.getElementById('live-refresh').hasAttribute('aria-busy'));
  assert.equal(await page.locator('#permission-trigger-label').textContent(),'帮我批准');assert.equal(await page.evaluate(()=>window.liveReads),1);
  await page.evaluate(()=>{window.desktopReviewer='user';});await page.locator('#live-refresh').click();await page.waitForFunction(()=>!document.getElementById('live-refresh').hasAttribute('aria-busy'));
  assert.equal(await page.locator('#permission-trigger-label').textContent(),'请求批准');
  console.log('Both refresh controls re-read desktop permissions in manual mode even when chat version is unchanged; duplicate clicks make one live request.');
 }finally{await browser.close();await new Promise(r=>app.server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
