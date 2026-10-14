'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFile,spawn} = require('node:child_process');
const {promisify} = require('node:util');
const exec = promisify(execFile);
// Fixed application paths only; no command or path supplied by the web page.
async function openTailscale({platform=process.platform,home=os.homedir(),programFiles=process.env.ProgramFiles||'C:\\Program Files',exists=fs.existsSync,run=exec,launch=spawn}={}) {
 if(platform==='darwin') {
  const app=['/Applications/Tailscale.app',path.join(home,'Applications/Tailscale.app')].find(exists);
  if(!app)throw Error('网页服务所在电脑未找到 Tailscale 应用，请先安装。');
  await run('/usr/bin/open',[app],{timeout:5000});
 } else if(platform==='win32') {
  const app=path.join(programFiles,'Tailscale','tailscale-ipn.exe');
  if(!exists(app))throw Error('网页服务所在电脑未找到 Tailscale 应用，请先安装。');
  await new Promise((resolve,reject)=>{const child=launch(app,[],{detached:true,stdio:'ignore',windowsHide:false});child.once('error',reject);child.once('spawn',()=>{child.unref();resolve();});});
 } else throw Error('请在运行网页服务的电脑上手动打开 Tailscale。');
 return {opened:true};
}
module.exports={openTailscale};
