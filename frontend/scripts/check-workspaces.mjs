// Isolated HTTP/storage fixtures; no real accounts or browser data are touched.
import assert from "node:assert/strict";
import {
  SAMPLE_WORKSPACE_ID, DEFAULT_SCENARIO, listWorkspaces, getWorkspace,
  createWorkspace, updateWorkspace, deleteWorkspace, subscribeWorkspaces,
} from "../src/lib/workspace-store.ts";

const plan = { id:"test-plan", name:"Test plan", width:900, height:600, area:304,
  items:[{id:"desk-1",label:"Desk",x:200,y:200,width:100,height:50,kind:"desk"}],
  walls:[{x1:80,y1:90,x2:820,y2:90}], exits:[{id:"exit-a",label:"Exit A",x:80,y:300}] };
const ownerA = "auth0|workspace-check-a", ownerB = "auth0|workspace-check-b";
const legacyKey = owner => `crowdy-workspaces-v1:${encodeURIComponent(owner)}`;
const local = new Map();
const browser = new EventTarget();
let storageBlocked = false;
browser.localStorage = {
  getItem(key) { if (storageBlocked) throw new Error("blocked"); return local.get(key) ?? null; },
  setItem(key, value) { if (storageBlocked) throw new Error("blocked"); local.set(key,value); },
  removeItem(key) { if (storageBlocked) throw new Error("blocked"); local.delete(key); },
};
globalThis.window = browser;
const cloud = new Map(), tombstones = new Set(), requests = [];
let session = ownerA, sequence = 0, timestamp = Date.now(), unavailable = false, rejectLegacy = false;
let blockPut = null;
const serverKey = (owner,id) => `${owner}:${id}`;
function record(owner,id,name="Legacy", floorPlan=plan) {
  const now = ++timestamp;
  return { id, ownerId:owner, name, plan:structuredClone(floorPlan), scenario:structuredClone(DEFAULT_SCENARIO), createdAt:now, updatedAt:now };
}
globalThis.fetch = async (url, init={}) => {
  if (init.signal?.aborted) throw init.signal.reason;
  const path = String(url).replace(/^\/api\/workspaces\/?/, "");
  const method = init.method ?? "GET";
  const body = init.body ? JSON.parse(init.body) : null;
  requests.push({path,method,body,init});
  assert.equal(init.cache,"no-store");
  assert.equal(init.credentials,"same-origin");
  assert.ok(!body || !("ownerId" in body), "Browser payloads cannot set an owner");
  if (init.headers["X-Crowdy-Account"] !== session) return Response.json({error:"Your account changed. Refresh the page before saving."},{status:409});
  if (unavailable) return Response.json({error:"Cloud storage unavailable"},{status:503});
  if (method === "POST") {
    const id = body.id ?? `ws-fixture-${++sequence}`;
    if (rejectLegacy && body.id) return Response.json({error:"Migration unavailable"},{status:503});
    const key = serverKey(session,id);
    if (tombstones.has(key)) return Response.json({error:"Workspace was deleted"},{status:410});
    if (cloud.has(key)) return Response.json({error:"Workspace already exists"},{status:409});
    const created = record(session,id,body.name,body.plan);
    created.scenario = body.scenario;
    cloud.set(key,created);
    return Response.json(created,{status:201});
  }
  if (!path) return Response.json({workspaces:[...cloud.values()].filter(value => value.ownerId === session)});
  const key = serverKey(session,decodeURIComponent(path));
  const current = cloud.get(key);
  if (!current) return Response.json({error:"Workspace not found"},{status:tombstones.has(key) ? 410 : 404});
  if (method === "PUT") {
    if (blockPut) await blockPut;
    if (init.signal?.aborted) throw init.signal.reason;
    if (body.expectedUpdatedAt !== current.updatedAt) return Response.json({error:"This workspace changed in another tab. Reload it before saving."},{status:409});
    const updated = {...current,...body,updatedAt:++timestamp};
    delete updated.expectedUpdatedAt;
    cloud.set(key,updated);
    return Response.json(updated);
  }
  if (method === "DELETE") { cloud.delete(key); tombstones.add(key); return new Response(null,{status:204}); }
  return Response.json(current);
};

