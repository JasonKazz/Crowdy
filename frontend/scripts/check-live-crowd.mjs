// Transport fixtures: no camera, model download, cloud account, or live service.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

function moduleUrl(path, replace = value => value) {
  const source = replace(readFileSync(new URL(path, import.meta.url), "utf8"));
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  return `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`;
}
const estimateUrl = moduleUrl("../src/lib/crowd-estimates.ts");
const contractUrl = moduleUrl("../src/lib/live-crowd.ts", source => source.replace('"./crowd-estimates"', JSON.stringify(estimateUrl)));
const { LiveCrowdError, isLiveCrowdSession, isLiveCrowdSnapshot, isLiveCrowdSessionId, isLiveCrowdToken,
  createLiveCrowdSession, getLiveCrowdSession, endLiveCrowdSession, sendLiveCrowdFrame, pauseLiveCrowdSession } = await import(contractUrl);
const { proxyLiveCrowd } = await import(moduleUrl("../src/lib/live-crowd-proxy.ts", source => source.replace('"./live-crowd"', JSON.stringify(contractUrl))));
const id = "a".repeat(32), otherId = "b".repeat(32);
const viewerToken = "v".repeat(43), cameraToken = "c".repeat(43);
const serviceToken = "fixture-service-credential-never-in-browser";
const expires = "2026-10-25T02:00:00+00:00";
const session = { session_id: id, viewer_token: viewerToken, camera_token: cameraToken, expires_at: expires };
const estimate = { estimate_id: "fixture-estimate", count: 0, detections: [], image: { width: 640, height: 480 },
  model: "fixture-model", processing_ms: 3, warnings: ["Visible people only."] };
const waiting = { session_id: id, expires_at: expires, sequence: 0, updated_at: null, estimate: null, preview: null, status: "waiting" };
const live = { ...waiting, sequence: 1, updated_at: "2026-10-25T01:00:00.123456Z", estimate, preview: "data:image/jpeg;base64,/9j/2Q==", status: "live" };
const image = new Blob(["fixture-frame"], { type: "image/jpeg" });
assert.ok(isLiveCrowdSession(session));
assert.ok(isLiveCrowdSnapshot(waiting, id));
assert.ok(isLiveCrowdSnapshot(live, id), "Zero people is a valid live estimate");
assert.ok(isLiveCrowdSnapshot({ ...waiting, sequence: 1, status: "paused" }, id), "The camera can pause before sending a frame");
assert.ok(isLiveCrowdSnapshot({ ...live, sequence: 2, status: "paused" }, id));
for (const value of [null, "", "../", id.toUpperCase(), `${id}/frames`, id.slice(1)]) assert.equal(isLiveCrowdSessionId(value), false);
for (const value of [null, "short", "a".repeat(129), `${"a".repeat(43)}\r\n`, "a/".repeat(22)]) assert.equal(isLiveCrowdToken(value), false);
for (const value of [null, {}, { ...session, viewer_token: cameraToken }, { ...session, extra: "untrusted" },
  { ...session, expires_at: "not a date" }, { ...session, session_id: "bad" }]) assert.equal(isLiveCrowdSession(value), false);
for (const value of [null, {}, { ...live, session_id: otherId }, { ...live, viewer_token: viewerToken },
  { ...live, sequence: -1 }, { ...live, sequence: 1.5 }, { ...live, updated_at: "yesterday" },
  { ...live, status: "recording" }, { ...live, estimate: { ...estimate, count: 1 } },
  { ...live, preview: "https://attacker.invalid/frame.jpg" }, { ...live, preview: "data:image/svg+xml;base64,YQ==" },
  { ...live, preview: "data:image/jpeg;base64," }, { ...live, preview: "data:image/jpeg;base64,malformed==" },
  { ...live, preview: `data:image/jpeg;base64,${"a".repeat(360_000)}` }, { ...live, estimate: null },
  { ...waiting, status: "live" }]) assert.equal(isLiveCrowdSnapshot(value, id), false);

