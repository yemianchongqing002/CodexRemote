// Optional integration test. Requires Playwright in the development environment only.
// Build bin/codex-remote, then: NODE_PATH=<playwright modules> node tests/browser.cjs
const {chromium,webkit} = require('playwright');
const {mkdtempSync,mkdirSync,writeFileSync,appendFileSync,readFileSync,rmSync,chmodSync} = require('node:fs');
const {tmpdir} = require('node:os');
const {join,resolve} = require('node:path');
const {spawn} = require('node:child_process');
const net = require('node:net');
const assert = require('node:assert/strict');
const root = mkdtempSync(join(process.platform==='darwin'?'/tmp':tmpdir(),'codexremote-browser-'));
const log = join(root,'sessions','test.jsonl');
const rec = (type,payload) => JSON.stringify({timestamp:'2026-09-08T10:00:00Z',type,payload})+'\n';
const message = (id,text) => rec('event_msg',{type:'item_completed',item:{type:'AgentMessage',id,content:[{type:'Text',text}]}});
mkdirSync(join(root,'sessions'));
let data=rec('session_meta',{id:'fixture',originator:'Codex Desktop',cwd:'/example/demo'});
data+=rec('event_msg',{type:'item_completed',item:{type:'UserMessage',id:'user',content:[{type:'text',text:'手机同步测试'}]}});
for(let i=0;i<110;i++) data+=message(String(i),'消息 '+i+'\n```js\nconst value = '+i+';\n```');
data+=message('unsafe','<img src=x onerror="window.pwned=true">');
data+=message('wide','很长的路径：/Users/example/'+ 'very-long-project/'.repeat(25)+'\n```txt\n'+ 'wide-code-column '.repeat(40)+'\n```');
const photo=join(root,'photo.png'),gif=join(root,'motion.gif'),video=join(root,'preview.webm');
writeFileSync(video,readFileSync(resolve('tests/fixtures/preview.webm')));
writeFileSync(photo,readFileSync(resolve('tests/fixtures/preview.png')));
writeFileSync(gif,Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7','base64'));
data+=message('rich',[
 '# 移动端富文本测试','这是 **重点**，以及 `inline code`。','- 第一项\n- 第二项',
 '| 项目 | 内容 |\n| --- | --- |\n| 公式 | 可横向滚动 |',
 '$$\n\\int_0^1 x^2 \\,dx = \\frac{1}{3}\n$$',
 '行内 $E=mc^2$，括号公式 \\(a+b\\)。',
 '```mermaid\ngraph LR\n A[手机] --> B[电脑]\n B --> C[聊天记录]\n```',
 '![本地图片](<'+photo+'>)','![动画](<'+gif+'>)',
 '[演示视频](<'+video+'>)',
 '[恶意链接](javascript:alert(1))','<script>window.pwned=true</script>'
].join('\n\n'));
writeFileSync(log,data);
for (const [id,cwd] of [['same-project','/example/demo'],['other-project','/another/demo'],['no-project',''],['create-project',root]]) {
  writeFileSync(join(root,'sessions',id+'.jsonl'),rec('session_meta',{id,originator:'Codex Desktop',cwd})+
    rec('event_msg',{type:'item_completed',item:{type:'UserMessage',id:'first',content:[{type:'text',text:id}]}}));
}
const catalogDB=require('./fixtures/desktop-catalog.cjs').catalog(root,
 [{id:'demo',name:'demo',path:'/example/demo'},{id:'other',name:'demo',path:'/another/demo'},{id:'create',name:'create',path:root}],
 [{id:'fixture',title:'手机同步测试',cwd:'/example/demo',projectId:'demo'},
 {id:'same-project',title:'same-project',cwd:'/example/demo',projectId:'demo'},
 {id:'other-project',title:'other-project',cwd:'/another/demo',projectId:'other'},
 {id:'no-project',title:'no-project'},
 {id:'create-project',title:'create-project',cwd:root,projectId:'create'}]);
 catalogDB.close();
const ipc=net.createServer(socket=>{
  let pending=Buffer.alloc(0);socket.on('error',()=>{});
  socket.on('data',chunk=>{pending=Buffer.concat([pending,chunk]);while(pending.length>=4 && pending.length>=4+pending.readUInt32LE(0)){
    const size=pending.readUInt32LE(0),r=JSON.parse(pending.subarray(4,4+size));pending=pending.subarray(4+size);
    let result={};let error=null;let delay=0;
    if(r.method==='initialize')result={clientId:'browser-test'};
    else if(r.method==='thread-owner-discovery')result={supportsUntrustedAppInput:true};
    else if(r.method==='thread-follower-steer-turn' || r.method==='thread-follower-start-turn'){
      const text=r.method==='thread-follower-steer-turn'?r.params.input[0].text:r.params.turnStart.request.input[0].text;
      if(text==='模拟拒绝')error='permission denied';
      else {result=r.method==='thread-follower-steer-turn'?{result:{turnId:'test-turn'}}:{result:{turn:{id:'queued-turn'}}};delay=text==='后台发送测试'?1200:0;
        appendFileSync(log,rec('event_msg',{type:'item_completed',item:{type:'UserMessage',id:r.params.clientUserMessageId,content:[{type:'text',text}]}}));
        appendFileSync(log,message('reply-'+r.params.clientUserMessageId,'电脑回复：'+text));}
    } else error='unsupported';
    const reply=Buffer.from(JSON.stringify({type:'response',requestId:r.requestId,method:r.method,handledByClientId:'desktop-owner',resultType:error?'error':'success',result,error}));
    const frame=Buffer.alloc(4+reply.length);frame.writeUInt32LE(reply.length);reply.copy(frame,4);setTimeout(()=>{if(!socket.destroyed)socket.write(frame);},delay);
  }});
});
ipc.listen(join(root,'ipc.sock'));
const fakeCodex=join(root,'fake-codex');
writeFileSync(fakeCodex,'#!'+process.execPath+'\n'+`
const {DatabaseSync}=require('node:sqlite');const fs=require('node:fs'),path=require('node:path'),rl=require('node:readline').createInterface({input:process.stdin});
const id='11111111-2222-4333-8444-555555555555',file=path.join(process.env.CODEX_HOME,'sessions','created.jsonl');
rl.on('line',line=>{const r=JSON.parse(line);if(!r.id)return;let result={};
if(r.method==='thread/start'){fs.writeFileSync(file,JSON.stringify({timestamp:new Date().toISOString(),type:'session_meta',payload:{id,cwd:r.params.cwd,originator:'codex_remote'}})+'\\n');const db=new DatabaseSync(path.join(process.env.CODEX_HOME,'state_5.sqlite'));db.prepare('INSERT INTO threads(id,title,cwd,recency_at_ms,project_id) VALUES (?,?,?,?,?)').run(id,'first',r.params.cwd,Date.now(),'create');db.close();result={thread:{id,path:file}};}
else if(r.method==='thread/inject_items'){fs.appendFileSync(file,JSON.stringify({timestamp:new Date().toISOString(),type:'response_item',payload:r.params.items[0]})+'\\n');}
else if(!['initialize','thread/unsubscribe'].includes(r.method))throw Error('unexpected method '+r.method);
process.stdout.write(JSON.stringify({id:r.id,result})+'\\n');});
`);chmodSync(fakeCodex,0o700);
const proc=spawn(resolve(process.env.SERVER_BINARY||'bin/codex-remote'),['--require-token','--listen','127.0.0.1:18787','--codex-home',root,'--token-file',join(root,'token'),'--interval','1s','--ipc-socket',join(root,'ipc.sock'),'--codex-binary',fakeCodex,'--open-created-in-desktop=false'],{stdio:'ignore'});
let browser;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  for(let n=0;n<100;n++){try{if((await fetch('http://127.0.0.1:18787')).ok)break;}catch{}await sleep(100);}
  browser=await (process.env.TEST_BROWSER==='webkit'?webkit:chromium).launch({headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{}),...(process.env.CHROME_CHANNEL?{channel:process.env.CHROME_CHANNEL}:{})});
  const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:18787');
  await page.locator('#token').fill('wrong');await page.locator('#login-form button[type=submit]').click();
  await page.waitForFunction(()=>document.getElementById('login-error').textContent.length>0);
  await page.locator('#token').fill(readFileSync(join(root,'token'),'utf8').trim());await page.locator('#login-form button[type=submit]').click();
  await page.locator('.thread').first().waitFor();
  assert.equal(await page.locator('.project-group').count(),3,'saved projects stay separate; projectless tasks are recent');
  // Stable project IDs distinguish saved projects with duplicate names.
  const group=page.locator('.project-group[data-project-id=demo]');
  assert.equal(await group.locator('.thread').count(),2);
  await group.locator('summary').click();
  await page.waitForFunction(()=>collapsedProjects.has('demo'));
  await page.evaluate(()=>renderList());
  assert.equal(await group.getAttribute('open'),null,'collapse survives list refresh');
  await page.locator('#search').fill('手机同步测试');
  assert.equal(await page.locator('.thread:visible').count(),1,'search opens matching group');
  await page.locator('#search').fill('/another/demo');
  assert.equal(await page.locator('.project-group').count(),1,'search includes project path');
  await page.locator('#search').fill('');
  assert.equal(await group.getAttribute('open'),null,'clearing search restores collapse');
  await group.locator('summary').click();
  await page.waitForFunction(()=>!collapsedProjects.has('demo'));
  await page.locator('.thread').filter({hasText:'手机同步测试'}).click();
  await page.locator('.message').first().waitFor();
  assert.equal(await page.locator('.message').count(),50);
  assert.equal(await page.locator('#messages img').count(),0);
  assert.equal(await page.evaluate(()=>window.pwned),undefined);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  // Check narrow phones, larger phones and landscape with real overflowing content.
  for (const size of [{width:320,height:568},{width:390,height:844},{width:430,height:932},{width:667,height:375}]) {
    await page.setViewportSize(size);
    await page.locator('#prompt').fill('多行草稿\n第二行\n第三行\n第四行\n第五行\n第六行\n第七行');
    await page.waitForTimeout(80);
    const layout=await page.evaluate(()=>{
      const input=$('prompt').getBoundingClientRect(),send=$('send').getBoundingClientRect();
      return {overflow:document.documentElement.scrollWidth>innerWidth,inputBottom:input.bottom,sendBottom:send.bottom,
        readerHeight:$('scroll').clientHeight,inputHeight:input.height,viewport:visualViewport.height};
    });
    assert.equal(layout.overflow,false,JSON.stringify(size));
    assert.ok(layout.inputBottom<=layout.viewport && layout.sendBottom<=layout.viewport,'composer remains inside viewport');
    assert.ok(layout.readerHeight>=100,'room remains for chat');
    assert.ok(layout.inputHeight<=145,'long drafts have a bounded height');
  }
  await page.setViewportSize({width:390,height:844});
  await page.locator('#prompt').fill('');
  await page.locator('#prompt').focus();
  await page.evaluate(()=>{
    Object.defineProperty(visualViewport,'height',{configurable:true,get:()=>420});
    Object.defineProperty(visualViewport,'offsetTop',{configurable:true,get:()=>20});
    visualViewport.dispatchEvent(new Event('resize'));
  });
  assert.equal(await page.evaluate(()=>document.body.classList.contains('keyboard-open')),true);
  assert.ok(await page.evaluate(()=>$('send').getBoundingClientRect().bottom<=440),'keyboard viewport keeps send visible');
  await page.evaluate(()=>{delete visualViewport.height;delete visualViewport.offsetTop;visualViewport.dispatchEvent(new Event('resize'));$('prompt').blur();});
  assert.equal(await page.evaluate(()=>document.body.classList.contains('keyboard-open')),false);
  if(process.env.SCREENSHOT_DIR){
    mkdirSync(process.env.SCREENSHOT_DIR,{recursive:true});
    await page.screenshot({path:join(process.env.SCREENSHOT_DIR,'mobile-chat.png')});
    await page.locator('#back').click();
    await page.screenshot({path:join(process.env.SCREENSHOT_DIR,'mobile-list.png')});
    await page.locator('.thread').filter({hasText:'手机同步测试'}).click();
  }
  const rich=page.locator('.message').filter({has:page.getByRole('heading',{name:'移动端富文本测试'})});
  await rich.scrollIntoViewIfNeeded();
  await rich.locator('.math-block .katex').waitFor();
  assert.equal(await rich.locator('.math-inline .katex').count(),2);
  assert.equal(await rich.locator('strong').textContent(),'重点');
  assert.equal(await rich.locator('.table-scroll table').count(),1);
  assert.equal(await page.locator('script[src*="mermaid.min"]').count(),0,'diagram library is lazy');
  await rich.getByRole('button',{name:'显示图表',exact:true}).click();
  await rich.locator('.diagram-output svg').waitFor();
  assert.equal(await rich.locator('.diagram-output foreignObject').count(),0);
  assert.ok((await rich.locator('.diagram-output svg').textContent()).includes('手机'),'diagram labels survive sanitization');
  await rich.getByRole('button',{name:'放大',exact:true}).click();await rich.getByRole('button',{name:'适应屏幕',exact:true}).click();
  await rich.getByRole('button',{name:'查看图片 · 本地图片',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.media-slot img')?.naturalWidth>0);
  await rich.getByRole('button',{name:'放大图片',exact:true}).click();
  await page.locator('.image-viewer').waitFor();await page.locator('.image-viewer button').click();
  await rich.getByRole('button',{name:'▶ 播放 GIF · 动画',exact:true}).click();
  await rich.getByRole('button',{name:'停止 GIF',exact:true}).waitFor();
  await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});document.dispatchEvent(new Event('visibilitychange'));});
  await rich.getByRole('button',{name:'▶ 播放 GIF · 动画',exact:true}).waitFor();
  await page.evaluate(()=>{delete document.hidden;document.dispatchEvent(new Event('visibilitychange'));});
  await rich.getByRole('button',{name:'▶ 加载视频 · 演示视频',exact:true}).click();
  assert.equal(await rich.locator('video').getAttribute('preload'),'none');
  assert.equal(await rich.locator('video').getAttribute('autoplay'),null);
  await rich.locator('video').evaluate(el=>el.play());
  await page.waitForFunction(()=>document.querySelector('video').currentTime>0);
  await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});document.dispatchEvent(new Event('visibilitychange'));});
  assert.equal(await rich.locator('video').evaluate(el=>el.paused),true);
  await page.evaluate(()=>{delete document.hidden;document.dispatchEvent(new Event('visibilitychange'));});
  assert.equal(await rich.locator('a[href^="javascript:"]').count(),0);
  for(const width of [320,390,430]){
    await page.setViewportSize({width,height:844});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'rich content fits '+width);
  }
  await page.setViewportSize({width:390,height:844});
  if(process.env.SCREENSHOT_DIR){await rich.locator('h1').evaluate(el=>{const sc=document.getElementById('scroll');sc.scrollTop+=el.getBoundingClientRect().top-sc.getBoundingClientRect().top-18;});await page.screenshot({path:join(process.env.SCREENSHOT_DIR,'mobile-rich.png')});await rich.locator('.code-block').evaluate(el=>{const sc=document.getElementById('scroll');sc.scrollTop+=el.getBoundingClientRect().top-sc.getBoundingClientRect().top-18;});await page.screenshot({path:join(process.env.SCREENSHOT_DIR,'mobile-media.png')});}
  await page.locator('#older').click();await page.waitForFunction(()=>document.querySelectorAll('.message').length===100);
  appendFileSync(log,message('live','新增消息同步成功'));
  await page.getByText('新增消息同步成功',{exact:true}).waitFor({timeout:10000});
  await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});document.dispatchEvent(new Event('visibilitychange'));});
  assert.equal(await page.evaluate(()=>state.stream===null),true);
  appendFileSync(log,message('hidden','返回页面后补齐'));
  await page.evaluate(()=>{delete document.hidden;document.dispatchEvent(new Event('visibilitychange'));});
  await page.getByText('返回页面后补齐',{exact:true}).waitFor({timeout:10000});
  async function sendThenSteer(text){
    await page.locator('#prompt').fill(text);await page.locator('#send').click();
    await page.locator('.queue-text').filter({hasText:text}).waitFor();
    assert.equal(await page.locator('#prompt').inputValue(),'');
    if(process.env.SCREENSHOT_DIR)await page.screenshot({path:join(process.env.SCREENSHOT_DIR,'mobile-queued-message.png')});
    if(text==='网页发送测试')await page.locator('#prompt').fill('下一条尚未发送的草稿');
    await page.getByRole('button',{name:'引导',exact:true}).click();
  }
  await sendThenSteer('网页发送测试');
  await page.getByText('电脑回复：网页发送测试',{exact:true}).waitFor({timeout:10000});
  assert.equal(await page.locator('#prompt').inputValue(),'下一条尚未发送的草稿');
  await page.locator('#queue-status').waitFor({state:'hidden'});
  await page.evaluate(()=>loadQueue());
  assert.equal(await page.locator('#queue-status').isVisible(),false,'accepted receipt must not reappear');
  await page.getByText('电脑回复：网页发送测试',{exact:true}).waitFor({timeout:10000});
  await sendThenSteer('模拟拒绝');
  await page.waitForFunction(()=>document.getElementById('send-note').textContent.includes('未接受'),{},{timeout:10000});
  await page.locator('#dismiss-send').click();assert.equal(await page.locator('#prompt').inputValue(),'');
  await sendThenSteer('后台发送测试');
  await page.waitForFunction(()=>state.submission && !state.submitting);
  await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});document.dispatchEvent(new Event('visibilitychange'));});
  await sleep(1600);assert.equal(await page.evaluate(()=>state.sendTimer===null),true);
  await page.evaluate(()=>{delete document.hidden;document.dispatchEvent(new Event('visibilitychange'));});
  await page.waitForFunction(()=>state.submission===null,{},{timeout:10000});
  assert.equal(await page.locator('#prompt').inputValue(),'');
  // Queue remains on the target computer while active, and can be cancelled.
  appendFileSync(log,rec('event_msg',{type:'task_started'}));
  await page.locator('#prompt').fill('取消这条排队消息');await page.locator('#send').click();
  await page.locator('#queue-status').waitFor({state:'visible'});
  assert.equal(readFileSync(log,'utf8').includes('取消这条排队消息'),false);
  await page.getByRole('button',{name:'删除',exact:true}).click();
  await page.locator('#queue-status').waitFor({state:'hidden'});
  await page.locator('#prompt').fill('完成后再发送');await page.locator('#send').click();
  await page.locator('#queue-status').waitFor({state:'visible'});
  await sleep(3300);assert.equal(readFileSync(log,'utf8').includes('完成后再发送'),false);
  appendFileSync(log,rec('event_msg',{type:'task_complete'}));
  await page.getByText('电脑回复：完成后再发送',{exact:true}).waitFor({timeout:15000});
  await page.locator('#queue-status').waitFor({state:'hidden'});
  await page.locator('#back').click();
  // Refresh restores the current conversation and tab draft; latest is the default.
  await page.locator('.thread').filter({hasText:'手机同步测试'}).click();
  await page.locator('#prompt').fill('刷新后保留的草稿');
  await page.evaluate(()=>{followLatest=false;$('scroll').scrollTop=0;saveView();});
  await page.reload();
  await page.waitForFunction(()=>state.selected==='fixture'&&state.messages.length>0&&!opening);
  assert.equal(await page.locator('#prompt').inputValue(),'刷新后保留的草稿');
  await page.waitForFunction(()=>$('scroll').scrollHeight-$('scroll').scrollTop-$('scroll').clientHeight<10);
  await page.locator('#prompt').fill('');
  await page.locator('#back').click();
  await page.locator('#sidebar [data-open-settings]').click();
  await page.locator('#open-position').selectOption('remember');
  await page.locator('#settings-close').click();
  await page.locator('.thread').filter({hasText:'手机同步测试'}).click();
  await page.locator('#older').click();
  await page.waitForFunction(()=>state.messages.length===100);
  const anchor=await page.locator('.message').nth(6).evaluate(el=>{followLatest=false;const sc=$('scroll');sc.scrollTop+=el.getBoundingClientRect().top-sc.getBoundingClientRect().top;saveView();return el.dataset.messageId;});
  await page.reload();
  await page.waitForFunction(()=>state.selected==='fixture'&&state.messages.length>=100&&!opening);
  assert.equal(await page.locator('#open-position').inputValue(),'remember');
  const offset=await page.evaluate(id=>{const el=[...$('messages').children].find(el=>el.dataset.messageId===id);return el.getBoundingClientRect().top-$('scroll').getBoundingClientRect().top;},anchor);
  assert.ok(Math.abs(offset)<15,'remembered message position: '+offset);
  await page.locator('#back').click();
  await page.locator('#sidebar [data-open-settings]').click();
  await page.locator('#open-position').selectOption('latest');
  await page.locator('#settings-close').click();
  await page.locator('#search').fill('/another/demo');
  await page.reload();
  await page.locator('.thread:visible').first().waitFor();
  assert.equal(await page.locator('#search').inputValue(),'/another/demo');
  assert.equal(await page.evaluate(()=>state.selected),'');
  await page.locator('#search').fill('');
  await page.getByRole('button',{name:'在 create 新建会话',exact:true}).click();
  await page.route('**/api/thread/create',async route=>{
    const request=route.request().postDataJSON();
    await route.fulfill({json:{id:request.id,mode:'create',threadId:'saved-thread',status:'created_unconfirmed',detail:'桌面接管未确认'}});
  });
  await page.locator('#create-prompt').fill('模拟桌面接管失败');
  await page.locator('#create-submit').click();
  await page.getByText(/会话已保存，但启动未确认/).waitFor();
  assert.equal(await page.locator('#create-dialog').isVisible(),true);
  assert.equal(await page.locator('#create-submit').isDisabled(),true);
  assert.equal(await page.locator('#create-prompt').inputValue(),'模拟桌面接管失败');
  await page.locator('#create-dismiss').click();
  await page.unroute('**/api/thread/create');
  await page.locator('#create-prompt').fill('创建会话的首条消息');
  if(process.env.SCREENSHOT_DIR)await page.screenshot({path:join(process.env.SCREENSHOT_DIR,'mobile-create.png')});
  await page.locator('#create-submit').click();
  await page.locator('#create-dialog').waitFor({state:'hidden',timeout:15000});
  await page.getByText('创建会话的首条消息',{exact:true}).last().waitFor();
  assert.equal(await page.evaluate(()=>state.selected),'11111111-2222-4333-8444-555555555555');
  await page.locator('#back').click();
  await page.locator('#sidebar [data-open-settings]').click();
  await page.locator('#mode').selectOption('manual');
  await page.locator('#settings-close').click();
  assert.equal(await page.evaluate(()=>state.stream===null && state.retry===null),true);
  let apiRequests=0;page.on('request',r=>{if(r.url().includes('/api/'))apiRequests++;});
  await sleep(2200);assert.equal(apiRequests,0,'manual mode must not poll');
  await page.locator('#logout').click();await page.locator('#login').waitFor({state:'visible'});
  assert.equal(await page.locator('.message').count(),0);
  assert.deepEqual(errors,[]);
  console.log('PASS: Markdown, math, Mermaid, local image, GIF background stop, video controls, unsafe markup, rich mobile overflow, project tree, queue cancellation, idle dispatch, project create, mobile widths 320/390/430, landscape, keyboard viewport, bounded composer, login, pagination, XSS, append sync, send through IPC, accepted receipt, failed draft, background send recovery, manual no-poll, logout');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();proc.kill('SIGTERM');if(proc.exitCode===null)await new Promise(r=>proc.once('exit',r));await new Promise(r=>ipc.close(r));rmSync(root,{recursive:true,force:true});});
