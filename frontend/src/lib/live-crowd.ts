import { isCrowdEstimate, type CrowdEstimate } from "./crowd-estimates";

export const MAX_LIVE_FRAME_BYTES = 3 * 1024 * 1024;
export const MAX_LIVE_PREVIEW_CHARACTERS = 360_000;

export type LiveCrowdSession = {
  session_id: string;
  viewer_token: string;
  camera_token: string;
  expires_at: string;
};

export type LiveCrowdSnapshot = {
  session_id: string;
  expires_at: string;
  sequence: number;
  updated_at: string | null;
  estimate: CrowdEstimate | null;
  preview: string | null;
  status: "waiting" | "live" | "paused";
};

type RequestOptions = { signal?: AbortSignal };
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const timestamp = (value: unknown): value is string => typeof value === "string" &&
  value.length <= 40 && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(value) && Number.isFinite(Date.parse(value));
const onlyKeys = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

export function isLiveCrowdSessionId(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{32}$/.test(value);
}

export function isLiveCrowdToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43,128}$/.test(value);
}

export function isLiveCrowdSession(value: unknown): value is LiveCrowdSession {
  return record(value) && onlyKeys(value, ["session_id", "viewer_token", "camera_token", "expires_at"]) &&
    isLiveCrowdSessionId(value.session_id) && isLiveCrowdToken(value.viewer_token) &&
    isLiveCrowdToken(value.camera_token) && value.viewer_token !== value.camera_token && timestamp(value.expires_at);
}

export function isLiveCrowdSnapshot(value: unknown, expectedSessionId?: string): value is LiveCrowdSnapshot {
  if (!record(value) || !onlyKeys(value, ["session_id", "expires_at", "sequence", "updated_at", "estimate", "preview", "status"]) ||
    !isLiveCrowdSessionId(value.session_id) || (expectedSessionId !== undefined && value.session_id !== expectedSessionId) ||
    !timestamp(value.expires_at) || !Number.isSafeInteger(value.sequence) || (value.sequence as number) < 0 ||
    (value.updated_at !== null && !timestamp(value.updated_at)) ||
    (value.estimate !== null && !isCrowdEstimate(value.estimate)) ||
    !["waiting", "live", "paused"].includes(value.status as string)) return false;
  if (value.preview !== null && (typeof value.preview !== "string" || value.preview.length > MAX_LIVE_PREVIEW_CHARACTERS ||
    !/^data:image\/jpeg;base64,(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.preview) ||
    value.preview.length <= "data:image/jpeg;base64,".length)) return false;
  // A frame's count, image, and timestamp are published together.
  return (value.estimate === null) === (value.preview === null) && (value.estimate === null) === (value.updated_at === null) &&
    (value.status !== "live" || value.estimate !== null);
}

export class LiveCrowdError extends Error {
  readonly status: number;

  constructor(message: string, status = 0) {
    super(message);
    this.name = "LiveCrowdError";
    this.status = status;
  }
}

function credentials(id: string, token: string) {
  if (!isLiveCrowdSessionId(id) || !isLiveCrowdToken(token))
    throw new LiveCrowdError("This live feed link is invalid. Start a new feed.", 401);
}

async function liveRequest(path: string, init: RequestInit, options: RequestOptions = {}) {
  options.signal?.throwIfAborted();
  const timeout = AbortSignal.timeout(60_000);
  let response: Response;
  try {
    response = await fetch(`/api/live-crowd${path}`, {
      ...init, cache: "no-store", credentials: "same-origin",
      signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
    });
  } catch {
    options.signal?.throwIfAborted();
    throw new LiveCrowdError(timeout.aborted ? "Live crowd estimation took too long. Try again shortly." : "Live crowd estimation is unavailable. Check your connection.", timeout.aborted ? 504 : 0);
  }
  if (!response.ok) {
    const data: unknown = await response.json().catch(() => null);
    const message = record(data) && typeof data.error === "string" && data.error.length > 0 && data.error.length <= 600
      ? data.error : "Live crowd estimation could not finish. Try again shortly.";
    throw new LiveCrowdError(message, response.status);
  }
  return response;
}

export async function createLiveCrowdSession(options: RequestOptions = {}): Promise<LiveCrowdSession> {
  const response = await liveRequest("", { method: "POST" }, options);
  const data: unknown = await response.json().catch(() => null);
  if (!isLiveCrowdSession(data)) throw new LiveCrowdError("The live feed could not be created. Try again.", 502);
  return data;
}

export async function getLiveCrowdSession(id: string, viewerToken: string, options: RequestOptions = {}): Promise<LiveCrowdSnapshot> {
  credentials(id, viewerToken);
  const response = await liveRequest(`/${id}`, { headers: { "X-Crowdy-Live-Token": viewerToken } }, options);
  return snapshotResponse(response, id);
}

export async function endLiveCrowdSession(id: string, viewerToken: string, options: RequestOptions & { keepalive?: boolean } = {}): Promise<void> {
  credentials(id, viewerToken);
  await liveRequest(`/${id}`, { method: "DELETE", keepalive: options.keepalive, headers: { "X-Crowdy-Live-Token": viewerToken } }, options);
}

export async function sendLiveCrowdFrame(id: string, cameraToken: string, image: Blob, options: RequestOptions = {}): Promise<LiveCrowdSnapshot> {
  credentials(id, cameraToken);
  if (!image.size || !["image/png", "image/jpeg", "image/webp"].includes(image.type))
    throw new LiveCrowdError("Capture a readable PNG, JPEG, or WebP camera frame.", 415);
  if (image.size > MAX_LIVE_FRAME_BYTES) throw new LiveCrowdError("Prepare a camera frame under 3 MB.", 413);
  const form = new FormData();
  form.append("image", image, `camera.${image.type === "image/png" ? "png" : image.type === "image/webp" ? "webp" : "jpg"}`);
  const response = await liveRequest(`/${id}/frames`, { method: "POST", body: form, headers: { "X-Crowdy-Live-Token": cameraToken } }, options);
  return snapshotResponse(response, id);
}

export async function pauseLiveCrowdSession(id: string, cameraToken: string, options: RequestOptions & { keepalive?: boolean } = {}): Promise<LiveCrowdSnapshot> {
  credentials(id, cameraToken);
  const response = await liveRequest(`/${id}/pause`, { method: "POST", keepalive: options.keepalive, headers: { "X-Crowdy-Live-Token": cameraToken } }, options);
  return snapshotResponse(response, id);
}

async function snapshotResponse(response: Response, id: string): Promise<LiveCrowdSnapshot> {
  const data: unknown = await response.json().catch(() => null);
  if (!isLiveCrowdSnapshot(data, id)) throw new LiveCrowdError("The live crowd estimate could not be read. Try again shortly.", 502);
  return data;
}
