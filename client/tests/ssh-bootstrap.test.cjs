const {test}=require('node:test'),assert=require('node:assert/strict'),net=require('node:net');
const {sshStatus}=require('../web/ssh-bootstrap.cjs');
test('SSH detection checks the server banner rather than treating any open port as SSH',async()=>{
 for(const [banner,expected] of [['SSH-2.0-OpenSSH_for_Windows_9.5\r\n','available'],['HTTP/1.1 200 OK\r\n','unavailable']]){
  const server=net.createServer(s=>s.end(banner));await new Promise(r=>server.listen(0,'127.0.0.1',r));
  try{const result=await sshStatus({address:'http://127.0.0.1:8787',port:server.address().port});assert.equal(result.state,expected);}finally{await new Promise(r=>server.close(r));}
 }
 assert.throws(()=>sshStatus({address:'http://user:secret@localhost',port:22}));
 assert.throws(()=>sshStatus({address:'http://localhost',port:0}));
});
