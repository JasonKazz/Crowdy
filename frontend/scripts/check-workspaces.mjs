// Node.js 22+: node --experimental-strip-types scripts/check-workspaces.mjs
// Uses an isolated in-memory browser-storage fixture; no real browser data is read.
import assert from "node:assert/strict";
import {
  SAMPLE_WORKSPACE_ID,
  DEFAULT_SCENARIO,
  listWorkspaces,
  getWorkspace,
  createWorkspace,
  updateWorkspace,
  deleteWorkspace,
  subscribeWorkspaces,
} from "../src/lib/workspace-store.ts";

const data = new Map();
let writeError = null;
let readError = null;
const browser = new EventTarget();
browser.localStorage = {
  getItem(key) {
    if (readError) throw readError;
    return data.get(key) ?? null;
  },
  setItem(key, value) {
    if (writeError) throw writeError;
    data.set(key, value);
  },
  removeItem(key) {
    data.delete(key);
  },
};
globalThis.window = browser;

const plan = {
  id: "test-plan",
  name: "Test plan",
  width: 900,
  height: 600,
  area: 304,
  items: [
    {
      id: "desk-1",
      label: "Desk",
      x: 200,
      y: 200,
      width: 100,
      height: 50,
      kind: "desk",
    },
  ],
  walls: [{ x1: 80, y1: 90, x2: 820, y2: 90 }],
  exits: [{ id: "exit-a", label: "Exit A", x: 80, y: 300 }],
};
const ownerA = "auth0|workspace-check-a";
const ownerB = "google-oauth2|workspace-check-b";
const key = (owner) => `crowdy-workspaces-v1:${encodeURIComponent(owner)}`;
const previousLayout = '{"previous":"layout"}';
data.set("crowdy-workspace-v1", previousLayout);

assert.deepEqual(listWorkspaces(ownerA), []);
assert.throws(() => listWorkspaces(""), /Sign in/);
let notifications = 0;
const unsubscribe = subscribeWorkspaces(() => notifications++);
const first = createWorkspace(ownerA, {
  name: "  First   workspace  ",
  plan,
  scenario: DEFAULT_SCENARIO,
});
assert.equal(first.name, "First workspace");
assert.match(first.id, /^ws-/);
assert.equal(first.ownerId, ownerA);
assert.deepEqual(
  listWorkspaces(ownerB),
  [],
  "Another account must not see the first account's data",
);
assert.equal(getWorkspace(ownerB, first.id), null);
assert.equal(notifications, 1);

first.plan.items[0].x = 800;
plan.items[0].x = 300;
DEFAULT_SCENARIO.occupancy = 100;
assert.equal(
  getWorkspace(ownerA, first.id).plan.items[0].x,
  200,
  "Returned and supplied plans must not mutate storage",
);
assert.equal(
  getWorkspace(ownerA, first.id).scenario.occupancy,
  80,
  "A supplied scenario is cloned",
);
DEFAULT_SCENARIO.occupancy = 80;
const listed = listWorkspaces(ownerA);
listed[0].plan.items[0].label = "Changed outside the store";
assert.equal(getWorkspace(ownerA, first.id).plan.items[0].label, "Desk");

const second = createWorkspace(ownerA, {
  name: "Second",
  plan,
  scenario: DEFAULT_SCENARIO,
});
assert.equal(
  listWorkspaces(ownerA)[0].id,
  second.id,
  "Newest workspaces appear first",
);
const changedPlan = structuredClone(plan);
changedPlan.items[0].x = 350;
const updated = updateWorkspace(ownerA, first.id, {
  name: "Renamed",
  plan: changedPlan,
  scenario: { ...DEFAULT_SCENARIO, occupancy: 120 },
});
assert.equal(updated.createdAt, first.createdAt);
assert.ok(updated.updatedAt > first.updatedAt);
assert.equal(
  listWorkspaces(ownerA)[0].id,
  first.id,
  "A recently saved workspace appears first",
);
assert.equal(getWorkspace(ownerA, first.id).name, "Renamed");
assert.equal(getWorkspace(ownerA, first.id).scenario.occupancy, 120);
changedPlan.items[0].x = 400;
updated.scenario.occupancy = 150;
assert.equal(getWorkspace(ownerA, first.id).plan.items[0].x, 350);
assert.equal(getWorkspace(ownerA, first.id).scenario.occupancy, 120);
assert.throws(
  () => updateWorkspace(ownerB, first.id, { plan, scenario: DEFAULT_SCENARIO }),
  /no longer available/,
);
assert.throws(() => deleteWorkspace(ownerB, first.id), /no longer available/);
assert.equal(getWorkspace(ownerA, SAMPLE_WORKSPACE_ID), null);
assert.throws(
  () =>
    updateWorkspace(ownerA, SAMPLE_WORKSPACE_ID, {
      plan,
      scenario: DEFAULT_SCENARIO,
    }),
  /shared sample/,
);
assert.throws(
  () => deleteWorkspace(ownerA, SAMPLE_WORKSPACE_ID),
  /shared sample/,
);

