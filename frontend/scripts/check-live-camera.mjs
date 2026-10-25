import assert from "node:assert/strict";
import { cameraErrorMessage, canApplyLiveCount, captureLiveFrame, LIVE_STALE_AFTER_MS, MAX_LIVE_FRAME_EDGE, smoothedCrowdCount } from "../src/lib/live-camera.ts";

const now = Date.parse("2026-10-25T00:00:10Z");
const updated = new Date(now - 2_000).toISOString();
assert.equal(smoothedCrowdCount([]), null);
assert.equal(smoothedCrowdCount([18, 190, 20]), 20, "A transient detector spike should not set occupancy to190");
assert.equal(smoothedCrowdCount([90, 20, 21, 19]), 20, "Only the latest three frames count");
assert.equal(smoothedCrowdCount([0, 0, 8]), 0);
assert.equal(smoothedCrowdCount([10000, 10000, 9999]), 10000);
assert.equal(LIVE_STALE_AFTER_MS,45_000);
assert.equal(MAX_LIVE_FRAME_EDGE,4096);
for (const count of [1,20,5000,5001,10000]) assert.equal(canApplyLiveCount(count, updated, now), true);
for (const count of [0,-1,10001,1.5,NaN,Infinity,null]) assert.equal(canApplyLiveCount(count, updated, now), false);
assert.equal(canApplyLiveCount(5000,new Date(now-44_999).toISOString(),now),true,"A complete frame within the inference-aware freshness window remains usable");
assert.equal(canApplyLiveCount(20, new Date(now - LIVE_STALE_AFTER_MS).toISOString(), now), false, "A stale frame cannot update occupancy");
assert.equal(canApplyLiveCount(20, "invalid", now), false);
assert.equal(canApplyLiveCount(20, new Date(now + 60_000).toISOString(), now), false);
assert.match(cameraErrorMessage(new DOMException("denied", "NotAllowedError")), /Allow camera access/);
assert.match(cameraErrorMessage(new DOMException("busy", "NotReadableError")), /another app/);

const originalDocument = globalThis.document;
const calls = [];
const encodes = [];
const oversized = new Blob([new Uint8Array(3 * 1024 * 1024 + 1)], { type: "image/jpeg" });
let encode = type => new Blob(["jpeg"], {type});
const canvas = {
  width: 0, height: 0,
  getContext: () => ({ drawImage: (...args) => calls.push(args) }),
  toBlob: (callback, type, quality) => { assert.equal(type, "image/jpeg"); encodes.push({width:canvas.width,height:canvas.height,quality}); callback(encode(type,quality)); },
};
globalThis.document = { createElement: name => { assert.equal(name, "canvas"); return canvas; } };
try {
  const frame = await captureLiveFrame({ readyState: 2, videoWidth: 3840, videoHeight: 2160 });
  assert.equal(frame.type, "image/jpeg");
  assert.equal(canvas.width, 3840);
  assert.equal(canvas.height, 2160,"A 4K source must retain detail needed for dense crowd estimates");
  assert.equal(calls.length, 1);
  assert.equal(encodes[0].quality,.9);
  await captureLiveFrame({ readyState: 2, videoWidth: 7680, videoHeight: 4320 });
  assert.equal(canvas.width,4096);
  assert.equal(canvas.height,2304,"Oversized source frames remain bounded and keep their aspect ratio");
  await captureLiveFrame({ readyState: 2, videoWidth: 720, videoHeight: 1280 });
  assert.equal(canvas.width, 720);
  assert.equal(canvas.height, 1280, "Portrait iPhone frames keep their aspect ratio");
  const exactLimit = new Blob([new Uint8Array(3*1024*1024)],{type:"image/jpeg"});
  encode=()=>exactLimit;
  assert.equal((await captureLiveFrame({readyState:2,videoWidth:640,videoHeight:480})).size,exactLimit.size,"The exact upload byte boundary remains valid");
  encodes.length=0; calls.length=0;
  encode=(type,quality)=>quality===.9?oversized:new Blob(["jpeg"],{type});
  await captureLiveFrame({readyState:2,videoWidth:3840,videoHeight:2160});
  assert.deepEqual(encodes.map(value=>value.quality),[.9,.8],"Try lower JPEG quality before discarding source detail");
  assert.equal(canvas.width,3840);
  assert.equal(calls.length,1);
  encodes.length=0; calls.length=0;
  encode=type=>canvas.width>3072?oversized:new Blob(["jpeg"],{type});
  await captureLiveFrame({readyState:2,videoWidth:7680,videoHeight:4320});
  assert.deepEqual(encodes.map(value=>[value.width,value.height,value.quality]),[[4096,2304,.9],[4096,2304,.8],[4096,2304,.65],[3072,1728,.9]]);
  assert.equal(calls.length,2,"Resize only when quality reduction cannot satisfy the byte limit");
  await assert.rejects(captureLiveFrame({ readyState: 1, videoWidth: 0, videoHeight: 0 }), /Waiting for the camera/);
  for(const failure of [null,new Blob([],{type:"image/jpeg"}),oversized]) {
    encodes.length=0; calls.length=0; encode=()=>failure;
    await assert.rejects(captureLiveFrame({ readyState: 2, videoWidth: 7680, videoHeight: 4320 }), /could not be prepared/);
    assert.equal(encodes.length,12,"Unencodable or oversized frames have a finite work budget");
    assert.equal(calls.length,4);
    assert.ok(encodes.every(value=>value.width<=4096 && value.height<=4096));
  }
  canvas.getContext=()=>null;
  await assert.rejects(captureLiveFrame({readyState:2,videoWidth:640,videoHeight:480}),/could not prepare/);
} finally {
  if (originalDocument === undefined) delete globalThis.document;
  else globalThis.document = originalDocument;
}
console.log("Live camera checks passed: retained 4K/portrait detail, bounded adaptive JPEG quality/resizing, permission errors, smoothing, 45-second freshness and 1–10,000 count guards.");
