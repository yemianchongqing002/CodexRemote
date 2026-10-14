const {chromium}=require('playwright'),http=require('node:http'),assert=require('node:assert/strict');
const {start}=require('../client/web/server.cjs');
(async()=>{
 const projects=[{id:'shi',name:'shi-ya-ya',path:'/projects/shi',available:true},{id:'piano',name:'PianoArc',path:'/Volumes/offline/ExampleProject',available:false},{id:'remote',name:'CodexRemote',path:'/projects/remote',available:true}];
 const task=(id,title,projectId='',archived=false)=>({id,title,projectId,project:projects.find(p=>p.id===projectId)?.name||'',projectPath:projectId?projects.find(p=>p.id===projectId).path:'/temporary/wo',archived,status:'idle',updated:'2026-09-11T10:00:00Z',count:0});
 const threads=[task('refactor','帮我重构一下代码结构，我们代码现在很冗余','remote'),task('model','确认模型是否传递至客户端','remote'),task('stack','检查项目技术栈与视频支持','shi'),task('piano-task','分析钢琴训练软件架构','piano'),task('recent1','排查 Mac 远程连接实例问题'),task('recent2','创建童趣古诗背诵工程'),task('archived','归档任务','',true)];
 let warning='',waiting=true;
 const target=http.createServer((req,res)=>{
  const path=new URL(req.url,'http://localhost').pathname;
  const payload=path==='/api/thread/live'?{approvals:waiting?[{key:'request',kind:'command',params:{command:'test'},decisions:['accept']}]:[]}:path==='/api/status'?{adapter:'desktop-rollout',connectionName:'测试电脑',authRequired:false,sendingEnabled:true}:path==='/api/threads'?{threads,projects,sections:[],warning}:path==='/api/thread'?{thread:threads.find(t=>t.id===new URL(req.url,'http://localhost').searchParams.get('id')),messages:[],cursor:''}:{};
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify(payload));
 });await new Promise(r=>target.listen(0,'127.0.0.1',r));const web=await start();
 const browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{})});
 try{
  const page=await browser.newPage({viewport:{width:1000,height:800}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(web.url);await page.locator('#add-computer').click();await page.locator('#computer-address').fill('127.0.0.1:'+target.address().port);await page.locator('#connect-computer-submit').click();await page.locator('#app').waitFor();await page.locator('.project-name').first().waitFor();
  assert.deepEqual(await page.locator('.sidebar-section-title').allTextContents(),['项目','最近']);
  assert.deepEqual(await page.locator('.project-name').allTextContents(),['shi-ya-ya','PianoArc','CodexRemote']);
  assert.deepEqual(await page.locator('.recent-section .thread-title').allTextContents(),['排查 Mac 远程连接实例问题','创建童趣古诗背诵工程']);
  assert.equal(await page.locator('.project-path,.project-count,.thread-info').count(),0);
  assert.equal(await page.locator('.project-heading.unavailable').count(),1);
  const group=page.locator('[data-project-id=remote]');await group.locator('summary').click();await page.locator('#refresh').click();assert.equal(await group.getAttribute('open'),null);
  await page.locator('#search').fill('确认模型');assert.equal(await page.locator('.thread:visible').count(),1);await page.locator('#search').fill('');assert.equal(await group.getAttribute('open'),null);await group.locator('summary').click();
  threads[1].status='active';await page.locator('#refresh').click();
  const approval=page.locator('[data-thread-id=model] .thread-approval');await approval.waitFor();assert.equal(await approval.textContent(),'等待批准');
  waiting=false;await page.locator('#refresh').click();await approval.waitFor({state:'detached'});
  waiting=true;await page.locator('#refresh').click();await approval.waitFor();
  threads[1].archived=true;await page.locator('#refresh').click();await approval.waitFor({state:'detached'});
  threads[1].archived=false;threads[1].status='idle';waiting=false;await page.locator('#refresh').click();
  threads[0].title='Codex 中的新标题';threads[0].projectId='shi';threads[0].project='shi-ya-ya';await page.locator('#refresh').click();await page.getByText('Codex 中的新标题',{exact:true}).waitFor();assert.equal(await page.locator('[data-project-id=shi] .thread').count(),2);
  await page.locator('#archive').check();assert.deepEqual(await page.locator('.thread-title').allTextContents(),['归档任务']);await page.locator('#archive').uncheck();
  for(const width of [320,390,1000]){await page.setViewportSize({width,height:800});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);}
  require('node:fs').mkdirSync('.local/sidebar-preview',{recursive:true});await page.screenshot({path:'.local/sidebar-preview/client.png'});
  assert.deepEqual(errors,[]);console.log('Sidebar: projects/recent, names, ordering, unavailable roots, collapse, search, archive, reassignment and responsive layout passed');
 }finally{await browser.close();web.server.closeAllConnections();target.closeAllConnections();await new Promise(r=>web.server.close(r));await new Promise(r=>target.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
