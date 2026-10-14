'use strict';
const PermissionMenu=(()=>{
 const trigger=document.getElementById('permission-select');
 const svg=path=>`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
 const hand=svg('<path d="M8 12V5a1.5 1.5 0 0 1 3 0v6m0-6V3a1.5 1.5 0 0 1 3 0v8m0-6a1.5 1.5 0 0 1 3 0v7m0-4a1.5 1.5 0 0 1 3 0v6c0 5-2.5 8-6 8-3 0-5-2-6-4l-3-5a1.6 1.6 0 0 1 2.6-1.8L8 13"/>');
 const shield=svg('<path d="m12 3 8 3v6c0 5-4 8-8 10-4-2-8-5-8-10V6l8-3Z"/><path d="M9 11h.01M15 11h.01m-6 4c1.5 1.3 4.5 1.3 6 0"/>');
 const full=svg('<path d="m12 3 8 3v6c0 5-4 8-8 10-4-2-8-5-8-10V6l8-3Z"/><path d="M12 8v5m0 4h.01"/>');
 const lock=svg('<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V6a4 4 0 0 1 8 0v4"/>');
 const choices=[{settings:{approvalPolicy:'on-request',approvalsReviewer:'user',permissions:':workspace'},label:'请求批准',description:'编辑外部文件和使用互联网时始终询问',icon:hand},{settings:{approvalPolicy:'on-request',approvalsReviewer:'auto_review',permissions:':workspace'},label:'帮我批准',description:'仅对检测到的风险操作请求批准',icon:shield},{settings:{approvalPolicy:'never',approvalsReviewer:'user',permissions:':danger-full-access'},label:'完全访问权限',description:'可不受限制地访问互联网和你电脑上的任何文件',icon:full}];
 const menu=document.createElement('div');menu.id='permission-menu';menu.className='permission-menu';menu.setAttribute('popover','auto');menu.hidden=true;
 const header=document.createElement('div');header.className='permission-menu-header';
 const heading=document.createElement('span');heading.textContent='应如何批准 ChatGPT 操作？';
 const help=document.createElement('button');help.type='button';help.className='permission-learn';help.textContent='了解更多';help.setAttribute('aria-expanded','false');help.setAttribute('aria-controls','permission-help');header.append(heading,help);menu.append(header);
 const list=document.createElement('div');list.setAttribute('role','menu');list.setAttribute('aria-label','会话访问权限');menu.append(list);
 const buttons=choices.map(choice=>{
  const button=document.createElement('button');button.type='button';button.className='permission-option';button.dataset.reviewer=choice.settings.approvalsReviewer;button.dataset.permissions=choice.settings.permissions;button.setAttribute('role','menuitemradio');button.setAttribute('aria-checked','false');
  button.innerHTML=choice.icon;
  const text=document.createElement('span');text.className='permission-option-text';const label=document.createElement('span');label.className='permission-option-label';label.textContent=choice.label;const description=document.createElement('span');description.className='permission-option-description';description.textContent=choice.description;text.append(label,description);button.append(text);
  const check=document.createElement('span');check.className='permission-check';check.innerHTML=svg('<path d="m6 12 4 4 8-10"/>');button.append(check);
  button.addEventListener('click',()=>{const unchanged=button.getAttribute('aria-checked')==='true';close(true);if(unchanged||trigger.disabled)return;trigger.dispatchEvent(new CustomEvent('permission-change',{detail:{...choice.settings}}));});list.append(button);return button;
 });
 const note=document.createElement('p');note.id='permission-scope-note';note.className='permission-help';note.textContent='在此设置会话默认审批模式，对后续轮次生效；Codex 桌面选项不会同步修改。';menu.append(note);
 const info=document.createElement('p');info.id='permission-help';info.className='permission-help';info.hidden=true;info.textContent='请求批准：由你确认超出工作区或联网的操作。帮我批准：由 Codex 自动审查风险，需要时向你请求批准。完全访问权限：允许访问全部文件和网络，执行操作不再逐项询问。修改会话审批模式不会改变 Codex 桌面选择，后续桌面操作可能覆盖会话设置。';menu.append(info);document.body.append(menu);
 help.addEventListener('click',()=>{info.hidden=!info.hidden;help.setAttribute('aria-expanded',String(!info.hidden));place();});
 function place(){const r=trigger.getBoundingClientRect(),box=menu.getBoundingClientRect();menu.style.left=Math.max(8,Math.min(innerWidth-box.width-8,r.left))+'px';menu.style.top=Math.max(8,r.top-box.height-8>=8?r.top-box.height-8:Math.min(innerHeight-box.height-8,r.bottom+8))+'px';}
 function close(focus=false){if(menu.matches(':popover-open'))menu.hidePopover();menu.hidden=true;trigger.setAttribute('aria-expanded','false');if(focus)trigger.focus();}
 function open(last=false){if(trigger.disabled)return;menu.hidden=false;menu.showPopover();info.hidden=true;help.setAttribute('aria-expanded','false');trigger.setAttribute('aria-expanded','true');place();(last?buttons.at(-1):buttons.find(b=>b.getAttribute('aria-checked')==='true')||buttons[0]).focus();}
 trigger.addEventListener('click',()=>menu.hidden?open():close());
 trigger.addEventListener('keydown',e=>{if(['ArrowDown','ArrowUp'].includes(e.key)){e.preventDefault();open(e.key==='ArrowUp');}});
 menu.addEventListener('keydown',e=>{
  if(e.key==='Escape'){e.preventDefault();close(true);return;}
  const index=buttons.indexOf(document.activeElement);
  if(index>=0&&['ArrowDown','ArrowUp','Home','End'].includes(e.key)){e.preventDefault();buttons[e.key==='Home'?0:e.key==='End'?buttons.length-1:(index+(e.key==='ArrowDown'?1:buttons.length-1))%buttons.length].focus();}
 });
 menu.addEventListener('toggle',e=>{if(e.newState==='closed'){menu.hidden=true;trigger.setAttribute('aria-expanded','false');}});
 menu.addEventListener('focusout',e=>{if(e.relatedTarget&&!menu.contains(e.relatedTarget)&&e.relatedTarget!==trigger)close();});
 window.addEventListener('resize',()=>close());document.addEventListener('scroll',e=>{if(!menu.contains(e.target))close();},true);
 function matches(actual, choice){
  const reviewer=actual?.approvalsReviewer==='guardian_subagent'?'auto_review':actual?.approvalsReviewer;
  return actual?.approvalPolicy===choice.approvalPolicy && reviewer===choice.approvalsReviewer && actual?.activePermissionProfile?.id===choice.permissions;
 }
 return {update(settings,locked){
  const selected=choices.find(c=>matches(settings,c.settings));
  const current=selected||(settings?.approvalPolicy&&settings?.sandboxPolicy?{label:settings.activePermissionProfile?.id===':read-only'?'只读':'自定义权限',icon:lock}:null);
  trigger.hidden=!current;trigger.disabled=locked;
  if(current){document.getElementById('permission-trigger-label').textContent=current.label;document.getElementById('permission-trigger-icon').innerHTML=current.icon;const desktop=({'auto':'请求批准','granular':'请求批准','guardian-approvals':'帮我批准','full-access':'完全访问权限','read-only':'只读'})[settings?.permissionSelection?.agentMode];trigger.title='会话审批模式：'+current.label+(desktop?'；Codex 桌面选择：'+desktop:'')+'。修改会话模式不会改变桌面选择。';}
  for(let i=0;i<buttons.length;i++){const button=buttons[i],checked=choices[i]===selected;button.setAttribute('aria-checked',String(checked));button.tabIndex=checked?0:-1;button.disabled=locked;}
  if(locked||!current)close();
 }};
})();
