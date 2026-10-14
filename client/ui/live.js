'use strict';
const LiveControls = (() => {
 const el=id=>document.getElementById(id);
 let context={},data=null,timer=null,request=null,epoch=0,writing=false,fresh=false,lastCards='',paused=false,syncing=false,syncSerial=0;
 const active=()=>context.enabled&&!Runtime.hidden;
 function status(text,show=false){el('live-status').textContent=text;el('live-status').hidden=!show;}
 function publish(options){if(context.threadId)context.onApprovals?.(context.threadId,fresh&&!!data?.approvals?.length);ModelPicker.live(context.threadId,fresh?data:null,options);}
 function pause(){paused=true;clearTimeout(timer);timer=null;request?.abort();request=null;epoch++;syncSerial++;syncing=false;el('live-refresh').removeAttribute('aria-busy');fresh=false;writing=false;publish();render();}
 function schedule(){clearTimeout(timer);if(active()&&context.auto&&!syncing)timer=setTimeout(()=>void refresh(),5000);}
 function render(){
  const locked=!active()||!fresh||writing||syncing;
  el('live-refresh').disabled=!active()||writing||syncing;
  PermissionMenu.update(fresh?data:null,locked);
  const approvals=data?.approvals||[];
  el('approval-panel').hidden=!approvals.length;
  const signature=JSON.stringify([approvals,locked]);
  if(signature===lastCards)return;lastCards=signature;el('approval-panel').replaceChildren();
  for(const a of approvals){
   const card=document.createElement('section');card.className='approval-card';
   const title=document.createElement('strong');title.textContent=({command:'命令执行',file:'文件修改',permissions:'额外权限'})[a.kind]+' · 等待批准';card.append(title);
   const reason=document.createElement('p');reason.textContent=a.params.reason||'桌面请求你批准以下操作';card.append(reason);
   const detail=document.createElement('pre');
   const p=a.params;
   detail.textContent=a.kind==='command'?[p.command||JSON.stringify(p.commandActions||[]),p.cwd?'目录：'+p.cwd:'',p.additionalPermissions?'额外权限：'+JSON.stringify(p.additionalPermissions,null,2):'',p.networkApprovalContext?'网络：'+JSON.stringify(p.networkApprovalContext,null,2):''].filter(Boolean).join('\n'):a.kind==='permissions'?JSON.stringify(p.permissions,null,2):JSON.stringify(a.changes||{grantRoot:p.grantRoot,itemId:p.itemId,说明:'桌面未提供文件差异，请在电脑核对后决定'},null,2);
   card.append(detail);
   const scope=document.createElement('p');scope.className='fine';scope.textContent=a.kind==='permissions'?'允许仅授予本轮申请的权限。':'决定仅针对这条审批请求。';card.append(scope);
   for(const decision of a.decisions){
    const button=document.createElement('button');button.type='button';button.textContent=decision==='accept'?'允许':decision==='cancel'?'取消执行':'拒绝';button.disabled=locked;
    button.addEventListener('click',()=>void mutate('/api/thread/approval',{key:a.key,decision},''));card.append(button);
   }
   el('approval-panel').append(card);
  }
 }
 async function refresh(force=false,{discardDraft=false}={}){
  if(!active()||writing||(syncing&&!discardDraft))return false;
  if(request){if(!force)return false;request.abort();request=null;epoch++;}
  clearTimeout(timer);const current=epoch,thread=context.threadId;const controller=new AbortController();request=controller;render();
  const timeout=setTimeout(()=>{console.warn('[sync] live request timed out',{thread});controller.abort();},60000);
  try{
   const next=await context.api('/api/thread/live?'+new URLSearchParams({threadId:thread}),{signal:controller.signal});
   if(current!==epoch||!active())return;
   data=next;fresh=true;publish({discardDraft});console.debug('[sync] desktop settings',{thread,activePermissionProfile:next.activePermissionProfile,approvalPolicy:next.approvalPolicy,approvalsReviewer:next.approvalsReviewer,model:next.model,effort:next.effort});
   if(!next.approvalPolicy||!next.sandboxPolicy){status('无法读取 Codex 会话审批设置，请重新同步',true);return false;}
   if(discardDraft&&(!next?.model||!next?.effort)){status('权限已同步，但 Codex 模型设置不完整，请重新同步',true);return false;}
   if(discardDraft)status('');return true;
  }catch(e){if(current===epoch){fresh=false;publish();if(/no-client-found|桌面尚未接管/.test(e.message||''))status('');else status(e.name==='AbortError'?'同步超时，请重试':e.message,true);console.warn('[sync] live request failed',{thread,error:e.message});}return false;}
  finally{clearTimeout(timeout);if(current===epoch){request=null;render();schedule();}}
 }
 async function mutate(path,body,success){
  if(!active()||!fresh||writing||syncing)return;
  request?.abort();request=null;clearTimeout(timer);const current=++epoch;writing=true;render();
  const thread=context.threadId;const controller=new AbortController();request=controller;
  status('');
  try{
   const next=await context.api(path,{method:'POST',signal:controller.signal,body:JSON.stringify({threadId:thread,...body})});
   if(current!==epoch||!active())return;
   data=next;fresh=true;publish();status(success||'',!!success);
  }catch(e){if(current===epoch){fresh=false;publish();const msg=e.name==='AbortError'?'操作结果未确认，请刷新核对':e.message;status(msg,true);}}
  finally{if(current===epoch){request=null;writing=false;render();schedule();}}
 }
 async function sync(){
  if(syncing||!active())return false;
  if(writing){status('正在提交审批决定，请完成后再同步',true);return false;}
  syncing=true;const current=++syncSerial;render();
  status('');el('live-refresh').title='从 Codex 同步权限和模型';el('live-refresh').setAttribute('aria-busy','true');
  try{
   const results=await Promise.allSettled([refresh(true,{discardDraft:true}),ModelPicker.refresh({silent:true,force:true})]);
   if(current!==syncSerial)return false;
   const ok=results.map(r=>r.status==='fulfilled'&&r.value===true);
   if(ok[0]&&!ok[1])status('权限已同步，模型列表同步失败，请重试',true);
   return ok.every(Boolean);
  }finally{if(current===syncSerial){syncing=false;el('live-refresh').removeAttribute('aria-busy');render();schedule();}}
 }
 el('live-refresh').addEventListener('click',()=>void sync());
 el('permission-select').addEventListener('permission-change',e=>{
  const {approvalPolicy,approvalsReviewer,permissions}=e.detail;
  void mutate('/api/thread/permissions',{version:data?.permissionVersion,approvalPolicy,approvalsReviewer,permissions},'');
 });
 document.addEventListener('visibilitychange',()=>{if(Runtime.hidden)pause();else void refresh();});
 return {pause,refresh,sync,update(next){
  const changed=next.threadId!==context.threadId||next.enabled!==context.enabled;
  const resume=paused;paused=false;
  if(changed){pause();data=null;lastCards='';status('');}
  context=next;paused=false;publish();render();
  if((changed||resume)&&active())void refresh();else if(!next.auto){clearTimeout(timer);timer=null;}else if(active()&&!timer&&!request&&!writing)schedule();
 }};
})();
