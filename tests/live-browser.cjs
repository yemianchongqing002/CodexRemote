// NODE_PATH=<playwright modules> node tests/live-browser.cjs
const {chromium}=require('playwright');
const {readFileSync}=require('node:fs');
const {resolve}=require('node:path');
const assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{})});
 try{
 const page=await browser.newPage({viewport:{width:390,height:844}});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.setContent(readFileSync(resolve('internal/server/web/index.html'),'utf8').replace(/<script[\s\S]*?<\/script>/g,'').replace(/<link[^>]*>/g,''));
 await page.addStyleTag({content:readFileSync(resolve('internal/server/web/style.css'),'utf8')});
 await page.evaluate(()=>{
  window.Runtime={hidden:false,storage:()=>({getItem:()=>null,setItem(){}})};
  window.remote={approvalPolicy:'on-request',approvalsReviewer:'user',activePermissionProfile:{id:':workspace'},sandboxPolicy:{type:'workspaceWrite'},model:'gpt-6-astra',effort:'medium',permissionSelection:{agentMode:'auto',source:'desktop-preference',canChange:false,reason:'请在 Codex 中修改后同步'},permissionVersion:'a'.repeat(64),permissionSource:'next-turn',approvals:[{key:'b'.repeat(64),kind:'command',params:{command:'cat /private/example.txt',cwd:'/project',reason:'需要读取工作区之外的文件'},decisions:['accept','decline']}]};
  window.posts=[];window.fail=false;window.hold=false;
  window.api=async(path,options={})=>{
   if(path==='/api/models')return {models:[{model:'gpt-6-astra',defaultReasoningEffort:'medium',supportedReasoningEfforts:[{reasoningEffort:'medium',description:'中等思考'}]}]};
   if(window.fail)throw Error('桌面连接中断');
   if(options.method==='POST'){
    const body=JSON.parse(options.body);window.posts.push({path,...body});
    if(path.endsWith('/permissions')){window.remote.approvalPolicy=body.approvalPolicy;window.remote.approvalsReviewer=body.approvalsReviewer;window.remote.activePermissionProfile={id:body.permissions};window.remote.permissionVersion='c'.repeat(64);}
    else window.remote.approvals=[];
   }
   if(window.hold)return new Promise(resolve=>window.release=()=>resolve(structuredClone(window.remote)));
   return structuredClone(window.remote);
  };
  for(const id of ['login','welcome'])document.getElementById(id).hidden=true;
  for(const id of ['app','conversation','composer'])document.getElementById(id).hidden=false;
  document.body.classList.add('detail');document.getElementById('chat-title').textContent='远程审批测试';
 });
 await page.addScriptTag({path:resolve('internal/server/web/models.js')});
 await page.addScriptTag({path:resolve('internal/server/web/live.js')});
 await page.evaluate(()=>{ModelPicker.update({threadId:'a',enabled:true,busy:false,api});LiveControls.update({threadId:'a',enabled:true,auto:false,api});});
 await page.getByText('命令执行 · 等待批准',{exact:true}).waitFor();
 assert.match(await page.locator('#model-picker-open').innerText(),/gpt-6-astra/);
 await page.screenshot({path:'/tmp/cr-live-qa/approval-mobile.png'});
 await page.locator('#approval-panel').getByRole('button',{name:'拒绝',exact:true}).click();
 await page.waitForFunction(()=>document.getElementById('approval-panel').hidden);
 assert.equal(await page.evaluate(()=>posts[0].decision),'decline');
 await page.locator('#model-picker-open').click();
 assert.equal(await page.locator('#permission-select').isDisabled(),false);
 await page.locator('#permission-select').selectOption('full-access');
 assert.match(await page.locator('#permission-description').innerText(),/对后续轮次生效/);
 await page.locator('#permission-apply').click();
 await page.waitForFunction(()=>document.getElementById('permission-current').textContent.includes('完全访问'));
 assert.equal(await page.evaluate(()=>posts[1].permissions),':danger-full-access');
 assert.equal(await page.evaluate(()=>remote.permissionSelection.agentMode),'auto');
 await page.locator('#model-close').click();
 await page.evaluate(()=>{window.fail=true;return LiveControls.refresh();});
 assert.equal(await page.locator('#permission-select').isDisabled(),true);
 assert.match(await page.locator('#live-status').innerText(),/连接中断/);
 await page.evaluate(()=>{window.fail=false;window.hold=true;void LiveControls.refresh();});
 await page.evaluate(()=>{LiveControls.update({threadId:'b',enabled:false,auto:false,api});window.release();});
 assert.equal(await page.locator('#approval-panel').isHidden(),true);
 assert.equal(await page.locator('#permission-apply').isDisabled(),true);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 assert.deepEqual(errors,[]);
 console.log('Live approval, desktop permission sync, disconnect, stale response and mobile layout checks passed');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
