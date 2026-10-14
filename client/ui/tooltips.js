'use strict';
(() => {
 const tip=document.createElement('div');
 tip.id='client-tooltip';tip.className='client-tooltip';tip.role='tooltip';tip.hidden=true;
 tip.setAttribute('popover','manual');document.body.append(tip);
 let target=null,timer=null,previousDescription=null;
 // Convert native titles, including later updates, so the browser cannot show a second tooltip.
 function convert(element){
  if(!element.hasAttribute('title'))return;
  element.dataset.tooltip=element.getAttribute('title');element.removeAttribute('title');
 }
 function scan(root){if(root.nodeType!==1)return;convert(root);root.querySelectorAll('[title]').forEach(convert);}
 document.querySelectorAll('[title]').forEach(convert);
 new MutationObserver(records=>{
  for(const record of records){
   if(record.type==='attributes')convert(record.target);
   else record.addedNodes.forEach(scan);
  }
  if(target&&(!target.isConnected||!target.dataset.tooltip))hide();
  else if(target&&!tip.hidden&&tip.textContent!==target.dataset.tooltip){tip.textContent=target.dataset.tooltip;place();}
 }).observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['title']});
 function place(){
  const r=target.getBoundingClientRect(),box=tip.getBoundingClientRect();
  tip.style.left=Math.max(8,Math.min(innerWidth-box.width-8,r.left+(r.width-box.width)/2))+'px';
  tip.style.top=Math.max(8,r.top-box.height-8>=8?r.top-box.height-8:Math.min(innerHeight-box.height-8,r.bottom+8))+'px';
 }
 function hide(){
  clearTimeout(timer);timer=null;
  if(target&&previousDescription!==null){
   if(previousDescription)target.setAttribute('aria-describedby',previousDescription);else target.removeAttribute('aria-describedby');
  }
  previousDescription=null;target=null;
  if(tip.hidePopover&&tip.matches(':popover-open'))tip.hidePopover();tip.hidden=true;
 }
 function begin(element){
  if(element===target)return;hide();if(!element?.dataset.tooltip)return;target=element;
  timer=setTimeout(()=>{
   if(!target?.isConnected)return hide();
   tip.textContent=target.dataset.tooltip;tip.hidden=false;
   if(tip.showPopover)tip.showPopover();else (target.closest('dialog')||document.body).append(tip);
   previousDescription=target.getAttribute('aria-describedby')||'';
   target.setAttribute('aria-describedby',[previousDescription,tip.id].filter(Boolean).join(' '));place();
  },1300);
 }
 document.addEventListener('pointerover',e=>{if(e.pointerType!=='touch')begin(e.target.closest('[data-tooltip]'));});
 document.addEventListener('pointerout',e=>{if(target&&!target.contains(e.relatedTarget))hide();});
 document.addEventListener('focusin',e=>begin(e.target.closest('[data-tooltip]')));
 document.addEventListener('focusout',hide);
 document.addEventListener('pointerdown',hide,true);
 document.addEventListener('keydown',e=>{if(e.key==='Escape')hide();});
 document.addEventListener('scroll',hide,true);window.addEventListener('resize',hide);window.addEventListener('blur',hide);
 document.addEventListener('visibilitychange',()=>{if(document.hidden)hide();});
})();
