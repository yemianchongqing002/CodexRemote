'use strict';
const ModelPicker = (() => {
 const el=id=>document.getElementById(id), dialog=el('model-dialog');
 const names={none:'无',minimal:'极低',low:'低',medium:'中',high:'高',xhigh:'极高',max:'最大',ultra:'超高'};
 let context={threadId:'',enabled:false,busy:false},models=[],choice=null,loading=false,serial=0;
 let openThread='',request=null;
 // Local unsent overrides only; never infer live desktop settings.
 const storage=Runtime.storage('session');
 const modelStorage=Runtime.storage('local');
 let remembered=new Map();
 try{const rows=JSON.parse(modelStorage.getItem('cr-thread-models')||'[]');if(Array.isArray(rows))remembered=new Map(rows.filter(r=>Array.isArray(r)&&typeof r[0]==='string'&&typeof r[1]?.model==='string').slice(-200));}catch{}
 const liveModels=new Map();
 function remember(thread,value){
  if(!thread||!value?.model)return;
  value={model:value.model,...(value.effort?{effort:value.effort}:{}),...(typeof value.fast==='boolean'?{fast:value.fast}:{}),...(value.timestamp?{timestamp:value.timestamp}:{})};
  if(JSON.stringify(remembered.get(thread))===JSON.stringify(value))return;
  remembered.delete(thread);remembered.set(thread,{...value});
  if(remembered.size>200)remembered.delete(remembered.keys().next().value);
  try{modelStorage.setItem('cr-thread-models',JSON.stringify([...remembered]));}catch{}
 }
 function current(){return liveModels.get(context.threadId)||remembered.get(context.threadId);}
 function selectChoice(value){
  choice=value?{model:value.model,effort:value.effort,fast:!!value.fast}:null;
  if(choice&&!models.some(m=>m.model===choice.model)&&el('model-select').value!==choice.model){const option=document.createElement('option');option.value=choice.model;option.textContent=choice.model+'（当前模型）';option.disabled=true;el('model-select').append(option);}
  el('model-select').value=choice?.model||'';
 }
 function syncChoice(){if(dialog.open&&!loading&&!applied.has(context.threadId))selectChoice(current());}

 let applied=new Map();
 try { const rows=JSON.parse(storage.getItem('cr-model-drafts')||'[]'); if(Array.isArray(rows))applied=new Map(rows.slice(-50)); } catch {}
 function persist(){try{storage.setItem('cr-model-drafts',JSON.stringify([...applied].slice(-50)));}catch{}}
 function changed(){if(choice)applied.set(openThread,{...choice});else applied.delete(openThread);persist();el('model-note').textContent=choice?'已保存在本地，随下一条消息发送':note();render();}

 const label=e=>names[e]||e;
 const selected=()=>models.find(m=>m.model===choice?.model);
 const fastTier=m=>(m?.serviceTiers||[]).find(t=>t.id==='priority');
 function defaults(m){return {model:m.model,effort:m.defaultReasoningEffort,fast:false};}
 function recorded(){const v=current();return v?.model?`${v.model}${v.effort?' · '+label(v.effort):''}`:'';}
 function note(){return `${recorded()?'当前会话模型：'+recorded()+'。':'尚未获取此会话的模型。'}修改后随下一条消息生效。`;}
 function summary(){
  const value=applied.get(context.threadId),m=models.find(m=>m.model===value?.model);
  el('model-picker-open').textContent=value?`${value.fast?'ϟ ':''}${m?.displayName||value.model} · ${label(value.effort)} ⌄`:recorded()?`${recorded()} ⌄`:'模型待同步 ⌄';
  el('model-picker-open').title=value?'待发送的本地设置；随下一条消息提交':note();
  el('model-picker-open').disabled=!context.enabled||context.busy;
 }
 function render(){
  const m=selected(),locked=loading;
  el('model-select').disabled=locked||!models.length;
  el('model-fast').disabled=locked||!fastTier(m);
  el('model-fast').setAttribute('aria-pressed',String(!!choice?.fast));
  el('model-fast').classList.toggle('active',!!choice?.fast);
  el('model-reset').disabled=locked||!m;
  el('model-retry').disabled=locked;
  el('model-close').disabled=false;
  el('model-effort-name').textContent=choice?label(choice.effort):'—';
  const rail=el('model-efforts');rail.replaceChildren();
  for(const effort of m?.supportedReasoningEfforts||[]){
   const button=document.createElement('button');button.type='button';button.textContent='•';button.title=label(effort.reasoningEffort)+'：'+effort.description;button.setAttribute('aria-label',label(effort.reasoningEffort));button.setAttribute('aria-pressed',String(effort.reasoningEffort===choice.effort));button.disabled=locked;
   button.addEventListener('click',()=>{choice.effort=effort.reasoningEffort;changed();});rail.append(button);
  }
  el('model-description').textContent=(m?.supportedReasoningEfforts||[]).find(e=>e.reasoningEffort===choice?.effort)?.description||m?.description||'';
  el('model-fast-note').textContent=m?(fastTier(m)?`Fast：${fastTier(m).description||'优先处理，可能增加用量'}`:'此模型未提供 Fast 模式'):'';
  summary();
 }
 function place(){
  const r=el('model-picker-open').getBoundingClientRect();
  dialog.style.right=Math.max(12,window.innerWidth-r.right)+'px';
  dialog.style.bottom=Math.max(12,window.innerHeight-r.top+8)+'px';
  if(dialog.getBoundingClientRect().top<12)dialog.style.bottom='12px';
 }
 function close(){request?.abort();serial++;loading=false;dialog.close();}
 async function load(){
  request?.abort();request=new AbortController();const epoch=++serial,thread=openThread;
  loading=true;models=[];choice=null;el('model-select').replaceChildren();el('model-note').textContent='正在读取目标电脑的模型…';render();
  try{
   const result=await context.api('/api/models',{signal:request.signal});
   if(epoch!==serial||thread!==context.threadId)return;
   models=Array.isArray(result.models)?result.models:[];
   const placeholder=document.createElement('option');placeholder.value='';placeholder.textContent='选择模型';el('model-select').append(placeholder);
   for(const m of models){const option=document.createElement('option');option.value=m.model;option.textContent=m.displayName||m.model;el('model-select').append(option);}
   const previous=applied.get(thread)||current();
   selectChoice(previous);
   el('model-note').textContent=note();
  }catch(e){if(epoch===serial&&e.name!=='AbortError')el('model-note').textContent=e.message;}
  finally{if(epoch===serial){loading=false;render();place();}}
 }
 el('model-picker-open').addEventListener('click',()=>{openThread=context.threadId;dialog.showModal();place();void load();});
 el('model-close').addEventListener('click',close);
 dialog.addEventListener('cancel',e=>{e.preventDefault();close();});
 dialog.addEventListener('click',e=>{if(e.target===dialog){const r=dialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)close();}});
 el('model-retry').addEventListener('click',()=>void load());
 el('model-select').addEventListener('change',()=>{const m=models.find(m=>m.model===el('model-select').value);choice=m?defaults(m):null;changed();});
 el('model-fast').addEventListener('click',()=>{if(choice&&fastTier(selected())){choice.fast=!choice.fast;changed();}});
 el('model-reset').addEventListener('click',()=>{const m=selected();if(m){choice=defaults(m);changed();}});
 document.addEventListener('visibilitychange',()=>{if(document.hidden&&dialog.open)close();});
 window.addEventListener('resize',()=>{if(dialog.open)place();});
 return {
 live(thread,value){if(value?.model){liveModels.set(thread,{...value});remember(thread,value);}if(thread===context.threadId){syncChoice();summary();if(dialog.open){el('model-note').textContent=note();render();}}},
 snapshot(thread){const value=applied.get(thread);return value?{...value}:undefined;},
 consume(thread,value){if(value&&JSON.stringify(applied.get(thread))===JSON.stringify(value)){applied.delete(thread);persist();summary();}},
 update(next){if(next.threadId!==context.threadId||!next.enabled){if(dialog.open)close();}context=next;if(!liveModels.has(next.threadId))remember(next.threadId,next.lastTurnSettings);syncChoice();summary();if(dialog.open){el('model-note').textContent=note();render();}}};
})();
