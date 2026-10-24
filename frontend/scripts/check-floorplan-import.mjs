import assert from 'node:assert/strict';
import {awaitFloorPlanImport} from '../src/lib/floorplan-import.ts';
let replies=[];
globalThis.fetch=async()=>{
 const next=replies.shift();
 if(!next)throw new Error('Unexpected poll');
 return Response.json(next.body,{status:next.status??200});
};
const id='a'.repeat(32);
const progress=[];
replies=[{body:{status:'running',progress:'Reading detail 2',elapsed_seconds:12}},
 {body:{status:'complete',result:{plan:{id:'fixture'},warnings:['Review exits']}}}];
const result=await awaitFloorPlanImport(id,message=>progress.push(message));
assert.equal(result.plan.id,'fixture');
assert.match(progress[0],/Reading detail 2.*12s/);
replies=[{body:{status:'failed',error:'A detail region failed'}}];
await assert.rejects(awaitFloorPlanImport(id,()=>{}),/detail region failed/);
replies=[{status:404,body:{error:'Backend restarted'}}];
await assert.rejects(awaitFloorPlanImport(id,()=>{}),/Backend restarted/);
await assert.rejects(awaitFloorPlanImport('invalid',()=>{}),/Invalid import/);
replies=[{body:{status:'unexpected'}}];
await assert.rejects(awaitFloorPlanImport(id,()=>{}),/Invalid import status/);
console.log('Import polling checks passed: progress, final result, failed stage, restart, malformed ID and invalid status.');
