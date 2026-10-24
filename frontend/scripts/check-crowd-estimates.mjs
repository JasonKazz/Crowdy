// Isolated transport fixtures; no model download, cloud account, or live service.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { estimateVenueCrowd, isCrowdEstimate, largestCrowdEstimate } from "../src/lib/crowd-estimates.ts";

function moduleUrl(path, replace = value => value) {
  const source = replace(readFileSync(new URL(path, import.meta.url), "utf8"));
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  return `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`;
}
const contractUrl = moduleUrl("../src/lib/crowd-estimates.ts");
const { proxyCrowdEstimate } = await import(moduleUrl("../src/lib/crowd-estimation-proxy.ts", source => source.replace('"./crowd-estimates"', JSON.stringify(contractUrl))));
const result = count => ({ estimate_id: "estimate-fixture", count,
  detections: Array.from({ length: count }, () => ({ confidence: .9, bbox: [1, 2, 10, 20] })),
  image: { width: 640, height: 480 }, model: "yolo26n.pt", processing_ms: 7,
  warnings: ["Visible people only; review occupancy."] });
assert.ok(isCrowdEstimate(result(0)), "A valid zero result is not a missing estimate");
assert.equal(largestCrowdEstimate([]), null);
assert.equal(largestCrowdEstimate([result(0)]), 0);
assert.equal(largestCrowdEstimate([result(2), result(3)]), 3, "Overlapping views must never be summed");
for (const invalid of [null, {}, { ...result(0), count: -1 }, { ...result(0), count: 1 },
  { ...result(1), detections: [{ confidence: 2, bbox: [1, 2, 10, 20] }] },
  { ...result(1), detections: [{ confidence: .9, bbox: [1, 2, 1000, 20] }] },
  { ...result(1), detections: [{ confidence: .9, bbox: [10, 2, 1, 20] }] },
  { ...result(0), processing_ms: NaN }, { ...result(0), warnings: [17] },
  { ...result(0), image: { width: 0, height: 480 } }]) assert.equal(isCrowdEstimate(invalid), false);

