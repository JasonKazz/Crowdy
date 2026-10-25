export const SIMULATION_TIMEOUT_MS = 180_000;
const POLL_INTERVAL_MS = 1_000;
const jobId = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{32}$/.test(value);
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));

export type SimulationProgress = {
  phase: string;
  populationCount: number;
  simulationTime: number;
  evacuatedCount: number;
  elapsedSeconds: number;
};

function wait(signal: AbortSignal, duration: number) {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, duration);
    signal.addEventListener("abort", abort, {once:true});
  });
}

/** One native job, bounded polling, and cancellation of abandoned server work. */
export async function submitSimulation(input: unknown, options: {
  signal?: AbortSignal;
  onProgress?: (progress: SimulationProgress) => void;
  timeoutMs?: number;
  pollIntervalMs?: number;
} = {}): Promise<unknown> {
  const deadline = AbortSignal.timeout(Math.min(options.timeoutMs ?? SIMULATION_TIMEOUT_MS, SIMULATION_TIMEOUT_MS));
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  let activeJob: string | null = null;
  let completed = false;
  let cancellationSent = false;
  const cancel = () => {
    if (activeJob && !completed && !cancellationSent) {
      cancellationSent=true;
      void fetch(`/api/simulations?job_id=${activeJob}`, {
      method:"DELETE",cache:"no-store",keepalive:true,signal:AbortSignal.timeout(5_000),
    }).catch(() => undefined);
    }
  };
  signal.addEventListener("abort", cancel, {once:true});
  async function read(response: Response, initial = false) {
    let data: unknown;
    try { data = await response.json(); }
    catch { signal.throwIfAborted(); throw new Error("The simulation service returned an unreadable response. Please try again."); }
    // Preserve a server-created reference even if cancellation arrives with
    // the response body; the catch below can then stop that native worker.
    if (initial && response.ok && record(data) && jobId(data.job_id)) activeJob=data.job_id;
    signal.throwIfAborted();
    if (!response.ok) throw new Error(record(data) && typeof data.error === "string" && data.error.trim()
      ? data.error.slice(0,600) : `Simulation failed (HTTP ${response.status}). Please try again.`);
    return data;
  }
  try {
    signal.throwIfAborted();
    let response: Response;
    try { response = await fetch("/api/simulations", {method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify(input),signal,cache:"no-store"}); }
    catch { signal.throwIfAborted(); throw new Error("Unable to reach the simulation service. Please try again."); }
    let data = await read(response,true);
    if (!record(data) || !("job_id" in data)) { completed=true; return data; }
    if (!jobId(data.job_id)) throw new Error("The simulation service returned an invalid job reference.");
    activeJob = data.job_id;
    for (;;) {
      if (!record(data) || data.job_id !== activeJob || !["running","complete","failed"].includes(data.status as string))
        throw new Error("The simulation service returned an invalid job status.");
      if (data.status === "complete") {
        if (!record(data.result)) throw new Error("The simulation result could not be read.");
        completed=true; return data.result;
      }
      if (data.status === "failed") throw new Error(typeof data.error === "string" && data.error.trim()
        ? data.error.slice(0,600) : "This forecast could not finish. Review the layout and retry.");
      if (record(data.progress)) {
        const p=data.progress;
        const numeric=[p.population_count,p.simulation_time,p.evacuated_count,p.elapsed_seconds];
        if (typeof p.phase !== "string" || p.phase.length > 100 || numeric.some(value => typeof value !== "number" || !Number.isFinite(value) || value < 0))
          throw new Error("The simulation service returned invalid progress.");
        options.onProgress?.({phase:p.phase,populationCount:p.population_count as number,simulationTime:p.simulation_time as number,
          evacuatedCount:p.evacuated_count as number,elapsedSeconds:p.elapsed_seconds as number});
      }
      await wait(signal, options.pollIntervalMs ?? POLL_INTERVAL_MS);
      data = await read(await fetch(`/api/simulations?job_id=${activeJob}`,{signal,cache:"no-store"}));
    }
  } catch (error) {
    cancel();
    if (options.signal?.aborted) throw options.signal.reason ?? error;
    if (deadline.aborted) throw new Error("This forecast reached its processing deadline. Your layout is unchanged; try again.");
    throw error;
  } finally { signal.removeEventListener("abort",cancel); }
}
