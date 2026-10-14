const {test}=require('node:test'),assert=require('node:assert/strict');
const {create,sensitive}=require('../ui/consent-store.js');
function storage(){const data=new Map();return {getItem:k=>data.get(k),setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k)};}
test('first launch requires explicit acceptance; read-only acceptance is independent of AI permission',()=>{
 const s=storage(),c=create(s,'v1');assert.equal(c.read(),null);c.accept(false);assert.equal(c.read().ai,false);assert.throws(()=>c.grant('https://one','a'));assert(!c.allows('https://one','a'));
});
test('consent survives restarts but not recipient changes, a different server, policy updates or revocation',()=>{
 const s=storage(),c=create(s,'v1');c.accept(true);c.grant('https://one','a');const next=create(s,'v1');assert(next.allows('https://one','a'));assert(!next.allows('https://two','a'));assert(!next.allows('https://one','b'));assert.equal(create(s,'v2').read(),null);next.revoke();assert(!c.allows('https://one','a'));assert.equal(c.read().accepted,true);
 c.accept(true);c.grant('https://one','a');c.forget('https://one');assert(!c.allows('https://one','a'));
});
test('invalid records and failed persistence do not grant consent',()=>{
 const s=storage();s.setItem('cr-consent-v1','bad');assert.equal(create(s,'v1').read(),null);
 const c=create({...s,setItem(){throw Error('disk full');}},'v1');assert.throws(()=>c.accept(true));assert.equal(c.read(),null);
});
test('every data transmission entry point is gated; reading and cancelling remain available',()=>{
 for(const p of ['/api/send','/api/thread/create','/api/upload-file?name=a','/api/upload-image','/api/queue/steer','/api/thread/approval'])assert(sensitive(p,'POST'),p);
 for(const p of ['/api/status','/api/media','/api/privacy'])assert(!sensitive(p,'GET'));
 assert(!sensitive('/api/queue/cancel','POST'));assert(!sensitive('/api/logout','POST'));
});
