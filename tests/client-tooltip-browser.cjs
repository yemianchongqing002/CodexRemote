const {chromium}=require('playwright'),assert=require('node:assert/strict');
const {start}=require('../client/tests/preview-server.cjs');
(async()=>{
 const app=await start(),browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH});
 try{
  const page=await browser.newPage();await page.goto(app.url+'/?view=chat');await page.locator('#app').waitFor();
  for(const [id,text] of [['live-refresh','同步审批权限和模型选择列表'],['chat-refresh','刷新此聊天']]){
   const button=page.locator('#'+id);await button.hover();const startTime=Date.now();
   await page.waitForTimeout(950);assert.equal(await page.locator('#client-tooltip').isVisible(),false);
   await page.locator('#client-tooltip').waitFor();assert.ok(Date.now()-startTime>=1200);assert.ok(Date.now()-startTime<2000);
   assert.equal(await page.locator('#client-tooltip').textContent(),text);assert.equal(await button.getAttribute('title'),null);
   await page.keyboard.press('Escape');assert.equal(await page.locator('#client-tooltip').isVisible(),false);
  }
  await page.locator('#model-picker-open').click();await page.locator('#model-fast').hover();await page.locator('#client-tooltip').waitFor();
  assert.match(await page.locator('#client-tooltip').textContent(),/Fast/);assert.equal(await page.locator('#client-tooltip').evaluate(e=>e.matches(':popover-open')),true);
  await page.evaluate(()=>{document.getElementById('model-fast').title='更新后的提示';});await page.waitForFunction(()=>document.getElementById('client-tooltip').textContent==='更新后的提示');
  console.log('Tooltips appear after 1.3 seconds, have correct header text, work above dialogs, update dynamically and dismiss on Escape.');
 }finally{await browser.close();await new Promise(r=>app.server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
