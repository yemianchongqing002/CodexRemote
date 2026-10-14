const {chromium,webkit}=require('playwright'),assert=require('node:assert/strict');
const {start}=require('../client/tests/preview-server.cjs');
(async()=>{
 const app=await start(),browser=await (process.env.BROWSER==='webkit'?webkit:chromium).launch({headless:true,executablePath:process.env.BROWSER==='webkit'?process.env.WEBKIT_PATH:process.env.CHROMIUM_PATH});
 try{
  for(const viewport of [{width:1000,height:760},{width:390,height:844}]){
   const page=await browser.newPage({viewport});await page.goto(app.url+'/?view=chat');await page.locator('#app').waitFor();
   await page.evaluate(()=>{
    window.permissionWrites=[];window.currentSettings={approvalPolicy:'on-request',approvalsReviewer:'auto_review',permissions:':workspace'};
    LiveControls.update({threadId:'permission-test',enabled:true,auto:false,api:async(path,options)=>{
     if(path==='/api/thread/permissions'){const payload=JSON.parse(options.body);window.permissionWrites.push(payload);window.currentSettings=payload;}
     return {permissionSelection:{agentMode:'full-access',source:'desktop-preference',canChange:false},approvalPolicy:window.currentSettings.approvalPolicy,approvalsReviewer:window.currentSettings.approvalsReviewer,activePermissionProfile:{id:window.currentSettings.permissions},sandboxPolicy:{type:'workspaceWrite'},permissionVersion:'a'.repeat(64),model:'example-deep',effort:'medium',approvals:[]};
    }});
   });
   await page.locator('#permission-select').click();await page.locator('#permission-menu').waitFor();
   assert.equal(await page.locator('#permission-menu [role=menuitemradio]').count(),3);
   assert.match(await page.locator('#permission-scope-note').innerText(),/对后续轮次生效/);
   assert.equal(await page.locator('#settings-dialog').getByText('会话审批模式',{exact:true}).count(),0);
   assert.equal(await page.locator('[data-reviewer=auto_review]').getAttribute('aria-checked'),'true');
   assert.equal(await page.locator('#permission-menu').evaluate(e=>getComputedStyle(e).backgroundColor),'rgb(255, 255, 255)');
   assert.equal(await page.locator('[data-permissions=":danger-full-access"]').evaluate(e=>getComputedStyle(e).color),'rgb(245, 76, 0)');
   const bounds=await page.locator('#permission-menu').boundingBox();assert.ok(bounds.x>=0&&bounds.x+bounds.width<=viewport.width);
   await page.locator('#permission-menu').screenshot({path:'/tmp/cr-live-qa/permissions-menu-'+viewport.width+'.png'});
   await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');
   await page.waitForFunction(()=>document.getElementById('permission-trigger-label').textContent==='完全访问权限');
   assert.equal(await page.evaluate(()=>window.permissionWrites[0].permissions),':danger-full-access');assert.equal(await page.evaluate(()=>window.permissionWrites[0].version),'a'.repeat(64));assert.equal(await page.evaluate(()=>window.permissionWrites.some(p=>'mode' in p||'permissionMode' in p)),false);
   await page.locator('#permission-select').click();await page.locator('[data-reviewer=auto_review]').click();
   await page.waitForFunction(()=>document.getElementById('permission-trigger-label').textContent==='帮我批准');assert.equal(await page.evaluate(()=>window.permissionWrites[1].approvalsReviewer),'auto_review');
   await page.locator('#permission-select').click();await page.keyboard.press('Escape');assert.equal(await page.locator('#permission-menu').isVisible(),false);assert.equal(await page.locator('#permission-select').evaluate(e=>e===document.activeElement),true);
   await page.locator('#permission-select').click();await page.locator('.permission-learn').click();assert.equal(await page.locator('#permission-help').isVisible(),true);
   await page.locator('#chat-title').click();assert.equal(await page.locator('#permission-menu').isVisible(),false);
   await page.evaluate(async()=>{window.currentSettings={approvalPolicy:'on-request',approvalsReviewer:'guardian_subagent',permissions:':workspace'};await LiveControls.refresh();window.currentSettings.approvalsReviewer='user';await LiveControls.refresh();});
   assert.equal(await page.locator('#permission-trigger-label').textContent(),'请求批准');
   assert.match(await page.locator('#permission-select').getAttribute('data-tooltip'),/Codex 桌面选择：完全访问权限/);
   await page.evaluate(()=>{
    LiveControls.update({threadId:'permission-test',enabled:true,auto:false,api:()=>new Promise(resolve=>{window.resolvePermission=resolve;})});
   });
   await page.locator('#permission-select').click();await page.locator('[data-permissions=":danger-full-access"]').click();
   assert.equal(await page.locator('#permission-trigger-label').textContent(),'请求批准');
   assert.equal(await page.locator('#permission-select').isEnabled(),false);
   await page.evaluate(()=>window.resolvePermission({approvalPolicy:'on-request',permissionVersion:'b'.repeat(64),activePermissionProfile:{id:':workspace'},sandboxPolicy:{type:'workspaceWrite'},approvalsReviewer:'auto_review',model:'example-deep',effort:'medium',approvals:[]}));
   await page.waitForFunction(()=>document.getElementById('permission-trigger-label').textContent==='帮我批准');
   await page.locator('#permission-select').click();assert.equal(await page.locator('[data-reviewer=auto_review]').getAttribute('aria-checked'),'true');assert.equal(await page.locator('[data-permissions=":danger-full-access"]').getAttribute('aria-checked'),'false');
   await page.close();
  }
  console.log('Desktop/mobile permission popover matches colors, mode selection, confirmed writeback, keyboard navigation, dismissal and help.');
 }finally{await browser.close();await new Promise(r=>app.server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
