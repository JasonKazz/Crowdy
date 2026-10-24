import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {doorEnds, moveGeometry, nativeLayout, pixelPoint, wallShape, withNativeLayout, worldPoint} from "../src/lib/native-editor.ts";
import {validatePlan} from "../src/lib/plan-validation.ts";

const layout=JSON.parse(readFileSync(new URL("../../examples/editable_office.json",import.meta.url),"utf8"));
const base={id:"editor-test",name:"Editor test",width:900,height:600,area:160,items:[],walls:[],exits:[],
  native:{layout,transform:{pixels_per_metre:40,offset_x:100,offset_y:500},floors:[[{x:100,y:500},{x:740,y:500},{x:740,y:100},{x:100,y:100}]],walls:[],exit_zones:[]}};
const plan=withNativeLayout(base,layout);
for (const area of [14813.587936797483, 1e12])
  assert.equal(validatePlan({...plan,area}).area,area,"Large finite floor areas must remain importable");
for (const [changes,message] of [
  [{id:""},/needs an ID/],
  [{name:""},/needs a name/],
  [{width:1500},/editor canvas must be 900 × 600/],
  ...[0,-1,NaN,Infinity].map(area=>[{area},/Floor area must be a finite number greater than 0/]),
  [{items:undefined},/furniture list/],
  [{walls:undefined},/walls list/],
  [{exits:undefined},/exits list/],
  [{native:undefined,exits:[]},/has no exits/],
]) assert.throws(()=>validatePlan({...plan,...changes}),message,"Invalid imports must identify the failing field");
const before=JSON.stringify(plan);
assert.deepEqual(worldPoint(plan,pixelPoint(plan,[3.5,4.2])),[3.5,4.2]);
const oldDoor=doorEnds(layout,layout.doors[0]);
const moved=moveGeometry(plan,{kind:"wall",id:"partition"},[7,5]);
assert.equal(nativeLayout(moved).walls[0].start[0],7);
assert.equal(nativeLayout(moved).doors[0].offset,4);
assert.deepEqual(doorEnds(nativeLayout(moved),nativeLayout(moved).doors[0]),oldDoor.map(([x,y])=>[x-1,y]));
const slid=moveGeometry(plan,{kind:"door",id:"connecting-door"},[9,6]);
assert.equal(nativeLayout(slid).doors[0].offset,6);
assert.ok(slid.native.walls.length===2,"The parent wall is cut into two solid sections by the moved door");
const clipped=moveGeometry(plan,{kind:"door",id:"connecting-door"},[8,30]);
assert.equal(nativeLayout(clipped).doors[0].offset,9.4,"Dragging stays within the parent wall");
const exit=moveGeometry(plan,{kind:"exit",id:"exit-west"},[0,6]);
assert.equal(nativeLayout(exit).exits[0].edge_index,3);
assert.equal(nativeLayout(exit).exits[0].offset,4);
assert.equal(exit.exits[0].y,260);
const resized=moveGeometry(plan,{kind:"wall",id:"partition"},[8,1],"start");
assert.deepEqual(nativeLayout(resized).walls[0].start,[8,1]);
assert.equal(JSON.stringify(plan),before,"Editing must not mutate prior history or baseline plans");
assert.deepEqual(wallShape({id:"w",start:[0,0],end:[2,0],thickness:.2}),[[0,.1],[2,.1],[2,-.1],[0,-.1]]);
const draft=structuredClone(layout);draft.exits=[];
assert.equal(validatePlan(withNativeLayout(plan,draft)).exits.length,0,"A draft without an exit must remain editable");
const invalidDoor=structuredClone(layout);invalidDoor.doors[0].offset=100;
assert.equal(validatePlan(withNativeLayout(plan,invalidDoor)).native.layout.doors[0].offset,100,
  "A geometrically invalid door position must remain editable before the backend check");
for (const malformed of [
  {},
  {...layout,walls:undefined},
  {...layout,walls:[null]},
  {...layout,walls:[{...layout.walls[0],start:null}]},
  {...layout,doors:[null]},
  {...layout,exits:[null]},
  {...layout,walkable_areas:[{...layout.walkable_areas[0],polygon:[null]}]},
  {...layout,agent_defaults:null},
]) {
  const invalid=structuredClone(plan);invalid.native.layout=malformed;
  assert.throws(()=>validatePlan(invalid),/missing its geometry or scale/,
    "Malformed canonical geometry must be rejected before the editor renders");
}
console.log("Native editor checks passed: transforms, wall/attached-door movement, door gaps, endpoint edits, exit attachment, editable drafts, malformed import recovery, and immutable history.");
