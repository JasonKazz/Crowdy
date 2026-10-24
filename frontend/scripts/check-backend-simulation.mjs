// Run with Node.js 22+: node --experimental-strip-types scripts/check-backend-simulation.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  adaptBackendSimulation,
  runBackendSimulation,
} from "../src/lib/backend-simulation.ts";
import {
  SAMPLE_PLAN,
  getEvacuatedCount,
  positionAt,
} from "../src/lib/simulation.ts";

const scenario = { occupancy: 2, mobility: "mixed", distribution: "workstations" };
const point = (id, x, y) => ({ id, x, y });
const fixture = {
  engine: "jupedsim",
  engine_version: "1.4.2",
  status: "timed_out",
  population_generation: null,
  editor_metadata: { seed: 42 },
  scenario: {
    settings: { dt: 0.01, sample_interval: 0.2, max_time: 60 },
    occupants: [
      { id: "source-z", position: [2, 10] },
      { id: "source-a", position: [2.5, 10] },
    ],
  },
  // Deliberately reordered: identities must follow IDs rather than array offsets.
  assignments: [
    { agent_id: "source-a", exit_id: "exit-b", route_length: 8 },
    { agent_id: "source-z", exit_id: "exit-a", route_length: 4 },
  ],
  frames: [
    { time: 0, agents: [point("source-a", 2.5, 10), point("source-z", 2, 10)] },
    { time: 1, agents: [point("source-z", 2, 10), point("source-a", 2.5, 10)] },
    { time: 2, agents: [point("source-z", 3, 10), point("source-a", 2.5, 11)] },
    { time: 3, agents: [point("source-a", 2.5, 11)] },
    { time: 4, agents: [point("source-a", 3.5, 11)] },
  ],
  evacuations: [{ agent_id: "source-z", exit_id: "exit-a", time: 2.5 }],
  summary: {
    evacuated_count: 1,
    remaining_count: 1,
    simulation_time: 4,
    clearance_time: null,
    per_exit_counts: { "exit-a": 1, "exit-b": 0 },
  },
};

const planInput = structuredClone(SAMPLE_PLAN);
const scenarioInput = structuredClone(scenario);
const result = adaptBackendSimulation(fixture, planInput, scenarioInput, 1234);
const transformedPlan = structuredClone(planInput);
transformedPlan.native = {transform:{pixels_per_metre:20,offset_x:100,offset_y:500},
  layout:{},floors:[],walls:[],exit_zones:[]};
const transformed = adaptBackendSimulation(fixture, transformedPlan, scenarioInput, 1234);
assert.deepEqual(positionAt(transformed.agents[0],0),{x:140,y:300},"Native layouts must use their calibrated view transform");
assert.deepEqual(positionAt(transformed.agents[1],4),{x:170,y:280});
assert.equal(transformed.agents[0].duration,2.5,"Coordinate conversion must preserve native departure times");
assert.equal(result.engine, "jupedsim");
assert.equal(result.engineVersion, "1.4.2");
assert.equal(result.agentRadius,.2,"Older recorded fixtures retain the native default body radius");
const sizedFixture = structuredClone(fixture);
sizedFixture.scenario.agent_defaults = {radius:.32,desired_speed:1.2};
assert.equal(adaptBackendSimulation(sizedFixture,planInput,scenarioInput,1234).agentRadius,.32,
  "The person glyph must receive the native collision-body radius in metres");
