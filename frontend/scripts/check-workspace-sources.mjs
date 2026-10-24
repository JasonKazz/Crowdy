// Isolated HTTP fixtures cover durable sources without touching real accounts.
import assert from "node:assert/strict";
import {
  MAX_VENUE_IMAGE_BYTES,
  VENUE_IMAGE_TYPES,
  validateVenueImageSource,
  estimateVenueCrowd,
  listVenueImages,
  saveVenueImage,
  deleteVenueImage,
  venueImageMigrationNotice,
} from "../src/lib/workspace-sources.ts";

const source = (type = "image/png", size = 16) => ({
  id: "venue-check-1",
  name: "venue.png",
  type,
  size,
  width: 640,
  height: 480,
  addedAt: Date.now(),
  blob: new Blob([new Uint8Array(size)], { type }),
});

for (const type of VENUE_IMAGE_TYPES) {
  assert.doesNotThrow(() => validateVenueImageSource(source(type)));
}
assert.doesNotThrow(() => validateVenueImageSource(source("image/jpeg", MAX_VENUE_IMAGE_BYTES)),
  "A venue image at the exact 10 MiB boundary must be accepted");
assert.throws(() => validateVenueImageSource(source("image/png", MAX_VENUE_IMAGE_BYTES + 1)), /too large/);
for (const invalid of [
  null,
  undefined,
  {},
  source("image/gif"),
  source("image/svg+xml"),
  source("image/png", 0),
  { ...source(), size: 15 },
  { ...source(), type: "image/jpeg" },
  { ...source(), blob: {} },
  { ...source(), id: "" },
  { ...source(), id: " invalid " },
  { ...source(), name: "" },
  { ...source(), name: "a".repeat(256) },
  { ...source(), width: 0 },
  { ...source(), width: 1.5 },
  { ...source(), height: Infinity },
  { ...source(), height: -20 },
  { ...source(), addedAt: NaN },
  { ...source(), addedAt: -1 },
]) {
  assert.throws(() => validateVenueImageSource(invalid), /readable PNG, JPEG, or WebP/,
    "Invalid source metadata must be rejected before it reaches cloud storage");
}

for (const input of [
  undefined,
  null,
  0,
  50000,
  { venueSize: 1, crowdSize: 0 },
  { venueSize: 1000000, crowdSize: 12000 },
  source("image/png"),
  source("image/webp", MAX_VENUE_IMAGE_BYTES),
  new Blob(["an empty venue"]),
  new Blob(["a packed venue with hundreds of people"]),
]) {
  assert.equal(estimateVenueCrowd(input), 80,
    "Every image, venue size, and crowd-size input must produce exactly 80");
}

await assert.rejects(listVenueImages("", "workspace-a"), /Sign in/);
await assert.rejects(listVenueImages("owner-a", ""), /Choose a workspace/);
await assert.rejects(deleteVenueImage("owner-a", "workspace-a", ""), /could not be found/);
await assert.rejects(saveVenueImage("owner-a", "workspace-a", source("image/gif")), /readable PNG, JPEG, or WebP/);
await assert.rejects(saveVenueImage("owner-a", "workspace-a", source("image/png", 3 * 1024 * 1024 + 1)), /under 3 MB/);

