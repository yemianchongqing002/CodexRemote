'use strict';
const localStore=Runtime.storage('local'),sessionStore=Runtime.storage('session');
const $ = id => document.getElementById(id);
const state = { auth: false, threads: [], projects: [], sections: [], selected: '', cursor: '', before: '', version: '', messages: [], stream: null, retry: null, delay: 5000, busy: false, pending: false, readSerial: 0, requests: new Set(), mode: 'auto', canSend:false, drafts:new Map(), submission:null, sendTimer:null, submitting:false };
const sidebarApprovals=new Map();
let approvalTimer=null,approvalPolling=false,approvalEpoch=0;
function pauseSidebarApprovals(){clearTimeout(approvalTimer);approvalTimer=null;approvalEpoch++;sidebarApprovals.clear();}
function setSidebarApprovals(id,waiting){
 const previous=sidebarApprovals.get(id);sidebarApprovals.set(id,{waiting,revision:(previous?.revision||0)+1});
 if(!!previous?.waiting!==waiting)renderList();
}
async function refreshSidebarApprovals(){
 clearTimeout(approvalTimer);approvalTimer=null;
 if(approvalPolling||!state.auth||state.suspended||Runtime.hidden||!state.canSend)return;
 approvalPolling=true;const epoch=approvalEpoch;
 const candidates=state.threads.filter(t=>!t.archived&&(t.status==='active'||sidebarApprovals.get(t.id)?.waiting)&&t.id!==state.selected);
 let cursor=0;
 try{
  await Promise.all(Array.from({length:Math.min(3,candidates.length)},async()=>{
   while(cursor<candidates.length&&epoch===approvalEpoch){
    const t=candidates[cursor++],revision=sidebarApprovals.get(t.id)?.revision||0;
    const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),8000);
    try{
     const live=await api('/api/thread/live?'+new URLSearchParams({threadId:t.id}),{signal:controller.signal});
     if(epoch===approvalEpoch&&(sidebarApprovals.get(t.id)?.revision||0)===revision)setSidebarApprovals(t.id,!!live.approvals?.length);
    }catch{if(epoch===approvalEpoch&&(sidebarApprovals.get(t.id)?.revision||0)===revision)setSidebarApprovals(t.id,false);}
    finally{clearTimeout(timeout);}
   }
  }));
 }finally{
  approvalPolling=false;
  if(state.auth&&!state.suspended&&!Runtime.hidden&&state.mode==='auto')approvalTimer=setTimeout(()=>void refreshSidebarApprovals(),5000);
 }
}
try { state.mode = localStore.getItem('codex-remote-mode') === 'manual' ? 'manual' : 'auto'; } catch {}
$('mode').value = state.mode;
let serviceName='', machineName='', serverVersion='';
function renderAbout(){
 $('about-client-version').textContent=Compatibility.clientVersion;
 const connected=state.auth&&Runtime.hasConnection;
 $('about-server-version').textContent=connected?(serverVersion||'服务未提供版本信息'):'未连接';
 $('about-machine').textContent=connected?`${Runtime.profile?.name||machineName||Runtime.host}（${Runtime.host}）`:'未连接';
}
renderAbout();
function renderConnectionName(){
 const name=Runtime.profile?.name || serviceName || Runtime.host;
 $('connection-name').textContent=name;$('connection-name').title=name;
 $('connection-address').textContent=Runtime.host;$('connection-address').title=Runtime.origin;
 $('reader-connection-name').textContent=name;$('reader-connection-name').title=name+' · '+Runtime.host;
 document.title=name+' · Codex Remote';
 $('settings-computer-name').textContent=name;
 $('settings-computer-address').textContent=Runtime.host;
 $('settings-machine-name').textContent=machineName||serviceName||'未连接';
 $('settings-address').textContent=Runtime.host;
 $('settings-alias').textContent=Runtime.profile?.name||'未设置';
 $('connection-name-input').value=Runtime.profile?.name||'';$('connection-name-input').placeholder=serviceName;
 $('connection-identity').textContent=`电脑名称：${machineName || serviceName} · 地址：${Runtime.host}`;
}
function loadConnectionName(status){
 serverVersion=typeof status.release?.serverVersion==='string'?status.release.serverVersion:'';renderAbout();
 $('guardian-controls').hidden=!status.managed;
 serviceName=status.connectionName || Runtime.host;machineName=status.hostName || '';
 renderConnectionName();
}
function saveConnectionName(){
 const value=$('connection-name-input').value.trim();
 if([...value].length>48 || /[\u0000-\u001f\u007f-\u009f]/.test(value)){$('connection-alias-note').textContent='连接名称最多 48 个字符，不能包含控制字符。';return;}
 try{Runtime.rename(value);renderConnectionName();$('connection-alias-note').textContent='已保存连接名称。';}catch(e){$('connection-alias-note').textContent=e.message;}
}
$('connection-name-save').addEventListener('click',saveConnectionName);
$('guardian-status').addEventListener('click',async()=>{
 const button=$('guardian-status'),profile=Runtime.profile;button.disabled=true;
 try{const s=await api('/api/guardian/status');const phases={starting:'正在启动',running:'运行中',stopping:'正在停止',recovering:'正在恢复',unresponsive:'暂未响应'};$('guardian-note').textContent=`守护${phases[s.phase]||s.phase}。服务启动 ${s.restarts} 次，守护恢复 ${s.guardianRestarts||0} 次。`;}
 catch(e){await ConnectionRecovery.recover(profile,{error:e,verify:true});}finally{button.disabled=false;}
});
$('guardian-restart').addEventListener('click',()=>{
 $('guardian-restart-confirm').hidden=false;$('guardian-note').textContent='';
 $('guardian-restart-accept').focus();
});
$('guardian-restart-cancel').addEventListener('click',()=>{
 $('guardian-restart-confirm').hidden=true;$('guardian-restart').focus();
});
$('guardian-restart-accept').addEventListener('click',async()=>{
 const button=$('guardian-restart'),profile=Runtime.profile;if(button.disabled)return;
 button.disabled=true;$('guardian-restart-confirm').hidden=true;saveView();
 $('guardian-note').textContent='正在请求重启服务…';
 try{await api('/api/guardian/restart',{method:'POST'});$('guardian-note').textContent='已接收重启请求，服务恢复后刷新页面即可。';}
 catch(e){await ConnectionRecovery.recover(profile,{error:e,verify:true,restarting:true});}finally{button.disabled=false;}
});
$('connection-name-reset').addEventListener('click',()=>{$('connection-name-input').value='';saveConnectionName();});
$('connection-name-input').addEventListener('keydown',e=>{if(e.key==='Enter' && !e.isComposing && e.keyCode!==229){e.preventDefault();saveConnectionName();}});
let sendShortcut='enter';
try{if(localStore.getItem('cr-send-shortcut')==='ctrl-enter')sendShortcut='ctrl-enter';}catch{}
function renderSendShortcut(){
 $('send-shortcut').value=sendShortcut;
 $('send-shortcut-hint').textContent=sendShortcut==='enter'?'回车发送 · Shift + 回车换行':'Control + 回车发送 · 回车或 Shift + 回车换行';
 $('send').title=sendShortcut==='enter'?'发送（回车，默认排队）':'发送（Control + 回车，默认排队）';
}
renderSendShortcut();
function saveBrowserSetting(key,value){
 try{localStore.setItem(key,value);$('input-settings-note').textContent='已保存，修改立即生效。';}
 catch{$('input-settings-note').textContent='浏览器无法保存设置，本次页面内仍然有效。';}
}
const settingsPages={home:'设置',connection:'连接管理',alias:'连接别名',ssh:'免密连接',fingerprints:'主机身份指纹',about:'关于'};
let settingsPage='home';
function showSettingsPage(page,focus=true){
 if(!settingsPages[page])return;
 settingsPage=page;
 $('guardian-restart-confirm').hidden=true;
 for(const section of document.querySelectorAll('[data-settings-view]'))section.hidden=section.dataset.settingsView!==page;
 $('settings-title').textContent=settingsPages[page];$('settings-back').hidden=page==='home';
 $('settings-dialog').scrollTop=0;
 if(focus)$('settings-title').focus({preventScroll:true});
}
for(const button of document.querySelectorAll('[data-settings-page]'))button.addEventListener('click',()=>showSettingsPage(button.dataset.settingsPage));
$('settings-back').addEventListener('click',()=>showSettingsPage(['alias','ssh','fingerprints'].includes(settingsPage)?'connection':'home'));
for(const button of document.querySelectorAll('[data-open-settings]'))button.addEventListener('click',()=>{
 renderAbout();showSettingsPage('home',false);if(!$('settings-dialog').open)$('settings-dialog').showModal();
});
$('settings-close').addEventListener('click',()=>$('settings-dialog').close());
let settingsBackdropDown=false;
function outsideSettings(e){const r=$('settings-dialog').getBoundingClientRect();return e.clientX<r.left || e.clientX>r.right || e.clientY<r.top || e.clientY>r.bottom;}
$('settings-dialog').addEventListener('pointerdown',e=>{settingsBackdropDown=e.target===$('settings-dialog') && outsideSettings(e);});
$('settings-dialog').addEventListener('click',e=>{if(settingsBackdropDown && e.target===$('settings-dialog') && outsideSettings(e))$('settings-dialog').close();settingsBackdropDown=false;});
$('send-shortcut').addEventListener('change',()=>{
 sendShortcut=$('send-shortcut').value==='ctrl-enter'?'ctrl-enter':'enter';
 saveBrowserSetting('cr-send-shortcut',sendShortcut);
 renderSendShortcut();
});
let openPosition='latest', savedView={}, readingPositions={}, followLatest=false, readingAnchor=null, opening=0, openEpoch=0, viewTimer;
try {
  openPosition=localStore.getItem('cr-open-position')==='remember'?'remember':'latest';
  savedView=JSON.parse(localStore.getItem('cr-view')||'{}')||{};
  readingPositions=JSON.parse(localStore.getItem('cr-reading-positions')||'{}')||{};
  for(const [id,text] of JSON.parse(sessionStore.getItem('cr-drafts')||'[]'))if(typeof id==='string'&&typeof text==='string'&&text.length<=16384)state.drafts.set(id,text);
} catch {}
$('open-position').value=openPosition;
$('search').value=typeof savedView.search==='string'?savedView.search.slice(0,200):'';
$('archive').checked=savedView.archive===true;
if('scrollRestoration' in history)history.scrollRestoration='manual';
function saveView(){
  clearTimeout(viewTimer);
  if(!state.auth)return;
  capturePosition();
  try {
    localStore.setItem('cr-view',JSON.stringify({selected:state.selected,search:$('search').value.slice(0,200),archive:$('archive').checked}));
    localStore.setItem('cr-reading-positions',JSON.stringify(readingPositions));
    saveDrafts();
  } catch {}
}
function saveDrafts(){try{sessionStore.setItem('cr-drafts',JSON.stringify([...state.drafts].filter(([id,text])=>text&&text.length<=16384).slice(-20)));}catch{}}
function scheduleView(){clearTimeout(viewTimer);viewTimer=setTimeout(saveView,350);}
function capturePosition(){
  if(!state.selected||opening||!state.messages.length)return;
  const scroll=$('scroll'),top=scroll.getBoundingClientRect().top;
  const el=[...$('messages').children].find(el=>el.getBoundingClientRect().bottom>top);
  if(!el)return;
  delete readingPositions[state.selected];
  readingPositions[state.selected]={id:el.dataset.messageId,offset:el.getBoundingClientRect().top-top,bottom:scroll.scrollHeight-scroll.scrollTop-scroll.clientHeight<80};
  const entries=Object.entries(readingPositions).slice(-50);readingPositions=Object.fromEntries(entries);
}
async function restorePosition(id,position,epoch){
  if(!position||position.bottom){bottom();return;}
  followLatest=false;
  const find=()=>[...$('messages').children].find(el=>el.dataset.messageId===position.id);
  while(!find()&&state.before&&state.messages.length<200){
    const page=await api('/api/thread?'+new URLSearchParams({id,before:state.before}));
    if(state.selected!==id||opening!==epoch||Runtime.hidden)return;
    if(page.reset)break;
    const seqs=new Set(state.messages.map(m=>m.seq));
    state.messages=[...page.messages.filter(m=>!seqs.has(m.seq)),...state.messages].slice(-200);state.before=page.before||'';
    renderMessages(true);
  }
  if(state.selected!==id||opening!==epoch)return;
  const el=find();
  if(el){readingAnchor={id:position.id,offset:Number.isFinite(position.offset)?position.offset:0};alignReadingAnchor();requestAnimationFrame(alignReadingAnchor);$('latest').hidden=false;}
  else{bottom();$('sync-label').textContent='原阅读位置已超出可加载历史，已跳到最新';}
}
function alignReadingAnchor(){if(!readingAnchor||followLatest)return;const el=[...$('messages').children].find(el=>el.dataset.messageId===readingAnchor.id);if(el){el.style.contentVisibility='visible';const sc=$('scroll');sc.scrollTop+=el.getBoundingClientRect().top-sc.getBoundingClientRect().top-readingAnchor.offset;}}
$('open-position').addEventListener('change',()=>{openPosition=$('open-position').value;saveBrowserSetting('cr-open-position',openPosition);});
$('scroll').addEventListener('scroll',()=>{if(!opening)scheduleView();},{passive:true});
for(const type of ['wheel','touchmove','pointerdown','keydown'])$('scroll').addEventListener(type,()=>{followLatest=false;readingAnchor=null;},{passive:true});
new ResizeObserver(()=>{if(state.selected&&!Runtime.hidden){if(followLatest)bottom();else alignReadingAnchor();}}).observe($('messages'));

