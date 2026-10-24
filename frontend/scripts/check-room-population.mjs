import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {SAMPLE_PLAN} from '../src/lib/simulation.ts';
import {simulationRequest} from '../src/lib/simulation-request.ts';
import {validPopulationSettings,placementKey,startingPopulation,adaptPopulationPreview} from '../src/lib/room-population.ts';

const scenario={occupancy:40,mobility:'standard',distribution:'rooms',seed:42,bodyWidth:.46,
  population:{activity:'workday',roomCounts:{'meeting-room':7}}};
const request=simulationRequest({plan:SAMPLE_PLAN,scenario});
assert.equal(request.scenario.population_config.activity,'workday');
assert.equal(request.scenario.population_config.room_counts['meeting-room'],7);
assert.equal(request.plan.rooms.length,4);
for(const value of [{roomCounts:{x:-1}},{roomCounts:{x:1.5}},{roomTypes:{x:'secret'}},{activity:'panic'},[],null])
  assert.equal(validPopulationSettings(value),false);
assert.throws(()=>simulationRequest({plan:SAMPLE_PLAN,scenario:{...scenario,population:{roomCounts:{x:true}}}}));
assert.equal(placementKey(SAMPLE_PLAN,scenario),placementKey(SAMPLE_PLAN,{...scenario,behaviorMode:'behavioral',blockedExitIds:['exit-a']}));
assert.notEqual(placementKey(SAMPLE_PLAN,scenario),placementKey(SAMPLE_PLAN,{...scenario,population:{activity:'lunch'}}));
const baseline={scenario,startingOccupants:[{id:'p1',position:[4,5]}],agentRadius:.23};
assert.deepEqual(startingPopulation(baseline).population_config,request.scenario.population_config);
const adapted=adaptPopulationPreview({radius:.23,occupants:[{position:[4,5]}]},SAMPLE_PLAN,'key');
assert.deepEqual(adapted.people,[{x:128,y:440}]);
assert.throws(()=>adaptPopulationPreview({radius:0,occupants:[]},SAMPLE_PLAN,'key'));
console.log('Room placement contracts passed: presets, overrides, baseline configuration, preview coordinates and stable placement keys.');

if(process.env.ROOM_POPULATION_HTTP==='1') {
  const base=process.env.BACKEND_TEST_APP_URL||'http://localhost:3000';
  async function post(path,body){return fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',Origin:base},body:JSON.stringify(body)});}
  const layout=JSON.parse(readFileSync(new URL('../../examples/room_aware_office.json',import.meta.url),'utf8'));
  const imported=await post('/api/floorplans',{layout});
  assert.equal(imported.status,200);
  const plan=(await imported.json()).plan;
  const scenario={occupancy:40,mobility:'standard',distribution:'rooms',seed:42,population:{activity:'workday'}};
  const workResponse=await post('/api/populations',{plan,scenario});
  assert.equal(workResponse.status,200);
  const work=await workResponse.json();
  const lunchResponse=await post('/api/populations',{plan,scenario:{...scenario,population:{activity:'lunch'}}});
  assert.equal(lunchResponse.status,200);
  const lunch=await lunchResponse.json();
  const counts=payload=>Object.fromEntries(payload.room_population.rooms.map(r=>[r.id,r.count]));
  assert.ok(counts(work).workspace>counts(lunch).workspace);
  assert.ok(counts(work)['lunch-room']<counts(lunch)['lunch-room']);
  assert.equal(work.occupants.length,40);
  const runResponse=await post('/api/simulations',{plan,scenario});
  assert.equal(runResponse.status,200);
  const run=await runResponse.json();
  assert.deepEqual(run.scenario.occupants,work.occupants);
  const fixedResponse=await post('/api/populations',{plan,scenario:{...scenario,population:{roomCounts:{workspace:7}}}});
  assert.equal(fixedResponse.status,200);
  assert.equal(counts(await fixedResponse.json()).workspace,7);
  const closedResponse=await post('/api/populations',{plan,scenario:{...scenario,blocked_exit_ids:plan.exits.map(e=>e.id)}});
  assert.equal(closedResponse.status,200);
  assert.deepEqual((await closedResponse.json()).occupants,work.occupants);
  const invalid=await post('/api/populations',{plan,scenario:{...scenario,population:{roomCounts:{missing:7}}}});
  assert.equal(invalid.status,422);
  console.log('Room placement HTTP checks passed: real imports, workday/lunch counts, fixed counts, closure stability and identical preview/run starts.');
}