await assert.rejects(listWorkspaces(""),/Sign in/);
assert.deepEqual(await listWorkspaces(ownerA),[]);
let notifications = 0;
const unsubscribe = subscribeWorkspaces(() => notifications++);
const first = await createWorkspace(ownerA,{name:"  First   workspace ",plan,scenario:DEFAULT_SCENARIO});
assert.equal(first.name,"First workspace");
assert.equal(first.ownerId,ownerA);
assert.equal(notifications,1);
assert.equal(local.size,0,"New workspaces must never be persisted to browser storage");
first.plan.items[0].x = 800;
plan.items[0].x = 300;
DEFAULT_SCENARIO.occupancy = 100;
assert.equal((await getWorkspace(ownerA,first.id)).plan.items[0].x,200,
  "Returned and supplied plans must not mutate storage");
assert.equal((await getWorkspace(ownerA,first.id)).scenario.occupancy,24,
  "A supplied scenario is cloned");
DEFAULT_SCENARIO.occupancy = 24;
const listed = await listWorkspaces(ownerA);
listed[0].plan.items[0].label = "Changed outside the store";
assert.equal((await getWorkspace(ownerA,first.id)).plan.items[0].label,"Desk");
session = ownerB;
assert.deepEqual(await listWorkspaces(ownerB),[]);
assert.equal(await getWorkspace(ownerB,first.id),null);
await assert.rejects(createWorkspace(ownerA,{name:"Wrong account",plan,scenario:DEFAULT_SCENARIO}),/account changed/);
session = ownerA;
await assert.rejects(createWorkspace(ownerA,{name:"",plan,scenario:DEFAULT_SCENARIO}),/name/);
await assert.rejects(createWorkspace(ownerA,{name:"Invalid",plan:{...plan,items:[{...plan.items[0],width:Infinity}]},scenario:DEFAULT_SCENARIO}),/geometry/);
assert.throws(() => updateWorkspace(ownerA,first.id,{plan,scenario:{...DEFAULT_SCENARIO,occupancy:500}}),/scenario/);
assert.equal(await getWorkspace(ownerA,SAMPLE_WORKSPACE_ID),null);
assert.throws(() => deleteWorkspace(ownerA,SAMPLE_WORKSPACE_ID),/shared sample/);

