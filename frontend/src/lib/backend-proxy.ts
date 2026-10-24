const MAX_BODY_BYTES = 1024 * 1024;
const headers = { "Cache-Control": "private, no-store" };

function backendUrl(path: string) {
  const base =
    process.env.CROWDY_BACKEND_URL ||
    (process.env.NODE_ENV === "development" ? "http://127.0.0.1:8000" : "");
  if (!base) return null;
  const url = new URL(base.replace(/\/$/, "") + path);
  if (!["http:", "https:"].includes(url.protocol)) return null;
  return url;
}

export async function forwardBackendImage(request: Request, imageId: string) {
  if (!/^[a-f0-9]{32}$/.test(imageId)) return failure("Invalid image reference.", 400);
  try {
    const url = backendUrl(`/api/floorplans/images/${imageId}`);
    if (!url) return failure("Image storage is unavailable.", 503);
    const token = process.env.CROWDY_BACKEND_TOKEN;
    const response = await fetch(url, {cache: "no-store", redirect: "error",
      headers: token ? {Authorization: `Bearer ${token}`} : {},
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(15_000)])});
    if (!response.ok) return failure("Source image unavailable on this server. Upload it again to restore the overlay.", response.status);
    if (!response.headers.get("content-type")?.startsWith("image/png")) return failure("Invalid source image.", 502);
    const image = await response.arrayBuffer();
    if (image.byteLength > 32 * 1024 * 1024) return failure("Source image is too large.", 502);
    return new Response(image, {headers: {...headers, "Content-Type": "image/png", "X-Content-Type-Options": "nosniff"}});
  } catch {
    return failure("Source image unavailable on this server.", 503);
  }
}

export function failure(error: string, status: number) {
  return Response.json({ error }, { status, headers });
}

export async function readBackendBody(request: Request, limit = MAX_BODY_BYTES) {
  if (Number(request.headers.get("content-length")) > limit)
    throw new RangeError("The workspace is too large to simulate.");
  const reader = request.body?.getReader();
  if (!reader) throw new Error("Choose a floor plan and scenario first.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new RangeError("The workspace is too large to simulate.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

export async function forwardBackend(request: Request, path: string, body?: unknown, timeout = 55_000) {
  let url: URL | null;
  try {
    url = backendUrl(path);
  } catch {
    return failure("Simulation service configuration is invalid.", 503);
  }
  if (!url)
    return failure("Simulation service is not configured for this deployment.", 503);
  const token = process.env.CROWDY_BACKEND_TOKEN;
  try {
    const response = await fetch(url, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(timeout)]),
    });
    const data = await response.json();
    if (!response.ok) {
      const message =
        typeof data.error === "string"
          ? data.error.slice(0, 600)
          : typeof data.detail === "string"
            ? data.detail.slice(0, 600)
          : "The simulation could not run. Check the layout and try again.";
      return failure(message, response.status >= 500 ? 502 : response.status);
    }
    const payload = JSON.stringify(data);
    if (Buffer.byteLength(payload) > 4 * 1024 * 1024)
      return failure(
        "This run produced too much playback data. Reduce occupancy and try again.",
        502,
      );
    return new Response(payload, {
      status: response.status,
      headers: { ...headers, "Content-Type": "application/json" },
    });
  } catch (error) {
    if (request.signal.aborted)
      return failure("Run cancelled. Your current setup is unchanged.", 499);
    if (error instanceof Error && error.name === "TimeoutError")
      return failure(path === "/api/floorplans"
        ? "Image extraction took too long. Check the provider status, then retry or choose the other provider."
        : "The run took too long. Reduce occupancy and try again.", 504);
    return failure(
      "The simulation service is unavailable. Your current setup is unchanged; try again shortly.",
      503,
    );
  }
}
