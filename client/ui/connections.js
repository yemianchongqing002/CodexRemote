/* Connection management belongs to the local app, never to a remote service. */
(() => {
 document.body.classList.add('native-client');
 const byId=id=>document.getElementById(id);
 byId('input-settings-note').textContent='设置自动保存到当前设备';
 byId('connection-name-help').textContent='别名仅在当前设备显示，留空使用电脑名称。';
 let switching=false;
 const message=text=>{byId('connections-note').textContent=text;byId('add-computer-note').textContent=text;byId('computer-switcher-note').textContent=text;};
 for(const button of document.querySelectorAll('[data-client-only]'))button.hidden=false;
 const switcher=byId('computer-switcher'),addDialog=byId('add-computer-dialog');
 let switchOrigin=null;
 function closeSwitcher(){switcher.close();}
 function addComputer(){closeSwitcher();byId('add-computer-note').textContent='';addDialog.showModal();window.dispatchEvent(new Event('cr-add-computer'));}
 byId('add-computer').addEventListener('click',addComputer);
 byId('computer-switcher-add').addEventListener('click',addComputer);
 byId('add-computer-close').addEventListener('click',()=>addDialog.close());
 byId('computer-switcher-close').addEventListener('click',closeSwitcher);
 switcher.addEventListener('close',()=>{document.querySelectorAll('[data-connections]').forEach(b=>b.setAttribute('aria-expanded','false'));switchOrigin?.focus();});
 switcher.addEventListener('click',event=>{if(event.target===switcher){const r=switcher.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)closeSwitcher();}});
 for(const button of document.querySelectorAll('[data-connections]'))button.addEventListener('click',()=>{
  if(switcher.open){closeSwitcher();return;}switchOrigin=button;renderSwitcher();
  const rect=button.getBoundingClientRect();switcher.style.left=Math.max(12,Math.min(rect.left,window.innerWidth-332))+'px';switcher.style.top=Math.max(12,Math.min(rect.bottom+8,window.innerHeight-300))+'px';
  switcher.style.maxHeight=Math.min(540,window.innerHeight-parseFloat(switcher.style.top)-12)+'px';
  switcher.showModal();button.setAttribute('aria-expanded','true');
 });
 async function selectComputer(row){
  if(switching)return;
  if(Runtime.profile?.id===row.id){closeSwitcher();return;}
  switching=true;message('正在连接…');renderSwitcher();
  try{await Runtime.select(row);}catch(e){
   message('');await ConnectionRecovery.recover(row,{error:e});
  }finally{switching=false;renderSwitcher();}
 }
 async function removeComputer(row){
  if(switching)return;
  switching=true;
  try{await Runtime.forgetComputer(row);render();message('已删除此电脑的本地连接、草稿和登录会话。远端数据不受影响。');}
  catch(e){message('删除未完成：'+String(e?.message||e));}
  finally{switching=false;render();}
 }
 function deleteButton(row){
  const button=document.createElement('button');button.type='button';button.className='computer-delete';button.disabled=switching;
  button.setAttribute('aria-label','删除 '+(row.name||row.serviceName||new URL(row.address).host));button.title='删除连接及其本地草稿和登录会话（保留远端数据）';
  button.innerHTML='<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/></svg>';
  button.addEventListener('click',()=>removeComputer(row));return button;
 }
 function renderSwitcher(){
  const list=byId('computer-switcher-list');list.replaceChildren();
  for(const row of Runtime.profiles()){
   const button=document.createElement('button');button.type='button';button.className='computer-option';button.disabled=switching;
   const name=document.createElement('strong');name.textContent=row.name||row.serviceName||new URL(row.address).host;
   const address=document.createElement('span');address.className='fine';address.textContent=row.address;
   button.append(name,address);
   if(Runtime.profile?.id===row.id){button.classList.add('current');button.setAttribute('aria-current','true');const current=document.createElement('span');current.className='fine';current.textContent='当前电脑';button.append(current);}
   button.addEventListener('click',()=>selectComputer(row));const item=document.createElement('div');item.className='computer-option-row';item.append(button,deleteButton(row));list.append(item);
  }
 }
 byId('login-machine-name').textContent=Runtime.profile?.name||Runtime.profile?.serviceName||Runtime.host;
 byId('login-machine-address').textContent=Runtime.profile?.address||'';
 if(!Runtime.hasConnection){byId('connections-screen').hidden=false;byId('connection-settings').hidden=true;}
 function render(){
  const list=byId('connections-list');list.replaceChildren();
  const rows=Runtime.profiles();byId('connections-screen').classList.toggle('no-computers',rows.length===0);renderSwitcher();
  for(const row of rows){
   const card=document.createElement('article');card.className='connection-card';
   const open=document.createElement('button');open.type='button';open.className='connection-open';
   const title=document.createElement('strong');title.textContent=row.name||row.serviceName||new URL(row.address).host;
   const address=document.createElement('span');address.className='fine';address.textContent=row.address;
   open.append(title,address);open.addEventListener('click',()=>selectComputer(row));
   card.append(open,deleteButton(row));list.append(card);
  }
 }
 window.addEventListener('cr-profiles-changed',render);
 render();
 Runtime.ready.catch(e=>message('连接初始化失败：'+String(e)));
})();