sizedFixture.scenario.agent_defaults.radius = 0;
assert.throws(()=>adaptBackendSimulation(sizedFixture,planInput,scenarioInput,1234),/person radius/);
assert.deepEqual(result.modelSettings, { dt: 0.01, sampleInterval: 0.2, maxTime: 60, seed: 42 });
assert.equal(result.status, "timed_out");
assert.equal(result.totalTime, 4, "Playback horizon must be the recorded simulation time");
assert.equal(result.clearanceTime, null, "Timeout is not a clearance time");
assert.equal(result.averageTime, 2.5, "Average includes evacuated people only");
assert.deepEqual(result.perExitCounts, { "exit-a": 1, "exit-b": 0 });
assert.equal(result.remaining, 1);
assert.equal(result.exited, 1);
const [departed, stillMoving] = result.agents;
assert.equal(departed.id, 0);
assert.equal(departed.sourceId, "source-z");
assert.equal(stillMoving.id, 1);
assert.equal(stillMoving.sourceId, "source-a");
assert.equal(departed.assignedExitId, "exit-a");
assert.equal(departed.exitId, "exit-a");
assert.equal(departed.duration, 2.5, "Departure uses the exact backend event time");
assert.equal(stillMoving.assignedExitId, "exit-b");
assert.equal(stillMoving.exitId, null, "Assignment alone is not an evacuation");
assert.deepEqual(departed.samples.map((sample) => sample.time), [0, 1, 2]);
assert.deepEqual(positionAt(departed, -1), { x: 64, y: 280 });
assert.deepEqual(positionAt(departed, 0.5), { x: 64, y: 280 }, "Queue pauses must remain stationary");
assert.deepEqual(positionAt(departed, 1.5), { x: 80, y: 280 }, "Interpolate using actual timestamps");
assert.deepEqual(positionAt(departed, 2.4), { x: 96, y: 280 }, "Do not invent a segment to the exit");
assert.equal(positionAt(departed, 2.5), null);
assert.deepEqual(positionAt(stillMoving, 2.5), { x: 80, y: 248 }, "Preserve a mid-route queue pause");
assert.deepEqual(positionAt(stillMoving, 3.5), { x: 96, y: 248 }, "A timed-out agent can still move");
assert.deepEqual(positionAt(stillMoving, 20), { x: 112, y: 248 }, "Do not extrapolate beyond measured positions");
assert.equal(getEvacuatedCount(result, 2.49), 0);
assert.equal(getEvacuatedCount(result, 2.5), 1);
assert.equal(getEvacuatedCount(result, 20), 1);
assert.equal(result.peakDensity, 0.5, "Two agents in a 4 m² bin gives 0.5 people/m²");
assert.deepEqual(result.hotspot, { x: 96, y: 288 }, "Hotspot must use canvas pixel coordinates");
const irregularFixture = structuredClone(fixture);
irregularFixture.frames[1].time = 0.25;
const irregular = adaptBackendSimulation(irregularFixture, SAMPLE_PLAN, scenario);
assert.deepEqual(positionAt(irregular.agents[0], 1.125), { x: 80, y: 280 }, "Uneven sample spacing must retain its original timing");
const roundedFixture = structuredClone(fixture);
roundedFixture.scenario.occupants[1].position[0] += 0.0000004;
assert.doesNotThrow(() => adaptBackendSimulation(roundedFixture, SAMPLE_PLAN, scenario), "Allow the service's six-decimal coordinate rounding");
const generatedFixture = structuredClone(fixture);
generatedFixture.population_generation = { seed: 17 };
assert.equal(adaptBackendSimulation(generatedFixture, SAMPLE_PLAN, scenario).modelSettings.seed, 17);
planInput.items[0].x += 100;
scenarioInput.occupancy = 99;
assert.deepEqual(result.plan, SAMPLE_PLAN, "Keep the original plan snapshot");
assert.deepEqual(result.scenario, scenario, "Keep the original editor scenario, not the backend's geometry schema");

const completedFixture = structuredClone(fixture);
completedFixture.status = "completed";
completedFixture.frames.at(-1).agents = [];
completedFixture.evacuations.push({ agent_id: "source-a", exit_id: "exit-b", time: 4 });
Object.assign(completedFixture.summary, {
  evacuated_count: 2,
  remaining_count: 0,
  clearance_time: 4,
  per_exit_counts: { "exit-a": 1, "exit-b": 1 },
});
const completed = adaptBackendSimulation(completedFixture, SAMPLE_PLAN, scenario, 1234);
assert.equal(completed.clearanceTime, 4);
assert.equal(completed.averageTime, 3.25);
assert.equal(getEvacuatedCount(completed, 4), 2);
assert.ok(completed.agents.every((agent) => positionAt(agent, 4) === null));
const finalizedFixture = structuredClone(completedFixture);
finalizedFixture.frames.at(-1).agents = [point("source-a", 3.5, 11)];
finalizedFixture.frames.push({ time: 4.01, agents: [] });
finalizedFixture.summary.simulation_time = 4.01;
finalizedFixture.summary.clearance_time = 4.01;
const finalized = adaptBackendSimulation(finalizedFixture, SAMPLE_PLAN, scenario);
assert.equal(finalized.agents[1].duration, 4, "Keep the departure event before the finalization step");
assert.equal(finalized.clearanceTime, 4.01);
assert.equal(positionAt(finalized.agents[1], 4), null, "Same-time native frame presence must not delay departure playback");
const excessiveGap = structuredClone(finalizedFixture);
excessiveGap.frames.at(-1).time = 4.02;
excessiveGap.summary.simulation_time = 4.02;
excessiveGap.summary.clearance_time = 4.02;
assert.throws(() => adaptBackendSimulation(excessiveGap, SAMPLE_PLAN, scenario), /clearance does not match/);

