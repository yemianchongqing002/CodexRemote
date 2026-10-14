'use strict';
window.ClientConsent=(()=>{
 const el=id=>document.getElementById(id),store=ConsentStore.create(localStorage,LegalDocuments.version);
 let resolveReady,generation=0,pending=null;
 const ready=new Promise(resolve=>{resolveReady=resolve;});
 const startup=el('consent-dialog'),privacy=el('privacy-dialog'),recipient=el('recipient-dialog');
 function documents(root){
  for(const [title,sections] of [['用户协议',LegalDocuments.terms],['隐私政策',LegalDocuments.privacy]]){
   const details=document.createElement('details'),summary=document.createElement('summary');summary.textContent=title+'（'+LegalDocuments.version+'）';details.append(summary);
   for(const [heading,text] of sections){const h=document.createElement('h3'),p=document.createElement('p');h.textContent=heading;p.textContent=text;details.append(h,p);}root.append(details);
  }
  const status=document.createElement('p');status.className='fine';status.textContent=LegalDocuments.published?'隐私联系：'+LegalDocuments.supportEmail:'本地测试版：公开政策地址和隐私联系邮箱待运营方补全，上架材料尚未完成。';root.append(status);
  for(const [title,url] of [['公开隐私政策',LegalDocuments.privacyURL],[LegalDocuments.licenseType==='apple-standard'?'苹果标准许可协议（EULA）':'公开用户协议',LegalDocuments.termsURL]])if(/^https:\/\//.test(url)){const link=document.createElement('a');link.href=url;link.textContent=title;link.target='_blank';link.rel='noopener noreferrer';root.append(link);}
 }
 documents(el('consent-documents'));documents(el('privacy-documents'));
 function showStartup(){el('consent-terms').checked=false;el('consent-ai').checked=false;el('consent-continue').disabled=true;el('consent-note').textContent='';if(!startup.open)startup.showModal();}
 startup.addEventListener('cancel',e=>e.preventDefault());
 el('consent-terms').addEventListener('change',()=>{el('consent-continue').disabled=!el('consent-terms').checked;});
 el('consent-form').addEventListener('submit',e=>{
  e.preventDefault();if(!el('consent-terms').checked)return;
  try{store.accept(el('consent-ai').checked);generation++;startup.close();resolveReady();}catch{el('consent-note').textContent='无法保存确认记录，请检查本机存储权限。';}
 });
 el('consent-decline').addEventListener('click',()=>{el('consent-note').textContent='未同意，连接和数据传输尚未开始。你可以关闭应用，或阅读后再作决定。';});
 function status(){const r=store.read();el('privacy-consent-status').textContent=r?'已确认版本 '+r.version+'；AI 数据共享：'+(r.ai?'允许（仅限已确认接收方）':'未允许'):'尚未确认协议';}
 document.querySelectorAll('[data-privacy]').forEach(button=>button.addEventListener('click',()=>{status();if(!privacy.open)privacy.showModal();}));
 el('privacy-revoke').addEventListener('click',()=>{try{store.revoke();generation++;if(pending){pending(false);pending=null;recipient.close();}status();el('privacy-consent-status').textContent+='。已阻止后续共享；已提交的远端任务不会自动取消。';}catch{el('privacy-consent-status').textContent='撤回未保存，请关闭应用并检查存储权限。';}});
 el('privacy-review').addEventListener('click',()=>{privacy.close();showStartup();});
 function finish(allow){if(pending){const done=pending;pending=null;recipient.close();done(allow);}}
 recipient.addEventListener('cancel',e=>{e.preventDefault();finish(false);});
 el('recipient-deny').addEventListener('click',()=>finish(false));
 el('recipient-check').addEventListener('change',()=>{el('recipient-allow').disabled=!el('recipient-check').checked;});
 el('recipient-allow').addEventListener('click',()=>{if(el('recipient-check').checked)finish(true);});
 async function authorize(origin,disclosure){
  await ready;
  if(!store.read()?.ai)throw Error('AI 数据共享未开启，请在“用户协议与隐私政策”中查看并选择。');
  if(disclosure?.schemaVersion!==1||!disclosure.configured||typeof disclosure.purpose!=='string'||!disclosure.purpose.trim()||!Array.isArray(disclosure.recipients)||!disclosure.recipients.length||disclosure.recipients.length>16||!/^([a-f0-9]{64})$/.test(disclosure.revision||''))throw Error('此服务器尚未提供完整的 AI 接收方说明，请联系服务器管理员配置；仍可浏览已有会话。');
  const current=generation;
  if(store.allows(origin,disclosure.revision))return current;
  if(pending)throw Error('请先完成正在显示的数据共享确认。');
  el('recipient-origin').textContent=origin;el('recipient-purpose').textContent=disclosure.purpose;
  const list=el('recipient-list');list.replaceChildren();
  for(const r of disclosure.recipients){if(typeof r.name!=='string'||!r.name.trim())throw Error('服务器接收方名称无效');const item=document.createElement('li'),link=document.createElement('a');link.textContent=r.name+'：隐私政策';let u;try{u=new URL(r.privacyURL);}catch{throw Error('服务器隐私政策地址无效');}if(u.protocol!=='https:'||u.username||u.password)throw Error('服务器隐私政策地址无效');link.href=u.href;link.target='_blank';link.rel='noopener noreferrer';item.append(link);list.append(item);}
  el('recipient-check').checked=false;el('recipient-allow').disabled=true;
  const accepted=await new Promise(resolve=>{pending=resolve;recipient.showModal();});
  if(!accepted||generation!==current)throw Error('未允许此次数据共享，内容没有发送。');
  store.grant(origin,disclosure.revision);return current;
 }
 function assertCurrent(value){if(value!==generation||!store.read()?.ai)throw Error('数据共享许可已撤回，内容没有发送。');}
 if(store.read())resolveReady();else showStartup();
 return {ready,authorize,assertCurrent,forget:origin=>store.forget(origin)};
})();

window.resolveClientConsentBoot(window.ClientConsent.ready);