// Concurrent autosaves must reach the server in edit order, with a fresh revision.
let release;
blockPut = new Promise(resolve => { release = resolve; });
const earlier = updateWorkspace(ownerA,first.id,{plan,scenario:{...DEFAULT_SCENARIO,occupancy:90}});
const newerPlan = structuredClone(plan);
newerPlan.items[0].x = 350;
const later = updateWorkspace(ownerA,first.id,{plan:newerPlan,scenario:{...DEFAULT_SCENARIO,occupancy:120}});
newerPlan.items[0].x = 400;
await new Promise(resolve => setImmediate(resolve));
assert.equal(requests.filter(request => request.method === "PUT").length,1,"Only one workspace mutation may be in flight");
release(); blockPut = null;
const savedFirst = await earlier, savedLast = await later;
assert.ok(savedLast.updatedAt > savedFirst.updatedAt);
const puts = requests.filter(request => request.method === "PUT");
assert.equal(puts[1].body.expectedUpdatedAt,savedFirst.updatedAt);
assert.equal(savedLast.plan.items[0].x,350,"Queued writes snapshot geometry before awaiting");
assert.equal((await getWorkspace(ownerA,first.id)).scenario.occupancy,120);
// Never overwrite another tab's newer edit by silently retrying a conflict.
cloud.get(serverKey(ownerA,first.id)).updatedAt = ++timestamp;
await assert.rejects(updateWorkspace(ownerA,first.id,{plan,scenario:DEFAULT_SCENARIO}),/another tab/);
assert.equal(cloud.get(serverKey(ownerA,first.id)).scenario.occupancy,120);
await getWorkspace(ownerA,first.id);
const controller = new AbortController(); controller.abort();
await assert.rejects(updateWorkspace(ownerA,first.id,{plan,scenario:DEFAULT_SCENARIO},{signal:controller.signal}));
assert.equal(cloud.get(serverKey(ownerA,first.id)).scenario.occupancy,120);
const nativePlan = {...plan,native:{floors:[[{x:80,y:90},{x:820,y:90},{x:820,y:510}]],walls:[],draft:{state:"editing"}},items:[{...plan.items[0],polygon:[{x:0,y:0},{x:1,y:0},{x:1,y:1}]}]};
const native = await createWorkspace(ownerA,{name:"Native draft",plan:nativePlan,scenario:{...DEFAULT_SCENARIO,behaviorMode:"behavioral",bodyWidth:.6}});
assert.deepEqual(native.plan.native,nativePlan.native);
assert.deepEqual(native.plan.items[0].polygon,nativePlan.items[0].polygon);
assert.equal(native.scenario.bodyWidth,.6);

// Small YOLO counts must survive the same create/autosave/reload flow as larger
// populations. Zero remains a review result, outside the simulation contract.
const smallCrowd = await createWorkspace(ownerA,{name:"Detected small crowd",plan,scenario:{...DEFAULT_SCENARIO,occupancy:1}});
assert.equal(smallCrowd.scenario.occupancy,1);
for (let occupancy = 1; occupancy <= 9; occupancy++) {
  await updateWorkspace(ownerA,smallCrowd.id,{plan,scenario:{...DEFAULT_SCENARIO,occupancy}});
  assert.equal((await getWorkspace(ownerA,smallCrowd.id)).scenario.occupancy,occupancy,
    `A ${occupancy}-person estimate must remain valid after saving and reloading`);
  assert.equal((await listWorkspaces(ownerA)).find(workspace => workspace.id === smallCrowd.id).scenario.occupancy,occupancy);
}
const beforeZero = requests.length;
await assert.rejects(createWorkspace(ownerA,{name:"Invalid zero crowd",plan,scenario:{...DEFAULT_SCENARIO,occupancy:0}}),/scenario/);
assert.throws(() => updateWorkspace(ownerA,smallCrowd.id,{plan,scenario:{...DEFAULT_SCENARIO,occupancy:0}}),/scenario/);
assert.equal(requests.length,beforeZero,"Zero occupancy must fail before a cloud mutation");
assert.equal(cloud.get(serverKey(ownerA,smallCrowd.id)).scenario.occupancy,9,"An invalid estimate must preserve the last saved occupancy");

unavailable = true;
await assert.rejects(createWorkspace(ownerA,{name:"Offline",plan,scenario:DEFAULT_SCENARIO}),/unavailable/);
assert.equal(local.size,0,"Network failures must not silently fall back to local storage");
unavailable = false; storageBlocked = true;
assert.ok((await listWorkspaces(ownerA)).length);
await createWorkspace(ownerA,{name:"Cloud despite blocked storage",plan,scenario:DEFAULT_SCENARIO});
storageBlocked = false;

