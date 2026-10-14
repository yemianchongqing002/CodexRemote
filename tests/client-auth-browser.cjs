const {chromium}=require('playwright'),http=require('node:http'),assert=require('node:assert/strict');
const {start}=require('../client/web/server.cjs');
(async()=>{
 let mode='down',logins=0;
 const service=http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');if(mode==='down'){res.writeHead(503);res.end('{}');return;}if(req.url==='/api/login'){logins++;mode='ready';res.end('{}');return;}if(mode==='auth'){res.writeHead(401);res.end('{"error":"请先输入访问口令"}');return;}res.end(JSON.stringify(req.url==='/api/status'?{adapter:'desktop-rollout',authRequired:false,connectionName:'免口令测试',sendingEnabled:false}:req.url==='/api/threads'?{threads:[]}:{models:[]}));});
 await new Promise(r=>service.listen(0,'127.0.0.1',r));const web=await start();const address='http://127.0.0.1:'+service.address().port;
 const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH});
 try{
  const context=await browser.newContext();await context.addInitScript(address=>{if(localStorage.getItem('cr-client-profiles'))return;localStorage.setItem('cr-client-profiles',JSON.stringify([{id:'auth-test-computer',name:'测试',address},{id:'other-test-computer',name:'备用电脑',address:'http://127.0.0.1:1'}]));sessionStorage.setItem('cr-client-active','auth-test-computer');},address);
  const page=await context.newPage();await page.goto(web.url);await page.locator('#login').waitFor();assert.equal(await page.locator('#token').isVisible(),false);assert.equal(await page.locator('#token').getAttribute('required'),null);
  assert.equal(await page.locator('#login-title').innerText(),'连接失败');
  assert.equal(await page.locator('#login-form .brand-mark').count(),0);
  for(const width of [320,390,1100]){
   await page.setViewportSize({width,height:800});
   const box=await page.locator('#login-machine-switch').boundingBox();assert(box.x<40&&box.y<40);
   assert.equal(await page.locator('#login-machine-name').innerText(),'测试');
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  }
  await page.setViewportSize({width:390,height:800});
  await page.screenshot({path:'/tmp/codex-connection-failed.png'});
  await page.locator('#login-machine-switch').click();
  await page.locator('.computer-option').filter({hasText:'备用电脑'}).click();
  await page.waitForFunction(()=>Runtime.profile?.id==='other-test-computer');
  await page.locator('#login').waitFor();
  assert.equal(await page.locator('#login-machine-name').innerText(),'备用电脑');
  await page.locator('#login-machine-switch').click();
  await page.locator('.computer-option').filter({hasText:'测试'}).click();
  await page.waitForFunction(()=>Runtime.profile?.id==='auth-test-computer');
  await page.locator('#login').waitFor();
  mode='ready';await page.locator('#login-form button[type=submit]').click();await page.locator('#app').waitFor();assert.equal(logins,0);
  mode='auth';await page.reload();await page.locator('#token').waitFor();await page.locator('#token').fill('fixture-only');await page.locator('#login-form button[type=submit]').click();await page.locator('#app').waitFor();assert.equal(logins,1);
  console.log('Network failure keeps token hidden; no-auth retry skips login; explicit 401 still requests authentication');
 }finally{await browser.close();await new Promise(r=>web.server.close(r));await new Promise(r=>service.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
