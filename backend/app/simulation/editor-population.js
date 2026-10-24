/* The editor defaults to fresh placement; backend imports retain exact coordinates. */
(function(root){
  function withGeneratedPopulation(layout,count=layout.population?.count??layout.occupants.length,seed=layout.population?.seed??42){
    if(!Number.isInteger(count)||count<1||count>5000)throw new Error('People must be a whole number from 1 to 5000.');
    if(!Number.isInteger(seed)||seed<0||seed>4294967295)throw new Error('Seed must be a whole number from 0 to 4294967295.');
    const next=JSON.parse(JSON.stringify(layout));
    const spawnIds=layout.population?.spawn_area_ids??layout.walkable_areas
      .filter(area=>!area.id.startsWith('exit-apron:')).map(area=>area.id);
    if(!spawnIds.length)throw new Error('Add an interior floor area before placing people.');
    next.occupants=[];
    next.population={count,seed,spawn_area_ids:[...spawnIds]};
    return next;
  }
  const helpers={withGeneratedPopulation};
  if(typeof module!=='undefined'&&module.exports)module.exports=helpers;else root.CrowdyPopulation=helpers;
})(typeof window!=='undefined'?window:this);
