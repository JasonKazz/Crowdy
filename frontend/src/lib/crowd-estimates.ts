import {MAX_CROWD_SIZE} from "./crowd-limits.ts";

export type CrowdEstimate = {
  estimate_id: string;
  count: number;
  detections: { confidence: number; bbox: [number, number, number, number] }[];
  image: { width: number; height: number };
  model: string;
  processing_ms: number;
  warnings: string[];
  method?: "detections" | "density";
  density_count?: number;
  inference?: {
    strategy: "whole" | "tiled";
    tiles_processed: number;
    tiles_planned: number;
    max_detections: number;
    truncated: boolean;
    complete: boolean;
  };
};

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, limit: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= limit;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

export function isCrowdEstimate(value: unknown): value is CrowdEstimate {
  if (!record(value) || !text(value.estimate_id, 128) || !text(value.model, 256) ||
    !Number.isSafeInteger(value.count) || (value.count as number) < 0 || (value.count as number) > MAX_CROWD_SIZE ||
    !finite(value.processing_ms) || value.processing_ms < 0 || !record(value.image) ||
    !Number.isSafeInteger(value.image.width) || (value.image.width as number) < 1 ||
    !Number.isSafeInteger(value.image.height) || (value.image.height as number) < 1 ||
    !Array.isArray(value.detections) ||
    !Array.isArray(value.warnings) || !value.warnings.every(warning => text(warning, 600))) return false;
  if (value.inference !== undefined) {
    const meta = value.inference;
    if (!record(meta) || !["whole", "tiled"].includes(meta.strategy as string) ||
      !Number.isSafeInteger(meta.tiles_processed) || (meta.tiles_processed as number) < 0 ||
      !Number.isSafeInteger(meta.tiles_planned) || (meta.tiles_planned as number) < 1 ||
      (meta.tiles_processed as number) > (meta.tiles_planned as number) ||
      !Number.isSafeInteger(meta.max_detections) || (meta.max_detections as number) < (value.count as number) ||
      (meta.max_detections as number) > MAX_CROWD_SIZE || typeof meta.truncated !== "boolean" || typeof meta.complete !== "boolean" ||
      (meta.complete && (meta.truncated || meta.tiles_processed !== meta.tiles_planned))) return false;
  }
  if (value.method === "density") {
    if (!finite(value.density_count) || value.density_count < 0 || value.detections.length !== 0) return false;
    const truncated = record(value.inference) && value.inference.truncated === true;
    if (truncated ? value.density_count < (value.count as number) : Math.floor(value.density_count + .5) !== value.count) return false;
  } else if ((value.method !== undefined && value.method !== "detections") || value.density_count !== undefined || value.detections.length !== value.count) return false;
  const { width, height } = value.image as { width: number; height: number };
  return value.detections.every(detection => {
    if (!record(detection) || !finite(detection.confidence) || detection.confidence < 0 || detection.confidence > 1 ||
      !Array.isArray(detection.bbox) || detection.bbox.length !== 4 || !detection.bbox.every(finite)) return false;
    const [x1, y1, x2, y2] = detection.bbox as number[];
    return x1 >= 0 && y1 >= 0 && x2 > x1 && y2 > y1 && x2 <= width && y2 <= height;
  });
}

/** Partial scans and detector caps are lower bounds, never automatic occupancy. */
export function isUsableCrowdEstimate(estimate: CrowdEstimate | null | undefined): boolean {
  return Boolean(estimate && estimate.count <= MAX_CROWD_SIZE &&
    (!estimate.inference || (estimate.inference.complete && !estimate.inference.truncated)));
}

// Several views can show the same people. Never add their counts together.
export function largestCrowdEstimate(estimates: CrowdEstimate[]): number | null {
  return estimates.length ? Math.max(...estimates.map(estimate => estimate.count)) : null;
}

export async function estimateVenueCrowd(image: Blob, options: { signal?: AbortSignal } = {}): Promise<CrowdEstimate> {
  if (!["image/png", "image/jpeg", "image/webp"].includes(image.type) || image.size === 0)
    throw new Error("Choose a readable PNG, JPEG, or WebP venue image.");
  if (image.size > 3 * 1024 * 1024) throw new Error("Prepare a venue image under 3 MB before estimating.");
  options.signal?.throwIfAborted();
  const form = new FormData();
  form.append("image", image, `venue.${image.type === "image/png" ? "png" : image.type === "image/webp" ? "webp" : "jpg"}`);
  const timeout = AbortSignal.timeout(60_000);
  let response: Response;
  try {
    response = await fetch("/api/crowd-estimates", {
      method: "POST", body: form, cache: "no-store",
      signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
    });
  } catch {
    options.signal?.throwIfAborted();
    throw new Error(timeout.aborted ? "Crowd estimation took too long. Try again shortly." : "Crowd estimation is unavailable. Try again shortly.");
  }
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = record(data) && text(data.error, 600) ? data.error : "Crowd estimation could not finish. Try again shortly.";
    throw new Error(message);
  }
  if (!isCrowdEstimate(data)) throw new Error("The crowd estimate could not be read. Review the image and try again.");
  return data;
}