// Only acknowledged same-owner legacy records are removed; conflicting cloud wins.
const migrationOwner = "auth0|migration-check"; session = migrationOwner;
const legacy = record(migrationOwner,"ws-legacy-fixture");
local.set(legacyKey(migrationOwner),JSON.stringify([legacy]));
assert.ok((await listWorkspaces(migrationOwner)).some(value => value.id === legacy.id));
assert.equal(local.has(legacyKey(migrationOwner)),false);
await deleteWorkspace(migrationOwner,legacy.id);
local.set(legacyKey(migrationOwner),JSON.stringify([legacy]));
assert.deepEqual(await listWorkspaces(migrationOwner),[],"The once-per-session migration must not recreate deleted workspaces");
const conflictOwner = "auth0|migration-conflict"; session = conflictOwner;
const conflict = record(conflictOwner,"ws-conflict-fixture");
cloud.set(serverKey(conflictOwner,conflict.id),{...conflict,name:"Current cloud"});
local.set(legacyKey(conflictOwner),JSON.stringify([{...conflict,name:"Old local"}]));
assert.equal((await listWorkspaces(conflictOwner))[0].name,"Current cloud");
assert.equal(local.has(legacyKey(conflictOwner)),false);
const failedOwner = "auth0|migration-failed"; session = failedOwner;
const failed = record(failedOwner,"ws-failed-fixture");
local.set(legacyKey(failedOwner),JSON.stringify([failed]));
rejectLegacy = true;
assert.deepEqual(await listWorkspaces(failedOwner),[]);
assert.deepEqual(JSON.parse(local.get(legacyKey(failedOwner))),[failed],"Failed migrations must leave legacy data intact");
rejectLegacy = false;
const deletedOwner = "auth0|migration-deleted"; session = deletedOwner;
const deleted = record(deletedOwner,"ws-deleted-fixture");
tombstones.add(serverKey(deletedOwner,deleted.id));
local.set(legacyKey(deletedOwner),JSON.stringify([deleted]));
assert.deepEqual(await listWorkspaces(deletedOwner),[]);
assert.equal(local.has(legacyKey(deletedOwner)),false,"A durable tombstone safely retires stale legacy data");
const corruptOwner = "auth0|migration-corrupt"; session = corruptOwner;
local.set(legacyKey(corruptOwner),"{bad-json");
assert.deepEqual(await listWorkspaces(corruptOwner),[]);
assert.equal(local.get(legacyKey(corruptOwner)),"{bad-json","Corrupt browser data must be kept for recovery without disabling the cloud");
unsubscribe();
const stoppedAt = notifications;
session = ownerB;
const previousLayout = '{"previous":"layout"}';
local.set("crowdy-workspace-v1",previousLayout);
await createWorkspace(ownerB, {
  name: "Unsubscribed",
  plan,
  scenario: DEFAULT_SCENARIO,
});
assert.equal(notifications, stoppedAt);
assert.equal(
  local.get("crowdy-workspace-v1"),
  previousLayout,
  "The original browser layout must remain untouched",
);

const polygonPlan = structuredClone(plan);
polygonPlan.items[0].polygon = [{x:0,y:0},{x:1,y:0},{x:.5,y:1}];
polygonPlan.native = {layout:{name:"Source geometry"},transform:{pixels_per_metre:20,offset_x:0,offset_y:600},
  floors:[[{x:0,y:0},{x:900,y:0},{x:900,y:600}]],walls:[],exit_zones:[]};
const calibrated = await createWorkspace(ownerB,{name:"Calibrated geometry",plan:polygonPlan,scenario:{...DEFAULT_SCENARIO,seed:7}});
polygonPlan.native.layout.name="Changed outside saved workspace";
polygonPlan.items[0].polygon[0].x=.2;
const restored = await getWorkspace(ownerB,calibrated.id);
assert.equal(restored.scenario.seed,7);
assert.equal(restored.plan.native.layout.name,"Source geometry");
assert.equal(restored.plan.items[0].polygon[0].x,0,"Saving must preserve and clone furniture polygons");

const draftPlan = structuredClone(restored.plan);
draftPlan.exits = [];
draftPlan.native.layout.exits = [];
const savedDraft = await updateWorkspace(ownerB, calibrated.id, {
  plan: draftPlan,
  scenario: restored.scenario,
});
assert.equal((await getWorkspace(ownerB, calibrated.id)).plan.exits.length, 0,
  "A native draft must remain saved while its exterior exits are being edited");
