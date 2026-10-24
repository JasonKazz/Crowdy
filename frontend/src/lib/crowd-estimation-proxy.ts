import { isCrowdEstimate } from "./crowd-estimates";

const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const MAX_REQUEST_BYTES = MAX_IMAGE_BYTES + 64 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const privateHeaders = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };

function failure(error: string, status: number, extraHeaders: Record<string, string> = {}) {
  return Response.json({ error }, { status, headers: { ...privateHeaders, ...extraHeaders } });
}

async function readBounded(body: ReadableStream<Uint8Array> | null, limit: number, signal: AbortSignal) {
  signal.throwIfAborted();
  if (!body) throw new Error("Missing body");
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

export async function proxyCrowdEstimate(request: Request) {
  const origin = request.headers.get("origin");
  if ((origin && ![new URL(request.url).origin, process.env.APP_BASE_URL].includes(origin)) ||
    request.headers.get("sec-fetch-site") === "cross-site")
    return failure("Open Crowdy to estimate a venue crowd.", 403);
  const contentType = request.headers.get("content-type");
  if (!contentType?.toLowerCase().startsWith("multipart/form-data;"))
    return failure("Send a PNG, JPEG, or WebP venue image.", 415);
  if (Number(request.headers.get("content-length")) > MAX_REQUEST_BYTES)
    return failure("Prepare a venue image under 3 MB before estimating.", 413);

  let url: URL;
  const token = process.env.CROWDY_CROWD_ESTIMATION_TOKEN;
  try {
    const base = process.env.CROWDY_CROWD_ESTIMATION_URL || (process.env.NODE_ENV === "development" ? "http://127.0.0.1:8001" : "");
    if (!base || !token)
      return failure("Crowd estimation is not configured for this deployment.", 503);
    url = new URL(`${base.replace(/\/$/, "")}/v1/estimates`);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
  } catch { return failure("Crowd estimation service configuration is invalid.", 503); }

  const timeout = AbortSignal.timeout(55_000);
  const signal = AbortSignal.any([request.signal, timeout]);
  let form: FormData;
  try {
    const bytes = await readBounded(request.body, MAX_REQUEST_BYTES, signal);
    const incoming = await new Response(bytes, { headers: { "Content-Type": contentType } }).formData();
    const image = incoming.get("image");
    if ([...incoming.keys()].some(key => key !== "image") || incoming.getAll("image").length !== 1 || !(image instanceof Blob) || !image.size)
      return failure("Choose one nonempty venue image.", 400);
    if (!["image/png", "image/jpeg", "image/webp"].includes(image.type))
      return failure("Choose a PNG, JPEG, or WebP venue image.", 415);
    if (image.size > MAX_IMAGE_BYTES) return failure("Prepare a venue image under 3 MB before estimating.", 413);
    form = new FormData();
    form.append("image", image, `venue.${image.type === "image/png" ? "png" : image.type === "image/webp" ? "webp" : "jpg"}`);
  } catch (error) {
    if (request.signal.aborted) return failure("Crowd estimation cancelled.", 499);
    if (timeout.aborted) return failure("Crowd estimation took too long. Try again shortly.", 504);
    return failure(error instanceof RangeError ? "Prepare a venue image under 3 MB before estimating." : "The venue image request could not be read.", error instanceof RangeError ? 413 : 400);
  }
  try {
    const response = await fetch(url, {
      method: "POST", body: form, cache: "no-store", redirect: "error",
      headers: { Authorization: `Bearer ${token}` }, signal,
    });
    if (Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES) {
      await response.body?.cancel();
      return failure("The crowd estimation response is too large.", 502);
    }
    const bytes = await readBounded(response.body, MAX_RESPONSE_BYTES, signal);
    let data: unknown;
    try { data = JSON.parse(new TextDecoder().decode(bytes)); }
    catch { return failure("The crowd estimation response could not be read.", 502); }
    if (!response.ok) {
      const message = data && typeof data === "object" && "error" in data && typeof data.error === "string"
        ? data.error.slice(0, 600) : "Crowd estimation is unavailable. Review your image and try again.";
      const retryAfter = response.headers.get("retry-after");
      const retryHeaders: Record<string, string> = response.status === 503 && retryAfter && /^\d{1,5}$/.test(retryAfter) ? { "Retry-After": retryAfter } : {};
      return failure(message, response.status === 503 ? 503 : response.status >= 500 || [401, 403].includes(response.status) ? 502 : response.status, retryHeaders);
    }
    if (response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json" || !isCrowdEstimate(data))
      return failure("The crowd estimation response could not be read.", 502);
    return Response.json(data, { headers: privateHeaders });
  } catch (error) {
    if (request.signal.aborted) return failure("Crowd estimation cancelled.", 499);
    if (timeout.aborted) return failure("Crowd estimation took too long. Try again shortly.", 504);
    return failure(error instanceof RangeError ? "The crowd estimation response is too large." : "Crowd estimation is unavailable. Try again shortly.", error instanceof RangeError ? 502 : 503);
  }
}
