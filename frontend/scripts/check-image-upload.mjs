import assert from "node:assert/strict";
import {
  IMAGE_UPLOAD_SIZE_ERROR,
  MAX_UPLOAD_IMAGE_BYTES,
  encodeUploadImage,
  imageBase64Length,
  uploadImageDimensions,
} from "../src/lib/image-upload.ts";
import { forwardBackend } from "../src/lib/backend-proxy.ts";

assert.deepEqual(uploadImageDimensions(4200, 2800), {width:1092,height:728});
assert.deepEqual(uploadImageDimensions(2800, 4200), {width:728,height:1092});
assert.deepEqual(uploadImageDimensions(600, 400), {width:600,height:400}, "Small images must not be enlarged");
assert.deepEqual(uploadImageDimensions(1, 20000), {width:1,height:1092}, "Thin crops must keep a nonzero dimension");
assert.throws(() => uploadImageDimensions(0, 100), /dimensions/);
assert.throws(() => uploadImageDimensions(6000, 6000), /30 million pixels/);
for (const bytes of [0, 1, 2, 3, MAX_UPLOAD_IMAGE_BYTES - 1, MAX_UPLOAD_IMAGE_BYTES, MAX_UPLOAD_IMAGE_BYTES + 1]) {
  assert.equal(imageBase64Length(bytes), Buffer.alloc(bytes).toString("base64").length, "Base64 padding counts toward the request limit");
}
const largestPayload = JSON.stringify({filename:"é".repeat(200)+".png",provider:"gemini",
  image_base64:"A".repeat(imageBase64Length(MAX_UPLOAD_IMAGE_BYTES))});
assert.ok(Buffer.byteLength(largestPayload) < 4_500_000, "The full upload envelope must fit below the hosting request limit");

const blob = (size, type) => new Blob([new Uint8Array(size)], {type});
const calls = [];
const png = await encodeUploadImage(async (type, quality) => {
  calls.push([type,quality]);
  return blob(MAX_UPLOAD_IMAGE_BYTES, type);
});
assert.equal(png.type, "image/png");
assert.deepEqual(calls, [["image/png",undefined]], "A fitting PNG must stay lossless, including at the exact byte boundary");
calls.length = 0;
const jpeg = await encodeUploadImage(async (type, quality) => {
  calls.push([type,quality]);
  return blob(type === "image/png" ? MAX_UPLOAD_IMAGE_BYTES + 1 : 200000, type);
});
assert.equal(jpeg.type,"image/jpeg");
assert.deepEqual(calls, [["image/png",undefined],["image/jpeg",.92]], "An oversized PNG must use the high-quality JPEG fallback");
calls.length = 0;
await encodeUploadImage(async (type,quality) => {
  calls.push([type,quality]);
  return blob(quality === .82 ? 100000 : MAX_UPLOAD_IMAGE_BYTES + 1, type);
});
assert.equal(calls.length,3, "A second JPEG quality can make a noisy image fit without changing its geometry");
await assert.rejects(encodeUploadImage(async type => blob(MAX_UPLOAD_IMAGE_BYTES + 1,type)),
  {message:IMAGE_UPLOAD_SIZE_ERROR}, "If encoding cannot fit, stop before making a provider request");

const originalFetch = globalThis.fetch;
const originalUrl = process.env.CROWDY_BACKEND_URL;
process.env.CROWDY_BACKEND_URL = "http://backend.test";
try {
  globalThis.fetch = async () => new Response("FUNCTION_PAYLOAD_TOO_LARGE", {status:413});
  const response = await forwardBackend(new Request("http://app.test/api/floorplans"), "/api/floorplans", {});
  assert.equal(response.status,413);
  assert.equal((await response.json()).error,IMAGE_UPLOAD_SIZE_ERROR,
    "A hosting-level non-JSON 413 must explain how to retry the image");
  globalThis.fetch = async () => new Response("Bad Gateway", {status:502});
  const unavailable = await forwardBackend(new Request("http://app.test/api/floorplans"), "/api/floorplans", {});
  assert.equal(unavailable.status,502, "Non-JSON upstream failures must retain their HTTP failure classification");
} finally {
  globalThis.fetch = originalFetch;
  if (originalUrl === undefined) delete process.env.CROWDY_BACKEND_URL;
  else process.env.CROWDY_BACKEND_URL = originalUrl;
}
console.log("Image upload checks passed: size/pixel limits, base64 padding and complete request budget, lossless PNG/JPEG fallback, oversized-image rejection, and non-JSON upstream errors.");
