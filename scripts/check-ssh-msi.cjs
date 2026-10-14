const {execFileSync}=require('node:child_process'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..'),dir=path.join(root,'dist/ssh-setup'),msi=path.join(dir,'CodexRemote-EnableSSH-x64.msi');
const info=process.env.MSIINFO_BINARY||'msiinfo',extract=process.env.MSIEXTRACT_BINARY||'msiextract';
function table(name){return execFileSync(info,['export',msi,name],{encoding:'utf8'}).trim().split(/\r?\n/).slice(3).map(l=>l.split('\t'));}
const ca=table('CustomAction').find(r=>r[0]==='EnableSSH');
assert.equal(Number(ca[1]),3090,'deferred, non-impersonated EXE custom action must check exit status');assert.equal(ca[2],'SSHSetupExe');assert.equal(ca[3],'--enable-ssh');
const sequence=new Map(table('InstallExecuteSequence').map(r=>[r[0],r]));
assert.ok(Number(sequence.get('EnableSSH')[2])>Number(sequence.get('InstallFiles')[2]));
assert.ok(Number(sequence.get('EnableSSH')[2])<Number(sequence.get('InstallFinalize')[2]));
assert.equal(sequence.get('EnableSSH')[1],'NOT Installed AND NOT REMOVE');
assert.equal(table('Property').find(r=>r[0]==='ALLUSERS')[1],'1');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'cr-msi-check-'));
try{
 execFileSync(extract,['-C',temp,msi]);
 const files=fs.readdirSync(temp,{recursive:true}).filter(p=>p.endsWith('codex-remote.exe'));assert.equal(files.length,1);
 const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
 assert.equal(hash(path.join(temp,files[0])),hash(path.join(dir,'codex-remote.exe')));
 console.log('MSI verified: machine installation, elevated action after file installation, checked result, matching executable payload.');
}finally{fs.rmSync(temp,{recursive:true,force:true});}
