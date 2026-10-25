import { isLiveCrowdSession, isLiveCrowdSessionId, isLiveCrowdSnapshot, isLiveCrowdToken, MAX_LIVE_FRAME_BYTES, type LiveCrowdSnapshot } from "./live-crowd";

const MAX_REQUEST_BYTES = MAX_LIVE_FRAME_BYTES + 64 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const privateHeaders = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };

function failure(error: string, status: number, extraHeaders: Record<string, string> = {}) {
  return Response.json({ error }, { status, headers: { ...privateHeaders, ...extraHeaders } });
}

async function readBounded(body: ReadableStream<Uint8Array> | null, limit: number, signal: AbortSignal) {
  signal.throwIfAborted();
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new RangeError("Body exceeds limit");
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

function publicSnapshot(data: LiveCrowdSnapshot): LiveCrowdSnapshot {
  const estimate = data.estimate;
  return {
    session_id: data.session_id, expires_at: data.expires_at, sequence: data.sequence,
    updated_at: data.updated_at, preview: data.preview, status: data.status,
    estimate: estimate === null ? null : {
      estimate_id: estimate.estimate_id, count: estimate.count, model: estimate.model,
      processing_ms: estimate.processing_ms, warnings: [...estimate.warnings],
      image: { width: estimate.image.width, height: estimate.image.height },
      detections: estimate.detections.map(({ confidence, bbox }) => ({ confidence, bbox: [...bbox] })),
      ...(estimate.method ? {method: estimate.method} : {}),
      ...(estimate.method === "density" ? {density_count: estimate.density_count} : {}),
      ...(estimate.inference ? {inference: {
        strategy: estimate.inference.strategy, tiles_processed: estimate.inference.tiles_processed,
        tiles_planned: estimate.inference.tiles_planned, max_detections: estimate.inference.max_detections,
        truncated: estimate.inference.truncated, complete: estimate.inference.complete,
      }} : {}),
    },
  };
}

function upstreamFailure(response: Response) {
  const status = response.status;
  const retryAfter = response.headers.get("retry-after");
  const retryHeaders: Record<string, string> = [429, 503].includes(status) && retryAfter && /^\d{1,5}$/.test(retryAfter) ? { "Retry-After": retryAfter } : {};
  // Upstream errors may contain internal service credentials or diagnostics.
  if ([401, 403].includes(status)) return failure("This live feed link is invalid. Start a new feed.", status);
  if ([404, 410].includes(status)) return failure("This live feed has ended or expired. Start a new feed.", status);
  if (status === 413) return failure("Prepare a camera frame under 3 MB.", 413);
  if ([415, 422].includes(status)) return failure("The camera frame could not be read. Capture another frame.", status);
  if ([409, 429, 503].includes(status)) return failure("Live crowd estimation is busy. Try again shortly.", status, retryHeaders);
  return failure("Live crowd estimation is unavailable. Try again shortly.", status >= 500 ? 502 : 400);
}

export async function proxyLiveCrowd(request: Request, path: string[] = []) {
  const incomingUrl = new URL(request.url);
  const origin = request.headers.get("origin");
  if ((origin && ![incomingUrl.origin, process.env.APP_BASE_URL].includes(origin)) || request.headers.get("sec-fetch-site") === "cross-site")
    return failure("Open Crowdy to use a live crowd feed.", 403);
  if (incomingUrl.search) return failure("Live feed credentials must be sent in a request header.", 400);
  const create = path.length === 0;
  const id = path[0];
  const action = path[1];
  if (!create && (!isLiveCrowdSessionId(id) || path.length > 2 || (path.length === 2 && !["frames", "pause"].includes(action))))
    return failure("This live feed could not be found.", 404);
  const allowed = create || path.length === 2 ? ["POST"] : ["GET", "DELETE"];
  if (!allowed.includes(request.method)) return failure("This live feed action is not supported.", 405, { Allow: allowed.join(", ") });
  const capability = request.headers.get("x-crowdy-live-token");
  if (!create && !isLiveCrowdToken(capability)) return failure("This live feed link is invalid. Start a new feed.", 401);
  if (create && capability !== null) return failure("Create a new live feed without an existing feed token.", 400);
  const frame = action === "frames";
  const contentType = request.headers.get("content-type");
  if (frame && !contentType?.toLowerCase().startsWith("multipart/form-data;")) return failure("Send a PNG, JPEG, or WebP camera frame.", 415);
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null && !/^\d+$/.test(declaredLength)) return failure("The live feed request could not be read.", 400);
  if (Number(declaredLength) > (frame ? MAX_REQUEST_BYTES : 0)) return failure(frame ? "Prepare a camera frame under 3 MB." : "This live feed action does not accept a request body.", frame ? 413 : 400);

  let url: URL;
  const serviceToken = process.env.CROWDY_CROWD_ESTIMATION_TOKEN;
  try {
    const base = process.env.CROWDY_CROWD_ESTIMATION_URL || (process.env.NODE_ENV === "development" ? "http://127.0.0.1:8001" : "");
    if (!base || !serviceToken) return failure("Live crowd estimation is not configured for this deployment.", 503);
    const baseUrl = new URL(base);
    if (!["http:", "https:"].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) throw new Error();
    url = new URL(`${base.replace(/\/$/, "")}/v1/live-sessions${create ? "" : `/${path.join("/")}`}`);
  } catch { return failure("Live crowd estimation service configuration is invalid.", 503); }

  const timeout = AbortSignal.timeout(55_000);
  const signal = AbortSignal.any([request.signal, timeout]);
  let body: FormData | undefined;
  try {
    const bytes = await readBounded(request.body, frame ? MAX_REQUEST_BYTES : 1024, signal);
    if (frame) {
      const form = await new Response(bytes, { headers: { "Content-Type": contentType! } }).formData();
      const image = form.get("image");
      if ([...form.keys()].some(key => key !== "image") || form.getAll("image").length !== 1 || !(image instanceof Blob) || !image.size)
        return failure("Capture one nonempty camera frame.", 400);
      if (!["image/png", "image/jpeg", "image/webp"].includes(image.type)) return failure("Capture a PNG, JPEG, or WebP camera frame.", 415);
      if (image.size > MAX_LIVE_FRAME_BYTES) return failure("Prepare a camera frame under 3 MB.", 413);
      body = new FormData();
      body.append("image", image, `camera.${image.type === "image/png" ? "png" : image.type === "image/webp" ? "webp" : "jpg"}`);
    } else if (bytes.byteLength) return failure("This live feed action does not accept a request body.", 400);
  } catch (error) {
    if (request.signal.aborted) return failure("Live crowd estimation cancelled.", 499);
    if (timeout.aborted) return failure("Live crowd estimation took too long. Try again shortly.", 504);
    return failure(error instanceof RangeError && frame ? "Prepare a camera frame under 3 MB." : "The live feed request could not be read.", error instanceof RangeError && frame ? 413 : 400);
  }
  try {
    const response = await fetch(url, {
      method: request.method, body, cache: "no-store", redirect: "error", signal,
      headers: { Authorization: `Bearer ${serviceToken}`, ...(capability ? { "X-Crowdy-Live-Token": capability } : {}) },
    });
    if (!response.ok) {
      await response.body?.cancel();
      return upstreamFailure(response);
    }
    if (request.method === "DELETE") {
      await response.body?.cancel();
      return new Response(null, { status: 204, headers: privateHeaders });
    }
    if (Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES) {
      await response.body?.cancel();
      return failure("The live crowd estimation response is too large.", 502);
    }
    const bytes = await readBounded(response.body, MAX_RESPONSE_BYTES, signal);
    let data: unknown;
    try { data = JSON.parse(new TextDecoder().decode(bytes)); }
    catch { return failure("The live crowd estimation response could not be read.", 502); }
    if (response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json")
      return failure("The live crowd estimation response could not be read.", 502);
    if (create) {
      if (!isLiveCrowdSession(data) || JSON.stringify(data).includes(serviceToken)) return failure("The live feed could not be created. Try again.", 502);
      return Response.json(data, { status: 201, headers: privateHeaders });
    }
    if (!isLiveCrowdSnapshot(data, id)) return failure("The live crowd estimate could not be read. Try again shortly.", 502);
    const snapshot = publicSnapshot(data);
    const payload = JSON.stringify(snapshot);
    if (payload.includes(serviceToken) || (capability && payload.includes(capability)))
      return failure("The live crowd estimate could not be read. Try again shortly.", 502);
    return Response.json(snapshot, { headers: privateHeaders });
  } catch (error) {
    if (request.signal.aborted) return failure("Live crowd estimation cancelled.", 499);
    if (timeout.aborted) return failure("Live crowd estimation took too long. Try again shortly.", 504);
    return failure(error instanceof RangeError ? "The live crowd estimation response is too large." : "Live crowd estimation is unavailable. Try again shortly.", error instanceof RangeError ? 502 : 503);
  }
}
