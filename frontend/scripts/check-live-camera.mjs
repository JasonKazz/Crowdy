import assert from "node:assert/strict";
import { cameraErrorMessage, canApplyLiveCount, captureLiveFrame, LIVE_STALE_AFTER_MS, smoothedCrowdCount } from "../src/lib/live-camera.ts";

const now = Date.parse("2026-10-25T00:00:10Z");
const updated = new Date(now - 2_000).toISOString();
assert.equal(smoothedCrowdCount([]), null);
assert.equal(smoothedCrowdCount([18, 190, 20]), 20, "A transient detector spike should not set occupancy to190");
assert.equal(smoothedCrowdCount([90, 20, 21, 19]), 20, "Only the latest three frames count");
assert.equal(smoothedCrowdCount([0, 0, 8]), 0);
assert.equal(canApplyLiveCount(20, updated, now), true);
for (const count of [0, 201, null]) assert.equal(canApplyLiveCount(count, updated, now), false);
assert.equal(canApplyLiveCount(20, new Date(now - LIVE_STALE_AFTER_MS).toISOString(), now), false, "A stale frame cannot update occupancy");
assert.equal(canApplyLiveCount(20, "invalid", now), false);
assert.equal(canApplyLiveCount(20, new Date(now + 60_000).toISOString(), now), false);
assert.match(cameraErrorMessage(new DOMException("denied", "NotAllowedError")), /Allow camera access/);
assert.match(cameraErrorMessage(new DOMException("busy", "NotReadableError")), /another app/);

const originalDocument = globalThis.document;
const calls = [];
const canvas = {
  width: 0, height: 0,
  getContext: () => ({ drawImage: (...args) => calls.push(args) }),
  toBlob: (callback, type, quality) => { assert.equal(type, "image/jpeg"); assert.equal(quality, .8); callback(new Blob(["jpeg"], { type })); },
};
globalThis.document = { createElement: name => { assert.equal(name, "canvas"); return canvas; } };
try {
  const frame = await captureLiveFrame({ readyState: 2, videoWidth: 3840, videoHeight: 2160 });
  assert.equal(frame.type, "image/jpeg");
  assert.equal(canvas.width, 1280);
  assert.equal(canvas.height, 720);
  assert.equal(calls.length, 1);
  await captureLiveFrame({ readyState: 2, videoWidth: 720, videoHeight: 1280 });
  assert.equal(canvas.width, 720);
  assert.equal(canvas.height, 1280, "Portrait iPhone frames keep their aspect ratio");
  await assert.rejects(captureLiveFrame({ readyState: 1, videoWidth: 0, videoHeight: 0 }), /Waiting for the camera/);
  canvas.toBlob = callback => callback(null);
  await assert.rejects(captureLiveFrame({ readyState: 2, videoWidth: 640, videoHeight: 480 }), /could not be prepared/);
  canvas.toBlob = callback => callback(new Blob([new Uint8Array(3 * 1024 * 1024 + 1)], { type: "image/jpeg" }));
  await assert.rejects(captureLiveFrame({ readyState: 2, videoWidth: 640, videoHeight: 480 }), /could not be prepared/);
} finally {
  if (originalDocument === undefined) delete globalThis.document;
  else globalThis.document = originalDocument;
}
console.log("Live camera checks passed: bounded/portrait JPEG frames, permission errors, smoothing, stale/range guards.");
