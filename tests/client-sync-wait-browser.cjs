const {chromium}=require('playwright'),assert=require('node:assert/strict');
const {start}=require('../client/tests/preview-server.cjs');
(async()=>{
 const app=await start(),browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH});
 try{
  const page=await browser.newPage();await page.goto(app.url+'/?view=chat');await page.locator('#app').waitFor();await page.waitForFunction(()=>!document.getElementById('live-refresh').disabled);
  await page.clock.install();
  await page.evaluate(()=>{
   LiveControls.pause();window.calls=0;window.aborts=0;
   LiveControls.update({threadId:'wait-test',enabled:true,auto:false,api:(_path,{signal})=>new Promise((resolve,reject)=>{
    window.calls++;window.complete=()=>resolve({approvalPolicy:'on-request',sandboxPolicy:{type:'workspaceWrite'},permissionSelection:{agentMode:'auto',source:'desktop-preference',canChange:false},model:'test',effort:'medium',approvals:[]});
    signal.addEventListener('abort',()=>{window.aborts++;reject(new DOMException('cancelled','AbortError'));});
   })});
  });
  await page.evaluate(()=>{for(let i=0;i<5;i++){document.getElementById('live-refresh').click();}});
  assert.equal(await page.evaluate(()=>window.calls),2);
  await page.clock.fastForward(59000);assert.equal(await page.evaluate(()=>window.aborts),1);assert.equal(await page.locator('#live-refresh').isDisabled(),true);
  await page.clock.fastForward(1001);await page.waitForFunction(()=>!document.getElementById('live-refresh').disabled);
  assert.equal(await page.evaluate(()=>window.aborts),2);assert.equal(await page.locator('#live-status').isVisible(),true);
  await page.evaluate(()=>{void LiveControls.refresh();window.complete();});await page.waitForFunction(()=>!document.getElementById('live-refresh').disabled);
  assert.equal(await page.evaluate(()=>window.calls),3);assert.equal(await page.evaluate(()=>window.aborts),2);
  console.log('Manual sync replaces the poll once; duplicate clicks are coalesced; timeout is visible and releases the button.');
 }finally{await browser.close();await new Promise(r=>app.server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
