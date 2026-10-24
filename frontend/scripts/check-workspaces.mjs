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
assert.equal((await getWorkspace(ownerA,first.id)).plan.items[0].x,200);
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
console.log("Workspace checks passed: HTTP persistence, account isolation, validation, serialized autosaves, optimistic conflicts, cancellation, native drafts, offline errors, optional browser storage, and non-destructive legacy migration.");
