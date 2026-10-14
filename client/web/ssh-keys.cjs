// Private keys remain on the web-client host. Only public metadata crosses the bridge.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {utils}=require('ssh2');
const defaultRoot=path.join(os.homedir(),'.config','codex-remote','ssh-keys');
function createKeyStore(root=defaultRoot){
 const id=t=>crypto.createHash('sha256').update(JSON.stringify([t.host.toLowerCase(),t.port,t.username])).digest('hex');
 const file=t=>path.join(root,'id_'+id(t));
 function ensure(t){
  fs.mkdirSync(root,{recursive:true,mode:0o700});fs.chmodSync(root,0o700);
  const filename=file(t);
  if(!fs.existsSync(filename)){
   const pair=utils.generateKeyPairSync('ed25519',{comment:'CodexRemote'});
   try{fs.writeFileSync(filename,pair.private,{mode:0o600,flag:'wx'});}catch(e){if(e.code!=='EEXIST')throw e;}
  }
  const info=fs.lstatSync(filename);if(!info.isFile()||info.isSymbolicLink())throw Error('SSH 私钥文件无效');
  fs.chmodSync(filename,0o600);
  const parsed=utils.parseKey(fs.readFileSync(filename));if(parsed instanceof Error)throw Error('SSH 私钥无法读取');
  const bytes=parsed.getPublicSSH(),publicKey=parsed.type+' '+bytes.toString('base64')+' CodexRemote';
  return {path:filename,publicKey,fingerprint:'SHA256:'+crypto.createHash('sha256').update(bytes).digest('base64').replace(/=+$/,'')};
 }
 function mark(t,key){
  const row={host:t.host,port:t.port,username:t.username,path:key.path,publicKey:key.publicKey,fingerprint:key.fingerprint,verifiedAt:new Date().toISOString()};
  const temp=file(t)+'.json.tmp';fs.writeFileSync(temp,JSON.stringify(row),{mode:0o600});fs.renameSync(temp,file(t)+'.json');return row;
 }
 function list(){
  if(!fs.existsSync(root))return [];
  return fs.readdirSync(root).filter(n=>/^id_[a-f0-9]{64}\.json$/.test(n)).flatMap(n=>{try{return [JSON.parse(fs.readFileSync(path.join(root,n),'utf8'))];}catch{return [];}});
 }
 return {ensure,mark,list,file,root};
}
function authorizationScript(platform,publicKey){
 const encoded=Buffer.from(publicKey+'\n').toString('base64');
 if(platform==='darwin')return `set -eu
umask 077
[ ! -L "$HOME/.ssh" ] && [ ! -L "$HOME/.ssh/authorized_keys" ] || { echo 'SSH 授权路径不能是符号链接' >&2; exit 1; }
mkdir -p "$HOME/.ssh"
chmod 700 "$HOME/.ssh"
touch "$HOME/.ssh/authorized_keys"
chmod 600 "$HOME/.ssh/authorized_keys"
key=$(printf '%s' '${encoded}' | /usr/bin/base64 -D)
if ! /usr/bin/grep -qxF "$key" "$HOME/.ssh/authorized_keys"; then printf '\\n%s\\n' "$key" >> "$HOME/.ssh/authorized_keys"; fi
`;
 return `$ErrorActionPreference='Stop'
$key=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')).Trim()
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$principal=New-Object Security.Principal.WindowsPrincipal($identity)
$admin=$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$file=if($admin){Join-Path $env:ProgramData 'ssh\\administrators_authorized_keys'}else{Join-Path $HOME '.ssh\\authorized_keys'}
$dir=Split-Path $file
New-Item -ItemType Directory -Force $dir | Out-Null
if((Test-Path $file) -and ((Get-Item $file).Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'SSH 授权文件不能是链接'}
if(!(Test-Path $file) -or !(@(Get-Content $file) -contains $key)){[IO.File]::AppendAllText($file,([Environment]::NewLine+$key+[Environment]::NewLine),(New-Object Text.UTF8Encoding($false)))}
if($admin){ & icacls.exe $file /inheritance:r /grant:r '*S-1-5-32-544:F' '*S-1-5-18:F' | Out-Null }else{ & icacls.exe $file /inheritance:r /grant:r ($identity.Name+':F') '*S-1-5-18:F' | Out-Null }
if($LASTEXITCODE -ne 0){throw '无法设置 SSH 公钥文件权限'}
`;
}
module.exports={createKeyStore,authorizationScript};
