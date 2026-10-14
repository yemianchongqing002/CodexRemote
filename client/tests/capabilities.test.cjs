const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../..');
test('webview permissions contain no remote origins or general native filesystem access',()=>{
 const capability=JSON.parse(fs.readFileSync(path.join(root,'client/src-tauri/capabilities/main.json')));
 assert(!capability.remote);assert.deepEqual(capability.permissions,['core:default']);
});
