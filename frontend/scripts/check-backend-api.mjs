// Run with both the Next.js app and Python service running locally.
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import { SAMPLE_PLAN, positionAt } from "../src/lib/simulation.ts";
import { adaptBackendSimulation } from "../src/lib/backend-simulation.ts";

const base = new URL(process.env.BACKEND_TEST_APP_URL || "http://localhost:3000");
const endpoint = new URL("/api/simulations", base);
const scenario = { occupancy: 20, mobility: "standard", distribution: "uniform" };
const input = { plan: SAMPLE_PLAN, scenario };
let passed = 0;

async function post(body, extra = {}) {
  return fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: base.origin, ...extra },
    body: typeof body === "string" ? body : JSON.stringify(body),
    redirect: "manual",
  });
}

async function rejected(body, status, extra) {
  const response = await post(body, extra);
  assert.equal(response.status, status);
  const data = await response.json();
  assert.equal(typeof data.error, "string");
  assert.ok(data.error.length > 0);
  assert.match(response.headers.get("cache-control") || "", /no-store/);
  passed++;
}

try {
  const health = await fetch(endpoint);
  assert.equal(health.status, 200, "Start the Python service before running these checks.");
  assert.equal((await health.json()).engine, "jupedsim");
  assert.match(health.headers.get("cache-control") || "", /no-store/);
  passed++;

  await rejected(input, 403, { Origin: "https://unrelated.example" });
  await rejected(input, 415, { "Content-Type": "text/plain" });
  await rejected("{", 400);
  await rejected("null", 400);
  await rejected({ ...input, scenario: { ...scenario, occupancy: 201 } }, 400);
  await rejected({ ...input, plan: { ...SAMPLE_PLAN, exits: [] } }, 400);
  await rejected(" ".repeat(1024 * 1024 + 1), 413);

  const response = await post(input);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control") || "", /no-store/);
  const native = await response.json();
  const result = adaptBackendSimulation(native, SAMPLE_PLAN, scenario, 1);
  assert.equal(result.engine, "jupedsim");
  assert.equal(result.status, "completed");
  assert.equal(result.exited, scenario.occupancy);
  assert.equal(result.remaining, 0);
  assert.ok(result.clearanceTime > 0);
  assert.equal(Object.values(result.perExitCounts).reduce((a, b) => a + b, 0), scenario.occupancy);
  assert.equal(Object.keys(result.perExitCounts).length, 2);
  assert.ok(result.agents.every((agent) => agent.samples.length > 1));
  assert.equal(positionAt(result.agents[0], result.agents[0].duration), null);
  passed++;

  const withMetadata = structuredClone(input);
  withMetadata.scenario.occupancy = 2;
  withMetadata.plan.importNotes = "Extra import metadata is not simulation geometry";
  withMetadata.plan.items[0].importReference = "example-reference";
  const metadataResponse = await post(withMetadata);
  assert.equal(metadataResponse.status, 200);
  const metadataRun = adaptBackendSimulation(await metadataResponse.json(), withMetadata.plan, withMetadata.scenario, 2);
  assert.equal(metadataRun.exited, 2);
  passed++;

  const blocked = structuredClone(SAMPLE_PLAN);
  blocked.items.push({
    id: "blocking-wall", label: "Blocking wall", kind: "obstacle",
    x: 80, y: 280, width: 740, height: 40,
  });
  await rejected({ plan: blocked, scenario }, 422);
  const layout = JSON.parse(readFileSync(new URL("../../examples/narrow_table_regression.json",import.meta.url),"utf8"));
  const imported = await fetch(new URL("/api/floorplans",base),{method:"POST",
    headers:{"Content-Type":"application/json",Origin:base.origin},body:JSON.stringify({layout})});
  assert.equal(imported.status,200);
  const nativePlan = (await imported.json()).plan;
  assert.ok(nativePlan.native.layout.doors.length);
  nativePlan.items[1].x+=5;
  const seededScenario = {...scenario,seed:7};
  const nativeResponse = await post({plan:nativePlan,scenario:seededScenario});
  assert.equal(nativeResponse.status,200);
  const nativePayload = await nativeResponse.json();
  const nativeResult = adaptBackendSimulation(nativePayload,nativePlan,seededScenario,3);
  assert.equal(nativeResult.exited,20);
  assert.equal(nativeResult.remaining,0);
  assert.equal(nativeResult.modelSettings.seed,7);
  const start = nativePayload.scenario.occupants[0].position;
  const transform=nativePlan.native.transform;
  assert.deepEqual(positionAt(nativeResult.agents[0],0),nativeResult.agents[0].samples[0].point);
  assert.ok(Math.abs(nativeResult.agents[0].samples[0].point.x-(start[0]*transform.pixels_per_metre+transform.offset_x))<.0001);
  const closedIds = nativePlan.exits.map(exit=>exit.id);
  const reference={occupants:nativePayload.scenario.occupants,radius:nativePayload.scenario.agent_defaults.radius,
    mobility:seededScenario.mobility,distribution:seededScenario.distribution,seed:seededScenario.seed};
  const closedResponse=await post({plan:nativePlan,scenario:{...seededScenario,blocked_exit_ids:closedIds},starting_population:reference});
  assert.equal(closedResponse.status,200);
  const closedPayload=await closedResponse.json();
  const closedResult=adaptBackendSimulation(closedPayload,nativePlan,{...seededScenario,blockedExitIds:closedIds});
  assert.equal(closedResult.trapped,20);
  assert.equal(closedResult.status,"trapped");
  assert.deepEqual(closedPayload.scenario.occupants,nativePayload.scenario.occupants);
  assert.ok(closedPayload.editor_metadata.reused_starting_population);
  await rejected({plan:nativePlan,scenario:{...seededScenario,blocked_exit_ids:["unknown"]}},400);
  passed+=3;
  console.log(`Backend integration checks passed: ${passed} HTTP checks, real JuPedSim playback, two exit summaries, validation, and blocked-geometry recovery.`);
} catch (error) {
  console.error(`Backend integration checks failed: ${error instanceof Error ? error.message : "unknown failure"}`);
  process.exitCode = 1;
}
