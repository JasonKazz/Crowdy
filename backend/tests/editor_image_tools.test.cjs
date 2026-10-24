const assert=require('node:assert/strict');
const {rescaleLayout}=require('../app/simulation/editor-image-tools.js');
const layout={walkable_areas:[{polygon:[[1,2],[3,2],[3,4]]}],furniture:[],
  exits:[{id:'e',floor_id:'floor',edge_index:1,offset:2,width:1.2,landing_depth:2}],rooms:[{polygon:[[1,2],[2,2],[2,3]]}],
  walls:[{start:[1,2],end:[3,4],thickness:.2}],doors:[{offset:1,width:1.2}],occupants:[{position:[1.5,2.5]}],
  source_image:{meters_per_pixel:.02,scale_confirmed:false},
  agent_defaults:{radius:.2,desired_speed:1.2},settings:{dt:.01,max_time:120}};
const scaled=rescaleLayout(layout,2);
assert.deepEqual(scaled.walkable_areas[0].polygon[0],[2,4]);
assert.deepEqual(scaled.rooms[0].polygon[0],[2,4]);
assert.equal(scaled.walls[0].thickness,.4);
assert.equal(scaled.doors[0].width,2.4);
assert.equal(scaled.exits[0].offset,4);
assert.equal(scaled.exits[0].width,2.4);
assert.equal(scaled.exits[0].landing_depth,4);
assert.equal(scaled.exits[0].edge_index,1);
assert.deepEqual(scaled.occupants[0].position,[3,5]);
assert.equal(scaled.source_image.meters_per_pixel,.04);
assert.equal(scaled.source_image.scale_confirmed,true);
assert.deepEqual(scaled.agent_defaults,layout.agent_defaults);
assert.deepEqual(scaled.settings,layout.settings);
assert.equal(layout.source_image.scale_confirmed,false);
assert.throws(()=>rescaleLayout(layout,0));
assert.throws(()=>rescaleLayout(layout,Infinity));
console.log('Image calibration checks passed: geometry rescales without changing people size or speed.');
