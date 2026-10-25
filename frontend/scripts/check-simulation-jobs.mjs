import assert from "node:assert/strict";
import {submitSimulation} from "../src/lib/simulation-jobs.ts";

const originalFetch=globalThis.fetch;
const keepAlive=setInterval(()=>{},1000);
const id="a".repeat(32);
const result={engine:"jupedsim",summary:{evacuated_count:5000}};
const queued={job_id:id,status:"running"};
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
try {
  const requests=[], progress=[];
  const responses=[queued,{...queued,progress:{phase:"simulating",population_count:5000,
    simulation_time:4,evacuated_count:100,elapsed_seconds:10}},
    {job_id:id,status:"complete",result}];
  globalThis.fetch=async(url,options={})=>{
    requests.push({url,options});
    return Response.json(responses.shift(),{status:requests.length===1?202:200});
  };
  assert.deepEqual(await submitSimulation({plan:{}},{pollIntervalMs:1,onProgress:p=>progress.push(p)}),result);
  assert.deepEqual(requests.map(r=>r.options.method??"GET"),["POST","GET","GET"]);
  assert.equal(requests[1].url,`/api/simulations?job_id=${id}`);
  assert.deepEqual(progress,[{phase:"simulating",populationCount:5000,simulationTime:4,evacuatedCount:100,elapsedSeconds:10}]);

  globalThis.fetch=async()=>Response.json(result);
  assert.deepEqual(await submitSimulation({}),result,"Legacy completed responses remain usable");
  for(const bad of ["../health","a&x=1","A".repeat(32),"a".repeat(33)]) {
    let calls=0;
    globalThis.fetch=async()=>{calls++;return Response.json({...queued,job_id:bad});};
    await assert.rejects(submitSimulation({}),/invalid job reference/);
    assert.equal(calls,1,"Untrusted job references must never reach a URL");
  }

  let deletes=0, calls=0;
  globalThis.fetch=async(url,options={})=>{
    if(options.method==="DELETE"){deletes++;return new Response(null,{status:204});}
    return Response.json(calls++?{job_id:id,status:"failed",error:"No room for this crowd."}:queued);
  };
  await assert.rejects(submitSimulation({},{pollIntervalMs:1}),/No room for this crowd/);
  await tick(); assert.equal(deletes,1);

  for(const mode of ["abort","deadline"]) {
    const controller=new AbortController();let deletes=0;
    globalThis.fetch=async(url,options={})=>{
      if(options.method==="DELETE"){deletes++;assert.notEqual(options.signal,controller.signal);return new Response(null,{status:204});}
      if(mode==="abort") setTimeout(()=>controller.abort(new DOMException("Stopped by user","AbortError")),2);
      return Response.json(queued);
    };
    await assert.rejects(submitSimulation({},{signal:controller.signal,timeoutMs:10,pollIntervalMs:20}),
      mode==="abort"?/Stopped by user/:/processing deadline/);
    await tick();assert.equal(deletes,1,"Abandoned native work must be cancelled exactly once");
  }

  calls=0;deletes=0;
  const lateAbort=new AbortController();
  globalThis.fetch=async(url,options={})=>{
    if(options.method==="DELETE"){deletes++;return new Response(null,{status:204});}
    return {ok:true,json:async()=>{lateAbort.abort(new DOMException("Late stop","AbortError"));return queued;}};
  };
  await assert.rejects(submitSimulation({},{signal:lateAbort.signal}),/Late stop/);
  await tick();assert.equal(deletes,1,"Cancellation racing the initial response must retain its job reference");

  calls=0;deletes=0;
  globalThis.fetch=async(url,options={})=>{
    if(options.method==="DELETE"){deletes++;return new Response(null,{status:204});}
    if(!calls++) return Response.json(queued);
    return new Response(new ReadableStream({start(stream){
      options.signal.addEventListener("abort",()=>stream.error(options.signal.reason),{once:true});
    }}),{headers:{"content-type":"application/json"}});
  };
  await assert.rejects(submitSimulation({},{timeoutMs:15,pollIntervalMs:1}),/processing deadline/);
  await tick();assert.equal(deletes,1,"Deadline includes response-body delivery");

  calls=0;deletes=0;
  globalThis.fetch=async(url,options={})=>{
    if(options.method==="DELETE"){deletes++;return new Response(null,{status:204});}
    return Response.json(calls++?{job_id:id,status:"running",progress:{phase:"simulating",population_count:5000,
      simulation_time:NaN,evacuated_count:0,elapsed_seconds:0}}:queued);
  };
  await assert.rejects(submitSimulation({},{pollIntervalMs:1}),/invalid progress/);
  await tick();assert.equal(deletes,1);
} finally {clearInterval(keepAlive);globalThis.fetch=originalFetch;}
console.log("Simulation jobs: async polling, progress, legacy results, safe references, failure, abort, body deadline and single cancellation passed.");
