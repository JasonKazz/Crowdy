import assert from 'node:assert/strict';
import {awaitFloorPlanImport} from '../src/lib/floorplan-import.ts';
let replies=[];
const originalFetch=globalThis.fetch;
const scriptedFetch=async()=>{
 const next=replies.shift();
 if(!next)throw new Error('Unexpected poll');
 if(next.response)return next.response;
 return Response.json(next.body,{status:next.status??200});
};
globalThis.fetch=scriptedFetch;
const id='a'.repeat(32);
const noop=()=>{};
const serviceError=pattern=>error=>{
 assert.ok(error instanceof Error);
 assert.ok(!(error instanceof SyntaxError),'Service errors must not be reported as invalid source-file JSON.');
 assert.match(error.message,/floor plan service/i);
 assert.match(error.message,pattern);
 return true;
};
const progress=[];
replies=[{body:{status:'running',progress:'Reading detail 2',elapsed_seconds:12}},
 {body:{status:'complete',result:{plan:{id:'fixture'},warnings:['Review exits']}}}];
const result=await awaitFloorPlanImport(id,message=>progress.push(message));
assert.equal(result.plan.id,'fixture');
assert.match(progress[0],/Reading detail 2.*12s/);
replies=[{body:{status:'failed',error:'A detail region failed'}}];
await assert.rejects(awaitFloorPlanImport(id,noop),/detail region failed/);
replies=[{status:404,body:{error:'Backend restarted'}}];
await assert.rejects(awaitFloorPlanImport(id,noop),/Backend restarted/);
await assert.rejects(awaitFloorPlanImport('invalid',noop),/Invalid import/);

// Proxy failures and damaged responses must identify the service, retaining the
// source file and avoiding a misleading "invalid JSON file" error in the UI.
for(const response of [
 new Response('<html>Gateway unavailable</html>',{status:502}),
 new Response('not JSON',{status:200}),
]){
 replies=[{response}];
 await assert.rejects(awaitFloorPlanImport(id,noop),serviceError(/unreadable import response/i));
}
for(const body of [null,[],42,'running']){
 replies=[{body}];
 await assert.rejects(awaitFloorPlanImport(id,noop),serviceError(/unreadable import response/i));
}
for(const status of [null,42,{},'unexpected',undefined]){
 replies=[{body:{status}}];
 await assert.rejects(awaitFloorPlanImport(id,noop),serviceError(/invalid import status/i));
}
for(const body of [
 {status:'running',progress:{stage:'detail'}},
 {status:'running',elapsed_seconds:-1},
]){
 replies=[{body}];
 await assert.rejects(awaitFloorPlanImport(id,noop),serviceError(/unreadable import progress/i));
}

const scale={needs_scale:true,extraction_id:'b'.repeat(32),image_id:'c'.repeat(32),
 width_px:1800,height_px:1200,reason:'Mark a known measurement.',warnings:['No scale found']};
for(const result of [null,[],{}, {plan:null},{plan:[]},{plan:{id:'fixture'},warnings:[{}]},
 {...scale,image_id:undefined},{...scale,width_px:0},{...scale,reason:undefined}]){
 replies=[{body:{status:'complete',result}}];
 await assert.rejects(awaitFloorPlanImport(id,noop),serviceError(/incomplete import result/i));
}
replies=[{body:{status:'complete',result:scale}}];
assert.deepEqual(await awaitFloorPlanImport(id,noop),scale,'A valid manual-scale result must open the existing calibration flow.');
for(const reply of [
 {status:503,body:{error:{message:'bad'}}},
 {body:{status:'failed',error:null}},
]){
 replies=[reply];
 await assert.rejects(awaitFloorPlanImport(id,noop),serviceError(/try again/i));
}
globalThis.fetch=async()=>{throw new TypeError('Network disconnected');};
await assert.rejects(awaitFloorPlanImport(id,noop),serviceError(/connection/i));

// Cancellation must stop network work and polling delays, preserving the
// caller's reason so navigation/unmount cleanup cannot look like an import error.
const beforeStart=new AbortController();
const beforeReason=new DOMException('Workspace closed','AbortError');
beforeStart.abort(beforeReason);
let fetchCount=0;
globalThis.fetch=async()=>{fetchCount++;throw new Error('Should not fetch');};
await assert.rejects(awaitFloorPlanImport(id,noop,beforeStart.signal),error=>error===beforeReason);
assert.equal(fetchCount,0);

const duringFetch=new AbortController();
const fetchReason=new DOMException('Navigated away','AbortError');
let fetchStarted;
const started=new Promise(resolve=>{fetchStarted=resolve;});
globalThis.fetch=async(_url,{signal})=>new Promise((resolve,reject)=>{
 fetchStarted();
 signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
});
const fetching=awaitFloorPlanImport(id,noop,duringFetch.signal);
await started;
duringFetch.abort(fetchReason);
await assert.rejects(fetching,error=>error===fetchReason);

globalThis.fetch=scriptedFetch;
const betweenPolls=new AbortController();
const waitReason=new DOMException('Import dismissed','AbortError');
replies=[{body:{status:'running',progress:'Reading walls',elapsed_seconds:2}},
 {body:{status:'complete',result:{plan:{id:'should-not-be-polled'}}}}];
await assert.rejects(awaitFloorPlanImport(id,()=>{
 queueMicrotask(()=>betweenPolls.abort(waitReason));
},betweenPolls.signal),error=>error===waitReason);
assert.equal(replies.length,1,'Cancelling while waiting must not fetch another result.');
globalThis.fetch=originalFetch;
console.log('Import polling checks passed: progress, floor plans/manual scale, backend errors, malformed service responses, network failures, and cancellation before/during/between polls.');
