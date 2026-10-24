/* Small, dependency-free geometry helpers shared by the editor and its checks. */
(function (root) {
  function bounds(points) {
    return {minX: Math.min(...points.map(p => p[0])), maxX: Math.max(...points.map(p => p[0])),
      minY: Math.min(...points.map(p => p[1])), maxY: Math.max(...points.map(p => p[1]))};
  }
  function center(points) {
    const b = bounds(points); return [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2];
  }
  function translate(points, dx, dy) { return points.map(([x,y]) => [x+dx, y+dy]); }
  function rotate(points, degrees) {
    const [cx,cy] = center(points), angle = degrees * Math.PI / 180;
    return points.map(([x,y]) => [cx + (x-cx)*Math.cos(angle) - (y-cy)*Math.sin(angle),
      cy + (x-cx)*Math.sin(angle) + (y-cy)*Math.cos(angle)]);
  }
  function resize(points, width, height) {
    const b = bounds(points), [cx,cy] = center(points);
    if (!(width > 0 && height > 0 && b.maxX > b.minX && b.maxY > b.minY))
      throw new Error('Width and height must be positive');
    return points.map(([x,y]) => [cx+(x-cx)*width/(b.maxX-b.minX), cy+(y-cy)*height/(b.maxY-b.minY)]);
  }
  function wallLength(wall) { return Math.hypot(wall.end[0]-wall.start[0], wall.end[1]-wall.start[1]); }
  function wallPolygon(wall, start=0, end=wallLength(wall)) {
    const length = wallLength(wall);
    if (length < 1e-6) return [];
    const ux=(wall.end[0]-wall.start[0])/length, uy=(wall.end[1]-wall.start[1])/length;
    const nx=-uy*wall.thickness/2, ny=ux*wall.thickness/2;
    const a=[wall.start[0]+ux*start,wall.start[1]+uy*start];
    const b=[wall.start[0]+ux*end,wall.start[1]+uy*end];
    return [[a[0]+nx,a[1]+ny],[b[0]+nx,b[1]+ny],[b[0]-nx,b[1]-ny],[a[0]-nx,a[1]-ny]];
  }
  function wallPieces(wall, doors) {
    const length=wallLength(wall), pieces=[];
    let cursor=0;
    const gaps=doors.filter(d=>d.wall_id===wall.id)
      .map(d=>[Math.max(0,d.offset-d.width/2),Math.min(length,d.offset+d.width/2)]).sort((a,b)=>a[0]-b[0]);
    for (const [start,end] of gaps) {
      if (start>cursor) pieces.push(wallPolygon(wall,cursor,start));
      cursor=Math.max(cursor,end);
    }
    if (cursor<length) pieces.push(wallPolygon(wall,cursor,length));
    return pieces;
  }
  function doorOffset(wall, door, point) {
    const length=wallLength(wall);
    if (length < 1e-6) return door.offset;
    const projected=((point[0]-wall.start[0])*(wall.end[0]-wall.start[0])+
      (point[1]-wall.start[1])*(wall.end[1]-wall.start[1]))/length;
    return Math.max(door.width/2,Math.min(length-door.width/2,projected));
  }
  function exitGeometry(door, floors, radius=.2) {
    const floor=floors.find(f=>f.id===door.floor_id), points=floor?.polygon;
    if(!points||!Number.isInteger(door.edge_index)||!points[door.edge_index])return null;
    const start=points[door.edge_index],end=points[(door.edge_index+1)%points.length];
    const wall={start,end},length=wallLength(wall);if(length<1e-6)return null;
    const ux=(end[0]-start[0])/length,uy=(end[1]-start[1])/length;
    const area=points.reduce((sum,p,i)=>{const q=points[(i+1)%points.length];return sum+p[0]*q[1]-q[0]*p[1];},0);
    const [nx,ny]=area>0?[uy,-ux]:[-uy,ux];
    const width=door.outside_width||door.width+2*door.landing_depth;
    const spread=door.outside_space==='corridor'?0:(width-door.width)/2;
    const transition=Math.min(.25,door.landing_depth*.2);
    const position=(along,depth)=>[start[0]+ux*along+nx*depth,start[1]+uy*along+ny*depth];
    const a=door.offset-door.width/2,b=door.offset+door.width/2,d=door.landing_depth;
    return {wall,apron:[position(a,-.05),position(b,-.05),position(b,0),position(b+spread,transition),position(b+spread,d),
      position(a-spread,d),position(a-spread,transition),position(a,0)],
      target:[position(a+.01,radius+.02),position(b-.01,radius+.02),position(b-.01,radius+.20),position(a+.01,radius+.20)],
      threshold:[position(a,-.05),position(b,-.05),position(b,.05),position(a,.05)]};
  }
  function resizeCorner(points,index,point,keepAspect=false){
    const b=bounds(points),corners=[[b.minX,b.minY],[b.maxX,b.minY],[b.maxX,b.maxY],[b.minX,b.maxY]];
    const anchor=corners[(index+2)%4],old=corners[index];
    let sx=Math.max(.05,Math.abs(point[0]-anchor[0]))/Math.max(.0001,Math.abs(old[0]-anchor[0]));
    let sy=Math.max(.05,Math.abs(point[1]-anchor[1]))/Math.max(.0001,Math.abs(old[1]-anchor[1]));
    if(keepAspect)sx=sy=Math.max(sx,sy);
    return points.map(([x,y])=>[anchor[0]+(x-anchor[0])*sx,anchor[1]+(y-anchor[1])*sy]);
  }
  function nearestEdge(floors,point,width){
    const candidates=[];
    for(const floor of floors)for(let index=0;index<floor.polygon.length;index++){
      const wall={start:floor.polygon[index],end:floor.polygon[(index+1)%floor.polygon.length]},length=wallLength(wall);
      if(length<width)continue;
      const offset=doorOffset(wall,{width,offset:0},point),ux=(wall.end[0]-wall.start[0])/length,uy=(wall.end[1]-wall.start[1])/length;
      candidates.push({floor_id:floor.id,edge_index:index,offset,distance:Math.hypot(point[0]-wall.start[0]-ux*offset,point[1]-wall.start[1]-uy*offset)});
    }
    return candidates.sort((a,b)=>a.distance-b.distance)[0]||null;
  }
  function zoomBox(box,factor,anchor=[box[0]+box[2]/2,box[1]+box[3]/2]){
    return[anchor[0]+(box[0]-anchor[0])*factor,anchor[1]+(box[1]-anchor[1])*factor,box[2]*factor,box[3]*factor];
  }
  const geometry={bounds,center,translate,rotate,resize,wallLength,wallPolygon,wallPieces,doorOffset,exitGeometry,resizeCorner,nearestEdge,zoomBox};
  if (typeof module !== 'undefined' && module.exports) module.exports=geometry;
  else root.CrowdyGeometry=geometry;
})(typeof window !== 'undefined' ? window : this);
