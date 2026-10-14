/* All renderers are local. No model text is treated as executable HTML. */
const Rich = (() => {
 const make=(tag,cls,text)=>{const el=document.createElement(tag);if(cls)el.className=cls;if(text!==undefined)el.textContent=text;return el;};
 const escape=s=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const libraries=new Map(), pending=new Map();let serial=0, diagramChain=Promise.resolve();
 function script(name,path){
  if(!libraries.has(name))libraries.set(name,new Promise((resolve,reject)=>{const el=make('script');el.src=path;el.onload=resolve;el.onerror=()=>{el.remove();libraries.delete(name);reject(Error('加载失败，点击重试'));};document.head.append(el);}));
  return libraries.get(name);
 }
 function stylesheet(path){if(document.querySelector(`link[href="${path}"]`))return;const el=make('link');el.rel='stylesheet';el.href=path;document.head.append(el);}
 const observer=new IntersectionObserver(entries=>{for(const e of entries)if(e.isIntersecting&&!Runtime.hidden){const run=pending.get(e.target);pending.delete(e.target);observer.unobserve(e.target);if(e.target.isConnected)void run?.();}},{root:document.getElementById('scroll'),rootMargin:'160px'});
 function sweep(){for(const el of pending.keys())if(!el.isConnected){observer.unobserve(el);pending.delete(el);}}
 function clear(){observer.disconnect();pending.clear();for(const el of document.querySelectorAll('video,audio'))el.pause();}
 document.addEventListener('visibilitychange',()=>{if(Runtime.hidden){for(const el of document.querySelectorAll('video,audio'))el.pause();for(const el of document.querySelectorAll('[data-animated]'))el.dispatchEvent(new Event('stop-media'));}else{for(const el of pending.keys()){observer.unobserve(el);observer.observe(el);}}});
 function later(el,run){pending.set(el,run);observer.observe(el);}
 function safeURL(raw){try{if(/[\u0000-\u001f\u007f]/.test(raw)||raw.startsWith('//'))return null;const u=new URL(raw,(Runtime.origin||'http://localhost')+'/');if(!['http:','https:'].includes(u.protocol)||u.username||u.password)return null;return u;}catch{return null;}}
 function mediaURL(raw,context){if(/^[a-z]:[\\/]/i.test(raw)&&!/[\u0000-\u001f\u007f]/.test(raw))return '/api/media?'+new URLSearchParams({...context,path:raw});const u=safeURL(raw);if(!u)return null;if(/^https?:\/\//i.test(raw))return u.href;return '/api/media?'+new URLSearchParams({...context,path:raw});}
 // Markdown unescapes backslashes before punctuation (e.g. Windows \.config).
 // Preserve an explicitly written drive path, matching the server's reference check.
 function reference(token){
  const match=/!?\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|([^\s)]+))/.exec(token.raw||'');
  const raw=match?.[1]||match?.[2];
  return raw&&/^[a-z]:[\\/]/i.test(raw)?raw:token.href;
 }
 function media(raw,label,context){
  const box=make('span','media-card'),url=mediaURL(raw,context);
  if(!url){box.textContent=label+'（媒体地址不支持）';return box;}
  const ext=raw.split(/[?#]/)[0].toLowerCase(),video=/\.(mp4|webm|mov|m4v)$/.test(ext),audio=/\.(mp3|wav|ogg|m4a)$/.test(ext),animated=/\.gif$/.test(ext);
  const button=make('button','media-load',(video?'▶ 加载视频':audio?'▶ 加载音频':animated?'▶ 播放 GIF':'查看图片')+(label?' · '+label:''));button.type='button';
  const slot=make('span','media-slot');box.append(button,slot);
  if(video||audio){
   const download=make('button','media-load',audio?'下载音频':'下载视频');download.type='button';
   const status=make('span','fine');status.setAttribute('role','status');box.append(download,status);
   download.addEventListener('click',async()=>{
    download.disabled=true;status.textContent='正在准备下载…';
    try{status.textContent=await Runtime.downloadMedia(url,raw);}
    catch(error){status.textContent='下载失败：'+(error.message||String(error));}
    finally{download.disabled=false;}
   });
  }
  let loaded=false;
  const stop=()=>{slot.replaceChildren();loaded=false;button.textContent=(animated?'▶ 播放 GIF':'查看图片')+(label?' · '+label:'');};
  if(animated){box.dataset.animated='true';box.addEventListener('stop-media',stop);}
  button.addEventListener('click',()=>{
   if(loaded){if(animated){stop();return;}const img=slot.querySelector('img');if(img)openImage(img);return;}
   loaded=true;
   const el=make(video?'video':audio?'audio':'img');
   if(video||audio){el.controls=true;el.preload='metadata';if(video)el.playsInline=true;button.hidden=true;}
   else{el.alt=label||'聊天图片';el.decoding='async';el.loading='lazy';el.addEventListener('click',()=>openImage(el));button.textContent=animated?'停止 GIF':'放大图片';}
   el.addEventListener('error',event=>{loaded=false;const reason=event.detail?.message||({1:'加载已中断，请重试',2:'网络中断，请检查目标电脑连接后重试',3:'音频或视频解码失败，文件可能不完整',4:'媒体地址不可用，或浏览器不支持此格式'})[el.error?.code]||'附件加载失败，请检查目标电脑连接后重试';slot.replaceChildren(make('span','media-error','无法加载：'+reason));button.hidden=false;button.textContent='重试加载';},{once:true});
   const loading=video||audio?make('span','fine',audio?'正在加载音频…':'正在加载视频…'):null;
   if(loading){loading.setAttribute('role','status');el.addEventListener('loadedmetadata',()=>loading.remove(),{once:true});}
   slot.replaceChildren(...(loading?[loading,el]:[el]));Runtime.setMedia(el,url);
  });
  // Even static images are on-demand: opening a history never downloads large media.
  return box;
 }
 function openImage(img){
  const dialog=make('dialog','image-viewer');const close=make('button','','关闭');close.type='button';close.addEventListener('click',()=>dialog.close());const copy=make('img');copy.src=img.src;copy.alt=img.alt;dialog.append(close,copy);dialog.addEventListener('close',()=>dialog.remove());document.body.append(dialog);dialog.showModal();
 }
 async function copyCode(text,button){
  try{if(navigator.clipboard&&window.isSecureContext)await navigator.clipboard.writeText(text);else{const input=make('textarea');input.value=text;input.className='copy-buffer';document.body.append(input);input.select();const ok=document.execCommand('copy');input.remove();if(!ok)throw Error();}button.textContent='已复制';}catch{button.textContent='请长按代码复制';}
 }
 function codeBlock(code,lang){
  const box=make('div','code-block'),bar=make('div','code-toolbar'),copy=make('button','','复制');copy.type='button';copy.onclick=()=>copyCode(code,copy);bar.append(make('span','',lang||'代码'),copy);const pre=make('pre');pre.append(make('code','',code));box.append(bar,pre);
  if(lang==='mermaid'){
   const draw=make('button','','显示图表'),output=make('div','diagram-output');draw.type='button';bar.prepend(draw);box.append(output);
   draw.onclick=async()=>{
    if(output.childNodes.length){output.hidden=!output.hidden;pre.hidden=!output.hidden;draw.textContent=output.hidden?'显示图表':'查看源码';return;}
    if(code.length>16000){draw.textContent='图表较大，请在电脑查看';return;}
    draw.disabled=true;draw.textContent='绘制中…';
    try{
     await script('mermaid','/vendor/mermaid/mermaid.min.js');
     const run=async()=>{
      if(!box.isConnected)return;
      mermaid.initialize({startOnLoad:false,securityLevel:'strict',theme:'dark',htmlLabels:false,suppressErrorRendering:true,maxTextSize:16000,maxEdges:150,flowchart:{htmlLabels:false},secure:['securityLevel','startOnLoad','maxTextSize','maxEdges','suppressErrorRendering','htmlLabels','themeCSS','secure']});
      const {svg}=await mermaid.render('cr-diagram-'+(++serial),code);
      if(!box.isConnected)return;
      output.innerHTML=DOMPurify.sanitize(svg,{USE_PROFILES:{svg:true,svgFilters:true},FORBID_TAGS:['foreignObject','a','image'],FORBID_ATTR:['href','xlink:href']});
      const zoom=make('button','','放大');zoom.type='button';
      zoom.onclick=()=>{const svg=output.querySelector('svg');if(!svg)return;const expanded=output.classList.toggle('expanded');svg.style.width=expanded?Math.max(svg.viewBox.baseVal.width,600)+'px':'100%';zoom.textContent=expanded?'适应屏幕':'放大';};bar.append(zoom);
      pre.hidden=true;draw.textContent='查看源码';
     };
     const work=diagramChain.then(run);diagramChain=work.catch(()=>{});await work;
    }catch{draw.textContent='绘制失败，重试';}finally{draw.disabled=false;}
   };
  }
  return box;
 }
 function render(container,text,context){
  const body=make('div','message-text markdown');container.append(body);
  const slots=[];const placeholder=(kind,value,block=false)=>{const n=slots.push({kind,value})-1;return `<${block?'div':'span'} data-rich="${n}"></${block?'div':'span'}>`;};
  const parser=new marked.Marked({gfm:true,breaks:true,renderer:{
   html:token=>escape(token.text),
   checkbox:token=>token.checked?'☑ ':'☐ ',
   image:token=>placeholder('media',{raw:reference(token),label:token.text}),
   link:token=>placeholder('link',{raw:reference(token),label:token.text}),
   code:token=>placeholder('code',{code:token.text,lang:(token.lang||'').split(/\s/)[0].toLowerCase()},true)
  }});
  parser.use({extensions:[
   {name:'mathBlock',level:'block',start:src=>{const i=src.search(/\$\$|\\\[/);return i<0?undefined:i;},tokenizer(src){const m=/^(?:\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\])(?:\n|$)/.exec(src);if(m)return {type:'mathBlock',raw:m[0],text:m[1]??m[2]};},renderer:token=>placeholder('math',{text:token.text,display:true},true)},
   {name:'mathInline',level:'inline',start:src=>{const i=src.search(/\$|\\\(/);return i<0?undefined:i;},tokenizer(src){const m=/^(?:\\\(([^\n]+?)\\\)|\$(?!\s|\$)((?:\\.|[^$\n])+?[^\s$])\$(?!\d)|\$([^\s$])\$(?!\d))/.exec(src);if(m)return {type:'mathInline',raw:m[0],text:m[1]??m[2]??m[3]};},renderer:token=>placeholder('math',{text:token.text,display:false})}
  ]});
  try{body.innerHTML=DOMPurify.sanitize(parser.parse(text),{USE_PROFILES:{html:true},FORBID_TAGS:['style','input','form','img','video','audio'],FORBID_ATTR:['style','id','name']});}catch{body.textContent=text;return;}
  for(const el of body.querySelectorAll('[data-rich]')){
   const item=slots[Number(el.dataset.rich)];if(!item)continue;const v=item.value;
   if(item.kind==='code')el.replaceWith(codeBlock(v.code,v.lang));
   else if(item.kind==='media')el.replaceWith(media(v.raw,v.label,context));
   else if(item.kind==='link'){
    if(/\.(mp4|webm|mov|m4v|mp3|wav|ogg|m4a)(?:[?#]|$)/i.test(v.raw)){el.replaceWith(media(v.raw,v.label,context));continue;}
    const u=safeURL(v.raw);let link=make('a','',v.label);
    if(u&&/^https?:\/\//i.test(v.raw)){link.href=u.href;link.target='_blank';link.rel='noopener noreferrer';}
    else {link=undefined;}
    if(link)el.replaceWith(link);else el.replaceWith(make('span','local-reference',v.label+' ('+v.raw+')'));
   }else if(item.kind==='math'){
    el.className=v.display?'math-block':'math-inline';el.textContent=(v.display?'$$':'$')+v.text+(v.display?'$$':'$');
    later(el,async()=>{try{if(v.text.length>8000)return;stylesheet('/vendor/katex/katex.min.css');await script('katex','/vendor/katex/katex.min.js');if(el.isConnected)katex.render(v.text,el,{displayMode:v.display,throwOnError:false,trust:false,maxExpand:300,maxSize:20,strict:'ignore',output:'htmlAndMathml'});}catch{/* Keep readable TeX. */}});
   }
  }
  for(const table of body.querySelectorAll('table')){const wrap=make('div','table-scroll');wrap.tabIndex=0;wrap.setAttribute('aria-label','表格，可横向滚动');table.replaceWith(wrap);wrap.append(table);}
 }
 return {render,sweep,clear};
})();