const draftCopy = await createWorkspace(ownerB, {
  name: "Draft copy",
  plan: savedDraft.plan,
  scenario: savedDraft.scenario,
});
assert.deepEqual((await getWorkspace(ownerB, draftCopy.id)).plan, savedDraft.plan,
  "Copying an unfinished native layout must preserve its geometry");
for (const id of [plan.id, SAMPLE_WORKSPACE_ID]) {
  await assert.rejects(createWorkspace(ownerB, {
    name: "Invalid pixel plan",
    plan: {...plan, id, exits: []},
    scenario: DEFAULT_SCENARIO,
  }), /geometry/, "Pixel plans still require an exit before saving");
}

const densePlan = structuredClone(restored.plan);
densePlan.items = Array.from({length:300},(_,index)=>({...densePlan.items[0],id:`table-${index}`}));
const denseRecord = await createWorkspace(ownerB,{name:"Dense venue extraction",plan:densePlan,scenario:restored.scenario});
assert.equal((await getWorkspace(ownerB,denseRecord.id)).plan.items.length,300,
  "Dense extracted furniture must survive persistence above the old 100-item limit");

const largeVenue = await createWorkspace(ownerB, {
  name: "Large venue",
  plan: {...plan,area:14813.587936797483},
  scenario: DEFAULT_SCENARIO,
});
assert.equal((await getWorkspace(ownerB,largeVenue.id)).plan.area,14813.587936797483,
  "Large venues must survive saving and reopening");
await updateWorkspace(ownerB,largeVenue.id,{plan:{...plan,area:40000},scenario:DEFAULT_SCENARIO});
assert.equal((await getWorkspace(ownerB,largeVenue.id)).plan.area,40000,
  "Editing a saved venue must not reinstate an area cap");

session = ownerA;
const roomPlan={...plan,rooms:[{id:"office",label:"Office",room_type:"office",polygon:[{x:80,y:90},{x:820,y:90},{x:820,y:510},{x:80,y:510}]}]};
const roomScenario={...DEFAULT_SCENARIO,distribution:"rooms",population:{buildingType:"office",activity:"lunch",roomCounts:{office:12},roomTypes:{office:"meeting"}}};
const roomRecord=await createWorkspace(ownerA,{name:"Room settings",plan:roomPlan,scenario:roomScenario});
assert.deepEqual((await getWorkspace(ownerA,roomRecord.id)).scenario.population,roomScenario.population);
assert.deepEqual((await getWorkspace(ownerA,roomRecord.id)).plan.rooms,roomPlan.rooms);
roomScenario.population.roomCounts.office=99;
roomPlan.rooms[0].label="Changed outside storage";
assert.equal((await getWorkspace(ownerA,roomRecord.id)).scenario.population.roomCounts.office,12);
assert.equal((await getWorkspace(ownerA,roomRecord.id)).plan.rooms[0].label,"Office");
const roomUpdate = {...roomRecord.scenario,population:{...roomRecord.scenario.population,
  activity:"meeting",roomCounts:{office:7}}};
await updateWorkspace(ownerA,roomRecord.id,{plan:roomRecord.plan,scenario:roomUpdate});
const savedRoom = (await listWorkspaces(ownerA)).find(workspace => workspace.id === roomRecord.id);
assert.deepEqual(savedRoom.scenario.population,roomUpdate.population,
  "Room settings must also survive autosave and library reload");
assert.deepEqual(savedRoom.plan.rooms,roomRecord.plan.rooms);

console.log("Workspace checks passed: HTTP persistence, 1–9-person crowd round trips and zero rejection, account isolation, validation, cloned inputs, serialized autosaves, optimistic conflicts, cancellation, native drafts, dense and large venues, offline errors, optional browser storage, non-destructive legacy migration, and room labels/types/activity/fixed-count persistence.");
