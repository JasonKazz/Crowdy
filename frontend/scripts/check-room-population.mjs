import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {SAMPLE_PLAN} from '../src/lib/simulation.ts';
import {simulationRequest} from '../src/lib/simulation-request.ts';
import {validPopulationSettings,placementKey,populationPreviewState,startingPopulation,adaptPopulationPreview} from '../src/lib/room-population.ts';
import {isSupportedCrowdSize, MAX_CROWD_SIZE, POFA_CAPACITY} from '../src/lib/crowd-limits.ts';

const scenario={occupancy:40,mobility:'standard',distribution:'rooms',seed:42,bodyWidth:.46,
  population:{activity:'workday',roomCounts:{'meeting-room':7}}};
const request=simulationRequest({plan:SAMPLE_PLAN,scenario});
assert.equal(request.scenario.population_config.activity,'workday');
assert.equal(request.scenario.population_config.room_counts['meeting-room'],7);
assert.equal(request.plan.rooms.length,4);
assert.equal(MAX_CROWD_SIZE,10000);
assert.equal(POFA_CAPACITY,5000);
for(const count of [1,5000,5001,10000]) {
  assert.ok(isSupportedCrowdSize(count));
  const large=simulationRequest({plan:{...SAMPLE_PLAN,capacity:POFA_CAPACITY},scenario:{...scenario,occupancy:count,population:{roomCounts:{hall:count}}}});
  assert.equal(large.scenario.occupancy,count,'Capacity is metadata, not an analysis ceiling');
  assert.equal(large.scenario.population_config.room_counts.hall,count);
  assert.equal(large.plan.capacity,5000);
}
for(const occupancy of [0,-1,10001,1.5,NaN,Infinity,'10000']) {
  assert.equal(isSupportedCrowdSize(occupancy),false);
  assert.throws(()=>simulationRequest({plan:SAMPLE_PLAN,scenario:{...scenario,occupancy}}),/1–10,000/);
}
assert.equal(validPopulationSettings({roomCounts:{a:5000,b:5000}}),true);
assert.equal(validPopulationSettings({roomCounts:{a:5000,b:5001}}),false,'Room totals must remain within the supported headcount');
assert.equal(validPopulationSettings({roomCounts:{hall:10001}}),false);
for(const capacity of [0,-1,1.5,NaN,'5000'])
  assert.throws(()=>simulationRequest({plan:{...SAMPLE_PLAN,capacity},scenario}),/capacity/);
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
const nineteen = adaptPopulationPreview({radius:.23,occupants:Array.from({length:19},(_,i)=>({position:[4+i,5]}))},SAMPLE_PLAN,'current');
assert.equal(populationPreviewState('current',nineteen,{key:'current',loading:false,error:''}).preview.people.length,19);
const rejected = populationPreviewState('current',nineteen,{key:'current',loading:false,error:"Wall 'structure_review:w1:0' extends outside the floor"});
assert.equal(rejected.preview,null,'An occupancy count or previous preview cannot substitute for rejected physical placement');
assert.match(rejected.error,/extends outside/);
const retrying = populationPreviewState('current',nineteen,{key:'current',loading:true,error:''});
assert.equal(retrying.preview,null,'Retry must wait for actual backend positions');
assert.equal(retrying.loading,true);
const changed = populationPreviewState('new-layout',nineteen,{key:'current',loading:false,error:'Old layout error'});
assert.equal(changed.error,'','A previous layout error must not follow corrected geometry');
assert.equal(changed.preview,null,'Positions from another layout cannot be drawn');
assert.equal(changed.loading,true);
assert.equal(populationPreviewState('current',nineteen,{key:'current',loading:false,error:''}).preview,nineteen,'Successful retry restores the real backend positions');
console.log('Room placement contracts passed: presets, overrides, baseline configuration, preview coordinates, failed/retried placement states, requested-vs-placed counts and stable placement keys.');

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
  const normalScenario={occupancy:24,mobility:'standard',distribution:'normal',seed:42,behaviorMode:'behavioral'};
  const normalResponse=await post('/api/populations',{plan:SAMPLE_PLAN,scenario:normalScenario});
  assert.equal(normalResponse.status,200);
  const normal=await normalResponse.json();
  assert.equal(normal.room_population.seated_count,21);
  assert.equal(normal.room_population.circulating_count,3);
  const normalRunResponse=await post('/api/simulations',{plan:SAMPLE_PLAN,scenario:normalScenario});
  assert.equal(normalRunResponse.status,200);
  const normalRun=await normalRunResponse.json();
  assert.deepEqual(normalRun.scenario.occupants,normal.occupants);
  assert.equal(normalRun.routing.mode,'adaptive');
  assert.equal(normalRun.summary.evacuated_count,24);
  const randomResponse=await post('/api/populations',{plan:SAMPLE_PLAN,scenario:{...normalScenario,distribution:'uniform'}});
  assert.equal(randomResponse.status,200);
  assert.notDeepEqual((await randomResponse.json()).occupants,normal.occupants);
  console.log('Room/Normal/Random HTTP checks passed: imports, counts, exact physical starts, immediate response and adaptive run metadata.');
}

const normalRequest=simulationRequest({plan:SAMPLE_PLAN,scenario:{...scenario,distribution:'normal'}});
assert.equal(normalRequest.scenario.distribution,'normal');
const seated=adaptPopulationPreview({radius:.23,occupants:[{position:[4,5]}],room_population:{rooms:[{id:'office',label:'Office',room_type:'office',count:1,rings:[]}],warnings:[],seated_count:1,circulating_count:0,
 normal_placements:[{seat_position:[4.1,5.1],standing_position:[4,5],facing:[0,1],kind:'sofa'}]}},SAMPLE_PLAN,'normal');
assert.deepEqual(seated.people,[{x:128,y:440}]);
assert.deepEqual(seated.displayPeople,[{x:4.1*32,y:600-5.1*32}]);
assert.equal(seated.facingAngles[0],-Math.PI/2);
assert.equal(seated.seatedCount,1);
console.log('Normal placement contracts passed: separate seated display poses and physical standing starts.');
