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
  const geometry={bounds,center,translate,rotate,resize,wallLength,wallPolygon,wallPieces,doorOffset};
  if (typeof module !== 'undefined' && module.exports) module.exports=geometry;
  else root.CrowdyGeometry=geometry;
})(typeof window !== 'undefined' ? window : this);
