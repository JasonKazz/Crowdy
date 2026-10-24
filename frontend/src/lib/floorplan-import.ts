/** Poll a bounded backend job without keeping an upload HTTP request open. */
export async function awaitFloorPlanImport(
  jobId: string,
  onProgress: (message: string) => void,
  signal?: AbortSignal,
) {
  if (!/^[a-f0-9]{32}$/.test(jobId)) throw new Error("Invalid import job reference.");
  const deadline = Date.now() + 15 * 60_000;
  while (Date.now() < deadline) {
    const response = await fetch(`/api/floorplans?job_id=${jobId}`, {
      cache: "no-store", signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(20_000)]),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not check image import progress.");
    if (data.status === "complete") return data.result;
    if (data.status === "failed") throw new Error(data.error || "Image import failed.");
    if (data.status !== "running") throw new Error("Invalid import status.");
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