let account = "owner-a", offline = false, releaseSave = null, lastSave, failUpload = false;
const deletedSources = new Set();
const images = new Map(), calls = [];
const key = (owner, workspace, id) => `${owner}:${workspace}:${id}`;
globalThis.fetch = async (url, init={}) => {
  if (init.signal?.aborted) throw init.signal.reason;
  calls.push({url,init});
  assert.equal(init.cache,"no-store");
  assert.equal(init.credentials,"same-origin");
  if (init.headers["X-Crowdy-Account"] !== account) return Response.json({error:"Your account changed"},{status:409});
  if (offline) return Response.json({error:"Cloud images unavailable"},{status:503});
  const parts = url.split("/");
  const workspace = decodeURIComponent(parts[3]), id = decodeURIComponent(parts[5] ?? "");
  if (init.method === "POST") {
    const body = JSON.parse(init.body);
    if (failUpload) return Response.json({error:"Upload unavailable"},{status:503});
    if (deletedSources.has(key(account,workspace,body.id))) return Response.json({error:"Image was deleted"},{status:410});
    assert.deepEqual(Object.keys(body).sort(),["id","image_base64","name"]);
    lastSave = body;
    if (releaseSave) await releaseSave;
    const blob = new Blob([Buffer.from(body.image_base64,"base64")],{type:"image/png"});
    const metadata = {...source(),id:body.id,name:body.name,size:blob.size,blob};
    images.set(key(account,workspace,body.id),{...metadata,owner:account,workspace});
    return Response.json({id:metadata.id,name:metadata.name,type:metadata.type,size:metadata.size,width:metadata.width,height:metadata.height,addedAt:metadata.addedAt},{status:201});
  }
  const saved = images.get(key(account,workspace,id));
  if (init.method === "DELETE") {
    if (!saved) return Response.json({error:"Image not found"},{status:404});
    images.delete(key(account,workspace,id));
    deletedSources.add(key(account,workspace,id));
    return new Response(null,{status:204});
  }
  if (parts[6] === "image") {
    return saved ? new Response(saved.blob,{headers:{"Content-Type":saved.type}}) : Response.json({error:"Image not found"},{status:404});
  }
  return Response.json({sources:[...images.values()].filter(image => image.owner === account && image.workspace === workspace).map(image => ({id:image.id,name:image.name,type:image.type,size:image.size,width:image.width,height:image.height,addedAt:image.addedAt}))});
};
globalThis.window = {};
Object.defineProperty(globalThis.window,"indexedDB",{get(){ throw new Error("IndexedDB must not be used for active persistence"); }});
Object.defineProperty(globalThis.window,"localStorage",{get(){ throw new Error("Browser storage must not be used for venue images"); }});
const supplied = source();
let release;
releaseSave = new Promise(resolve => {release = resolve;});
const pending = saveVenueImage("owner-a","workspace-a",supplied);
supplied.name = "changed after save";
await new Promise(resolve => setImmediate(resolve));
assert.equal(lastSave.name,"venue.png","Upload metadata must be snapshotted before awaiting file reads");
let saved = false;
pending.then(() => { saved = true; });
assert.equal(saved,false,"A save must not succeed before the backend acknowledges it");
release(); releaseSave = null;
await pending;
assert.equal(saved,true);
const persisted = await listVenueImages("owner-a","workspace-a");
assert.equal(persisted.length,1);
assert.equal(persisted[0].blob.size,16);
assert.equal(persisted[0].blob.type,"image/png");
assert.equal(persisted[0].name,"venue.png");
account = "owner-b";
assert.deepEqual(await listVenueImages("owner-b","workspace-a"),[],"Same workspace/image IDs must not cross accounts");
await assert.rejects(listVenueImages("owner-a","workspace-a"),/account changed/);
await assert.rejects(deleteVenueImage("owner-b","workspace-a","venue-check-1"),/not found/);
account = "owner-a";
assert.deepEqual(await listVenueImages("owner-a","workspace-b"),[],"Sources must remain scoped to one workspace");
const controller = new AbortController(); controller.abort();
await assert.rejects(listVenueImages("owner-a","workspace-a",{signal:controller.signal}));
offline = true;
await assert.rejects(saveVenueImage("owner-a","workspace-a",source()),/unavailable/);
await assert.rejects(deleteVenueImage("owner-a","workspace-a","venue-check-1"),/unavailable/);
offline = false;
assert.equal((await listVenueImages("owner-a","workspace-a")).length,1,"Failed deletion must retain cloud data");
await deleteVenueImage("owner-a","workspace-a","venue-check-1");
assert.deepEqual(await listVenueImages("owner-a","workspace-a"),[]);
// Narrow legacy IndexedDB fixture: only already-stored records are read, and
// originals may be deleted only after the HTTP service acknowledges the image.
const legacy = new Map();
let legacyDeleteFails = false;
function indexedTransaction() {
  const transaction = { abort() { queueMicrotask(() => transaction.onabort?.()); }, objectStore() {
    function task(action) {
      const request = {};
      queueMicrotask(() => {
        if (legacyDeleteFails && action.kind === "delete") { transaction.onabort?.(); return; }
        request.result = action.run();
        request.onsuccess?.();
        transaction.oncomplete?.();
      });
      return request;
    }
    return {
      index() { return { getAll(scope,count) { return task({kind:"read",run:() => [...legacy.values()].filter(image => image.ownerId === scope[0] && image.workspaceId === scope[1]).slice(0,count)}); } }; },
      delete(scope) { return task({kind:"delete",run:() => { legacy.delete(scope.join(":")); }}); },
    };
  } };
  return transaction;
}
const database = { objectStoreNames:{contains:() => true},close(){},transaction:indexedTransaction };
globalThis.window = {indexedDB:{databases:async() => [{name:"crowdy-workspace-sources-v1"}],open() {
  const request = {result:database}; queueMicrotask(() => request.onsuccess?.()); return request;
}}};
const legacyImage = {...source(),id:"legacy-image-a",ownerId:"owner-a",workspaceId:"workspace-legacy"};
const otherLegacy = {...legacyImage,ownerId:"owner-b"};
legacy.set(key(legacyImage.ownerId,legacyImage.workspaceId,legacyImage.id),legacyImage);
legacy.set(key(otherLegacy.ownerId,otherLegacy.workspaceId,otherLegacy.id),otherLegacy);
assert.equal((await listVenueImages("owner-a","workspace-legacy")).length,1);
assert.equal(legacy.has(key("owner-a","workspace-legacy",legacyImage.id)),false);
assert.equal(legacy.has(key("owner-b","workspace-legacy",legacyImage.id)),true,"Legacy migration must never read or remove another account's images");
const failedLegacy = {...legacyImage,id:"legacy-image-failed"};
legacy.set(key("owner-a","workspace-legacy",failedLegacy.id),failedLegacy);
failUpload = true;
assert.equal((await listVenueImages("owner-a","workspace-legacy")).length,1);
assert.equal(legacy.has(key("owner-a","workspace-legacy",failedLegacy.id)),true,"A failed upload must keep the original Blob");
assert.match(venueImageMigrationNotice("owner-a","workspace-legacy"),/originals have been kept/);
failUpload = false; legacyDeleteFails = true;
await listVenueImages("owner-a","workspace-legacy");
assert.equal(legacy.has(key("owner-a","workspace-legacy",failedLegacy.id)),true,"An aborted local cleanup must leave recoverable data");
const uploadCount = calls.filter(call => call.init.method === "POST").length;
legacyDeleteFails = false;
await listVenueImages("owner-a","workspace-legacy");
assert.equal(legacy.has(key("owner-a","workspace-legacy",failedLegacy.id)),false);
assert.equal(calls.filter(call => call.init.method === "POST").length,uploadCount,"An existing cloud image must not be overwritten by legacy data");
assert.equal(venueImageMigrationNotice("owner-a","workspace-legacy"),"");
await deleteVenueImage("owner-a","workspace-legacy",legacyImage.id);
legacy.set(key("owner-a","workspace-legacy",legacyImage.id),legacyImage);
await listVenueImages("owner-a","workspace-legacy");
assert.equal(legacy.has(key("owner-a","workspace-legacy",legacyImage.id)),false,"A source tombstone must retire stale local originals without resurrection");
assert.equal(images.has(key("owner-a","workspace-legacy",legacyImage.id)),false);
// Each pass is bounded to eight images; remaining originals get a visible notice.
for (let i=0;i<9;i++) {
  const image = {...legacyImage,id:`batch-image-${i}`,workspaceId:"workspace-batch"};
  legacy.set(key("owner-a","workspace-batch",image.id),image);
}
assert.equal((await listVenueImages("owner-a","workspace-batch")).length,8);
assert.match(venueImageMigrationNotice("owner-a","workspace-batch"),/Reopen Sources to retry/);
assert.equal((await listVenueImages("owner-a","workspace-batch")).length,9);
assert.equal(venueImageMigrationNotice("owner-a","workspace-batch"),"");
delete globalThis.window;
console.log("Workspace source checks passed: format/size validation, fixed 80 estimate, HTTP blob round trips, immutable metadata, cloud acknowledgement, account/workspace isolation, cancellation, offline errors, independence from browser storage, and bounded account-scoped legacy image migration with preserved originals, retry, and deletion tombstones.");
