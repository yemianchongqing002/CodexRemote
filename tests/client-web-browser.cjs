const {chromium}=require('playwright'),http=require('node:http'),assert=require('node:assert/strict');
const {start}=require('../client/web/server.cjs');
(async()=>{
 let available=false;
 const target=http.createServer((req,res)=>{
  if(!available){res.writeHead(503);res.end('unavailable');return;}
  res.setHeader('Content-Type','application/json');const p=new URL(req.url,'http://localhost').pathname;
  const payload=p==='/api/status'?{adapter:'desktop-rollout',connectionName:'测试电脑',hostName:'fixture',authRequired:false,sendingEnabled:false}:p==='/api/threads'?{threads:[]}:p==='/api/models'?{models:[]}:{};
  res.end(JSON.stringify(payload));
 });await new Promise(r=>target.listen(0,'127.0.0.1',r));const web=await start();
 const browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{})});
 try{
  const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/bridge',route=>{const body=route.request().postDataJSON();if(body.name==='ssh_status')return route.fulfill({json:{state:'closed',port:22}});return route.continue();});
  await page.goto(web.url);await page.locator('#add-computer').waitFor();assert.equal(await page.locator('#ssh-form').isVisible(),false);
  await page.locator('#add-computer').click();
  assert.equal(await page.locator('#add-computer-dialog input:visible').count(),1);
  assert.equal(await page.locator('#add-computer-dialog button:visible').count(),2); // Close and Connect only.
  await page.locator('#computer-address').fill('127.0.0.1:'+target.address().port);
  await page.locator('#connect-computer-submit').click();
  await page.locator('#computer-install-guide').waitFor();
  assert.equal(await page.evaluate(()=>Runtime.profiles().length),0);
  assert.equal(await page.locator('#connect-computer-form').isVisible(),false);
  await page.locator('#install-ssh-retry').waitFor();
  assert.equal(await page.locator('#install-download').count(),0);
  available=true;
  await page.locator('#install-retry').click();
  await page.locator('#app').waitFor();assert.equal(await page.locator('#connection-name').innerText(),'测试电脑');
  await page.locator('.brand [data-connections]').click();assert.equal(await page.locator('.computer-option[aria-current="true"]').count(),1);
  await page.locator('#computer-switcher-close').click();assert.equal(await page.locator('#app').isVisible(),true);
  assert.deepEqual(errors,[]);console.log('Real browser adapter: add machine, reload, proxy connection and floating switcher passed');
 }finally{await browser.close();await new Promise(r=>web.server.close(r));await new Promise(r=>target.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
