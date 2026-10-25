// Scheduler fixtures: no camera, model download, browser, or backend required.
import assert from "node:assert/strict";
import { LiveEvacuationRunner, initialLiveEvacuationState,
  LIVE_EVACUATION_MAX_FRAME_AGE_MS, LIVE_EVACUATION_MIN_INTERVAL_MS } from "../src/lib/live-evacuation.ts";

const origin = Date.parse("2026-10-25T01:00:00Z");
const plan = { id: "fixture", name: "Fixture venue", width: 900, height: 600, area: 304,
  items: [{ id: "desk", label: "Desk", kind: "desk", x: 100, y: 100, width: 40, height: 40 }],
  walls: [{ x1: 80, y1: 90, x2: 820, y2: 90 }], exits: [{ id: "exit-a", label: "Exit A", x: 80, y: 300 }] };
const scenario = { occupancy: 180, mobility: "mixed", distribution: "rooms", seed: 19, blockedExitIds: ["exit-a"],
  bodyWidth: .52, behaviorMode: "behavioral", population: { buildingType: "venue", activity: "event",
    roomCounts: { lobby: 180 }, roomTypes: { lobby: "lobby" } } };

class FakeClock {
  time = origin;
  nextId = 1;
  tasks = new Map();
  now = () => this.time;
  setTimeout = (callback, delay) => {
    const id = this.nextId++;
    this.tasks.set(id, { callback, at: this.time + delay });
    return id;
  };
  clearTimeout = id => { this.tasks.delete(id); };
  advance(ms) {
    const target = this.time + ms;
    for (;;) {
      const next = [...this.tasks].filter(([, task]) => task.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.time = next[1].at;
      this.tasks.delete(next[0]);
      next[1].callback();
    }
    this.time = target;
  }
}

const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const simulationResult = (submittedPlan, submittedScenario) => ({ id: "fixture-result", plan: submittedPlan,
  scenario: submittedScenario, agents: [], totalTime: 42, averageTime: 21, peakDensity: 1.4,
  exited: submittedScenario.occupancy, remaining: 0, hotspot: { x: 100, y: 100 }, createdAt: origin,
  clearanceTime: 42, status: "completed", engine: "jupedsim" });

function fixture() {
  const clock = new FakeClock();
  const requests = [];
  const states = [];
  let unresolved = 0, maximumConcurrent = 0;
  const runner = new LiveEvacuationRunner({ clock, onState: state => states.push(state),
    run: (submittedPlan, submittedScenario, options) => {
      const request = deferred();
      unresolved++;
      maximumConcurrent = Math.max(maximumConcurrent, unresolved);
      requests.push({ ...request, plan: submittedPlan, scenario: submittedScenario, signal: options.signal,
        startedAt: clock.now() });
      // Deliberately ignore cancellation, exercising the serial gate separately
      // from whether an HTTP transport observes AbortSignal.
      return request.promise.finally(() => { unresolved--; });
    } });
  const input = (count = 20, changes = {}) => ({ plan: structuredClone(plan), scenario: structuredClone(scenario),
    enabled: true, blocked: false, observation: { count, rawCount: count, sessionId: "camera-a", sequence: 1,
      updatedAt: new Date(clock.now()).toISOString(), status: "live" }, ...changes });
  const update = (count = 20, changes = {}) => { const value = input(count, changes); runner.update(value); return value; };
  const finish = async (index = requests.length - 1) => {
    const request = requests[index];
    request.resolve(simulationResult(request.plan, request.scenario));
    await flush();
  };
  return { clock, requests, states, runner, input, update, finish,
    get maximumConcurrent() { return maximumConcurrent; } };
}

assert.equal(LIVE_EVACUATION_MAX_FRAME_AGE_MS, 12_000);
assert.equal(LIVE_EVACUATION_MIN_INTERVAL_MS, 10_000);
assert.deepEqual(initialLiveEvacuationState(), { status: "idle", reason: null, error: null, completed: null,
  active: null, pending: false, current: false, nextRunAt: null, observation: null });

// Live occupancy is isolated from manual overrides and preserved with a frozen,
// exact plan/settings/frame provenance snapshot.
{
  const f = fixture();
  const input = f.update(24);
  input.plan.items[0].x = 700;
  input.scenario.seed = 99;
  input.observation.count = 100;
  await flush();
  assert.equal(f.requests.length, 1);
  const request = f.requests[0];
  assert.equal(request.plan.items[0].x, 100);
  assert.equal(request.scenario.occupancy, 24);
  assert.equal(request.scenario.population.roomCounts, undefined);
  assert.deepEqual(request.scenario.population, { buildingType: "venue", activity: "event", roomTypes: { lobby: "lobby" } });
  for (const key of ["mobility", "distribution", "seed", "bodyWidth", "behaviorMode", "blockedExitIds"])
    assert.deepEqual(request.scenario[key], scenario[key]);
  assert.ok(Object.isFrozen(request.plan.items[0]));
  f.clock.advance(250);
  await f.finish();
  const completed = f.runner.state.completed;
  assert.equal(f.runner.state.status, "current");
  assert.equal(f.runner.state.current, true);
  assert.equal(completed.count, 24);
  assert.equal(completed.sourceUpdatedAt, new Date(origin).toISOString());
  assert.equal(completed.sourceSequence, 1);
  assert.equal(completed.sessionId, "camera-a");
  assert.equal(completed.startedAt, origin);
  assert.equal(completed.completedAt, origin + 250);
  assert.ok(Object.isFrozen(completed.result));
  assert.equal(completed.result.scenario.occupancy, 24);
  assert.equal(completed.plan.items[0].x, 100);
  assert.throws(() => { completed.scenario.occupancy = 200; }, TypeError);
  f.runner.dispose();
}

// No history queue: intermediate changing counts and layouts collapse to the
// latest snapshot. A running forecast is allowed to finish instead of starving.
{
  const f = fixture();
  f.update(20);
  await flush();
  f.clock.advance(2_000);
  f.update(30);
  f.clock.advance(2_000);
  const latestPlan = structuredClone(plan);
  latestPlan.items[0].x = 150;
  const latestScenario = { ...scenario, bodyWidth: .6, seed: 20 };
  f.update(45, { plan: latestPlan, scenario: latestScenario });
  assert.equal(f.runner.state.pending, true);
  assert.equal(f.requests[0].signal.aborted, false);
  assert.equal(f.runner.state.active.count, 20);
  await f.finish(0);
  assert.equal(f.runner.state.completed.count, 20);
  assert.equal(f.runner.state.current, false);
  assert.equal(f.runner.state.status, "waiting");
  assert.equal(f.runner.state.nextRunAt, origin + 10_000);
  f.clock.advance(5_999);
  assert.equal(f.requests.length, 1);
  f.clock.advance(1);
  await flush();
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[1].scenario.occupancy, 45);
  assert.equal(f.requests[1].scenario.bodyWidth, .6);
  assert.equal(f.requests[1].scenario.seed, 20);
  assert.equal(f.requests[1].plan.items[0].x, 150);
  assert.equal(f.requests[1].startedAt - f.requests[0].startedAt, 10_000);
  assert.equal(f.runner.state.completed.count, 20);
  assert.equal(f.runner.state.current, false);
  await f.finish(1);
  assert.equal(f.runner.state.current, true);
  assert.equal(f.runner.state.completed.count, 45);
  assert.equal(f.maximumConcurrent, 1);
  f.runner.dispose();
}

