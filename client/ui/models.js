'use strict';
const ModelPicker = (() => {
 const el=id=>document.getElementById(id), dialog=el('model-dialog');
 const names={none:'无',minimal:'极低',low:'低',medium:'中',high:'高',xhigh:'极高',max:'最大',ultra:'超高',default:'默认'};
 let context={threadId:'',enabled:false,busy:false},models=[],choice=null,loading=false,serial=0;
 let openThread='',request=null,effortPointer=null;
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

 }
 function pending(){const draft=applied.get(context.threadId);return draft?.model===current()?.model?draft:undefined;}
 function syncChoice(){if(dialog.open&&!loading)selectChoice(pending()||current());}

 let applied=new Map();
 try { const rows=JSON.parse(storage.getItem('cr-model-drafts')||'[]'); if(Array.isArray(rows))applied=new Map(rows.slice(-50)); } catch {}
 function persist(){try{storage.setItem('cr-model-drafts',JSON.stringify([...applied].slice(-50)));}catch{}}
 function setNote(text,isError=false){
  el('model-note').textContent=text;el('model-note').hidden=!isError;
  el('model-current').title=text;el('model-title').title=text;
 }
 function changed(){if(choice)applied.set(openThread,{...choice});else applied.delete(openThread);persist();setNote(choice?'已保存在本地，随下一条消息发送':note());render();}

 const label=e=>names[e]||e;
 const selected=()=>models.find(m=>m.model===choice?.model);
 const fastTier=m=>(m?.serviceTiers||[]).find(t=>t.id==='priority');
 function defaults(m){return {model:m.model,effort:m.defaultReasoningEffort,fast:false};}
 function recorded(){const v=current();return v?.model?`${v.model}${v.effort?' · '+label(v.effort):''}`:'';}
 function note(){return `${recorded()?'当前会话模型：'+recorded()+'。':'尚未获取此会话的模型。'}修改后随下一条消息生效。`;}
 function summary(){
  const value=pending(),m=models.find(m=>m.model===value?.model);
  el('model-picker-open').hidden=!current()?.model;
  el('model-picker-open').textContent=value?`${value.fast?'ϟ ':''}${m?.displayName||value.model} · ${label(value.effort)} ⌄`:recorded()?`${recorded()} ⌄`:'';
  el('model-picker-open').title=value?'待发送的本地设置；随下一条消息提交':note();
  el('model-picker-open').disabled=!context.enabled||context.busy;
 }
 function render(){
  const m=selected(),locked=loading;
  const actual=current(),caption=el('model-current');
  caption.textContent=actual?.model?(models.find(item=>item.model===actual.model)?.displayName||actual.model):'';caption.hidden=!actual?.model;
  el('model-fast').disabled=locked||!fastTier(m);
  el('model-fast').setAttribute('aria-pressed',String(!!choice?.fast));
  el('model-fast').classList.toggle('active',!!choice?.fast);
  const hasDefault=!!m?.defaultReasoningEffort;
  el('model-reset').hidden=!hasDefault;el('model-reset').disabled=locked||!hasDefault;
  el('model-retry').disabled=locked;
  el('model-close').disabled=false;
  el('model-effort-name').textContent=choice?.effort?label(choice.effort):'';
  const rail=el('model-efforts'),levels=m?.supportedReasoningEfforts||[];
  const railKey=JSON.stringify(levels);
  if(rail.dataset.levels!==railKey){rail.replaceChildren();rail.dataset.levels=railKey;
  for(const effort of levels){
   const button=document.createElement('button');button.type='button';button.textContent='';button.title=label(effort.reasoningEffort)+'：'+effort.description;button.setAttribute('aria-label',label(effort.reasoningEffort));button.setAttribute('aria-pressed',String(effort.reasoningEffort===choice.effort));button.disabled=locked;
   button.addEventListener('click',e=>{if(e.detail===0&&choice&&!loading){choice.effort=effort.reasoningEffort;changed();}});rail.append(button);
  }}
  [...rail.children].forEach((button,i)=>{button.disabled=locked;button.setAttribute('aria-pressed',String(levels[i].reasoningEffort===choice?.effort));});
  const efforts=m?.supportedReasoningEfforts||[],index=efforts.findIndex(e=>e.reasoningEffort===choice?.effort);rail.style.setProperty('--effort-fill',index<0?'0%':((index+.5)/efforts.length*100)+'%');
  el('model-description').textContent=(m?.supportedReasoningEfforts||[]).find(e=>e.reasoningEffort===choice?.effort)?.description||m?.description||'';
  el('model-fast-note').textContent=m?(fastTier(m)?`Fast：${fastTier(m).description||'优先处理，可能增加用量'}`:'此模型未提供 Fast 模式'):'';
  el('model-efforts').title=el('model-description').textContent;
  el('model-effort-name').title=el('model-description').textContent;
  el('model-fast').title=el('model-fast-note').textContent||'Fast 模式';
  el('model-efforts').setAttribute('aria-describedby','model-description');
  el('model-fast').setAttribute('aria-describedby','model-fast-note');
  summary();
 }
 function place(){
  const r=el('model-picker-open').getBoundingClientRect();
  dialog.style.right=Math.max(12,window.innerWidth-r.right)+'px';
  dialog.style.bottom=Math.max(12,window.innerHeight-r.top+8)+'px';
  if(dialog.getBoundingClientRect().top<12)dialog.style.bottom='12px';
 }
 function close(){endEffortDrag();request?.abort();serial++;loading=false;dialog.close();}
 async function load({silent=false,force=false}={}){
  if(loading&&!force)return false;
  endEffortDrag();request?.abort();request=new AbortController();const controller=request;const epoch=++serial,thread=openThread;
  const timeout=setTimeout(()=>{console.warn('[sync] model catalog timed out',{thread});controller.abort();},60000);
  loading=true;models=[];choice=null;setNote('正在读取目标电脑的模型…');render();
  try{
   const result=await context.api('/api/models',{signal:request.signal});
   if(epoch!==serial||thread!==context.threadId)return;
   models=Array.isArray(result.models)?result.models:[];
   const previous=pending()||current();
   selectChoice(previous);
   setNote(note());return true;
  }catch(e){console.warn('[sync] model catalog failed',{thread,error:e.message});if(!silent&&epoch===serial&&e.name!=='AbortError')setNote(e.message,true);return false;}
  finally{clearTimeout(timeout);if(epoch===serial){loading=false;render();if(dialog.open)place();}}
 }
 const effortRail=el('model-efforts');
 function pickEffortAt(x){
  const levels=selected()?.supportedReasoningEfforts||[],rect=effortRail.getBoundingClientRect();
  if(loading||!choice||!levels.length||rect.width<=0)return;
  const index=Math.max(0,Math.min(levels.length-1,Math.floor((x-rect.left)/rect.width*levels.length)));
  if(choice.effort!==levels[index].reasoningEffort){choice.effort=levels[index].reasoningEffort;changed();}
 }
 function endEffortDrag(){
  const pointer=effortPointer;effortPointer=null;effortRail.classList.remove('dragging');
  if(pointer!==null&&effortRail.hasPointerCapture(pointer))effortRail.releasePointerCapture(pointer);
 }
 effortRail.addEventListener('pointerdown',e=>{
  if(e.button!==0||!e.isPrimary||loading||!choice||!selected()?.supportedReasoningEfforts?.length)return;
  e.preventDefault();effortPointer=e.pointerId;effortRail.setPointerCapture(e.pointerId);effortRail.classList.add('dragging');
  pickEffortAt(e.clientX);effortRail.querySelector('[aria-pressed=true]')?.focus({preventScroll:true});
 });
 effortRail.addEventListener('pointermove',e=>{if(e.pointerId===effortPointer)pickEffortAt(e.clientX);});
 effortRail.addEventListener('pointerup',e=>{if(e.pointerId===effortPointer){pickEffortAt(e.clientX);endEffortDrag();}});
 effortRail.addEventListener('pointercancel',endEffortDrag);
 effortRail.addEventListener('lostpointercapture',endEffortDrag);
 effortRail.addEventListener('keydown',e=>{
  const levels=selected()?.supportedReasoningEfforts||[];
  if(loading||!choice||!levels.length||!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;
  e.preventDefault();const current=levels.findIndex(v=>v.reasoningEffort===choice.effort);
  const index=e.key==='Home'?0:e.key==='End'?levels.length-1:Math.max(0,Math.min(levels.length-1,current+(e.key==='ArrowRight'?1:-1)));
  choice.effort=levels[index].reasoningEffort;changed();effortRail.children[index]?.focus();
 });
 el('model-picker-open').addEventListener('click',()=>{openThread=context.threadId;dialog.showModal();place();void load();});
 el('model-close').addEventListener('click',close);
 dialog.addEventListener('cancel',e=>{e.preventDefault();close();});
 dialog.addEventListener('click',e=>{if(e.target===dialog){const r=dialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)close();}});
 el('model-retry').addEventListener('click',()=>void load());

 el('model-fast').addEventListener('click',()=>{if(choice&&fastTier(selected())){choice.fast=!choice.fast;changed();}});
 el('model-reset').addEventListener('click',()=>{const m=selected();if(m){choice=defaults(m);changed();}});
 document.addEventListener('visibilitychange',()=>{if(document.hidden&&dialog.open)close();});
 window.addEventListener('resize',()=>{if(dialog.open)place();});
 return {
 refresh(options){if(!context.enabled)return Promise.resolve(false);openThread=context.threadId;return load(options);},
 live(thread,value,{discardDraft=false}={}){if(value?.model){liveModels.set(thread,{...value});remember(thread,value);if(discardDraft&&value.effort){applied.delete(thread);persist();}}if(thread===context.threadId){syncChoice();summary();if(dialog.open){setNote(note());render();}}},
 snapshot(thread){const value=applied.get(thread),actual=liveModels.get(thread)||remembered.get(thread);return value&&value.model===actual?.model?{...value}:undefined;},
 consume(thread,value){if(value&&JSON.stringify(applied.get(thread))===JSON.stringify(value)){applied.delete(thread);persist();summary();}},
 update(next){if(next.threadId!==context.threadId||!next.enabled){if(dialog.open)close();}context=next;if(!liveModels.has(next.threadId))remember(next.threadId,next.lastTurnSettings);syncChoice();summary();if(dialog.open){setNote(note());render();}}};
})();