const previousData = data.get(key(ownerA));
assert.throws(
  () => createWorkspace(ownerA, { name: "", plan, scenario: DEFAULT_SCENARIO }),
  /name/,
);
assert.throws(
  () =>
    createWorkspace(ownerA, {
      name: "Invalid geometry",
      plan: { ...plan, items: [{ ...plan.items[0], width: Infinity }] },
      scenario: DEFAULT_SCENARIO,
    }),
  /geometry/,
);
assert.throws(
  () =>
    updateWorkspace(ownerA, first.id, {
      plan,
      scenario: { ...DEFAULT_SCENARIO, occupancy: 500 },
    }),
  /scenario/,
);
assert.equal(
  data.get(key(ownerA)),
  previousData,
  "Invalid inputs must not overwrite existing data",
);

writeError = Object.assign(new Error("Quota"), { name: "QuotaExceededError" });
assert.throws(() => deleteWorkspace(ownerA, second.id), /no space left/);
assert.equal(
  data.get(key(ownerA)),
  previousData,
  "A failed write must preserve the prior record list",
);
writeError = Object.assign(new Error("Blocked"), { name: "SecurityError" });
assert.throws(
  () =>
    createWorkspace(ownerA, {
      name: "Not saved",
      plan,
      scenario: DEFAULT_SCENARIO,
    }),
  /could not be saved/,
);
writeError = null;
readError = Object.assign(new Error("Blocked"), { name: "SecurityError" });
assert.throws(() => listWorkspaces(ownerA), /storage is unavailable/);
readError = null;

for (const corrupt of [
  "{bad-json",
  "{}",
  JSON.stringify([{ ...listWorkspaces(ownerA)[0], ownerId: ownerB }]),
  JSON.stringify([{ ...listWorkspaces(ownerA)[0], id: SAMPLE_WORKSPACE_ID }]),
  JSON.stringify([
    { ...listWorkspaces(ownerA)[0], plan: { ...plan, items: [null] } },
  ]),
]) {
  data.set(key(ownerA), corrupt);
  assert.throws(() => listWorkspaces(ownerA), /Existing data has been kept/);
  assert.throws(
    () =>
      createWorkspace(ownerA, {
        name: "Do not overwrite",
        plan,
        scenario: DEFAULT_SCENARIO,
      }),
    /Existing data has been kept/,
  );
  assert.equal(
    data.get(key(ownerA)),
    corrupt,
    "Corrupt data must be retained for recovery",
  );
}
data.set(key(ownerA), previousData);
const other = createWorkspace(ownerB, {
  name: "Other account",
  plan,
  scenario: DEFAULT_SCENARIO,
});
deleteWorkspace(ownerA, second.id);
assert.equal(getWorkspace(ownerA, second.id), null);
assert.equal(getWorkspace(ownerB, other.id).name, "Other account");
const nativeEvent = new Event("storage");
Object.defineProperty(nativeEvent, "key", { value: key(ownerA) });
const notificationCount = notifications;
browser.dispatchEvent(nativeEvent);
assert.equal(
  notifications,
  notificationCount + 1,
  "Cross-tab workspace events notify subscribers",
);
unsubscribe();
const stoppedAt = notifications;
createWorkspace(ownerB, {
  name: "Unsubscribed",
  plan,
  scenario: DEFAULT_SCENARIO,
});
assert.equal(notifications, stoppedAt);
assert.equal(
  data.get("crowdy-workspace-v1"),
  previousLayout,
  "The original browser layout must remain untouched",
);

console.log(
  "Workspace checks passed: account isolation, sample protection, cloned inputs, update ordering, corruption preservation, storage failures, and change notifications.",
);