// Continued fresh same-count frames keep a forecast current without repeatedly
// simulating it, including changes to ignored manual counts and room overrides.
{
  const f = fixture();
  f.update(25);
  await flush();
  await f.finish();
  const completed = f.runner.state.completed;
  for (let i = 2; i <= 20; i++) {
    f.clock.advance(2_000);
    const value = f.input(25);
    value.observation.sequence = i;
    value.observation.rawCount = i % 2 ? 26 : 24;
    value.scenario.occupancy = i;
    value.scenario.population.roomCounts = { lobby: i };
    f.runner.update(value);
    await flush();
    assert.equal(f.runner.state.current, true);
    assert.equal(f.requests.length, 1);
    assert.equal(f.runner.state.observation.sequence, i);
    assert.equal(f.runner.state.completed, completed);
    assert.equal(completed.sourceSequence, 1, "A fresh equal count must not rewrite the source frame that ran");
  }
  f.clock.advance(12_000);
  assert.equal(f.runner.state.current, false);
  assert.equal(f.runner.state.status, "waiting");
  assert.equal(f.runner.state.completed, completed);
  f.runner.dispose();
}

// Geometry/settings changing after a completed result invalidate it even if
// occupancy is identical; semantic object key ordering does not.
{
  const f = fixture();
  f.update(18);
  await flush();
  await f.finish();
  const reorderedPlan = Object.fromEntries(Object.entries(structuredClone(plan)).reverse());
  f.update(18, { plan: reorderedPlan });
  assert.equal(f.runner.state.current, true);
  f.clock.advance(10_000);
  const editedPlan = structuredClone(plan);
  editedPlan.walls[0].x2 -= 20;
  f.update(18, { plan: editedPlan });
  await flush();
  assert.equal(f.requests.length, 2);
  assert.equal(f.runner.state.current, false);
  await f.finish();
  assert.equal(f.runner.state.current, true);
  f.clock.advance(10_000);
  f.update(18, { plan: editedPlan, scenario: { ...scenario, mobility: "standard" } });
  await flush();
  assert.equal(f.requests.length, 3);
  assert.equal(f.requests[2].scenario.mobility, "standard");
  f.runner.dispose();
  await f.finish();
}

