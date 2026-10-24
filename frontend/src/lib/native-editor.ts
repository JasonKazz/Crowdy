import type {FloorPlan, Point} from "./simulation";

export type XY = [number, number];
export type NativeWall = {id: string; start: XY; end: XY; thickness: number};
export type NativeDoor = {id: string; wall_id: string; offset: number; width: number};
export type NativeExit = {id: string; floor_id: string; edge_index: number; offset: number; width: number;
  landing_depth: number; outside_space: "open" | "corridor"; outside_width?: number | null};
export type NativeLayout = {
  walls: NativeWall[]; doors: NativeDoor[]; exits: (NativeExit | {id: string; polygon: XY[]})[];
  walkable_areas: {id: string; polygon: XY[]}[]; furniture: {id: string; polygon: XY[]}[];
  agent_defaults: {radius: number; desired_speed: number};
  source_image?: {id: string; width_px: number; height_px: number; meters_per_pixel: number;
    calibration?: {method: "automatic" | "manual" | "estimated"; label: string;
      meters_per_pixel_range?: [number, number] | null} | null} | null;
};
export type GeometrySelection = {kind: "wall" | "door" | "exit"; id: string} | null;
export type GeometryTool = "select" | "wall" | "door" | "exit";

export function nativeLayout(plan: FloorPlan): NativeLayout {
  return plan.native!.layout as unknown as NativeLayout;
}
export function pixelPoint(plan: FloorPlan, point: XY): Point {
  const t = plan.native!.transform;
  return {x: point[0] * t.pixels_per_metre + t.offset_x, y: t.offset_y - point[1] * t.pixels_per_metre};
}
export function worldPoint(plan: FloorPlan, point: Point): XY {
  const t = plan.native!.transform;
  return [(point.x - t.offset_x) / t.pixels_per_metre, (t.offset_y - point.y) / t.pixels_per_metre];
}
export const distance = (a: XY, b: XY) => Math.hypot(b[0] - a[0], b[1] - a[1]);
export function along(a: XY, b: XY, offset: number): XY {
  const length = distance(a,b) || 1;
  return [a[0] + (b[0] - a[0]) * offset / length, a[1] + (b[1] - a[1]) * offset / length];
}
export function project(a: XY, b: XY, point: XY) {
  const length = distance(a,b) || 1;
  const offset = Math.max(0, Math.min(length, ((point[0]-a[0])*(b[0]-a[0]) + (point[1]-a[1])*(b[1]-a[1])) / length));
  return {offset, distance: distance(point, along(a,b,offset)), length};
}
export function wallShape(wall: NativeWall, start=0, end=distance(wall.start,wall.end)): XY[] {
  const length = distance(wall.start,wall.end) || 1;
  const nx = -(wall.end[1]-wall.start[1]) / length * wall.thickness/2;
  const ny = (wall.end[0]-wall.start[0]) / length * wall.thickness/2;
  const a=along(wall.start,wall.end,start), b=along(wall.start,wall.end,end);
  return [[a[0]+nx,a[1]+ny],[b[0]+nx,b[1]+ny],[b[0]-nx,b[1]-ny],[a[0]-nx,a[1]-ny]];
}
export function doorEnds(layout: NativeLayout, door: NativeDoor): XY[] {
  const wall=layout.walls.find(w=>w.id===door.wall_id);
  return wall ? [along(wall.start,wall.end,door.offset-door.width/2), along(wall.start,wall.end,door.offset+door.width/2)] : [];
}
export function exitEdge(layout: NativeLayout, exit: NativeExit) {
  const floor=layout.walkable_areas.find(f=>f.id===exit.floor_id);
  if (!floor || !floor.polygon[exit.edge_index]) return null;
  const a=floor.polygon[exit.edge_index], b=floor.polygon[(exit.edge_index+1)%floor.polygon.length];
  const length=distance(a,b) || 1;
  const area=floor.polygon.reduce((sum,p,i)=>{const q=floor.polygon[(i+1)%floor.polygon.length]; return sum+p[0]*q[1]-q[0]*p[1];},0);
  const sign=area>0 ? 1 : -1;
  return {a,b,length,normal:[sign*(b[1]-a[1])/length,-sign*(b[0]-a[0])/length] as XY};
}

