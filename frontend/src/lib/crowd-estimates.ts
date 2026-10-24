export type CrowdEstimate = {
  estimate_id: string;
  count: number;
  detections: { confidence: number; bbox: [number, number, number, number] }[];
  image: { width: number; height: number };
  model: string;
  processing_ms: number;
  warnings: string[];
};

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, limit: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= limit;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

export function isCrowdEstimate(value: unknown): value is CrowdEstimate {
  if (!record(value) || !text(value.estimate_id, 128) || !text(value.model, 256) ||
    !Number.isSafeInteger(value.count) || (value.count as number) < 0 ||
    !finite(value.processing_ms) || value.processing_ms < 0 || !record(value.image) ||
    !Number.isSafeInteger(value.image.width) || (value.image.width as number) < 1 ||
    !Number.isSafeInteger(value.image.height) || (value.image.height as number) < 1 ||
    !Array.isArray(value.detections) || value.detections.length !== value.count ||
    !Array.isArray(value.warnings) || !value.warnings.every(warning => text(warning, 600))) return false;
  const { width, height } = value.image as { width: number; height: number };
  return value.detections.every(detection => {
    if (!record(detection) || !finite(detection.confidence) || detection.confidence < 0 || detection.confidence > 1 ||
      !Array.isArray(detection.bbox) || detection.bbox.length !== 4 || !detection.bbox.every(finite)) return false;
    const [x1, y1, x2, y2] = detection.bbox as number[];
    return x1 >= 0 && y1 >= 0 && x2 > x1 && y2 > y1 && x2 <= width && y2 <= height;
  });
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
