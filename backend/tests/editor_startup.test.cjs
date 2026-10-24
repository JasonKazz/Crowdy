/* Execute the actual inline script to reproduce startup failures without a browser. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const geometry = require('../app/simulation/editor-geometry.js');
const html = fs.readFileSync(path.join(__dirname,'../app/simulation/editor.html'),'utf8');
const script = fs.readFileSync(path.join(__dirname,'../app/simulation/editor-app.js'),'utf8');

async function startup(protocol) {
  const elements = new Map([...html.matchAll(/id="([^"]+)"/g)].map(([,id]) => [id, {
    id, disabled:false, textContent:'', className:'', addEventListener(){},
  }]));
  let requests = 0;
  const context = vm.createContext({
    window:{CrowdyGeometry:geometry}, location:{protocol}, console,
    document:{getElementById:id=>elements.get(id),
      querySelectorAll:()=>[...elements.values()], addEventListener(){}},
    fetch:async()=>{requests++;throw new Error('Failed to fetch');},
  });
  vm.runInContext(script,context);
  await new Promise(resolve=>setImmediate(resolve));
  return {elements,requests,context};
}

(async()=>{
  const file = await startup('file:');
  assert.equal(file.requests,0);
  assert.match(file.elements.get('status').textContent,/Python server/);
  assert.match(file.elements.get('status').textContent,/http:\/\/127\.0\.0\.1:8765/);
  assert.equal(file.elements.get('import').disabled,true);
  assert.equal(file.elements.get('run').disabled,true);
  // An error before a layout exists must not cause a second render exception.
  assert.doesNotThrow(()=>vm.runInContext('setBusy(false)',file.context));

  const offline = await startup('http:');
  assert.equal(offline.requests,2);
  assert.match(offline.elements.get('status').textContent,/Keep the Python editor server running/);
  assert.equal(offline.elements.get('import').disabled,true);
  assert.equal(offline.elements.get('run').disabled,true);
  console.log('Editor startup checks passed: direct-file guidance, offline errors, disabled controls, and no empty-layout crash.');
})().catch(error=>{console.error(error);process.exitCode=1;});