const collapsedProjects = new Set();
try { const saved = JSON.parse(localStore.getItem('cr-collapsed-projects') || '[]'); if (Array.isArray(saved)) for (const key of saved) if (typeof key === 'string') collapsedProjects.add(key); } catch {}

function connection(text, online = false) { $('connection-label').textContent = text; $('dot').classList.toggle('online', online); }
function error(text) { $('error').textContent = text; $('error').hidden = !text; }
function stop() { if (state.stream) state.stream.close(); state.stream = null; clearTimeout(state.retry); state.retry = null; }
function suspend() { pauseSidebarApprovals(); LiveControls.pause(); state.suspended=true; state.pending=false; stop(); clearTimeout(state.sendTimer); state.sendTimer=null; for (const c of state.requests) c.abort(); connection('已暂停 · 返回页面后更新'); }
let loginRequiresToken=false;
function loginAuthentication(required){
 loginRequiresToken=required;$('token').required=required;$('token').hidden=!required;
 document.querySelector('label[for=token]').hidden=!required;
 $('login-title').textContent=required?'连接电脑':'连接失败';
 $('login-submit-label').textContent=required?'连接电脑':'重新连接';
}
loginAuthentication(false);
function loggedOut(preserveDrafts = true) {
 $('guardian-controls').hidden=true;
	document.title='Codex Remote · 聊天';
	$('settings-dialog').close();
	if(!preserveDrafts)clearImageDrafts();
  state.auth = false; serverVersion='';renderAbout(); suspend(); state.selected = ''; state.messages = []; state.threads = []; state.projects = []; state.sections = []; state.cursor = ''; state.before = ''; state.version = '';
  if(!preserveDrafts)state.drafts.clear(); state.submission=null; $('prompt').value='';$('create-dialog').close();$('create-prompt').value='';
  Rich.clear(); $('messages').replaceChildren(); $('threads').replaceChildren(); $('app').hidden = true; $('login').hidden = false;
  $('conversation').hidden = true; $('welcome').hidden = false; document.body.classList.remove('detail');
}
async function api(path, options = {}) {
  const c = new AbortController(); state.requests.add(c);
  const abort = () => c.abort();
  options.signal?.addEventListener('abort',abort,{once:true});
  if(options.signal?.aborted)c.abort();
  try {
    const r = await Runtime.request(path, { ...options, signal: c.signal, cache: 'no-store', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', ...options.headers } });
    if (r.status === 401) { loginAuthentication(true); loggedOut(); throw Object.assign(new Error('请重新输入访问口令'),{status:401}); }
    if (!r.ok) { let text = '连接失败，请检查电脑上的服务'; try { text = (await r.json()).error || text; } catch {} const e=new Error(text);e.status=r.status;throw e; }
    return await r.json();
  } finally { options.signal?.removeEventListener('abort',abort);state.requests.delete(c); }
}
function date(text, full = false) { const d = new Date(text); if (Number.isNaN(d.valueOf())) return ''; return new Intl.DateTimeFormat('zh-CN', full ? { month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit' } : { month:'numeric',day:'numeric' }).format(d); }
function node(tag, cls, text) { const el = document.createElement(tag); if (cls) el.className = cls; if (text !== undefined) el.textContent = text; return el; }

function renderList() {
  const query = $('search').value.trim().toLowerCase();
  const archived = $('archive').checked;
  const list = state.threads.filter(t => t.archived === archived && (t.title + ' ' + t.project + ' ' + (t.projectPath || '')).toLowerCase().includes(query));
  $('thread-count').textContent = list.length;
  const fragment = document.createDocumentFragment();
  const section = (name, className) => {
    const container = node('section', 'sidebar-section ' + className);
    container.append(node('h2', 'sidebar-section-title', name));
    fragment.append(container);
    return container;
  };
  const task = t => {
    const button = node('button', 'thread' + (state.selected === t.id ? ' selected' : ''));
    button.type = 'button'; button.dataset.threadId = t.id;
    button.setAttribute('aria-current', state.selected === t.id ? 'true' : 'false');
    button.title = t.title;
    button.append(node('span', 'thread-title', t.title));
    if(!t.archived&&sidebarApprovals.get(t.id)?.waiting)button.append(node('span','thread-approval','等待批准'));
    if (t.status === 'active') {
      const indicator = node('span', 'thread-active');
      indicator.setAttribute('role', 'img'); indicator.setAttribute('aria-label', '进行中');
      button.append(indicator);
    }
    button.addEventListener('click', () => openThread(t.id));
    return button;
  };
  const byPosition = (a,b) => (a.sidebarPosition ?? Infinity) - (b.sidebarPosition ?? Infinity);
  const pinned = list.filter(t => t.pinned).sort(byPosition);
  if (pinned.length) { const container = section('已固定', 'pinned-section'); for (const t of pinned) container.append(task(t)); }
  const projects = state.projects.filter(p => !query && !archived || list.some(t => t.projectId === p.id && !t.pinned && !t.sectionId) || !archived && (p.name + ' ' + p.path).toLowerCase().includes(query));
  if (projects.length) {
    const container = section('项目', 'projects-section');
    for (const project of projects) {
      const key = project.id;
      const details = node('details', 'project-group'); details.dataset.projectId = key;
      details.open = !!query || !collapsedProjects.has(key);
      const summary = node('summary', 'project-heading' + (project.available === false ? ' unavailable' : ''));
      summary.title = project.path || project.name;
      const icon = node('span', 'project-icon'); icon.setAttribute('aria-hidden', 'true');
      icon.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8V6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v2M3 8h6l2 3h10l-3 9H3a1 1 0 0 1-1-1L3 8Z"/></svg>';
      summary.append(icon, node('span', 'project-name', project.name));
      if (project.path && project.available !== false && state.canSend && !archived) {
        const add = node('button', 'project-create', '＋'); add.type = 'button';
        add.setAttribute('aria-label', '在 ' + project.name + ' 新建会话');
        add.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); openCreate(project.path); });
        summary.append(add);
      }
      const children = node('div', 'project-threads');
      const threads = list.filter(t => t.projectId === key && !t.pinned && !t.sectionId);
      if (project.threadOrder?.length) {
        const ranks = new Map(project.threadOrder.map((id, index) => [id, index]));
        threads.sort((a,b) => (ranks.get(a.id) ?? Infinity) - (ranks.get(b.id) ?? Infinity));
      }
      for (const t of threads) children.append(task(t));
      details.append(summary, children); container.append(details);
      let previous = details.open;
      details.addEventListener('toggle', () => {
        if (details.open === previous) return;
        previous = details.open; if (query) return;
        if (details.open) collapsedProjects.delete(key); else collapsedProjects.add(key);
        try { localStore.setItem('cr-collapsed-projects', JSON.stringify([...collapsedProjects])); } catch {}
      });
    }
  }
  for (const group of state.sections) {
    const threads = list.filter(t => !t.pinned && t.sectionId === group.id).sort(byPosition);
    if (!threads.length) continue;
    const container = section(group.name, 'custom-section'); for (const t of threads) container.append(task(t));
  }
  const recent = list.filter(t => !t.projectId && !t.pinned && !t.sectionId);
  if (recent.length) { const container = section(archived ? '已归档' : '最近', 'recent-section'); for (const t of recent) container.append(task(t)); }
  $('threads').replaceChildren(fragment);
  $('list-empty').hidden = list.length > 0 || projects.length > 0;
  $('list-empty').textContent = query ? '没有找到匹配的聊天。' : '这里还没有聊天。电脑上的消息保存后，点击刷新。';
}

function messageNode(m) {
  const article = node('article','message ' + m.role); article.dataset.seq = m.seq; article.dataset.messageId=m.id;
  const meta = node('div','message-meta'); meta.append(node('span','message-role',m.role === 'user' ? '你' : 'Codex'));
  if (m.phase === 'commentary') meta.append(node('span','message-phase','进展'));
  const time = node('time','',date(m.timestamp,true)); time.dateTime = m.timestamp; meta.append(time); article.append(meta); Rich.render(article,m.role==='user'?displayUserMessage(m.text):m.text,{thread:state.selected,message:m.id}); return article;
}
function renderMessages(replace = false) {
  Rich.sweep();
  const root = $('messages');
  if (replace) { root.replaceChildren(); Rich.sweep(); }
  const existing = new Set([...root.children].map(n => Number(n.dataset.seq)));
  const fragment = document.createDocumentFragment(); for (const m of state.messages) if (!existing.has(m.seq)) fragment.append(messageNode(m)); root.append(fragment);
  const keep = new Set(state.messages.map(m => m.seq)); for (const el of [...root.children]) if (!keep.has(Number(el.dataset.seq))) el.remove();
  $('message-empty').hidden = state.messages.length > 0;
  $('older').hidden = !state.before; $('older').disabled = state.messages.length >= 200;
  $('older').textContent = state.messages.length >= 200 ? '已显示 200 条，请重新打开聊天回到最新' : '加载更早消息';
}
function header(t) {
  const index = state.threads.findIndex(thread => thread.id === t.id);
  if (index !== -1) state.threads[index] = t;
  $('chat-title').textContent = t.title;
  const status = t.status === 'active' ? '最近记录：进行中' : t.status === 'idle' ? '最近记录：已结束' : '已保存的聊天';
  $('chat-meta').textContent = [t.project,t.source,status].filter(Boolean).join(' · ');
  $('limit-note').hidden = !t.limited;
  renderComposer();
}
function bottom() { followLatest=true;readingAnchor=null; $('scroll').scrollTop = $('scroll').scrollHeight; $('latest').hidden = true; }
// Event-driven viewport handling: no keyboard polling, no continuous animation.
function fitPrompt() {
  const input = $('prompt');
  if ($('composer').hidden) return;
  const maximum = parseFloat(getComputedStyle(input).maxHeight) || 160;
  input.style.height = '0px';
  input.style.height = Math.min(maximum, Math.max(46, input.scrollHeight + 2)) + 'px';
}
function fitViewport() {
  const viewport = window.visualViewport;
  const mobile = matchMedia('(max-width:700px)').matches;
  // Leave pinch zoom to the browser instead of reflowing the page under it.
  if (viewport && viewport.scale !== 1) return;
  const scroll = $('scroll');
  const pinned = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 80;
  document.documentElement.style.setProperty('--viewport-height', (viewport?.height || innerHeight) + 'px');
  document.documentElement.style.setProperty('--viewport-top', (viewport?.offsetTop || 0) + 'px');
  document.body.classList.toggle('keyboard-open', mobile && document.activeElement === $('prompt') && innerHeight - (viewport?.height || innerHeight) > 120);
  fitPrompt();
  if (pinned) bottom();
}
window.visualViewport?.addEventListener('resize', fitViewport);
window.visualViewport?.addEventListener('scroll', fitViewport);
window.addEventListener('resize', fitViewport);
$('prompt').addEventListener('focus', fitViewport);
$('prompt').addEventListener('blur', fitViewport);
new ResizeObserver(() => {
  $('conversation').style.setProperty('--compose-height', $('composer').getBoundingClientRect().height + 'px');
}).observe($('composer'));
fitViewport();
async function openThread(id) {
  saveView(); const position=readingPositions[id],epoch=++openEpoch;opening=epoch;followLatest=false;readingAnchor=null;
  state.selected = id; state.cursor = ''; state.before = ''; state.version = ''; state.messages = [];
  document.body.classList.add('detail'); $('welcome').hidden = true; $('conversation').hidden = false; $('messages').replaceChildren();
  const t = state.threads.find(t => t.id === id); if (t) header(t); renderList();void loadQueue();
  try { await loadThread(true); if(state.selected===id&&opening===epoch&&state.messages.length){if(openPosition==='remember')await restorePosition(id,position,epoch);else bottom();} } catch (e) { if (e.name !== 'AbortError') error(e.message); } finally {if(opening===epoch){opening=0;saveView();}}
}
async function loadThread(initial = false) {
  const id = state.selected; if (!id) return;
  const serial = ++state.readSerial;
  const scroll = $('scroll'); const nearBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 140;
  let more = false;
  do {
    const cursor = initial ? '' : state.cursor;
    const page = await api('/api/thread?' + new URLSearchParams({ id, ...(cursor ? { after:cursor } : {}) }));
    if (id !== state.selected || serial !== state.readSerial || !state.auth || Runtime.hidden) return;
    const replace = initial || page.reset;
    if (replace) { state.messages = page.messages; state.before = page.before || ''; }
    else {
      const seqs = new Set(state.messages.map(m => m.seq));
      state.messages.push(...page.messages.filter(m => !seqs.has(m.seq)));
      if (state.messages.length > 200) { state.messages = state.messages.slice(-200); state.before = ''; }
    }
    state.cursor = page.cursor; state.version = page.thread.version; header(page.thread); renderMessages(replace);
    $('sync-label').textContent = '已更新 ' + new Intl.DateTimeFormat('zh-CN',{hour:'2-digit',minute:'2-digit'}).format(new Date()) + ' · 已保存的消息';
    if (initial || nearBottom) bottom(); else if (page.messages.length) $('latest').hidden = false;
    more = page.more; initial = false;
  } while (more && !Runtime.hidden);
}
async function sync() {
  if (!state.auth || Runtime.hidden || state.suspended) return;
  if (state.busy) { state.pending = true; return; }
  state.busy = true;
  try {
    const result = await api('/api/threads');
    if (!state.auth || Runtime.hidden || state.suspended) return;
    state.threads = result.threads; state.projects = result.projects || []; state.sections = result.sections || []; renderList(); void refreshSidebarApprovals(); if(state.canSend)void loadQueue(); error(result.warning || '');
    if (state.selected) {
      const t = state.threads.find(t => t.id === state.selected);
      if (!t) { state.selected = ''; state.messages = []; $('messages').replaceChildren(); $('conversation').hidden = true; $('welcome').hidden = false; document.body.classList.remove('detail'); }
      else if (t.version !== state.version) await loadThread(!state.cursor);
    }
    renderComposer();
    if (state.mode === 'manual') connection('手动更新 · 自动同步已关闭',true);
  } catch(e) { if (e.name !== 'AbortError') { error(e.message); connection('连接中断 · 请检查电脑'); } }
  finally { state.busy = false; if (state.pending) { state.pending = false; if (state.auth && !Runtime.hidden && !state.suspended) void sync(); } }
}
function connect() {
  stop(); if (!state.auth || Runtime.hidden || state.suspended || state.mode !== 'auto') return;
  connection('正在连接电脑');
  const stream = Runtime.events('/api/events'); state.stream = stream;
  stream.onopen = () => { state.delay = 5000; connection('已连接 · 前台自动更新',true); };
  stream.addEventListener('change', () => { void sync(); });
  stream.addEventListener('expired', loggedOut);
  stream.onerror = () => {
    if (state.stream !== stream) return;
    stop(); connection('连接中断 · 稍后重连');
    if (!Runtime.hidden && state.auth && state.mode === 'auto') {
      state.retry = setTimeout(async () => {
        try { await api('/api/status'); connect(); } catch(e) { if (state.auth && !Runtime.hidden && e.name !== 'AbortError') connect(); }
      }, state.delay); state.delay = Math.min(state.delay * 2,60000);
    }
  };
}
async function enter() { await Runtime.checkCompatibility(Runtime.origin); state.suspended=false; state.auth = true; const status=await api('/api/status');loginAuthentication(status.authRequired===true||(status.authRequired==null&&loginRequiresToken));Runtime.recordStatus(status);loadConnectionName(status);state.canSend=!!status.sendingEnabled;document.querySelector('.read-only').textContent=state.canSend?'可发送':'只读';try{const pending=JSON.parse(sessionStore.getItem('cr-submission')||'null');if(pending?.id && pending?.threadId)state.submission={...pending,status:'unknown',detail:'查询上次发送的结果'};}catch{} $('login').hidden = true; $('app').hidden = false; error(''); await sync(); if(!state.selected&&typeof savedView.selected==='string'&&state.threads.some(t=>t.id===savedView.selected))await openThread(savedView.selected); connect();if(state.submission)void checkSubmission(); }
$('login-form').addEventListener('submit', async e => {
  e.preventDefault(); $('login-error').textContent = ''; const button = e.currentTarget.querySelector('button'),profile=Runtime.profile; button.disabled = true;
  try { if(loginRequiresToken)await api('/api/login',{method:'POST',body:JSON.stringify({token:$('token').value.trim()})}); $('token').value = ''; await enter(); }
  catch(e) { if (e.name !== 'AbortError') { $('login-title').textContent='连接失败';$('login-error').textContent=e.status===401?'请检查访问口令后重试。':''; await ConnectionRecovery.recover(profile,{error:e}); } }
  finally { button.disabled = false; }
});
$('logout').addEventListener('click',async () => { try { await api('/api/logout',{method:'POST',body:'{}'}); try{localStore.removeItem('cr-view');localStore.removeItem('cr-reading-positions');sessionStore.removeItem('cr-drafts');}catch{} savedView={};readingPositions={};loggedOut(false); } catch(e) { error(e.message); } });
$('refresh').addEventListener('click',() => { void sync(); });
$('chat-refresh').addEventListener('click',() => { void sync(); void LiveControls.sync(); });
$('search').addEventListener('input',()=>{renderList();scheduleView();}); $('archive').addEventListener('change',()=>{renderList();saveView();});
$('back').addEventListener('click',() => {saveView();opening=0;followLatest=false; document.body.classList.remove('detail'); state.selected = ''; state.messages = []; state.cursor = ''; state.version = ''; $('messages').replaceChildren(); renderList();saveView(); });
$('latest').addEventListener('click',bottom);
$('mode').addEventListener('change',() => { state.mode = $('mode').value; saveBrowserSetting('codex-remote-mode',state.mode); if (state.mode === 'manual') { stop(); connection('手动更新 · 自动同步已关闭',true); } else { void sync(); connect(); } });
$('older').addEventListener('click',async () => {
  if (!state.before || state.messages.length >= 200) return;
  const id = state.selected, cursor = state.before, scroll = $('scroll'), height = scroll.scrollHeight, top = scroll.scrollTop;
  $('older').disabled = true;
  try {
    const page = await api('/api/thread?' + new URLSearchParams({id,before:cursor}));
    if (id !== state.selected || Runtime.hidden) return;
    if (page.reset) { await loadThread(true); return; }
    const seqs = new Set(state.messages.map(m => m.seq)); state.messages = [...page.messages.filter(m => !seqs.has(m.seq)),...state.messages].slice(-200); state.before = page.before || '';
    renderMessages(true); scroll.scrollTop = top + scroll.scrollHeight - height;
  } catch(e) { if (e.name !== 'AbortError') error(e.message); }
  finally { $('older').disabled = state.messages.length >= 200; }
});
document.addEventListener('visibilitychange',() => { if (Runtime.hidden) {saveView();suspend();} else if (state.auth) { state.suspended=false;void sync(); connect();if(state.submission)void checkSubmission(); } });
window.addEventListener('cr-visibilitychange',()=>{if(Runtime.hidden){saveView();suspend();}else if(state.auth){state.suspended=false;void sync();connect();if(state.submission)void checkSubmission();}});
window.addEventListener('cr-before-switch',()=>{saveView();saveImageDrafts();saveSubmission();suspend();});
window.addEventListener('pagehide',()=>{saveView();suspend();});
window.addEventListener('pageshow',e => { if (e.persisted && state.auth) { state.suspended=false;void sync(); connect();if(state.submission)void checkSubmission(); } });
window.addEventListener('online',() => { if (state.auth && !Runtime.hidden && state.mode === 'auto') { void sync(); connect(); } });
window.addEventListener('offline',() => { stop(); connection('网络已断开'); });
void (async () => { try { await Runtime.ready;if(!Runtime.hasConnection)return;await enter(); } catch(e) { loggedOut(); if (e.name !== 'AbortError' && e.message !== '请重新输入访问口令') { $('login-title').textContent='连接失败';$('login-error').textContent=''; } } })();

let queuedEntries = [];
const maxQueuedPerThread = 5;
function activeQueueCount(){return queuedEntries.filter(e=>e.threadId===state.selected && ['queued','pending'].includes(e.status)).length;}
const dismissedQueues = new Set();
async function loadQueue(){
 if(!state.auth || !state.canSend || Runtime.hidden || state.suspended || !state.selected)return;
 const selected=state.selected;
 try{const result=await api("/api/queue?"+new URLSearchParams({threadId:selected}));if(state.auth && state.selected===selected){queuedEntries=result.entries;renderComposer();}}catch(e){if(e.name!=="AbortError")error(e.message);}
}
const queueActions = new Set();
const imageDrafts = new Map();
let imageRenderKey='', queueRenderKey='';
try{
 for(const [thread,items] of JSON.parse(sessionStore.getItem('cr-image-drafts')||'[]')){
  if(typeof thread==='string' && Array.isArray(items))imageDrafts.set(thread,items.filter(i=>typeof i.id==='string' && /^[a-f0-9]{64}\.(png|jpeg|gif|file\.[a-z0-9]{1,16})$/.test(i.id)).slice(0,4).map(i=>({id:i.id,name:typeof i.name==='string'?i.name.slice(0,120):'附件',status:'ready'})));
 }
}catch{}
function currentImages(){return imageDrafts.get(state.selected)||[];}
function hasDraftContent(){return !!(state.drafts.get(state.selected)||'').trim() || currentImages().length>0;}
function imagesReady(){return currentImages().every(i=>i.status==='ready');}
function imageURL(id){return '/api/upload-image?'+new URLSearchParams({id});}
function saveImageDrafts(){try{sessionStore.setItem('cr-image-drafts',JSON.stringify([...imageDrafts].map(([thread,items])=>[thread,items.filter(i=>i.id).map(i=>({id:i.id,name:i.name}))]).filter(([,items])=>items.length).slice(-20)));}catch{}}
function removeImageDraft(thread,item){
 const items=imageDrafts.get(thread)||[];imageDrafts.set(thread,items.filter(i=>i!==item));
 if(item.url)URL.revokeObjectURL(item.url);saveImageDrafts();renderComposer();
}
function clearImageDrafts(){for(const items of imageDrafts.values())for(const item of items)if(item.url)URL.revokeObjectURL(item.url);imageDrafts.clear();saveImageDrafts();}
function renderImageDrafts(){
 const root=$('image-drafts');const items=currentImages();
 const blocked=state.submitting || !!state.submission;
 const key=JSON.stringify([state.selected,blocked,items]);if(key===imageRenderKey)return;imageRenderKey=key;
 root.replaceChildren();root.hidden=!items.length;
 $('add-images').disabled=blocked || items.length>=4;
 for(const item of items){
  const card=node('div','image-draft');
  if(item.kind==='file'||item.id?.includes('.file.')){const icon=node('div','file-draft-icon','▤');icon.setAttribute('aria-hidden','true');card.append(icon);}else{const img=node('img');Runtime.setMedia(img,item.id?imageURL(item.id):item.url);img.alt=item.name;card.append(img);}
  const remove=node('button','','×');remove.type='button';remove.disabled=blocked;remove.setAttribute('aria-label','移除附件 '+item.name);
  const thread=state.selected;remove.addEventListener('click',()=>removeImageDraft(thread,item));card.append(remove);
  const caption=node('span','fine',item.status==='uploading'?'上传中…':item.status==='failed'?'上传失败，请移除重选':item.name);caption.title=item.error||item.name;card.append(caption);root.append(card);
 }
 $('image-note').textContent=items.some(i=>i.status==='uploading')?'附件上传中，完成后可发送':items.some(i=>i.status==='failed')?'部分附件上传失败，请移除后重新添加':'';
 $('image-note').hidden=!$('image-note').textContent;
}
async function addImageFiles(files){
 if(!state.auth || !state.canSend || !state.selected || state.submitting || state.submission)return;
 const thread=state.selected,items=imageDrafts.get(thread)||[];imageDrafts.set(thread,items);
 const pending=[];
 for(const file of files){
  const isImage=['image/png','image/jpeg','image/gif'].includes(file.type)||/\.(png|jpe?g|gif)$/i.test(file.name);
  if(!file.size || file.size>8*1024*1024){error('每个附件最多 8 MiB，不能为空');continue;}
  if(items.length>=4){error('每条消息最多 4 个附件');break;}
  const item={name:file.name||'附件',kind:isImage?'image':'file',url:isImage?URL.createObjectURL(file):null,status:'uploading'};items.push(item);pending.push({item,file});
 }
 renderComposer();
 for(const {item,file} of pending){
  if(!(imageDrafts.get(thread)||[]).includes(item))continue;
  if(Runtime.hidden || state.suspended){item.status='failed';item.error='页面已暂停，请重新添加';continue;}
  try{
   const endpoint=item.kind==='file'?'/api/upload-file?'+new URLSearchParams({name:item.name}):'/api/upload-image';
   const result=await api(endpoint,{method:'POST',headers:{'Content-Type':item.kind==='file'?'application/octet-stream':(['image/png','image/jpeg','image/gif'].includes(file.type)?file.type:'application/octet-stream')},body:file});
   if(!(imageDrafts.get(thread)||[]).includes(item))continue;
   item.id=result.id;item.status='ready';if(item.url)URL.revokeObjectURL(item.url);delete item.url;saveImageDrafts();
  }catch(e){if((imageDrafts.get(thread)||[]).includes(item)){item.status='failed';item.error=e.name==='AbortError'?'上传已暂停，请重新添加':e.message;if(state.selected===thread)error(item.error);}}
  if(state.auth && state.selected===thread)renderComposer();
 }
 if(state.auth && state.selected===thread)renderComposer();
}
$('add-images').addEventListener('click',()=>$('image-picker').click());
$('image-picker').addEventListener('change',()=>{const files=[...$('image-picker').files];$('image-picker').value='';void addImageFiles(files);});
$('prompt').addEventListener('paste',e=>{
 const files=[...(e.clipboardData?.items||[])].filter(i=>i.kind==='file' && i.type.startsWith('image/')).map(i=>i.getAsFile()).filter(Boolean);
 if(!files.length)return;e.preventDefault();
 if(state.submitting || state.submission)return;
 const text=e.clipboardData.getData('text/plain');if(text){$('prompt').setRangeText(text,$('prompt').selectionStart,$('prompt').selectionEnd,'end');$('prompt').dispatchEvent(new Event('input'));}
 void addImageFiles(files);
});
$('composer').addEventListener('dragover',e=>{if([...e.dataTransfer.types].includes('Files'))e.preventDefault();});
$('composer').addEventListener('drop',e=>{if(e.dataTransfer.files.length){e.preventDefault();void addImageFiles([...e.dataTransfer.files]);}});
function renderQueue(){
 const entries=queuedEntries.filter(e=>e.threadId===state.selected && !['cancelled','accepted'].includes(e.status) && !dismissedQueues.has(e.id));
 const key=JSON.stringify([state.selected,entries,[...queueActions]]);if(key===queueRenderKey)return;queueRenderKey=key;
 const root=$('queue-status');const scrollTop=root.querySelector('.queue-list')?.scrollTop||0;root.replaceChildren();
 root.hidden=!entries.length;if(!entries.length)return;
 root.append(node('div','queue-heading',`排队 ${activeQueueCount()}/${maxQueuedPerThread}`));
 const list=node('div','queue-list');list.tabIndex=0;list.setAttribute('role','region');list.setAttribute('aria-label','排队消息');root.append(list);
 for(const entry of entries){
  const row=node('div','queue-row');const content=node('div','queue-content');
  if(entry.text){const preview=node('div','queue-text',entry.text);preview.title=entry.text;content.append(preview);}
  if(entry.images?.length){const images=node('div','queue-images');for(const id of entry.images){if(id.includes('.file.')){images.append(node('span','queue-file','▤ '+id.split('.file.')[1].toUpperCase()+' 文件'));continue;}const img=node('img');Runtime.setMedia(img,imageURL(id));img.alt='排队图片';img.loading='lazy';images.append(img);}content.append(images);}
  if(entry.status!=='queued')content.append(node('span','fine',entry.detail));row.append(content);
  const actions=node('div','queue-actions');
  const busy=queueActions.has(entry.id) || entry.status==='pending';
  for(const action of entry.status==='queued'?['删除','引导']:['关闭']){
   const button=node('button','',action);button.type='button';button.disabled=busy;if(action==='引导')button.title=entry.modelSettings?'立即引导当前轮，沿用当前模型；本条模型设置不随引导提交':'立即引导当前轮';
   button.addEventListener('click',async()=>{
    if(action==='关闭'){dismissedQueues.add(entry.id);renderQueue();return;}
    if(queueActions.has(entry.id) || (action==='引导' && (state.submission || state.submitting)))return;
    if(action==='引导')state.submitting=true;
    queueActions.add(entry.id);renderComposer();
    try{
     const result=await api(action==='删除'?'/api/queue/cancel':'/api/queue/steer',{method:'POST',body:JSON.stringify({id:entry.id})});
     queuedEntries=queuedEntries.map(e=>e.id===entry.id?{...e,...result}:e);
     state.lastDelivery={threadId:entry.threadId,detail:result.detail};
     if(action==='引导' && result.status==='pending'){
      state.submission={...result,queuePromotion:true};saveSubmission();renderComposer();void checkSubmission();
     }
     await loadQueue();
    }catch(e){if(e.name!=='AbortError')error(e.message);void loadQueue();}
    finally{queueActions.delete(entry.id);if(action==='引导')state.submitting=false;renderComposer();}
   });actions.append(button);
  }
  row.append(actions);list.append(row);
 }
 list.scrollTop=scrollTop;
}
let stoppingTurn=false;
function renderSendButton(){
 const thread=state.threads.find(t=>t.id===state.selected),active=thread?.status==='active'&&!!thread.activeTurnId;
 const stop=active&&!hasDraftContent(),blocked=state.submitting||!!state.submission;
 $('send').dataset.action=stop?'stop':'send';
 $('send').innerHTML=stop?'<span class="stop-square" aria-hidden="true"></span>':'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5m-6 6 6-6 6 6"/></svg>';
 const label=stoppingTurn?'正在停止…':stop?'停止回答':blocked?'正在发送…':'发送消息';
 $('send').setAttribute('aria-label',label);$('send').title=label;
 $('send').disabled=stop?stoppingTurn:blocked||stoppingTurn||activeQueueCount()>=maxQueuedPerThread||!imagesReady()||!hasDraftContent();
 $('stop-turn').hidden=!active||stop;$('stop-turn').disabled=stoppingTurn;
}
async function stopTurn(){
 const thread=state.threads.find(t=>t.id===state.selected);
 if(stoppingTurn||!state.canSend||thread?.status!=='active'||!thread.activeTurnId)return;
 stoppingTurn=true;renderSendButton();
 try{await api('/api/thread/interrupt',{method:'POST',body:JSON.stringify({threadId:thread.id,turnId:thread.activeTurnId})});await sync();}
 catch(e){error(e.name==='AbortError'?'停止结果未确认，请刷新聊天核对':e.message);}
 finally{stoppingTurn=false;renderSendButton();}
}
$('stop-turn').addEventListener('click',()=>void stopTurn());
$('send').addEventListener('click',e=>{if($('send').dataset.action==='stop'){e.preventDefault();void stopTurn();}});
function renderComposer(){
  const thread=state.threads.find(t=>t.id===state.selected);
  LiveControls.update({threadId:state.selected, enabled:state.auth && !state.suspended && state.canSend && !!thread && !thread.archived, auto:state.mode==='auto', api, onApprovals:setSidebarApprovals});
  ModelPicker.update({threadId:state.selected, lastTurnSettings:thread?.lastTurnSettings, enabled:state.canSend && !!thread && !thread.archived, busy:state.submitting || !!state.submission, api});
  $('composer').hidden=!state.canSend || !thread || thread.archived;
  const pending=state.submission;
  const own=pending?.threadId===state.selected;
  const blocked=state.submitting || !!pending;
  renderQueue();
  renderImageDrafts();
  $('prompt').disabled=blocked;
  const queueFull=activeQueueCount()>=maxQueuedPerThread;
  $('send').disabled=blocked || queueFull || !imagesReady() || !hasDraftContent();
  if(document.activeElement!==$('prompt'))$('prompt').value=state.drafts.get(state.selected)||'';
  renderSendButton();
  $('send-note').textContent=pending?(own?pending.detail:'另一个聊天有消息等待确认：'+pending.detail):'';
  if(!pending && queueFull)$('send-note').textContent='已排队 5/5 条，请等待投递或删除后再发送；草稿已保留';
  $('send-note').classList.toggle('failed',pending?.status==='failed' || pending?.status==='unknown');
  $('check-send').hidden=!pending || pending.status==='pending';
  $('dismiss-send').hidden=!pending || !['unknown','failed'].includes(pending.status);
  $('send-status').hidden=!pending && !queueFull;
  fitPrompt();
}
function saveSubmission(){try{if(state.submission)sessionStore.setItem('cr-submission',JSON.stringify({id:state.submission.id,threadId:state.submission.threadId,mode:state.submission.mode,queuePromotion:state.submission.queuePromotion,images:state.submission.images,modelSettings:state.submission.modelSettings}));else sessionStore.removeItem('cr-submission');}catch{}}
function submissionResult(entry){
  if(!state.submission || entry.id!==state.submission.id)return;
  if(entry.mode==='create'){creationResult(entry);return;}
  if(entry.threadId!==state.submission.threadId)return;
  const old=state.submission;state.submission={...old,...entry};
  queuedEntries=queuedEntries.map(item=>item.id===entry.id?{...item,...entry}:item);
  if(entry.status==='accepted' || entry.status==='queued'){
    if(!old.queuePromotion)ModelPicker.consume(entry.threadId,old.modelSettings);
    if(!old.queuePromotion){const sent=new Set(old.images||[]);imageDrafts.set(entry.threadId,(imageDrafts.get(entry.threadId)||[]).filter(i=>!sent.has(i.id)));saveImageDrafts();}
    if(!old.queuePromotion && (old.text===undefined || state.drafts.get(entry.threadId)===old.text))state.drafts.delete(entry.threadId);
    if(!old.queuePromotion && state.selected===entry.threadId)$('prompt').value='';
    state.lastDelivery={threadId:entry.threadId,detail:entry.status==='queued'?'已排队，电脑会在聊天结束后投递':'已送达目标电脑，回复保存后会显示'};
    state.submission=null;saveSubmission();saveDrafts();renderComposer();void sync();void loadQueue();return;
  }
  renderComposer();
  if(entry.status==='pending' && !Runtime.hidden && state.auth){clearTimeout(state.sendTimer);state.sendTimer=setTimeout(checkSubmission,1500);}
}
async function checkSubmission(){
  clearTimeout(state.sendTimer);state.sendTimer=null;
  if(!state.auth || Runtime.hidden || !state.submission)return;
  const id=state.submission.id;
  try{const entry=await api('/api/send-status?'+new URLSearchParams({id}));submissionResult(entry);}
  catch(e){if(state.submission?.id===id && e.name!=='AbortError'){state.submission.status='unknown';state.submission.detail=e.message;renderComposer();if(state.submission.mode==='create'){$('create-note').textContent=e.message;$('create-check').hidden=false;$('create-dismiss').hidden=false;}}}
}
$('prompt').addEventListener('input',()=>{state.lastDelivery=null;state.drafts.set(state.selected,$('prompt').value);scheduleView();renderSendButton();fitPrompt();});
$('prompt').addEventListener('keydown',e=>{
 // keyCode 229 also protects Safari's IME confirmation Enter.
 if(e.key!=='Enter' || e.isComposing || e.keyCode===229 || e.shiftKey || e.altKey || e.metaKey)return;
 if(sendShortcut==='ctrl-enter'?!e.ctrlKey:e.ctrlKey)return;
 e.preventDefault();
 if(!e.repeat && hasDraftContent() && !$('send').disabled)$('composer').requestSubmit();
});
$('composer').addEventListener('submit',async e=>{
  e.preventDefault();if(!state.canSend || !state.selected || state.submission || state.submitting)return;
  if(activeQueueCount()>=maxQueuedPerThread){renderComposer();return;}
  const text=$('prompt').value.trim();const images=currentImages().map(i=>i.id);if((!text && !images.length) || !imagesReady())return;
  if(new TextEncoder().encode(text).length>16384){$('send-status').hidden=false;$('send-note').textContent='正文太长，请缩短到 16 KiB 以内';return;}
  const bytes=new Uint8Array(16);crypto.getRandomValues(bytes);const id=[...bytes].map(b=>b.toString(16).padStart(2,'0')).join('');
  state.drafts.set(state.selected,text);state.submission={id,threadId:state.selected,text,images,modelSettings:ModelPicker.snapshot(state.selected),mode:'queue',status:'pending',detail:'正在发送到目标电脑'};state.submitting=true;saveSubmission();renderComposer();
  try{const result=await api('/api/send',{method:'POST',body:JSON.stringify({id,threadId:state.submission.threadId,text,images,mode:state.submission.mode,modelSettings:state.submission.modelSettings})});submissionResult(result);}
  catch(e){if(state.submission?.id===id){const rejected=[400,403,404,409,413].includes(e.status);state.submission.status=rejected?'failed':'unknown';state.submission.detail=rejected?e.message:e.name==='AbortError'?'页面已暂停，返回后查询送达状态':'发送结果未确认，请查询状态；不要重复发送';renderComposer();}}
  finally{state.submitting=false;renderComposer();}
});
$('check-send').addEventListener('click',()=>{void checkSubmission();});
$('dismiss-send').addEventListener('click',()=>{if(state.submission?.status==='pending')return;state.submission=null;saveSubmission();renderComposer();});

let creatingProject='';
function openCreate(path){
 if(state.submission?.mode==='create'){creatingProject=state.submission.threadId;$('create-note').textContent=state.submission.detail;$('create-check').hidden=false;}
 else if(state.submission || state.submitting){error('请先确认上一条消息的结果');return;}
 else{creatingProject=path;$('create-note').textContent='使用电脑的默认配置，在该项目目录开始。';$('create-check').hidden=true;}
 $('create-project').textContent=path;$('create-submit').disabled=!!state.submission;
 $('create-dialog').showModal();
}
$('create-close').addEventListener('click',()=>$('create-dialog').close());
$('create-check').addEventListener('click',()=>{void checkSubmission();});
$('create-form').addEventListener('submit',async e=>{
 e.preventDefault();if(state.submission || state.submitting)return;
 const text=$('create-prompt').value.trim();if(!text || new TextEncoder().encode(text).length>16384){$('create-note').textContent='请输入第一条消息，最多 16 KiB';return;}
 const bytes=new Uint8Array(16);crypto.getRandomValues(bytes);const id=[...bytes].map(b=>b.toString(16).padStart(2,'0')).join('');
 state.submission={id,threadId:creatingProject,mode:'create',status:'pending',detail:'正在创建，请稍候'};saveSubmission();$('create-submit').disabled=true;$('create-note').textContent=state.submission.detail;
 try{creationResult(await api('/api/thread/create',{method:'POST',body:JSON.stringify({id,projectPath:creatingProject,text})}));}
 catch(e){if(state.submission?.id===id){state.submission.status=e.status===403?'failed':'unknown';state.submission.detail=e.status===403?e.message:'创建结果未确认，请查询结果，不要重复创建';$('create-note').textContent=state.submission.detail;$('create-check').hidden=false;$('create-dismiss').hidden=false;}}
});
function creationResult(entry){
 if(state.submission?.id!==entry.id)return;
 if(entry.status==='created'){
  state.lastDelivery={threadId:entry.threadId,detail:entry.detail};state.submission=null;saveSubmission();$('create-prompt').value='';$('create-dialog').close();
  void sync().then(()=>{if(state.threads.some(t=>t.id===entry.threadId))void openThread(entry.threadId);else error(entry.detail+'；刷新列表查看。');});return;
 }
 state.submission={...state.submission,...entry};$('create-note').textContent=entry.status==='created_unconfirmed'?'会话已保存，但启动未确认。'+entry.detail+'。请先核对电脑，不要重复创建。':entry.detail;$('create-check').hidden=entry.status==='pending';$('create-dismiss').hidden=entry.status==='pending';
 if(entry.status==='pending' && state.auth && !Runtime.hidden){clearTimeout(state.sendTimer);state.sendTimer=setTimeout(checkSubmission,1500);}
}

$('create-dismiss').addEventListener('click',()=>{if(state.submission?.mode!=='create' || state.submission.status==='pending')return;state.submission=null;saveSubmission();$('create-submit').disabled=false;$('create-check').hidden=true;$('create-dismiss').hidden=true;});