/** A drawing preview only. The Python compiler validates every actual run. */
export function withNativeLayout(plan: FloorPlan, layout: NativeLayout): FloorPlan {
  const next=structuredClone(plan), native=next.native!;
  native.layout=layout as unknown as Record<string,unknown>;
  native.issues=["Layout changed. Check layout or run to validate your edits."];
  const pixels=(points: XY[])=>points.map(p=>pixelPoint(next,p));
  native.walls=[];
  for(const wall of layout.walls) {
    const length=distance(wall.start,wall.end);
    const gaps=layout.doors.filter(d=>d.wall_id===wall.id).map(d=>[Math.max(0,Math.min(length,d.offset-d.width/2)),Math.max(0,Math.min(length,d.offset+d.width/2))])
      .sort((a,b)=>a[0]-b[0]);
    let cursor=0;
    for(const [start,end] of [...gaps,[length,length]]) {
      if(start>cursor) native.walls.push(pixels(wallShape(wall,cursor,start)));
      cursor=Math.max(cursor,end);
    }
  }
  native.exit_zones=[];
  next.exits=layout.exits.map(exit=>{
    if("polygon" in exit) {
      const polygon=pixels(exit.polygon);
      native.exit_zones.push({id:exit.id,polygon});
      return {id:exit.id,label:exit.id,x:polygon.reduce((s,p)=>s+p.x,0)/polygon.length,y:polygon.reduce((s,p)=>s+p.y,0)/polygon.length};
    }
    const edge=exitEdge(layout,exit);
    if(!edge) return {id:exit.id,label:exit.id,x:0,y:0};
    const centre=along(edge.a,edge.b,exit.offset);
    const position=(offset:number,depth:number):XY=>{const p=along(edge.a,edge.b,offset);return [p[0]+edge.normal[0]*depth,p[1]+edge.normal[1]*depth];};
    const r=layout.agent_defaults.radius;
    native.exit_zones.push({id:exit.id,polygon:pixels([
      position(exit.offset-exit.width/2+.01,r+.02),position(exit.offset+exit.width/2-.01,r+.02),
      position(exit.offset+exit.width/2-.01,r+.20),position(exit.offset-exit.width/2+.01,r+.20)])});
    return {id:exit.id,label:exit.id,...pixelPoint(next,centre)};
  });
  return next;
}

export function moveGeometry(plan: FloorPlan, selection: NonNullable<GeometrySelection>, point: XY,
                             handle?: "start" | "end"): FloorPlan {
  const layout=structuredClone(nativeLayout(plan));
  if(selection.kind==="wall") {
    const wall=layout.walls.find(w=>w.id===selection.id)!;
    if(handle) wall[handle]=point;
    else {const centre=along(wall.start,wall.end,distance(wall.start,wall.end)/2);
      const delta=[point[0]-centre[0],point[1]-centre[1]];
      wall.start=[wall.start[0]+delta[0],wall.start[1]+delta[1]];
      wall.end=[wall.end[0]+delta[0],wall.end[1]+delta[1]];}
    if(distance(wall.start,wall.end)<.05) return plan;
  } else if(selection.kind==="door") {
    const door=layout.doors.find(d=>d.id===selection.id)!, wall=layout.walls.find(w=>w.id===door.wall_id);
    if(!wall) return plan;
    const p=project(wall.start,wall.end,point);
    door.offset=Math.max(door.width/2,Math.min(p.length-door.width/2,p.offset));
  } else {
    const exit=layout.exits.find(e=>e.id===selection.id);
    if(!exit || "polygon" in exit) return plan;
    const edges=layout.walkable_areas.flatMap(f=>f.polygon.map((a,i)=>({floor:f.id,index:i,...project(a,f.polygon[(i+1)%f.polygon.length],point)})))
      .filter(e=>e.length>=exit.width).sort((a,b)=>a.distance-b.distance);
    if(!edges.length) return plan;
    exit.floor_id=edges[0].floor;exit.edge_index=edges[0].index;
    exit.offset=Math.max(exit.width/2,Math.min(edges[0].length-exit.width/2,edges[0].offset));
  }
  return withNativeLayout(plan,layout);
}
