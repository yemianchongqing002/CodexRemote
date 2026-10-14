'use strict';
// One transport owner per web host. HTTP and SSH use the same route decision.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const {EmbeddedTailscale, tailnetHost} = require('./embedded-tailscale.cjs');
const exec = promisify(execFile);

function reduceStatus(raw) {
 const self = {...raw.Self, TailscaleIPs:raw.Self?.TailscaleIPs?.length ? raw.Self.TailscaleIPs : raw.TailscaleIPs};
 const seen = new Set();
 const peers = [{...self,isSelf:true}, ...Object.values(raw.Peer || {})].map(p => ({
  name:p.HostName || (p.isSelf ? '本机' : ''), dns:(p.DNSName || '').replace(/\.$/, ''),
  address:(p.TailscaleIPs || [])[0], os:p.OS || '', online:p.isSelf ? raw.BackendState === 'Running' : !!p.Online,
  ssh:!!p.sshHostKeys?.length, isSelf:!!p.isSelf,
 })).filter(p => {if (!p.address || seen.has(p.address)) return false; seen.add(p.address); return true;})
 .sort((a,b) => Number(b.isSelf)-Number(a.isSelf) || Number(b.online)-Number(a.online));
 return {installed:true,state:raw.BackendState,ips:raw.TailscaleIPs || [],peers};
}
async function systemStatus() {
 const candidates = [process.platform === 'win32' ? path.join(process.env.ProgramFiles || 'C:\\Program Files','Tailscale','tailscale.exe') : '/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/opt/homebrew/bin/tailscale','/usr/local/bin/tailscale','tailscale'];
 let installed = false;
 for (const executable of new Set(candidates)) {
  try {const {stdout} = await exec(executable,['status','--json'],{timeout:5000,maxBuffer:1024*1024,windowsHide:true}); return reduceStatus(JSON.parse(stdout));}
  catch (error) {if(error.code !== 'ENOENT') installed = true;}
 }
 return {installed,state:installed ? 'Unavailable' : 'NotInstalled',ips:[],peers:[]};
}
class Network {
 constructor({embedded = new EmbeddedTailscale(), detect = systemStatus, restore = false} = {}) {
  this.trust=new (require('./trust.cjs').Trust)(this.dial.bind(this));
  this.embedded = embedded; this.detect = detect; this.mode = 'auto'; this.detection = null; this.lastSystem=null; this.checkedAt=0;
  if(restore && embedded.available() && fs.existsSync(path.join(embedded.dir,'tailscaled.state'))) embedded.start().catch(()=>console.warn('内嵌服务入口启动失败'));
 }
 async system() {
  if(this.lastSystem && Date.now()-this.checkedAt<2000)return this.lastSystem;
  if(!this.detection) this.detection = this.detect().then(status=>{this.lastSystem=status;this.checkedAt=Date.now();return status;}).finally(()=>{this.detection = null;});
  return this.detection;
 }
 async route(host) {
  if(host !== undefined && !tailnetHost(host)) return {source:'system'};
  const system = this.mode === 'embedded' ? null : await this.system();
  const source = this.mode === 'auto' ? (!system.installed && this.embedded.available() ? 'embedded' : 'system') : this.mode;
  return {source,system};
 }
 async status() {
  const {source,system} = await this.route();
  if(source==='system') return {...system,source,embeddedAvailable:this.embedded.available()};
  const raw = await this.embedded.status(); let authUrl = '';
  try {const url = new URL(raw.AuthURL); if(url.protocol === 'https:' && url.hostname === 'login.tailscale.com') authUrl = url.href;} catch {}
  return {...reduceStatus(raw),source:'embedded',embeddedAvailable:true,authUrl};
 }
 async setMode(mode) {
  if(!['auto','system','embedded'].includes(mode)) throw Error('无效网络模式');
  if(mode === 'embedded' && !this.embedded.available()) throw Error('此构建未包含内嵌网络');
  const previous=this.mode;this.mode = mode;this.lastSystem=null;
  // Outbound selection never tears down the shared inbound node.
  try{return await this.status();}catch(error){this.mode=previous;throw error;}
 }
 async login() {
  if((await this.route()).source!=='embedded') throw Error('请在系统 Tailscale 中登录');
  return this.embedded.login();
 }
 async fetch(url, options) {
  if(new URL(url).protocol==='https:')return this.trust.fetch(url,options);
  return (await this.route(new URL(url).hostname)).source==='embedded' ? this.embedded.fetch(url,options) : fetch(url,options);
 }
 async dial(host, port) {
  return (await this.route(host)).source==='embedded' ? this.embedded.dial(host,port) : net.createConnection({host,port});
 }
 close() {void this.trust.close();this.embedded.close();}
}
module.exports = {Network, systemStatus, reduceStatus};