// Smoothed counts cannot disguise a zero/out-of-range raw observation. Missing,
// stale, future, fractional, or non-live observations never start simulations.
for (const change of [
  { count: 0 }, { rawCount: 0 }, { count: 201 }, { rawCount: 201 }, { count: -1 },
  { count: 1.5 }, { rawCount: NaN }, { count: null }, { rawCount: null },
  { updatedAt: null }, { updatedAt: "invalid" }, { updatedAt: new Date(origin - 12_000).toISOString() },
  { updatedAt: new Date(origin + 5_001).toISOString() }, { sessionId: null }, { sequence: 0 }, { sequence: 1.1 },
  ...["disconnected", "waiting", "paused", "stale", "error", "ended"].map(status => ({ status })),
]) {
  const f = fixture();
  const input = f.input(20);
  Object.assign(input.observation, change);
  f.runner.update(input);
  await flush();
  assert.equal(f.requests.length, 0, JSON.stringify(change));
  assert.equal(f.runner.state.current, false);
  f.runner.dispose();
}
// A camera/server clock slightly ahead of the viewer uses the same five-second
// tolerance as the live feed. Every frame can be ahead when clocks differ.
for (const offset of [1, 1_000, 5_000]) {
  const f = fixture();
  const input = f.input(20);
  input.observation.updatedAt = new Date(origin + offset).toISOString();
  f.runner.update(input);
  await flush();
  assert.equal(f.requests.length, 1, `Accept ${offset} ms clock skew`);
  await f.finish();
  assert.equal(f.runner.state.current, true);
  f.runner.dispose();
}
for (const count of [1, 200]) {
  const f = fixture();
  f.update(count);
  await flush();
  assert.equal(f.requests[0].scenario.occupancy, count);
  f.runner.dispose();
  await f.finish();
}

// A stale frame cancels the active job automatically. Its late success is
// discarded while the in-flight gate remains occupied until actual settlement.
{
  const f = fixture();
  f.update(20);
  await flush();
  f.clock.advance(12_000);
  assert.equal(f.requests[0].signal.aborted, true);
  assert.equal(f.runner.state.active.count, 20);
  assert.equal(f.runner.state.current, false);
  assert.equal(f.runner.state.completed, null);
  f.update(40);
  await flush();
  assert.equal(f.requests.length, 1);
  assert.equal(f.runner.state.pending, true);
  await f.finish(0);
  assert.equal(f.runner.state.completed, null);
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[1].scenario.occupancy, 40);
  await f.finish(1);
  assert.equal(f.runner.state.current, true);
  assert.equal(f.maximumConcurrent, 1);
  f.runner.dispose();
}

// Pause, disable, and manual-run blocking invalidate late results; resuming
// cannot release an uncooperative request's serial slot prematurely.
for (const changes of [
  { enabled: false }, { blocked: true },
  { observation: { count: 20, rawCount: 20, sessionId: "camera-a", sequence: 1,
    updatedAt: new Date(origin).toISOString(), status: "paused" } },
]) {
  const f = fixture();
  f.update(20);
  await flush();
  f.runner.update(f.input(20, changes));
  assert.equal(f.requests[0].signal.aborted, true);
  assert.equal(f.runner.state.active.count, 20);
  assert.ok(["idle", "paused"].includes(f.runner.state.status));
  f.clock.advance(10_000);
  f.update(35);
  await flush();
  assert.equal(f.requests.length, 1);
  await f.finish(0);
  assert.equal(f.requests.length, 2);
  assert.equal(f.runner.state.completed, null);
  assert.equal(f.requests[1].scenario.occupancy, 35);
  await f.finish(1);
  assert.equal(f.runner.state.current, true);
  assert.equal(f.maximumConcurrent, 1);
  f.runner.dispose();
}

