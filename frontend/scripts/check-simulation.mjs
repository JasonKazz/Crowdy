// Run with Node.js 22+: node --experimental-strip-types scripts/check-simulation.mjs
import assert from "node:assert/strict";
import {
  SAMPLE_PLAN,
  getEvacuatedCount,
  positionAt,
  runSimulation,
} from "../src/lib/simulation.ts";

const scenario = {
  occupancy: 80,
  mobility: "standard",
  distribution: "uniform",
};
const sample = runSimulation(SAMPLE_PLAN, scenario);
assert.equal(
  sample.exited,
  80,
  "The sample must give every person a route to an exit",
);
assert.deepEqual(
  sample.agents,
  runSimulation(SAMPLE_PLAN, scenario).agents,
  "Repeated inputs must produce identical routes and timings",
);
assert.equal(getEvacuatedCount(sample, sample.totalTime), 80);
assert.ok(
  sample.agents.every((agent) => positionAt(agent, sample.totalTime) === null),
);

for (const agent of sample.agents) {
  const point = agent.points[0];
  assert.ok(
    point.x > 80 && point.x < 820 && point.y > 90 && point.y < 510,
    "Sample placements must stay inside the floor",
  );
  assert.ok(
    !SAMPLE_PLAN.items.some(
      (item) =>
        point.x >= item.x - 5 &&
        point.x <= item.x + item.width + 5 &&
        point.y >= item.y - 5 &&
        point.y <= item.y + item.height + 5,
    ),
    "People must not start inside furniture",
  );
}

const emptyPlan = { ...structuredClone(SAMPLE_PLAN), items: [] };
const baseline = runSimulation(emptyPlan, scenario);
const firstStart = baseline.agents[0].points[0];
const obstacle = {
  id: "new-obstacle",
  label: "New obstacle",
  x: firstStart.x - 9,
  y: firstStart.y - 9,
  width: 18,
  height: 18,
  kind: "obstacle",
};
const proposal = runSimulation({ ...emptyPlan, items: [obstacle] }, scenario);
let retained = 0;
for (const original of baseline.agents) {
  const changed = proposal.agents[original.id];
  const point = original.points[0];
  const blocked =
    point.x >= obstacle.x - 5 &&
    point.x <= obstacle.x + obstacle.width + 5 &&
    point.y >= obstacle.y - 5 &&
    point.y <= obstacle.y + obstacle.height + 5;
  if (!blocked) {
    assert.deepEqual(
      changed.points[0],
      point,
      "A furniture edit must preserve unobstructed preferred starts",
    );
    retained++;
  }
  assert.equal(
    changed.delay,
    original.delay,
    "Reaction time must not change with layout",
  );
  const distance = (agent) =>
    agent.points
      .slice(1)
      .reduce(
        (sum, p, index) =>
          sum +
          Math.hypot(p.x - agent.points[index].x, p.y - agent.points[index].y),
        0,
      );
  if (original.travelTime && changed.travelTime)
    assert.ok(
      Math.abs(
        distance(original) / original.travelTime -
          distance(changed) / changed.travelTime,
      ) < 1e-8,
      "Each person's walking speed must remain fixed",
    );
}
assert.ok(retained > 70);

const blockedPlan = structuredClone(SAMPLE_PLAN);
blockedPlan.items.push(
  {
    id: "block-a",
    label: "Blocked A",
    x: 60,
    y: 260,
    width: 45,
    height: 80,
    kind: "obstacle",
  },
  {
    id: "block-b",
    label: "Blocked B",
    x: 800,
    y: 260,
    width: 45,
    height: 80,
    kind: "obstacle",
  },
);
const trapped = runSimulation(blockedPlan, scenario);
assert.equal(
  trapped.remaining,
  80,
  "Blocked exits must leave people in the space",
);
assert.equal(trapped.exited, 0);
assert.ok(
  runSimulation(SAMPLE_PLAN, { ...scenario, occupancy: 160 }).totalTime >
    sample.totalTime,
);
assert.ok(
  runSimulation(SAMPLE_PLAN, { ...scenario, mobility: "mixed" }).totalTime >
    sample.totalTime,
);
const x = sample.plan.items[0].x;
const changedInput = structuredClone(SAMPLE_PLAN);
const snapshot = runSimulation(changedInput, scenario);
changedInput.items[0].x += 50;
assert.equal(
  snapshot.plan.items[0].x,
  x,
  "Results must retain their original input snapshot",
);

console.log(
  `Simulation checks passed: ${retained} unobstructed starts retained; ${sample.totalTime}s sample run; blocked exits leave ${trapped.remaining} people.`,
);
