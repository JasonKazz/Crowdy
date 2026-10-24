import "server-only";

import { auth0 } from "@/lib/auth0";
import { failure, readBackendBody } from "@/lib/backend-proxy";

const privateHeaders = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
const workspaceId = /^ws-[a-zA-Z0-9-]{8,128}$/;
const sourceId = /^[a-zA-Z0-9-]{1,128}$/;
const MAX_JSON_BYTES = 4_350_000; // 3 MiB image in base64 + metadata, below the hosting limit.

export async function proxyWorkspace(request: Request, path: string[]) {
  const collection = path.length === 0;
  const workspace = path.length === 1 && workspaceId.test(path[0]);
  const sources = path.length === 2 && workspaceId.test(path[0]) && path[1] === "sources";
  const source = path.length === 3 && workspaceId.test(path[0]) && path[1] === "sources" && sourceId.test(path[2]);
  const image = path.length === 4 && workspaceId.test(path[0]) && path[1] === "sources" && sourceId.test(path[2]) && path[3] === "image";
  const allowed = collection ? ["GET", "POST"] : workspace ? ["GET", "PUT", "DELETE"] : sources ? ["GET", "POST"] : source ? ["DELETE"] : image ? ["GET"] : [];
  if (!allowed.length) return failure("Workspace endpoint not found.", 404);
  if (!allowed.includes(request.method)) return failure("Method not allowed.", 405);
  const session = await auth0.getSession();
  const owner = session?.user.sub;
  if (typeof owner !== "string" || !owner) return failure("Sign in to access your workspaces.", 401);
  const account = request.headers.get("X-Crowdy-Account");
  if (account && account !== owner) return failure("Your account changed. Refresh the page before saving.", 409);
  if (request.method !== "GET") {
    const origin = request.headers.get("origin");
    if (origin && ![new URL(request.url).origin, process.env.APP_BASE_URL].includes(origin))
      return failure("Open Crowdy to update your workspace.", 403);
    if (request.headers.get("sec-fetch-site") === "cross-site") return failure("Open Crowdy to update your workspace.", 403);
  }
  let url: URL;
  const token = process.env.CROWDY_BACKEND_TOKEN;
  try {
    const base = process.env.CROWDY_BACKEND_URL || (process.env.NODE_ENV === "development" ? "http://127.0.0.1:8000" : "");
    if (!base || !token) return failure("Cloud workspace storage is not configured.", 503);
    url = new URL(`${base.replace(/\/$/, "")}/api/workspaces${path.length ? `/${path.map(encodeURIComponent).join("/")}` : ""}`);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error();
  } catch { return failure("Cloud workspace storage configuration is invalid.", 503); }
  let body: unknown;
  if (["POST", "PUT"].includes(request.method)) {
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return failure("Send a JSON workspace request.", 415);
    try {
      body = await readBackendBody(request, sources ? MAX_JSON_BYTES : 2 * 1024 * 1024);
      if (!body || typeof body !== "object" || Array.isArray(body)) return failure("Invalid workspace request.", 400);
      // Ownership always comes from the Auth0 session, never request JSON/headers.
      const permitted = sources ? ["id", "name", "image_base64"] : collection ? ["id", "name", "plan", "scenario"] : ["name", "plan", "scenario", "expectedUpdatedAt"];
      if (Object.keys(body).some(key => !permitted.includes(key))) return failure("Invalid workspace fields.", 400);
      if (sources) {
        const encoded = (body as Record<string, unknown>).image_base64;
        if (typeof encoded !== "string" || encoded.length > 4_194_304) return failure("Choose an image under 3 MB after preparation.", 413);
      }
    } catch (error) { return failure(error instanceof RangeError ? "The workspace request is too large." : "The workspace request could not be read.", error instanceof RangeError ? 413 : 400); }
  }
  try {
    const response = await fetch(url, {
      method: request.method, cache: "no-store", redirect: "error",
      headers: { Authorization: `Bearer ${token}`, "X-Crowdy-Owner": owner, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(45_000)]),
    });
    if (response.status === 204) return new Response(null, { status: 204, headers: privateHeaders });
    const limit = 4 * 1024 * 1024;
    if (Number(response.headers.get("content-length")) > limit) return failure(collection ? "Your workspace library is too large to load at once. Contact support to export or reduce it." : "The saved workspace response is too large.", 502);
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > limit) return failure(collection ? "Your workspace library is too large to load at once. Contact support to export or reduce it." : "The saved workspace response is too large.", 502);
    if (!response.ok) {
      let data: { error?: unknown; detail?: unknown } | null = null;
      try { data = JSON.parse(new TextDecoder().decode(bytes)); } catch { /* Do not expose an upstream HTML error. */ }
      const message = typeof data?.error === "string" ? data.error : typeof data?.detail === "string" ? data.detail : "Your workspace could not be saved. Try again.";
      return failure(message.slice(0, 600), response.status >= 500 ? 502 : response.status);
    }
    const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
    if (image ? !["image/png", "image/jpeg", "image/webp"].includes(contentType ?? "") : contentType !== "application/json")
      return failure("The saved workspace response could not be read.", 502);
    return new Response(bytes, { status: response.status, headers: { ...privateHeaders, "Content-Type": contentType! } });
  } catch {
    return failure(request.signal.aborted ? "Workspace request cancelled." : "Cloud workspace storage is unavailable. Try again shortly.", request.signal.aborted ? 499 : 503);
  }
}