const image = new Blob(["image-fixture"], { type: "image/png" });
const originalFetch = globalThis.fetch;
const originalTimeout = AbortSignal.timeout;
const originalEnv = Object.fromEntries(["NODE_ENV", "APP_BASE_URL", "CROWDY_CROWD_ESTIMATION_URL", "CROWDY_CROWD_ESTIMATION_TOKEN"].map(key => [key, process.env[key]]));
try {
  globalThis.fetch = async (url, init) => {
    assert.equal(url, "/api/crowd-estimates");
    assert.equal(init.method, "POST");
    assert.ok(init.body instanceof FormData);
    assert.equal(init.body.get("image").size, image.size);
    assert.equal(init.headers, undefined, "The browser must never receive an upstream token or manually set a multipart boundary");
    return Response.json(result(0));
  };
  assert.equal((await estimateVenueCrowd(image)).count, 0);
  await assert.rejects(estimateVenueCrowd(new Blob(["x"], { type: "image/svg+xml" })), /PNG/);
  await assert.rejects(estimateVenueCrowd(new Blob([new Uint8Array(3 * 1024 * 1024 + 1)], { type: "image/png" })), /under 3 MB/);
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(estimateVenueCrowd(image, { signal: cancelled.signal }), { name: "AbortError" });
  globalThis.fetch = async () => Response.json({ error: "Estimator busy. Retry shortly." }, { status: 503 });
  await assert.rejects(estimateVenueCrowd(image), /Estimator busy/);
  globalThis.fetch = async () => new Response("Gateway failure", { status: 502 });
  await assert.rejects(estimateVenueCrowd(image), /could not finish/);
  globalThis.fetch = async () => Response.json({ ...result(0), count: 10 });
  await assert.rejects(estimateVenueCrowd(image), /could not be read/);
  globalThis.fetch = async () => { throw new TypeError("offline"); };
  await assert.rejects(estimateVenueCrowd(image), /unavailable/);

  process.env.NODE_ENV = "development";
  process.env.APP_BASE_URL = "https://crowdy.example";
  delete process.env.CROWDY_CROWD_ESTIMATION_URL;
  process.env.CROWDY_CROWD_ESTIMATION_TOKEN = "isolated-test-token";
  let fetchCount = 0;
  globalThis.fetch = async (url, init) => {
    fetchCount++;
    assert.equal(String(url), "http://127.0.0.1:8001/v1/estimates");
    assert.equal(init.headers.Authorization, "Bearer isolated-test-token");
    assert.equal(init.redirect, "error");
    assert.equal(init.cache, "no-store");
    assert.equal(init.body.get("image").name, "venue.png");
    assert.equal(init.body.get("image").size, image.size);
    return Response.json(result(3));
  };
  function request({ blob = image, headers = {}, fields = [], signal } = {}) {
    const form = new FormData(); form.append("image", blob, "untrusted-name.png");
    for (const [key, value] of fields) form.append(key, value);
    return new Request("https://crowdy.example/api/crowd-estimates", { method: "POST", body: form, headers: { Origin: "https://crowdy.example", ...headers }, signal });
  }
  delete process.env.CROWDY_CROWD_ESTIMATION_TOKEN;
  assert.equal((await proxyCrowdEstimate(request())).status, 503, "Local development also requires the service token");
  assert.equal(fetchCount, 0, "Missing local credentials must never forward a request");
  process.env.CROWDY_CROWD_ESTIMATION_TOKEN = "isolated-test-token";
  let response = await proxyCrowdEstimate(request());
  assert.equal(response.status, 200);
  assert.equal((await response.json()).count, 3);
  assert.match(response.headers.get("cache-control"), /no-store/);
  assert.equal(response.headers.get("authorization"), null);
  const beforeInvalid = fetchCount;
  assert.equal((await proxyCrowdEstimate(request({ headers: { Origin: "https://other.invalid" } }))).status, 403);
  assert.equal((await proxyCrowdEstimate(request({ headers: { "Sec-Fetch-Site": "cross-site" } }))).status, 403);
  assert.equal((await proxyCrowdEstimate(request({ headers: { "Content-Type": "application/json" } }))).status, 415);
  assert.equal((await proxyCrowdEstimate(request({ blob: new Blob(["x"], { type: "image/gif" }) }))).status, 415);
  assert.equal((await proxyCrowdEstimate(request({ blob: new Blob([], { type: "image/png" }) }))).status, 400);
  assert.equal((await proxyCrowdEstimate(request({ fields: [["owner", "untrusted"]] }))).status, 400);
  assert.equal((await proxyCrowdEstimate(request({ fields: [["image", image]] }))).status, 400);
  assert.equal((await proxyCrowdEstimate(request({ blob: new Blob([new Uint8Array(3 * 1024 * 1024 + 1)], { type: "image/png" }) }))).status, 413);
  assert.equal((await proxyCrowdEstimate(request({ headers: { "Content-Length": String(5 * 1024 * 1024) } }))).status, 413);
  const streamed = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(4 * 1024 * 1024)); controller.close(); } });
  assert.equal((await proxyCrowdEstimate(new Request("https://crowdy.example/api/crowd-estimates", { method: "POST", headers: { "Content-Type": "multipart/form-data; boundary=fixture" }, body: streamed, duplex: "half" }))).status, 413, "Requests without Content-Length must still be bounded");
  assert.equal(fetchCount, beforeInvalid, "Invalid requests must never reach inference");

  globalThis.fetch = async () => Response.json({ error: "Estimator is busy." }, { status: 503, headers: { "Retry-After": "2" } });
  response = await proxyCrowdEstimate(request());
  assert.equal(response.status, 503); assert.equal(response.headers.get("retry-after"), "2");
  assert.equal((await response.json()).error, "Estimator is busy.");
  globalThis.fetch = async () => Response.json({ error: "Unsupported image." }, { status: 422 });
  assert.equal((await proxyCrowdEstimate(request())).status, 422);
  globalThis.fetch = async () => Response.json({ error: "Unauthorized service." }, { status: 401 });
  assert.equal((await proxyCrowdEstimate(request())).status, 502);
  globalThis.fetch = async () => new Response("<h1>upstream failure</h1>", { status: 502 });
  response = await proxyCrowdEstimate(request());
  assert.equal(response.status, 502); assert.doesNotMatch(await response.text(), /<h1>/);
  globalThis.fetch = async () => Response.json({ ...result(0), count: 5 });
  assert.equal((await proxyCrowdEstimate(request())).status, 502);
  globalThis.fetch = async () => new Response(new Uint8Array(4 * 1024 * 1024 + 1));
  assert.equal((await proxyCrowdEstimate(request())).status, 502, "Chunked upstream responses must be bounded");
  globalThis.fetch = async () => { throw new TypeError("offline"); };
  assert.equal((await proxyCrowdEstimate(request())).status, 503);
  assert.equal((await proxyCrowdEstimate(request({ signal: cancelled.signal }))).status, 499);
  AbortSignal.timeout = () => AbortSignal.abort(new DOMException("Timed out", "TimeoutError"));
  assert.equal((await proxyCrowdEstimate(request())).status, 504);
  AbortSignal.timeout = originalTimeout;
  process.env.CROWDY_CROWD_ESTIMATION_URL = "ftp://invalid.example";
  assert.equal((await proxyCrowdEstimate(request())).status, 503);
  process.env.CROWDY_CROWD_ESTIMATION_URL = "https://user:secret@invalid.example";
  assert.equal((await proxyCrowdEstimate(request())).status, 503);
  process.env.NODE_ENV = "production";
  delete process.env.CROWDY_CROWD_ESTIMATION_URL;
  assert.equal((await proxyCrowdEstimate(request())).status, 503, "Production must never fall back to localhost");
  process.env.CROWDY_CROWD_ESTIMATION_URL = "https://estimator.example";
  delete process.env.CROWDY_CROWD_ESTIMATION_TOKEN;
  assert.equal((await proxyCrowdEstimate(request())).status, 503, "Production inference must use configured service credentials");
} finally {
  globalThis.fetch = originalFetch;
  AbortSignal.timeout = originalTimeout;
  for (const [key, value] of Object.entries(originalEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
}
console.log("Crowd estimation checks passed: multipart transport, server-only bearer credentials, zero results, max across views, response validation, origin rejection, streaming byte limits, busy/retry, cancellation, deadlines, service failures, and production configuration.");
