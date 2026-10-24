// Run against the configured Next app and protected backend. Synthetic Auth0 sessions
// use fresh isolated subjects and remove their fixtures; secrets are never logged.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { generateSessionCookie } from "@auth0/nextjs-auth0/testing";

const envFile = fileURLToPath(new URL("../.env.local",import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);
const base = new URL(process.env.AUTH_TEST_BASE_URL ?? "http://localhost:3000");
const subject = `auth0|crowdy-cloud-check-${randomUUID()}`;
const other = `${subject}-other`;
const plan = {id:"cloud-test-plan",name:"Cloud test plan",width:900,height:600,area:304,
  items:[{id:"desk-1",label:"Desk",x:200,y:200,width:100,height:50,kind:"desk"}],
  walls:[{x1:80,y1:90,x2:820,y2:90}],exits:[{id:"exit-a",label:"Exit A",x:80,y:300}]};
const scenario = {occupancy:80,mobility:"standard",distribution:"uniform",behaviorMode:"idealized",bodyWidth:.46};
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
let stage = "configuration", passed = 0, createdId, ownerCookie;
async function cookie(sub) {
  return `__session=${await generateSessionCookie({user:{sub},tokenSet:{accessToken:"synthetic-test-token",expiresAt:Math.floor(Date.now()/1000)+3600},internal:{sid:randomUUID(),createdAt:Math.floor(Date.now()/1000)}},{secret:process.env.AUTH0_SECRET})}`;
}
async function request(path="", init={}, auth=ownerCookie, account=subject) {
  const response = await fetch(new URL(`/api/workspaces${path}`,base),{
    ...init,redirect:"manual",signal:AbortSignal.timeout(60000),headers:{"Content-Type":"application/json",...(auth ? {Cookie:auth,"X-Crowdy-Account":account} : {}),...init.headers},
    body:init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  assert.match(response.headers.get("cache-control") ?? "",/no-store/);
  return response;
}
try {
  assert.ok(process.env.AUTH0_SECRET);
  ownerCookie = await cookie(subject);
  const otherCookie = await cookie(other);
  stage = "guest authentication";
  assert.equal((await request("",{},null)).status,401); passed++;
  stage = "empty isolated account";
  let response = await request(); assert.equal(response.status,200);
  assert.deepEqual((await response.json()).workspaces,[]); passed++;
  stage = "route whitelist";
  assert.equal((await request("/../../health")).status,404);
  assert.equal((await request("/not-a-workspace")).status,404); passed++;
  stage = "cross-site mutation rejection";
  assert.equal((await request("",{method:"POST",headers:{Origin:"https://other.invalid"},body:{name:"Rejected",plan,scenario}})).status,403); passed++;
  stage = "browser owner rejection";
  assert.equal((await request("",{method:"POST",body:{name:"Rejected",plan,scenario,ownerId:other}})).status,400); passed++;
  stage = "session-owned workspace creation";
  response = await request("",{method:"POST",headers:{"X-Crowdy-Owner":other},body:{name:"Cloud check",plan,scenario}});
  assert.equal(response.status,201);
  const created = await response.json(); createdId = created.id;
  assert.equal(created.ownerId,subject,"Upstream owner must derive from the encrypted session, never a browser header");
  assert.deepEqual(created.plan,plan); passed++;
  stage = "cross-account privacy";
  assert.equal((await request(`/${createdId}`,{},otherCookie,other)).status,404);
  assert.deepEqual((await (await request("",{},otherCookie,other)).json()).workspaces,[]); passed++;
  stage = "account-change precondition";
  assert.equal((await request(`/${createdId}`,{method:"PUT",body:{plan,scenario,expectedUpdatedAt:created.updatedAt}},ownerCookie,other)).status,409); passed++;
  stage = "optimistic autosave";
  response = await request(`/${createdId}`,{method:"PUT",body:{plan,scenario:{...scenario,occupancy:120},expectedUpdatedAt:created.updatedAt}});
  assert.equal(response.status,200);
  const updated = await response.json(); assert.ok(updated.updatedAt > created.updatedAt); assert.equal(updated.scenario.occupancy,120);
  assert.equal((await request(`/${createdId}`,{method:"PUT",body:{plan,scenario,expectedUpdatedAt:created.updatedAt}})).status,409); passed++;
  stage = "blob source persistence";
  const sourceId = randomUUID();
  response = await request(`/${createdId}/sources`,{method:"POST",body:{id:sourceId,name:"Venue check.png",image_base64:png}});
  assert.equal(response.status,201); const source = await response.json();
  assert.equal(source.width,1); assert.equal(source.height,1);
  response = await request(`/${createdId}/sources`); assert.equal((await response.json()).sources[0].id,sourceId);
  response = await request(`/${createdId}/sources/${sourceId}/image`); assert.equal(response.status,200); assert.equal(response.headers.get("content-type"),"image/png");
  assert.equal(Buffer.from(await response.arrayBuffer()).toString("base64"),png); passed++;
  stage = "private blob isolation";
  assert.equal((await request(`/${createdId}/sources/${sourceId}/image`,{},otherCookie,other)).status,404); passed++;
  stage = "source operations preserve editor revision";
  assert.equal((await (await request(`/${createdId}`)).json()).updatedAt,updated.updatedAt);
  assert.equal((await request(`/${createdId}/sources/${sourceId}`,{method:"DELETE"})).status,204);
  assert.deepEqual((await (await request(`/${createdId}/sources`)).json()).sources,[]); passed++;
  stage = "source deletion tombstone";
  assert.equal((await request(`/${createdId}/sources/${sourceId}`,{method:"DELETE"})).status,204);
  assert.equal((await request(`/${createdId}/sources/${sourceId}/image`)).status,410);
  assert.equal((await request(`/${createdId}/sources`,{method:"POST",body:{id:sourceId,name:"No resurrection.png",image_base64:png}})).status,410); passed++;
  stage = "cloud deletion and migration tombstone";
  assert.equal((await request(`/${createdId}`,{method:"DELETE"})).status,204);
  assert.equal((await request(`/${createdId}`)).status,410);
  assert.equal((await request("",{method:"POST",body:{id:createdId,name:"No resurrection",plan,scenario}})).status,409); passed++;
  createdId = null;
  console.log(`Cloud workspace integration passed: ${passed} checks covering authenticated Next-to-backend CRUD, ownership, private blobs, revision conflicts, and deletion tombstones.`);
} catch {
  console.error(`Cloud workspace integration failed during ${stage}. No credential, cookie, or user data was logged.`);
  process.exitCode = 1;
} finally {
  if (createdId) await request(`/${createdId}`,{method:"DELETE"}).catch(() => undefined);
}
