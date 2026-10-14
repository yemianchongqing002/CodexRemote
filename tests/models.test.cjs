const {test} = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const vm = require('node:vm');
const {join} = require('node:path');

test('recorded models follow the selected thread without becoming send overrides', async () => {
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      textContent:'', value:'', open:false, style:{}, handlers:{},
      addEventListener(name, fn){this.handlers[name]=fn;},
      setAttribute(){}, classList:{toggle(){}}, append(){}, replaceChildren(){},
      getBoundingClientRect(){return {top:100,right:300};},
      showModal(){this.open=true;}, close(){this.open=false;}
    });
    return elements.get(id);
  }
  const saved = new Map();
  const context = vm.createContext({
    document:{getElementById:element, createElement:()=>element(Symbol()),addEventListener(){}},
    window:{addEventListener(){},innerWidth:800,innerHeight:800},
    Runtime:{storage:()=>({getItem:key=>saved.get(key),setItem:(key,value)=>saved.set(key,value)})}, AbortController
  });
  vm.runInContext(readFileSync(join(__dirname,'../internal/server/web/models.js'),'utf8')+'\nglobalThis.picker=ModelPicker;',context);
  const picker=context.picker;
  const base={enabled:true,busy:false,api:async()=>({models:[{model:'example',defaultReasoningEffort:'high'}]})};
  picker.update({...base,threadId:'a',lastTurnSettings:{model:'gpt-6-astra',effort:'medium'}});
  assert.equal(element('model-picker-open').textContent,'gpt-6-astra · 中 ⌄');
  assert.equal(picker.snapshot('a'),undefined);
  picker.update({...base,threadId:'a',lastTurnSettings:{model:'new-model',effort:'high'}});
  assert.match(element('model-picker-open').textContent,/new-model · 高/);
  element('model-picker-open').handlers.click();
  await new Promise(setImmediate);
  assert.match(element('model-note').textContent,/new-model/);
  element('model-select').value='example';
  element('model-select').handlers.change();
  assert.equal(picker.snapshot('a').model,'example');
  assert.match(element('model-picker-open').textContent,/^example/);
  picker.consume('a',picker.snapshot('a'));
  assert.match(element('model-picker-open').textContent,/new-model/);
  assert.equal(picker.snapshot('a'),undefined);
  picker.update({...base,threadId:'b'});
  assert.equal(element('model-picker-open').textContent,'模型待同步 ⌄');
  picker.update({...base,threadId:'a'});
  assert.match(element('model-picker-open').textContent,/new-model/);
  picker.live('a',{model:'example',effort:'high'});
  picker.update({...base,threadId:'a',lastTurnSettings:{model:'old-model'}});
  assert.match(element('model-picker-open').textContent,/example/);
  assert.equal(picker.snapshot('a'),undefined);
  element('model-picker-open').handlers.click();
  await new Promise(setImmediate);
  assert.equal(element('model-select').value,'example');
  assert.equal(picker.snapshot('a'),undefined);
  picker.update({...base,threadId:'b'});
  assert.equal(element('model-picker-open').textContent,'模型待同步 ⌄');
  // Reload the module using the same persistent storage.
  vm.runInContext(readFileSync(join(__dirname,'../internal/server/web/models.js'),'utf8').replace('const ModelPicker =','const ReloadedPicker =')+'\nglobalThis.reloaded=ReloadedPicker;',context);
  context.reloaded.update({...base,threadId:'a'});
  assert.match(element('model-picker-open').textContent,/example/);
  assert.equal(context.reloaded.snapshot('a'),undefined);
});