// Captured from native JuPedSim 1.4.2 through the editor converter. The timeout
// uses the same two-person input with max_time=.02; positions retain HTTP's
// six-decimal precision, and simulation/event timestamps are unchanged.
const native = JSON.parse(readFileSync(new URL("./fixtures/native-simulation.json", import.meta.url), "utf8"));
const nativeResults = {};
for (const name of ["completed", "timedOut"]) {
  const payload = native[name];
  const actual = adaptBackendSimulation(payload, native.input.plan, native.input.scenario);
  nativeResults[name] = actual;
  assert.deepEqual(actual.plan, native.input.plan);
  assert.deepEqual(actual.scenario, native.input.scenario);
  assert.equal(actual.totalTime, payload.summary.simulation_time);
  assert.equal(actual.clearanceTime, payload.summary.clearance_time);
  assert.equal(actual.engineVersion, "1.4.2");
  for (const agent of actual.agents) {
    const recorded = payload.frames.flatMap((frame) => {
      const position = frame.agents.find((person) => person.id === agent.sourceId);
      return position ? [{ time: frame.time, point: { x: position.x * 32, y: 600 - position.y * 32 } }] : [];
    });
    assert.deepEqual(agent.samples, recorded, "Native timestamps and positions must survive adaptation exactly");
    const departure = payload.evacuations.find((event) => event.agent_id === agent.sourceId);
    assert.equal(agent.exitId, departure?.exit_id ?? null);
    assert.equal(agent.duration, departure?.time ?? payload.summary.simulation_time);
    for (const sample of recorded) {
      assert.deepEqual(
        positionAt(agent, sample.time),
        departure && sample.time >= departure.time ? null : sample.point,
        "Recorded samples must play at their native timestamps, with event-time removal",
      );
    }
  }
  for (const frame of payload.frames) {
    assert.equal(getEvacuatedCount(actual, frame.time), payload.evacuations.filter((event) => event.time <= frame.time).length);
  }
}
assert.equal(nativeResults.completed.totalTime, 10.95);
assert.equal(Math.max(...nativeResults.completed.agents.map((agent) => agent.duration)), 10.94);
assert.deepEqual(nativeResults.completed.perExitCounts, { "exit-a": 1, "exit-b": 1 });
assert.equal(nativeResults.timedOut.clearanceTime, null);
assert.equal(nativeResults.timedOut.averageTime, 0);
assert.equal(nativeResults.timedOut.exited, 0);
assert.equal(nativeResults.timedOut.remaining, 2);
assert.ok(nativeResults.timedOut.agents.some((agent) => {
  const first = agent.samples[0];
  const last = agent.samples.at(-1);
  assert.notDeepEqual(first.point, last.point, "Native timed-out people must keep their measured movement");
  const middle = positionAt(agent, (first.time + last.time) / 2);
  assert.ok(Math.abs(middle.x - (first.point.x + last.point.x) / 2) < 1e-10);
  assert.ok(Math.abs(middle.y - (first.point.y + last.point.y) / 2) < 1e-10);
  return true;
}));

