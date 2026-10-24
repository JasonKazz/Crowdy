import assert from 'node:assert/strict';
import {awaitFloorPlanImport,FLOOR_PLAN_IMPORT_TIMEOUT_MS,FLOOR_PLAN_IMPORT_TIMEOUT_MESSAGE} from '../src/lib/floorplan-import.ts';
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
replies=[{body:{status:'running',progress:'Reading floor plan',elapsed_seconds:12}},
 {body:{status:'complete',result:{plan:{id:'fixture'},warnings:['Review exits']}}}];
const result=await awaitFloorPlanImport(id,message=>progress.push(message));
assert.equal(result.plan.id,'fixture');
assert.match(progress[0],/Reading floor plan.*12s/);
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

// Control deadline signals without waiting through the interactive time budget.
// The shared upload signal is also passed here by the workspace, so polling
// cannot extend an upload that has already consumed part of that budget.
const originalTimeout=AbortSignal.timeout;
async function withDeadlines(check){
 const deadlines=new Map();
 AbortSignal.timeout=milliseconds=>{
  const controller=new AbortController();
  deadlines.set(milliseconds,controller);
  return controller.signal;
 };
 try{await check(deadlines);}
 finally{AbortSignal.timeout=originalTimeout;}
}
const timeoutReason=()=>new DOMException('Image import deadline reached','TimeoutError');
const timedOut=error=>error instanceof Error && error.message===FLOOR_PLAN_IMPORT_TIMEOUT_MESSAGE;
assert.equal(FLOOR_PLAN_IMPORT_TIMEOUT_MS,110_000);

await withDeadlines(async deadlines=>{
 let started;
 const startedRequest=new Promise(resolve=>{started=resolve;});
 let requests=0;
 globalThis.fetch=async(_url,{signal,cache})=>new Promise((resolve,reject)=>{
  requests++; assert.equal(cache,'no-store'); started();
  signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
 });
 const pending=awaitFloorPlanImport(id,noop);
 await startedRequest;
 deadlines.get(110_000).abort(timeoutReason());
 await assert.rejects(pending,timedOut);
 assert.equal(requests,1,'An expired import must not retry the request');
});

await withDeadlines(async deadlines=>{
 let bodyStarted;
 const startedBody=new Promise(resolve=>{bodyStarted=resolve;});
 globalThis.fetch=async(_url,{signal})=>({ok:true,json:()=>new Promise((resolve,reject)=>{
  bodyStarted();
  signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
 })});
 const pending=awaitFloorPlanImport(id,noop);
 await startedBody;
 deadlines.get(110_000).abort(timeoutReason());
 await assert.rejects(pending,timedOut,'Slow response bodies must share the total deadline');
});

await withDeadlines(async deadlines=>{
 globalThis.fetch=scriptedFetch;
 replies=[{body:{status:'running',progress:'Reading floor plan',elapsed_seconds:89}},
  {body:{status:'complete',result:{plan:{id:'too-late'}}}}];
 await assert.rejects(awaitFloorPlanImport(id,()=>{
  queueMicrotask(()=>deadlines.get(110_000).abort(timeoutReason()));
 }),timedOut);
 assert.equal(replies.length,1,'An expired import must not poll or accept a later result');
});

await withDeadlines(async deadlines=>{
 let started;
 const startedRequest=new Promise(resolve=>{started=resolve;});
 globalThis.fetch=async(_url,{signal})=>new Promise((resolve,reject)=>{
  started(); signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
 });
 const pending=awaitFloorPlanImport(id,noop);
 await startedRequest;
 deadlines.get(20_000).abort(timeoutReason());
 await assert.rejects(pending,serviceError(/took too long to respond/i));
});

await withDeadlines(async()=>{
 const upload=new AbortController();
 const uploadTimeout=timeoutReason();
 let started;
 const startedRequest=new Promise(resolve=>{started=resolve;});
 globalThis.fetch=async(_url,{signal})=>new Promise((resolve,reject)=>{
  started(); signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
 });
 const pending=awaitFloorPlanImport(id,noop,upload.signal);
 await startedRequest;
 upload.abort(uploadTimeout);
 await assert.rejects(pending,error=>error===uploadTimeout,
  'The workspace upload deadline must remain authoritative while polling');
});

globalThis.fetch=originalFetch;
console.log('Import polling checks passed: measured progress, floor plans/manual scale, backend errors, malformed responses, network failures, cancellation, and bounded upload/poll/response-body deadlines without retries.');