const originalFetch = globalThis.fetch;
const originalTimeout = AbortSignal.timeout;
const originalEnv = Object.fromEntries(["NODE_ENV", "APP_BASE_URL", "CROWDY_CROWD_ESTIMATION_URL", "CROWDY_CROWD_ESTIMATION_TOKEN"].map(key => [key, process.env[key]]));
try {
  let clientCalls = [];
  globalThis.fetch = async (url, init) => {
    clientCalls.push({ url, init });
    assert.equal(init.cache, "no-store");
    assert.equal(init.credentials, "same-origin");
    assert.doesNotMatch(JSON.stringify(init.headers ?? {}), new RegExp(serviceToken));
    if (url === "/api/live-crowd") {
      assert.equal(init.method, "POST"); assert.equal(init.body, undefined); assert.equal(init.headers, undefined);
      return Response.json(session, { status: 201 });
    }
    assert.ok(!url.includes("?"), "Capabilities must never appear in a URL");
    if (init.method === "DELETE") return new Response(null, { status: 204 });
    if (url.endsWith("/frames")) {
      assert.equal(init.headers["X-Crowdy-Live-Token"], cameraToken);
      assert.equal(init.headers["Content-Type"], undefined, "The browser owns the multipart boundary");
      assert.ok(init.body instanceof FormData); assert.equal(init.body.get("image").size, image.size);
      return Response.json(live);
    }
    return Response.json(url.endsWith("/pause") ? { ...live, status: "paused" } : waiting);
  };
  assert.deepEqual(await createLiveCrowdSession(), session);
  assert.deepEqual(await getLiveCrowdSession(id, viewerToken), waiting);
  assert.deepEqual(await sendLiveCrowdFrame(id, cameraToken, image), live);
  assert.equal((await pauseLiveCrowdSession(id, cameraToken, { keepalive: true })).status, "paused");
  assert.equal(clientCalls.at(-1).init.keepalive, true);
  await endLiveCrowdSession(id, viewerToken, { keepalive: true });
  assert.equal(clientCalls.at(-1).init.keepalive, true);
  assert.equal(clientCalls.at(-1).init.headers["X-Crowdy-Live-Token"], viewerToken);
  const beforeInvalidClient = clientCalls.length;
  await assert.rejects(getLiveCrowdSession("invalid", viewerToken), error => error instanceof LiveCrowdError && error.status === 401);
  await assert.rejects(sendLiveCrowdFrame(id, cameraToken, new Blob(["x"], { type: "image/svg+xml" })), error => error.status === 415);
  await assert.rejects(sendLiveCrowdFrame(id, cameraToken, new Blob([new Uint8Array(3 * 1024 * 1024 + 1)], { type: "image/jpeg" })), error => error.status === 413);
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(createLiveCrowdSession({ signal: cancelled.signal }), { name: "AbortError" });
  assert.equal(clientCalls.length, beforeInvalidClient);
  for (const status of [401, 403, 404, 410, 429, 503]) {
    globalThis.fetch = async () => Response.json({ error: "Fixture failure." }, { status });
    await assert.rejects(getLiveCrowdSession(id, viewerToken), error => error instanceof LiveCrowdError && error.status === status && error.message === "Fixture failure.");
  }
  globalThis.fetch = async () => Response.json({ ...live, session_id: otherId });
  await assert.rejects(getLiveCrowdSession(id, viewerToken), error => error.status === 502);
  globalThis.fetch = async () => new Response("invalid", { status: 502 });
  await assert.rejects(createLiveCrowdSession(), error => error.status === 502 && /could not finish/.test(error.message));
  globalThis.fetch = async () => { throw new TypeError("offline"); };
  await assert.rejects(createLiveCrowdSession(), error => error.status === 0);

  process.env.NODE_ENV = "development";
  process.env.APP_BASE_URL = "https://crowdy.example";
  delete process.env.CROWDY_CROWD_ESTIMATION_URL;
  process.env.CROWDY_CROWD_ESTIMATION_TOKEN = serviceToken;
  let proxyCalls = [];
  function request(path = [], { method = path.length === 1 ? "GET" : "POST", token = path.length ? (path.length === 2 ? cameraToken : viewerToken) : undefined,
    headers = {}, blob = image, fields = [], body, signal, query = "" } = {}) {
    if (path[1] === "frames" && body === undefined) {
      body = new FormData(); body.append("image", blob, "untrusted-name.jpg");
      for (const [key, value] of fields) body.append(key, value);
    }
    return new Request(`https://crowdy.example/api/live-crowd${path.length ? `/${path.join("/")}` : ""}${query}`, {
      method, headers: { Origin: "https://crowdy.example", ...(token === undefined ? {} : { "X-Crowdy-Live-Token": token }), ...headers }, body, signal,
      ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
    });
  }
  globalThis.fetch = async (url, init) => {
    proxyCalls.push({ url, init });
    assert.equal(init.headers.Authorization, `Bearer ${serviceToken}`);
    assert.equal(init.redirect, "error"); assert.equal(init.cache, "no-store");
    assert.ok(!String(url).includes("?"));
    if (String(url).endsWith("/v1/live-sessions")) return Response.json(session, { status: 201 });
    if (init.method === "DELETE") return new Response(null, { status: 204 });
    if (String(url).endsWith("/frames")) {
      assert.equal(init.headers["X-Crowdy-Live-Token"], cameraToken);
      assert.equal(init.body.get("image").name, "camera.jpg"); assert.equal(init.body.get("image").size, image.size);
      return Response.json(live);
    }
    return Response.json(String(url).endsWith("/pause") ? { ...live, status: "paused" } : waiting);
  };
  delete process.env.CROWDY_CROWD_ESTIMATION_TOKEN;
  assert.equal((await proxyLiveCrowd(request())).status, 503);
  assert.equal(proxyCalls.length, 0);
  process.env.CROWDY_CROWD_ESTIMATION_TOKEN = serviceToken;
  let response = await proxyLiveCrowd(request());
  assert.equal(response.status, 201); assert.deepEqual(await response.json(), session);
  assert.equal(String(proxyCalls.at(-1).url), "http://127.0.0.1:8001/v1/live-sessions");
  assert.equal(proxyCalls.at(-1).init.headers["X-Crowdy-Live-Token"], undefined);
  for (const path of [[id], [id, "frames"], [id, "pause"]]) {
    response = await proxyLiveCrowd(request(path), path);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("cache-control"), /no-store/);
    assert.equal(response.headers.get("authorization"), null);
    assert.equal(response.headers.get("x-crowdy-live-token"), null);
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    const text = await response.text();
    assert.doesNotMatch(text, new RegExp(`${viewerToken}|${cameraToken}|${serviceToken}`));
  }
  assert.equal((await proxyLiveCrowd(request([id], { method: "DELETE" }), [id])).status, 204);
  const beforeInvalid = proxyCalls.length;
  for (const [req, path, status] of [
    [request([], { headers: { Origin: "https://attacker.invalid" } }), [], 403],
    [request([id], { headers: { "Sec-Fetch-Site": "cross-site" } }), [id], 403],
    [request([id], { token: "" }), [id], 401],
    [request([], { token: viewerToken }), [], 400],
    [request([id], { query: `?token=${viewerToken}` }), [id], 400],
    [request(["../private"]), ["../private"], 404],
    [request([id, "unknown"]), [id, "unknown"], 404],
    [request([id, "frames", "extra"]), [id, "frames", "extra"], 404],
    [request([id], { method: "POST" }), [id], 405],
    [request([], { body: "unexpected" }), [], 400],
    [request([id, "pause"], { body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array(2048)); c.close(); } }) }), [id, "pause"], 400],
    [request([id, "frames"], { headers: { "Content-Type": "application/json" } }), [id, "frames"], 415],
    [request([id, "frames"], { blob: new Blob([], { type: "image/jpeg" }) }), [id, "frames"], 400],
    [request([id, "frames"], { blob: new Blob(["x"], { type: "image/gif" }) }), [id, "frames"], 415],
    [request([id, "frames"], { fields: [["owner", "untrusted"]] }), [id, "frames"], 400],
    [request([id, "frames"], { fields: [["image", image]] }), [id, "frames"], 400],
    [request([id, "frames"], { blob: new Blob([new Uint8Array(3 * 1024 * 1024 + 1)], { type: "image/jpeg" }) }), [id, "frames"], 413],
    [request([id, "frames"], { headers: { "Content-Length": String(5 * 1024 * 1024) } }), [id, "frames"], 413],
    [request([id, "frames"], { headers: { "Content-Length": "invalid" } }), [id, "frames"], 400],
    [request([id, "frames"], { body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array(4 * 1024 * 1024)); c.close(); } }), headers: { "Content-Type": "multipart/form-data; boundary=fixture" } }), [id, "frames"], 413],
  ]) assert.equal((await proxyLiveCrowd(req, path)).status, status);
  assert.equal(proxyCalls.length, beforeInvalid, "Invalid requests must never reach inference");

  for (const status of [401, 403, 404, 410, 413, 415, 422, 429, 503, 500]) {
    globalThis.fetch = async () => Response.json({ error: `${serviceToken} ${viewerToken} private stack trace` }, { status, headers: { "Retry-After": "2", "X-Secret": serviceToken } });
    response = await proxyLiveCrowd(request([id]), [id]);
    assert.equal(response.status, status === 500 ? 502 : status);
    assert.doesNotMatch(await response.text(), new RegExp(`${serviceToken}|${viewerToken}|private stack`));
    assert.equal(response.headers.get("x-secret"), null);
    if ([429, 503].includes(status)) assert.equal(response.headers.get("retry-after"), "2");
  }
  for (const value of [{ ...live, session_id: otherId }, { ...live, viewer_token: viewerToken }, { ...live, preview: "data:text/html,untrusted" }]) {
    globalThis.fetch = async () => Response.json(value);
    assert.equal((await proxyLiveCrowd(request([id]), [id])).status, 502);
  }
  globalThis.fetch = async () => Response.json({ ...live, estimate: { ...estimate, private_secret: serviceToken, image: { ...estimate.image, private_secret: serviceToken } } });
  response = await proxyLiveCrowd(request([id]), [id]);
  assert.equal(response.status, 200);
  assert.doesNotMatch(await response.text(), /private_secret|fixture-service-credential/);
  for (const secret of [serviceToken, viewerToken]) {
    globalThis.fetch = async () => Response.json({ ...live, estimate: { ...estimate, warnings: [`Private diagnostic ${secret}`] } });
    response = await proxyLiveCrowd(request([id]), [id]);
    assert.equal(response.status, 502);
    assert.doesNotMatch(await response.text(), new RegExp(secret));
  }
  globalThis.fetch = async () => new Response(JSON.stringify(waiting), { headers: { "Content-Type": "text/html" } });
  assert.equal((await proxyLiveCrowd(request([id]), [id])).status, 502);
  globalThis.fetch = async () => new Response("<h1>private diagnostics</h1>");
  response = await proxyLiveCrowd(request([id]), [id]);
  assert.equal(response.status, 502); assert.doesNotMatch(await response.text(), /<h1>|diagnostics/);
  globalThis.fetch = async () => new Response(new Uint8Array(4 * 1024 * 1024 + 1));
  assert.equal((await proxyLiveCrowd(request([id]), [id])).status, 502, "Chunked upstream responses are bounded");
  globalThis.fetch = async () => new Response("", { headers: { "Content-Length": String(5 * 1024 * 1024) } });
  assert.equal((await proxyLiveCrowd(request([id]), [id])).status, 502);
  globalThis.fetch = async () => { throw new TypeError("offline"); };
  assert.equal((await proxyLiveCrowd(request())).status, 503);
  assert.equal((await proxyLiveCrowd(request([], { signal: cancelled.signal }))).status, 499);
  AbortSignal.timeout = () => AbortSignal.abort(new DOMException("Timed out", "TimeoutError"));
  assert.equal((await proxyLiveCrowd(request())).status, 504);
  AbortSignal.timeout = originalTimeout;
  for (const base of ["ftp://invalid.example", "https://user:secret@invalid.example", "https://invalid.example?secret=token", "https://invalid.example#secret"]) {
    process.env.CROWDY_CROWD_ESTIMATION_URL = base;
    assert.equal((await proxyLiveCrowd(request())).status, 503);
  }
  process.env.NODE_ENV = "production";
  delete process.env.CROWDY_CROWD_ESTIMATION_URL;
  assert.equal((await proxyLiveCrowd(request())).status, 503, "Production must never default to localhost");
} finally {
  globalThis.fetch = originalFetch;
  AbortSignal.timeout = originalTimeout;
  for (const [key, value] of Object.entries(originalEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
}
console.log("Live crowd transport checks passed: separate viewer/camera capabilities, client contracts, expiry/auth statuses, origin rejection, multipart validation, frame/preview/stream limits, deadlines, cancellation, private errors, no caching, and secret isolation.");
