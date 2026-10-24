/* Physical scaling is shared by calibration and its regression checks. */
(function(root){
  function rescaleLayout(layout,factor){
    if(!Number.isFinite(factor)||factor<=0)throw new Error('Scale must be positive.');
    const next=JSON.parse(JSON.stringify(layout));
    const point=p=>p.map(value=>value*factor);
    for(const kind of ['walkable_areas','furniture','exits','rooms'])
      for(const region of next[kind]||[]){
        if(region.polygon)region.polygon=region.polygon.map(point);
        else if(kind==='exits'){region.offset*=factor;region.width*=factor;region.landing_depth*=factor;}
      }
    for(const wall of next.walls){wall.start=point(wall.start);wall.end=point(wall.end);wall.thickness*=factor;}
    for(const door of next.doors){door.offset*=factor;door.width*=factor;}
    for(const person of next.occupants)person.position=point(person.position);
    if(next.source_image){next.source_image.meters_per_pixel*=factor;next.source_image.scale_confirmed=true;}
    // People remain human-sized: radius, walking speed, and time settings are not scaled.
    return next;
  }
  const helpers={rescaleLayout};
  if(typeof module!=='undefined'&&module.exports)module.exports=helpers;else root.CrowdyImageTools=helpers;
})(typeof window!=='undefined'?window:this);
