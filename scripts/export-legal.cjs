'use strict';
const fs=require('node:fs'),path=require('node:path'),legal=require('../client/ui/legal.js');
function validate(){
 if(!legal.published||!/^\S+@\S+\.\S+$/.test(legal.supportEmail))throw Error('发布前请补全并核准 legal.js 中的联系邮箱和政策发布状态。');
 if(legal.licenseType==='apple-standard'&&legal.termsURL!=='https://www.apple.com/legal/internet-services/itunes/dev/stdeula/')throw Error('苹果标准许可协议链接不正确。');
 for(const key of legal.licenseType==='apple-standard'?['privacyURL']:['privacyURL','termsURL']){const u=new URL(legal[key]);if(u.protocol!=='https:'||u.username||u.password)throw Error('正式政策地址必须是 HTTPS 公共地址。');}
}
function exportFiles(out){
 const escape=v=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 fs.mkdirSync(out,{recursive:true});
 for(const [file,title,sections] of [['terms','用户协议',legal.terms],['privacy','隐私政策',legal.privacy]]){
  const content='<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>'+title+'</title><main><h1>'+title+'</h1><p>版本 '+escape(legal.version)+'</p><p>'+escape(legal.operator)+'</p>'+sections.map(([h,p])=>'<h2>'+escape(h)+'</h2><p>'+escape(p)+'</p>').join('')+'<p>'+escape(legal.published?'联系：'+legal.supportEmail:'测试草稿，公开地址与联系方式尚未核准，不用于正式上架。')+'</p>'+(file==='terms'&&legal.licenseType==='apple-standard'?'<p><a href="'+escape(legal.termsURL)+'">苹果标准许可协议（EULA）完整条款</a></p>':'')+'</main></html>';
  fs.writeFileSync(path.join(out,file+'.html'),content);
 }
}
if(require.main===module){try{if(process.argv[2]==='--check')validate();else exportFiles(path.resolve(__dirname,'../dist/legal'));}catch(e){console.error(e.message);process.exitCode=1;}}
module.exports={validate,exportFiles};
