/* Same-origin runtime for the Go service's standalone web page. */
const Runtime = (() => {
 function storage(kind) { return kind === 'local' ? localStorage : sessionStorage; }
 function request(path, options = {}) {
  return fetch(path, {...options, cache: 'no-store', credentials: 'same-origin'});
 }
 function events(path) { return new EventSource(path); }
 function setMedia(element, path) { element.src = path; }
 async function downloadMedia(path,raw) {
  if(!path.startsWith('/api/')){window.open(path,'_blank','noopener,noreferrer');return '已打开原始媒体，可在该页面保存';}
  const response=await request(path);
  if(!response.ok)throw Error(`媒体请求失败（HTTP ${response.status}）`);
  const blob=await response.blob();
  if(!/^(audio|video)\//.test(blob.type)&&blob.type!=='application/ogg')throw Error('返回内容不是音频或视频');
  let filename=raw.split(/[?#]/)[0].split(/[\\/]/).pop()||'media';
  try{filename=decodeURIComponent(filename);}catch{}
  filename=filename.replace(/[<>:"/\\|?*\x00-\x1f]/g,'_');
  const url=URL.createObjectURL(blob),link=document.createElement('a');
  link.href=url;link.download=filename;document.body.append(link);link.click();link.remove();
  setTimeout(()=>URL.revokeObjectURL(url),60000);return '已交给浏览器下载';
 }
 return {storage, request, events, setMedia, downloadMedia,
  get hidden() { return document.hidden; },
  get origin() { return location.origin; },
  get host() { return location.host; }};
})();