let invalidChecks = 0;
const rejects = (label, mutate) => {
  const invalid = structuredClone(fixture);
  mutate(invalid);
  assert.throws(
    () => adaptBackendSimulation(invalid, SAMPLE_PLAN, scenario),
    /simulation service returned invalid results/,
    label,
  );
  invalidChecks++;
};
rejects("Unexpected engine", (p) => { p.engine = "other"; });
rejects("Unexpected status", (p) => { p.status = "partial"; });
rejects("Malformed result list", (p) => { p.frames = {}; });
rejects("Population count differs", (p) => { p.scenario.occupants.pop(); });
rejects("Duplicate source IDs", (p) => { p.scenario.occupants[1].id = "source-z"; });
rejects("Nonfinite spawn", (p) => { p.scenario.occupants[0].position[0] = NaN; });
rejects("Nonfinite frame coordinate", (p) => { p.frames[0].agents[0].x = Infinity; });
rejects("Overflowing canvas coordinate", (p) => { p.frames[1].agents[0].x = 1e308; });
rejects("Unknown frame agent", (p) => { p.frames[0].agents[0].id = "intruder"; });
rejects("Duplicate frame agent", (p) => { p.frames[0].agents.push(p.frames[0].agents[0]); });
rejects("Unknown assigned agent", (p) => { p.assignments[0].agent_id = "intruder"; });
rejects("Unknown exit", (p) => { p.assignments[0].exit_id = "other"; });
rejects("Missing assignment", (p) => { p.assignments.pop(); });
rejects("Duplicate assignment", (p) => { p.assignments[0] = p.assignments[1]; });
rejects("Nonfinite route length", (p) => { p.assignments[0].route_length = Infinity; });
rejects("Unknown evacuation agent", (p) => { p.evacuations[0].agent_id = "intruder"; });
rejects("Wrong evacuation exit", (p) => { p.evacuations[0].exit_id = "exit-b"; });
rejects("Missing evacuation", (p) => { p.evacuations = []; });
rejects("Agent vanishes without evacuation", (p) => { p.frames[1].agents.pop(); });
rejects("Departed agent reappears", (p) => { p.frames[4].agents.push(point("source-z", 3, 10)); });
rejects("Initial position differs", (p) => { p.frames[0].agents[0].x += 1; });
rejects("Frame times repeat", (p) => { p.frames[2].time = 1; });
rejects("Missing initial frame", (p) => { p.frames.shift(); });
rejects("Missing final frame", (p) => { p.frames.pop(); });
rejects("Nonfinite time", (p) => { p.summary.simulation_time = NaN; });
rejects("Nonfinite model settings", (p) => { p.scenario.settings.dt = NaN; });
rejects("Invalid generation seed", (p) => { p.editor_metadata.seed = -1; });
rejects("Counts inconsistent", (p) => { p.summary.remaining_count = 0; });
rejects("False completion", (p) => { p.status = "completed"; p.summary.clearance_time = 4; });
rejects("False clearance", (p) => { p.summary.clearance_time = 4; });
rejects("Exit count inconsistent", (p) => { p.summary.per_exit_counts["exit-a"] = 0; });

const originalFetch = globalThis.fetch;
try {
  const controller = new AbortController();
  let submitted;
  globalThis.fetch = async (url, options) => {
    assert.equal(url, "/api/simulations");
    assert.equal(options.method, "POST");
    assert.equal(options.signal, controller.signal);
    assert.equal(options.cache, "no-store");
    submitted = JSON.parse(options.body);
    return Response.json(fixture);
  };
  const plan = structuredClone(SAMPLE_PLAN);
  const run = runBackendSimulation(plan, scenario, { signal: controller.signal });
  plan.items[0].x += 100;
  const fetched = await run;
  assert.deepEqual(submitted, { plan: SAMPLE_PLAN, scenario });
  assert.deepEqual(fetched.plan, SAMPLE_PLAN, "Async requests must retain their submitted snapshot");
  globalThis.fetch = async () => Response.json({ error: "This plan has no reachable exits." }, { status: 422 });
  await assert.rejects(runBackendSimulation(SAMPLE_PLAN, scenario), /This plan has no reachable exits\./);
  globalThis.fetch = async () => { throw new TypeError("Failed to fetch"); };
  await assert.rejects(runBackendSimulation(SAMPLE_PLAN, scenario), /Unable to reach the simulation service/);
  globalThis.fetch = async () => new Response("not JSON", { status: 200 });
  await assert.rejects(runBackendSimulation(SAMPLE_PLAN, scenario), /unreadable response/);
  const abort = new DOMException("Request aborted", "AbortError");
  controller.abort();
  globalThis.fetch = async () => { throw abort; };
  await assert.rejects(runBackendSimulation(SAMPLE_PLAN, scenario, { signal: controller.signal }), (error) => error === abort);
} finally {
  globalThis.fetch = originalFetch;
}

console.log(`Backend simulation checks passed: native completed/timeout fixtures, measured pauses, timeout motion, exact departures, coordinates, density, snapshots, HTTP errors, and ${invalidChecks} invalid responses.`);
