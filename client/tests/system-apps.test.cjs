const {test}=require('node:test'),assert=require('node:assert/strict');
const {openTailscale}=require('../web/system-apps.cjs');
test('installed Mac app opens locally with a fixed path, not a website',async()=>{
 let actual;await openTailscale({platform:'darwin',exists:p=>p==='/Applications/Tailscale.app',run:async(...args)=>{actual=args;}});
 assert.equal(actual[0],'/usr/bin/open');assert.deepEqual(actual[1],['/Applications/Tailscale.app']);
});
test('user Applications directory is supported and absence is explicit',async()=>{
 let actual;await openTailscale({platform:'darwin',home:'/Users/test',exists:p=>p==='/Users/test/Applications/Tailscale.app',run:async(...args)=>{actual=args;}});
 assert.deepEqual(actual[1],['/Users/test/Applications/Tailscale.app']);
 await assert.rejects(openTailscale({platform:'darwin',exists:()=>false,run:async()=>assert.fail('must not launch')}),/未找到/);
});
