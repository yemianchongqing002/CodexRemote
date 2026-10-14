const {chromium}=require('playwright'),assert=require('node:assert/strict');
const {start}=require('../client/tests/preview-server.cjs');
(async()=>{
 const app=await start(),browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH});
 try{
  const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(app.url+'/?view=chat');await page.locator('#app').waitFor();
  await page.locator('#model-picker-open').click();
  const rail=page.locator('#model-efforts');await rail.locator('button').first().waitFor();
  const count=await rail.locator('button').count();assert.ok(count>=2);
  const bounds=await rail.boundingBox(),y=bounds.y+bounds.height/2;
  await page.mouse.move(bounds.x+bounds.width/2,y);await page.waitForTimeout(180);
  const transform=await rail.locator('[aria-pressed=true]').evaluate(e=>getComputedStyle(e,'::before').transform);
  assert.ok(parseFloat(transform.slice(7))>1,'hover enlarges thumb');
  await page.mouse.move(bounds.x+5,y);await page.mouse.down();
  assert.equal(await rail.locator('button').first().getAttribute('aria-pressed'),'true');
  await page.mouse.move(bounds.x+bounds.width+30,y,{steps:8});
  assert.equal(await rail.locator('button').last().getAttribute('aria-pressed'),'true');
  await page.mouse.move(bounds.x-30,y,{steps:8});await page.mouse.up();
  assert.equal(await rail.locator('button').first().getAttribute('aria-pressed'),'true');
  assert.equal(await rail.evaluate(e=>e.classList.contains('dragging')),false);
  await rail.locator('button').first().focus();await page.keyboard.press('End');
  assert.equal(await rail.locator('button').last().getAttribute('aria-pressed'),'true');
  await page.keyboard.press('ArrowLeft');
  assert.equal(await rail.locator('button').nth(count-2).getAttribute('aria-pressed'),'true');
  // Touch uses the same captured Pointer Events path, including cancellation.
  const cdp=await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:bounds.x+5,y}]});
  await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:bounds.x+bounds.width-5,y}]});
  assert.equal(await rail.locator('button').last().getAttribute('aria-pressed'),'true');
  await cdp.send('Input.dispatchTouchEvent',{type:'touchCancel',touchPoints:[]});
  assert.equal(await rail.evaluate(e=>e.classList.contains('dragging')),false);
  assert.deepEqual(errors,[]);
  console.log('Effort rail: hover enlargement, drag across bounds, release, keyboard selection and cancellation passed.');
 }finally{await browser.close();await new Promise(r=>app.server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
