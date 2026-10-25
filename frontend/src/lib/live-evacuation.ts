import type { FloorPlan, Scenario, SimulationResult } from "./simulation";
import {MAX_CROWD_SIZE} from "./crowd-limits.ts";
import {LIVE_STALE_AFTER_MS} from "./live-camera.ts";

export const LIVE_EVACUATION_MAX_FRAME_AGE_MS = LIVE_STALE_AFTER_MS;
export const LIVE_EVACUATION_MIN_INTERVAL_MS = 10_000;
const MAX_CAMERA_CLOCK_SKEW_MS = 5_000;

export type LiveCrowdObservation = {
  count: number | null;
  rawCount: number | null;
  updatedAt: string | null;
  sessionId: string | null;
  status: "disconnected" | "waiting" | "live" | "paused" | "stale" | "error" | "ended";
  sequence: number;
  complete?: boolean;
};

export type LiveEvacuationInput = {
  plan: FloorPlan;
  scenario: Scenario;
  observation: LiveCrowdObservation;
  enabled: boolean;
  blocked: boolean;
};

/** The exact camera frame and editor snapshot that started a request. */
export type LiveEvacuationSubmission = {
  plan: FloorPlan;
  scenario: Scenario;
  count: number;
  sourceUpdatedAt: string;
  sourceSequence: number;
  sessionId: string;
  startedAt: number;
};

export type LiveEvacuationCompletion = LiveEvacuationSubmission & {
  result: SimulationResult;
  completedAt: number;
};

export type LiveEvacuationState = {
  status: "idle" | "waiting" | "running" | "current" | "error" | "paused";
  reason: string | null;
  error: string | null;
  completed: LiveEvacuationCompletion | null;
  active: LiveEvacuationSubmission | null;
  pending: boolean;
  current: boolean;
  nextRunAt: number | null;
  observation: LiveCrowdObservation | null;
};

export function initialLiveEvacuationState(): LiveEvacuationState {
  return Object.freeze({ status: "idle", reason: null, error: null, completed: null, active: null,
    pending: false, current: false, nextRunAt: null, observation: null });
}