// Reconnecting to another camera clears the old camera's result and invalidates
// an older session's active completion without permitting concurrent requests.
{
  const f = fixture();
  f.update(20);
  await flush();
  await f.finish();
  f.clock.advance(10_000);
  let input = f.input(25);
  input.observation.sessionId = "camera-b";
  f.runner.update(input);
  await flush();
  assert.equal(f.runner.state.completed, null);
  f.clock.advance(1_000);
  input = f.input(30);
  input.observation.sessionId = "camera-c";
  f.runner.update(input);
  assert.equal(f.requests[1].signal.aborted, true);
  await f.finish(1);
  assert.equal(f.runner.state.completed, null);
  assert.equal(f.requests.length, 2);
  f.clock.advance(9_000);
  await flush();
  assert.equal(f.requests.length, 3);
  assert.equal(f.runner.state.active.sessionId, "camera-c");
  await f.finish(2);
  assert.equal(f.runner.state.completed.sessionId, "camera-c");
  assert.equal(f.maximumConcurrent, 1);
  f.runner.dispose();
}

// Failures retry at a bounded interval using the latest fresh frame. Repeated
// refreshes and frames cannot make an error spin or bypass the ten-second gap.
{
  const f = fixture();
  f.update(20);
  await flush();
  f.clock.advance(3_000);
  f.requests[0].reject(new Error("Fixture service unavailable"));
  await flush();
  assert.equal(f.runner.state.status, "error");
  assert.equal(f.runner.state.error, "Fixture service unavailable");
  assert.equal(f.runner.state.nextRunAt, origin + 13_000);
  for (let i = 0; i < 9; i++) {
    f.clock.advance(1_000);
    const input = f.input(20);
    input.observation.sequence = 2 + i;
    f.runner.update(input);
    f.runner.refresh();
    await flush();
    assert.equal(f.requests.length, 1);
  }
  f.clock.advance(1_000);
  await flush();
  assert.equal(f.requests.length, 2);
  assert.equal(f.runner.state.active.sourceSequence, 10);
  assert.equal(f.requests[1].startedAt, origin + 13_000);
  await f.finish(1);
  assert.equal(f.runner.state.current, true);
  assert.equal(f.runner.state.error, null);
  f.runner.dispose();
}

// Synchronous transport errors are handled as failures, and disposal prevents
// callbacks, scheduled retries, late settlements, and future update work.
{
  const clock = new FakeClock();
  let attempts = 0;
  const runner = new LiveEvacuationRunner({ clock, run: () => { attempts++; throw new Error("Synchronous fixture error"); } });
  const f = fixture();
  runner.update(f.input(20));
  await flush();
  assert.equal(attempts, 1);
  assert.equal(runner.state.status, "error");
  runner.dispose();
  clock.advance(30_000);
  assert.equal(attempts, 1);
  f.runner.dispose();
}
{
  const f = fixture();
  let subscriberCalls = 0;
  const unsubscribe = f.runner.subscribe(() => { subscriberCalls++; });
  assert.equal(subscriberCalls, 1);
  f.update(20);
  await flush();
  unsubscribe();
  const beforeSubscriber = subscriberCalls;
  f.runner.refresh();
  assert.equal(subscriberCalls, beforeSubscriber);
  const beforeDispose = f.states.length;
  f.runner.dispose();
  assert.equal(f.requests[0].signal.aborted, true);
  f.update(30);
  f.runner.refresh();
  f.clock.advance(60_000);
  await f.finish(0);
  assert.equal(f.states.length, beforeDispose);
  assert.equal(f.requests.length, 1);
  assert.equal(f.clock.tasks.size, 0);
}

console.log("Live evacuation checks passed: fresh camera-only occupancy, immutable source snapshots, latest-only serial scheduling, stable-count deduplication, geometry/settings invalidation, ten-second cooldown/retry, stale/pause/manual/session cancellation, late completion isolation, and disposal.");
