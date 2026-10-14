'use strict';
const LiveControls = (() => {
 const el=id=>document.getElementById(id);
 const choices={'full-access':{approvalPolicy:'never',approvalsReviewer:'user',permissions:':danger-full-access'},auto:{approvalPolicy:'on-request',approvalsReviewer:'user',permissions:':workspace'},'guardian-approvals':{approvalPolicy:'on-request',approvalsReviewer:'auto_review',permissions:':workspace'},'read-only':{approvalPolicy:'on-request',approvalsReviewer:'user',permissions:':read-only'}};
 const labels={'full-access':'完全访问权限',auto:'请求批准',granular:'请求批准','guardian-approvals':'帮我批准','read-only':'只读'};
 let context={},data=null,timer=null,request=null,epoch=0,writing=false,fresh=false,lastCards='',paused=false,syncing=false,draftVersion='';
 const active=()=>context.enabled&&!Runtime.hidden;
 function publish(){ModelPicker.live(context.threadId,fresh?data:null);}
 function pause(){paused=true;clearTimeout(timer);timer=null;request?.abort();request=null;epoch++;syncing=false;fresh=false;writing=false;publish();render();}
 function schedule(){clearTimeout(timer);if(active()&&context.auto)timer=setTimeout(()=>void refresh(),5000);}
 function render(){
  const locked=!active()||!fresh||writing||syncing;
  el('live-refresh').disabled=!active()||writing||syncing;
  const reviewer=data?.approvalsReviewer==='guardian_subagent'?'auto_review':data?.approvalsReviewer;
  const mode=fresh?Object.keys(choices).find(k=>choices[k].permissions===data?.activePermissionProfile?.id&&choices[k].approvalPolicy===data?.approvalPolicy&&choices[k].approvalsReviewer===reviewer):null;
  el('permission-select').disabled=locked;
  el('permission-apply').hidden=false;el('permission-apply').disabled=locked||!choices[el('permission-select').value];
  el('permission-current').textContent=fresh?'会话审批模式：'+(labels[mode]||'自定义权限'):'会话审批模式未确认，请同步';
  el('permission-description').textContent='在此设置会话默认审批模式，对后续轮次生效；Codex 桌面选项不会同步修改。';
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
 async function refresh(force=false){
  if(!active()||writing||syncing)return false;
  if(request){if(!force)return false;request.abort();request=null;epoch++;}
  syncing=force;clearTimeout(timer);render();const current=epoch,thread=context.threadId;const controller=new AbortController();request=controller;
  const timeout=setTimeout(()=>controller.abort(),60000);
  try{
   const next=await context.api('/api/thread/live?'+new URLSearchParams({threadId:thread}),{signal:controller.signal});
   if(current!==epoch||!active())return;
   data=next;fresh=true;publish();
   if(!next.approvalPolicy||!next.sandboxPolicy){el('live-status').textContent='无法读取 Codex 会话审批设置';return false;}
   if(force)el('live-status').textContent='已从 Codex 同步';return true;
  }catch(e){if(current===epoch){fresh=false;publish();el('live-status').textContent=/no-client-found|桌面尚未接管/.test(e.message||'')?'':e.name==='AbortError'?'同步超时，请重试':e.message;}}
  finally{clearTimeout(timeout);if(current===epoch){request=null;syncing=false;render();schedule();}}
 }
 async function mutate(path,body,success){
  if(!active()||!fresh||writing||syncing)return;
  request?.abort();request=null;clearTimeout(timer);const current=++epoch;writing=true;render();
  const thread=context.threadId;const controller=new AbortController();request=controller;
  el('permission-note').textContent='';el('live-status').textContent='正在提交到桌面…';
  try{
   const next=await context.api(path,{method:'POST',signal:controller.signal,body:JSON.stringify({threadId:thread,...body})});
   if(current!==epoch||!active())return;
   data=next;fresh=true;publish();el('live-status').textContent=success;
   if(path.endsWith('/permissions')){el('permission-select').value='';draftVersion='';}
  }catch(e){if(current===epoch){fresh=false;publish();const msg=e.name==='AbortError'?'操作结果未确认，请刷新核对':e.message;el('live-status').textContent=msg;el('permission-note').textContent=msg;}}
  finally{if(current===epoch){request=null;writing=false;render();schedule();}}
 }
 el('live-refresh').addEventListener('click',()=>void refresh(true));
 el('permission-select').addEventListener('change',()=>{draftVersion=data?.permissionVersion||'';render();});
 el('permission-apply').addEventListener('click',()=>void mutate('/api/thread/permissions',{version:draftVersion,...choices[el('permission-select').value]},''));
 document.addEventListener('visibilitychange',()=>{if(Runtime.hidden)pause();else void refresh();});
 return {pause,refresh,update(next){
  const changed=next.threadId!==context.threadId||next.enabled!==context.enabled;
  const resume=paused;paused=false;
  if(changed){pause();data=null;lastCards='';draftVersion='';el('permission-select').value='';el('permission-note').textContent='';}
  context=next;paused=false;publish();render();
  if((changed||resume)&&active())void refresh();else if(!next.auto){clearTimeout(timer);timer=null;}else if(active()&&!timer&&!request&&!writing)schedule();
 }};
})();
