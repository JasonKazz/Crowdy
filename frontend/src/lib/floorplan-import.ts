type ImportResult = {
  plan: Record<string, unknown>;
  warnings?: string[];
} | {
  needs_scale: true;
  extraction_id: string;
  image_id: string;
  width_px: number;
  height_px: number;
  reason: string;
  current_width_m?: number;
  warnings?: string[];
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function serviceMessage(value: unknown, fallback: string) {
  return typeof value === "string" && value.trim() ? value.slice(0, 600) : fallback;
}

function completeResult(value: unknown): ImportResult {
  const invalid = () => new Error("The floor plan service returned an incomplete import result. Check its status and try again.");
  if (!record(value) || (value.warnings !== undefined &&
    (!Array.isArray(value.warnings) || !value.warnings.every(warning => typeof warning === "string"))))
    throw invalid();
  if (value.needs_scale === true) {
    if (typeof value.extraction_id !== "string" || !/^[a-f0-9]{32}$/.test(value.extraction_id) ||
      typeof value.image_id !== "string" || !/^[a-f0-9]{32}$/.test(value.image_id) ||
      typeof value.width_px !== "number" || !Number.isSafeInteger(value.width_px) || value.width_px <= 0 ||
      typeof value.height_px !== "number" || !Number.isSafeInteger(value.height_px) || value.height_px <= 0 ||
      typeof value.reason !== "string" || !value.reason.trim() ||
      (value.current_width_m !== undefined &&
        (typeof value.current_width_m !== "number" || !Number.isFinite(value.current_width_m) || value.current_width_m <= 0)))
      throw invalid();
  } else if (!record(value.plan) || (value.needs_scale !== undefined && value.needs_scale !== false)) {
    throw invalid();
  }
  // Geometry is checked by validatePlan when the workspace accepts the import.
  return value as ImportResult;
}

/** Poll a bounded backend job without keeping an upload HTTP request open. */
export async function awaitFloorPlanImport(
  jobId: string,
  onProgress: (message: string) => void,
  signal?: AbortSignal,
) {
  if (!/^[a-f0-9]{32}$/.test(jobId)) throw new Error("Invalid import job reference.");
  signal?.throwIfAborted();
  const deadline = Date.now() + 15 * 60_000;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    const requestSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(20_000)]);
    let response: Response;
    try {
      response = await fetch(`/api/floorplans?job_id=${jobId}`, {cache: "no-store", signal: requestSignal});
    } catch {
      requestSignal.throwIfAborted();
      throw new Error("Could not reach the floor plan service to check import progress. Check the connection and try again.");
    }
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      requestSignal.throwIfAborted();
      throw new Error("The floor plan service returned an unreadable import response. Check its status and try again.");
    }
    requestSignal.throwIfAborted();
    if (!record(data))
      throw new Error("The floor plan service returned an unreadable import response. Check its status and try again.");
    if (!response.ok) throw new Error(serviceMessage(data.error, "Could not check image import progress. Check the floor plan service and try again."));
    if (data.status === "complete") return completeResult(data.result);
    if (data.status === "failed") throw new Error(serviceMessage(data.error, "Image import failed. Check the floor plan service and try again."));
    if (data.status !== "running") throw new Error("The floor plan service returned an invalid import status. Check its status and try again.");
    if ((data.progress !== undefined && typeof data.progress !== "string") ||
      (data.elapsed_seconds !== undefined &&
        (typeof data.elapsed_seconds !== "number" || !Number.isFinite(data.elapsed_seconds) || data.elapsed_seconds < 0)))
      throw new Error("The floor plan service returned unreadable import progress. Check its status and try again.");
    onProgress(`${data.progress || "Reading floor plan"} · ${data.elapsed_seconds ?? 0}s`);
    await new Promise<void>((resolve, reject) => {
      const abort = () => {clearTimeout(timer); reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));};
      const timer = setTimeout(() => {signal?.removeEventListener("abort", abort); resolve();}, 2000);
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, {once: true});
    });
  }
  throw new Error("This import is taking too long. The provider may still be finishing; check its status before retrying.");
}
