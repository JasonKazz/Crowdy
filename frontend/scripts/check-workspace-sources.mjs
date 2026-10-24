// The browser UI verifies IndexedDB persistence. These checks cover input
// boundaries and prove the placeholder estimate never depends on input data.
import assert from "node:assert/strict";
import {
  MAX_VENUE_IMAGE_BYTES,
  VENUE_IMAGE_TYPES,
  validateVenueImageSource,
  estimateVenueCrowd,
  listVenueImages,
  saveVenueImage,
  deleteVenueImage,
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
    "Invalid source metadata must be rejected before it reaches browser storage");
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
await assert.rejects(listVenueImages("owner-a", "workspace-a"), /Browser storage is unavailable/,
  "Server rendering must not silently accept nonpersistent venue sources");

globalThis.window = {};
await assert.rejects(listVenueImages("owner-a", "workspace-a"), /Browser storage is unavailable/);
Object.defineProperty(globalThis.window, "indexedDB", {
  get() { throw Object.assign(new Error("blocked"), { name: "SecurityError" }); },
});
await assert.rejects(listVenueImages("owner-a", "workspace-a"), /Enable site storage/,
  "Browser policy failures must tell the user how to retry");
delete globalThis.window;

// A narrow request fixture verifies commit/error timing without pretending to
// implement IndexedDB. Actual blob round trips belong to browser verification.
const request = {};
let written;
let deletedKey;
let lookupKey;
let closed = 0;
const transaction = {
  error: null,
  objectStore() {
    return {
      put(record) { written = record; return request; },
      delete(key) { deletedKey = key; return request; },
      index() { return { getAll(key) { lookupKey = key; return request; } }; },
    };
  },
};
const database = { close() { closed++; }, transaction() { return transaction; } };
globalThis.window = { indexedDB: {
  open() {
    const opened = { result: database };
    queueMicrotask(() => opened.onsuccess());
    return opened;
  },
} };
const untilRequest = () => new Promise(resolve => setImmediate(resolve));

const supplied = source();
const save = saveVenueImage("owner-a", "workspace-a", supplied);
supplied.name = "mutated after saving";
await untilRequest();
assert.equal(written.name, "venue.png", "Saving must snapshot metadata before awaiting browser storage");
assert.equal(written.ownerId, "owner-a");
assert.equal(written.workspaceId, "workspace-a");
let saved = false;
save.then(() => { saved = true; });
request.onsuccess();
await Promise.resolve();
assert.equal(saved, false, "Request success must not report a durable save before transaction completion");
transaction.oncomplete();
await save;
assert.equal(saved, true);

const failure = saveVenueImage("owner-b", "workspace-a", source());
await untilRequest();
request.onsuccess();
transaction.error = Object.assign(new Error("quota"), { name: "QuotaExceededError" });
transaction.onabort();
await assert.rejects(failure, /no space left/,
  "A quota failure after request success must still reject the save");
transaction.error = null;

const remove = deleteVenueImage("owner-b", "workspace-b", "same-image-id");
await untilRequest();
assert.deepEqual(deletedKey, ["owner-b", "workspace-b", "same-image-id"],
  "Deleting a shared image ID must stay scoped to the account and workspace");
request.onsuccess();
transaction.oncomplete();
await remove;

const read = listVenueImages("owner-a", "workspace-b");
await untilRequest();
assert.deepEqual(lookupKey, ["owner-a", "workspace-b"]);
request.result = [{ ...source(), ownerId: "owner-b", workspaceId: "workspace-b" }];
request.onsuccess();
transaction.oncomplete();
await assert.rejects(read, /Existing images have been kept/,
  "A mismatched stored account must never be returned by the source API");
assert.equal(closed, 4, "Completed and aborted requests must close their database connections");
delete globalThis.window;

console.log("Workspace source checks passed: format/size/metadata validation, fixed 80 estimate, storage failures, scope keys, immutable save metadata, transaction commit timing, and quota aborts.");