export type LiveEvacuationClock = {
  now: () => number;
  setTimeout: (callback: () => void, delay: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};

type RunnerOptions = {
  run: (plan: FloorPlan, scenario: Scenario, options: { signal: AbortSignal }) => Promise<SimulationResult>;
  onState?: (state: LiveEvacuationState) => void;
  clock?: LiveEvacuationClock;
};

type DesiredRun = Omit<LiveEvacuationSubmission, "startedAt"> & { key: string; expiresAt: number };
type ActiveRun = { submission: LiveEvacuationSubmission; key: string; controller: AbortController; invalidated: boolean };
type Unavailable = { status: "idle" | "waiting" | "paused"; reason: string };

const defaultClock: LiveEvacuationClock = {
  now: () => Date.now(),
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

// Object insertion order is not part of a simulation's identity.
function keyFor(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
}

function liveScenario(scenario: Scenario, count: number): Scenario {
  // Only camera occupancy is used. In particular, room overrides and historical
  // starting populations must never replace the live total or reuse a baseline.
  const population = scenario.population;
  return {
    occupancy: count,
    mobility: scenario.mobility,
    distribution: scenario.distribution,
    ...(population ? { population: {
      ...(population.buildingType === undefined ? {} : { buildingType: population.buildingType }),
      ...(population.activity === undefined ? {} : { activity: population.activity }),
      ...(population.roomTypes === undefined ? {} : { roomTypes: structuredClone(population.roomTypes) }),
    } } : {}),
    ...(scenario.seed === undefined ? {} : { seed: scenario.seed }),
    ...(scenario.blockedExitIds === undefined ? {} : { blockedExitIds: structuredClone(scenario.blockedExitIds) }),
    ...(scenario.behaviorMode === undefined ? {} : { behaviorMode: scenario.behaviorMode }),
    ...(scenario.bodyWidth === undefined ? {} : { bodyWidth: scenario.bodyWidth }),
  };
}

/**
 * Serial, latest-only simulation scheduling, independent of React and transport.
 * Aborted requests keep their concurrency slot until their promise settles; a
 * transport that ignores AbortSignal can therefore never cause overlapping runs.
 */
export class LiveEvacuationRunner {
  private readonly run: RunnerOptions["run"];
  private readonly clock: LiveEvacuationClock;
  private readonly listeners = new Set<(state: LiveEvacuationState) => void>();
  private input: LiveEvacuationInput | null = null;
  private snapshot = initialLiveEvacuationState();
  private activeRun: ActiveRun | null = null;
  private completed: LiveEvacuationCompletion | null = null;
  private completedKey: string | null = null;
  private sessionId: string | null = null;
  private lastStartedAt = -Infinity;
  private failure: { key: string; message: string; retryAt: number } | null = null;
  private timer: unknown = null;
  private disposed = false;

  constructor({ run, onState, clock = defaultClock }: RunnerOptions) {
    this.run = run;
    this.clock = clock;
    if (onState) this.listeners.add(onState);
  }

  get state(): LiveEvacuationState { return this.snapshot; }

  subscribe(listener: (state: LiveEvacuationState) => void): () => void {
    if (this.disposed) return () => {};
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => { this.listeners.delete(listener); };
  }

  update(input: LiveEvacuationInput): void {
    if (this.disposed) return;
    this.input = structuredClone(input);
    if (input.observation.sessionId !== this.sessionId) {
      this.invalidateActive();
      this.sessionId = input.observation.sessionId;
      this.completed = null;
      this.completedKey = null;
      this.failure = null;
    }
    this.refresh();
  }

  /** Re-evaluate freshness; this deliberately does not bypass deduplication. */
  refresh(): void {
    if (this.disposed) return;
    this.clearTimer();
    const now = this.clock.now();
    const candidate = this.desired(now);
    if (!("key" in candidate)) {
      this.invalidateActive();
      this.publish({ status: candidate.status, reason: candidate.reason, error: null,
        completed: this.completed, active: this.activeRun?.submission ?? null, pending: false, current: false, nextRunAt: null,
        observation: this.input?.observation ?? null });
      return;
    }

    const current = this.completedKey === candidate.key && this.completed?.sessionId === candidate.sessionId;
    const retryAt = this.failure?.key === candidate.key ? this.failure.retryAt : -Infinity;
    const nextRunAt = Math.max(this.lastStartedAt + LIVE_EVACUATION_MIN_INTERVAL_MS, retryAt);
    if (!this.activeRun && !current && now >= nextRunAt) {
      this.start(candidate, now);
      return;
    }

    const active = this.activeRun?.submission ?? null;
    const running = this.activeRun && !this.activeRun.invalidated;
    const error = !running && !current && this.failure?.key === candidate.key ? this.failure.message : null;
    this.publish({
      status: running ? "running" : current ? "current" : error ? "error" : "waiting",
      reason: running ? (this.activeRun?.key === candidate.key ? "Simulating the live crowd." : "A newer crowd or layout is waiting.")
        : current ? null : this.activeRun ? "Waiting for the previous request to stop."
          : error ? "The simulation will retry while fresh camera data is available." : "Waiting for the next live simulation.",
      error,
      completed: this.completed,
      active,
      pending: !current && (!running || this.activeRun?.key !== candidate.key),
      current,
      nextRunAt: this.activeRun || current ? null : nextRunAt,
      observation: this.input!.observation,
    });
    // Even an unchanged count expires. No new frame means no current forecast.
    this.schedule(Math.min(candidate.expiresAt, !this.activeRun && !current ? nextRunAt : Infinity) - now);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearTimer();
    this.invalidateActive();
    this.listeners.clear();
  }

  private desired(now: number): DesiredRun | Unavailable {
    const input = this.input;
    if (!input?.enabled) return { status: "idle", reason: "Live analytics is off." };
    if (input.blocked) return { status: "paused", reason: "Live analytics is paused while another simulation runs." };
    const observation = input.observation;
    if (observation.status === "paused") return { status: "paused", reason: "The camera is paused." };
    if (observation.status !== "live") return { status: "waiting", reason: observation.status === "stale"
      ? "Waiting for a fresh camera frame." : "Waiting for the live camera." };
    if (observation.complete === false) return {status:"waiting",reason:"The camera count is a lower bound. Waiting for a complete estimate."};
    const validCount = (count: number | null): count is number => Number.isSafeInteger(count) && count! >= 1 && count! <= MAX_CROWD_SIZE;
    if (!validCount(observation.count) || !validCount(observation.rawCount))
      return { status: "waiting", reason: `A live estimate of 1–${MAX_CROWD_SIZE.toLocaleString()} people is required.` };
    const capturedAt = observation.updatedAt === null ? NaN : Date.parse(observation.updatedAt);
    if (!Number.isFinite(capturedAt) || capturedAt > now + MAX_CAMERA_CLOCK_SKEW_MS || now - capturedAt >= LIVE_EVACUATION_MAX_FRAME_AGE_MS)
      return { status: "waiting", reason: "Waiting for a fresh camera frame." };
    if (!observation.sessionId || !Number.isSafeInteger(observation.sequence) || observation.sequence < 1)
      return { status: "waiting", reason: "Waiting for the live camera." };
    const plan = input.plan;
    const scenario = liveScenario(input.scenario, observation.count);
    return { plan, scenario, count: observation.count, sourceUpdatedAt: observation.updatedAt!,
      sourceSequence: observation.sequence, sessionId: observation.sessionId,
      expiresAt: capturedAt + LIVE_EVACUATION_MAX_FRAME_AGE_MS,
      key: keyFor([observation.sessionId, plan, scenario]) };
  }

  private start(candidate: DesiredRun, now: number): void {
    const { plan, scenario, count, sourceUpdatedAt, sourceSequence, sessionId } = candidate;
    const submission = freeze(structuredClone({ plan, scenario, count, sourceUpdatedAt, sourceSequence, sessionId, startedAt: now }));
    const job: ActiveRun = { submission, key: candidate.key, controller: new AbortController(), invalidated: false };
    this.activeRun = job;
    this.lastStartedAt = now;
    this.failure = null;
    this.publish({ status: "running", reason: "Simulating the live crowd.", error: null, completed: this.completed,
      active: submission, pending: false, current: false, nextRunAt: null, observation: this.input!.observation });
    this.schedule(candidate.expiresAt - now);
    void Promise.resolve().then(() => {
      job.controller.signal.throwIfAborted();
      return this.run(submission.plan, submission.scenario, { signal: job.controller.signal });
    }).then(result => {
      if (this.disposed || job.invalidated) return;
      const desired = this.desired(this.clock.now());
      if (!("key" in desired) || desired.sessionId !== submission.sessionId) return;
      // The submitted snapshot is authoritative even if a transport returns its
      // own mutable plan/scenario objects with the result.
      this.completed = freeze(structuredClone({ ...submission, completedAt: this.clock.now(),
        result: { ...result, plan: submission.plan, scenario: submission.scenario } }));
      this.completedKey = job.key;
      this.failure = null;
    }, error => {
      if (this.disposed || job.invalidated) return;
      this.failure = { key: job.key,
        message: error instanceof Error ? error.message : "Live evacuation estimation failed. Please try again.",
        retryAt: this.clock.now() + LIVE_EVACUATION_MIN_INTERVAL_MS };
    }).finally(() => {
      if (this.activeRun === job) this.activeRun = null;
      if (!this.disposed) this.refresh();
    });
  }

  private invalidateActive(): void {
    if (!this.activeRun || this.activeRun.invalidated) return;
    this.activeRun.invalidated = true;
    this.activeRun.controller.abort();
  }

  private schedule(delay: number): void {
    if (this.disposed || !Number.isFinite(delay)) return;
    this.timer = this.clock.setTimeout(() => { this.timer = null; this.refresh(); }, Math.max(1, delay));
  }

  private clearTimer(): void {
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
  }

  private publish(state: LiveEvacuationState): void {
    if (this.disposed) return;
    this.snapshot = freeze({ ...state });
    for (const listener of this.listeners) {
      if (this.disposed) break;
      listener(this.snapshot);
    }
  }
}
