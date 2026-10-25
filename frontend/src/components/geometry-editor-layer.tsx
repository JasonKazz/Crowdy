"use client";

import {useRef,useState} from "react";
import type {PointerEvent} from "react";
import type {FloorPlan} from "@/lib/simulation";
import {along,distance,doorEnds,exitEdge,moveGeometry,nativeLayout,pixelPoint,project,withNativeLayout,worldPoint,
  type GeometrySelection,type GeometryTool,type NativeWall,type XY} from "@/lib/native-editor";

function WallControls({plan,wall,index,selected,onSelect,onBegin}: {plan:FloorPlan;wall:NativeWall;index:number;selected:boolean;
  onSelect:(s:GeometrySelection)=>void;onBegin:(event:PointerEvent<SVGElement>,s:NonNullable<GeometrySelection>,handle?:"start"|"end")=>void}) {
  const a=pixelPoint(plan,wall.start),b=pixelPoint(plan,wall.end);
  return <g role="button" tabIndex={0} aria-label={`Select wall ${index+1}`} aria-pressed={selected}
    onKeyDown={e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();onSelect({kind:"wall",id:wall.id});}}}>
    <rect x={Math.min(a.x,b.x)-7} y={Math.min(a.y,b.y)-7} width={Math.abs(b.x-a.x)+14} height={Math.abs(b.y-a.y)+14}
      fill="transparent" pointerEvents="none"/>
    <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="transparent"
      strokeWidth="14" cursor="move" onPointerDown={e=>onBegin(e,{kind:"wall",id:wall.id})}/>
    {selected&&<line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#245dca" strokeWidth="2" pointerEvents="none"/>}
    {selected&&(["start","end"] as const).map(handle=>{const p=pixelPoint(plan,wall[handle]);return <circle key={handle}
      cx={p.x} cy={p.y} r="6" fill="white" stroke="#245dca" strokeWidth="2" cursor="crosshair"
      aria-label={`Wall ${handle} handle`} onPointerDown={e=>onBegin(e,{kind:"wall",id:wall.id},handle)}/>;})}
  </g>;
}

type Props={plan:FloorPlan; selection:GeometrySelection; tool:GeometryTool; onSelect:(s:GeometrySelection)=>void;
  onChange:(plan:FloorPlan)=>void; onPreview:(plan:FloorPlan|null)=>void; onToolDone:()=>void};
export default function GeometryEditorLayer({plan,selection,tool,onSelect,onChange,onPreview,onToolDone}:Props) {
  const drag=useRef<{plan:FloorPlan; preview:FloorPlan; selection:NonNullable<GeometrySelection>; handle?:"start"|"end"; offset:XY; moved:boolean}|null>(null);
  const [start,setStart]=useState<XY|null>(null);
  const [cursor,setCursor]=useState<XY|null>(null);
  const layout=nativeLayout(plan);
  function point(event:PointerEvent<SVGElement>):XY {
    const matrix=(event.currentTarget as SVGGraphicsElement).getScreenCTM();if(!matrix)return [0,0];
    const p=new DOMPoint(event.clientX,event.clientY).matrixTransform(matrix.inverse());
    return worldPoint(plan,{x:p.x,y:p.y});
  }
  function snap(p:XY):XY {
    const corners=[...layout.walkable_areas.flatMap(f=>f.polygon),...layout.walls.flatMap(w=>[w.start,w.end])];
    const nearest=corners.slice().sort((a,b)=>distance(a,p)-distance(b,p))[0];
    return nearest&&distance(nearest,p)*plan.native!.transform.pixels_per_metre<8 ? nearest : [Math.round(p[0]*100)/100,Math.round(p[1]*100)/100];
  }
  function place(event:PointerEvent<SVGElement>) {
    event.stopPropagation();if(event.button!==0)return;
    const p=snap(point(event)), next=structuredClone(layout);
    if(tool==="wall") {
      if(!start){setStart(p);setCursor(p);return;}
      const end:XY=event.shiftKey?(Math.abs(p[0]-start[0])>Math.abs(p[1]-start[1])?[p[0],start[1]]:[start[0],p[1]]):p;
      if(distance(start,end)<.1)return;
      const id=`wall-${crypto.randomUUID()}`;next.walls.push({id,start,end,thickness:.15});
      onChange(withNativeLayout(plan,next));onSelect({kind:"wall",id});setStart(null);onToolDone();
    } else if(tool==="door") {
      const choices=next.walls.map(w=>({wall:w,...project(w.start,w.end,p)})).sort((a,b)=>a.distance-b.distance);
      const best=choices[0];if(!best||best.distance*plan.native!.transform.pixels_per_metre>20||best.length<.6)return;
      const width=Math.min(1,best.length*.7), id=`door-${crypto.randomUUID()}`;
      next.doors.push({id,wall_id:best.wall.id,width,offset:Math.max(width/2,Math.min(best.length-width/2,best.offset))});
      onChange(withNativeLayout(plan,next));onSelect({kind:"door",id});onToolDone();
    } else if(tool==="exit") {
      const edges=next.walkable_areas.flatMap(f=>f.polygon.map((a,i)=>({floor:f.id,index:i,...project(a,f.polygon[(i+1)%f.polygon.length],p)})))
        .filter(e=>e.length>.6).sort((a,b)=>a.distance-b.distance);
      const best=edges[0];if(!best||best.distance*plan.native!.transform.pixels_per_metre>25)return;
      const id=`exit-${crypto.randomUUID()}`,width=Math.min(1.2,best.length*.7);
      next.exits.push({id,floor_id:best.floor,edge_index:best.index,offset:Math.max(width/2,Math.min(best.length-width/2,best.offset)),
        width,landing_depth:2,outside_space:"open"});
      onChange(withNativeLayout(plan,next));onSelect({kind:"exit",id});onToolDone();
    } else onSelect(null);
  }
  function begin(event:PointerEvent<SVGElement>,s:NonNullable<GeometrySelection>,handle?:"start"|"end") {
    if(tool!=="select"){place(event);return;}
    event.stopPropagation();if(event.button!==0)return;
    onSelect(s);
    const p=point(event);let centre=p;
    if(s.kind==="wall") {const w=layout.walls.find(w=>w.id===s.id)!;centre=handle?w[handle]:along(w.start,w.end,distance(w.start,w.end)/2);}
    drag.current={plan:structuredClone(plan),preview:plan,selection:s,handle,offset:[p[0]-centre[0],p[1]-centre[1]],moved:false};
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function finish() {
    const current=drag.current;drag.current=null;
    if(current?.moved)onChange(current.preview);
    onPreview(null);
  }
  const pixels=(points:XY[])=>points.map(p=>pixelPoint(plan,p));
  return <g aria-label="Wall and door editing" onPointerMove={event=>{
    const p=point(event);
    if(start)setCursor(p);
    const current=drag.current;if(!current)return;
    const target:XY=snap([p[0]-current.offset[0],p[1]-current.offset[1]]);
    current.moved=true;current.preview=moveGeometry(current.plan,current.selection,target,current.handle);onPreview(current.preview);
  }} onPointerUp={finish} onPointerCancel={()=>{drag.current=null;onPreview(null);}}
    onKeyDown={event=>{if(event.key==="Escape"){setStart(null);onToolDone();}}}>
    {tool!=="select"&&<rect x="0" y="0" width="900" height="600" fill="transparent" cursor="crosshair" onPointerDown={place}/>}
    {layout.walls.map((wall,index)=><WallControls key={wall.id} plan={plan} wall={wall} index={index}
      selected={selection?.kind==="wall"&&selection.id===wall.id} onSelect={onSelect} onBegin={begin}/>)}
    {layout.doors.map((door,index)=>{const ends=pixels(doorEnds(layout,door));if(ends.length!==2)return null;
      const selected=selection?.kind==="door"&&selection.id===door.id;
      return <g key={door.id} role="button" tabIndex={0} aria-label={`Select door ${index+1}`} aria-pressed={selected}
        onPointerDown={e=>begin(e,{kind:"door",id:door.id})}
        onKeyDown={e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();onSelect({kind:"door",id:door.id});}}}>
        <rect x={Math.min(ends[0].x,ends[1].x)-6} y={Math.min(ends[0].y,ends[1].y)-6}
          width={Math.abs(ends[1].x-ends[0].x)+12} height={Math.abs(ends[1].y-ends[0].y)+12} fill="transparent" pointerEvents="none"/>
        <line x1={ends[0].x} y1={ends[0].y} x2={ends[1].x} y2={ends[1].y} stroke={selected?"#245dca":"#539998"} strokeWidth="8" strokeOpacity=".65" cursor="ew-resize"/>
      </g>;
    })}
    {layout.exits.map((exit,index)=>{if("polygon" in exit)return null;const edge=exitEdge(layout,exit);if(!edge)return null;
      const p=pixelPoint(plan,along(edge.a,edge.b,exit.offset));
      const selected=selection?.kind==="exit"&&selection.id===exit.id;
      const label=`Exit ${index+1}`;
      return <g key={exit.id} role="button" tabIndex={0}
        aria-label={`Select exterior exit ${index+1}`} aria-pressed={selection?.kind==="exit"&&selection.id===exit.id}
        onPointerDown={e=>begin(e,{kind:"exit",id:exit.id})} onKeyDown={e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();onSelect({kind:"exit",id:exit.id});}}}>
        <title>{`${label} · ${exit.width.toFixed(2)} m wide. Drag along the outline to move.`}</title>
        <circle cx={p.x} cy={p.y} r="10" fill="transparent" cursor="move"/>
        <circle cx={p.x} cy={p.y} r={selected?5:3} fill={selected?"#245dca":"#397b51"} stroke="white" strokeWidth="1.5" pointerEvents="none"/>
        <text x={p.x+8} y={p.y-9} fontSize="9" fill="#315f45" stroke="#fbfcfa" strokeWidth="3" paintOrder="stroke" pointerEvents="none">
          {label}{selected?` · ${exit.width.toFixed(2)} m`:""}</text>
      </g>;})}
    {start&&cursor&&(()=>{const a=pixelPoint(plan,start),b=pixelPoint(plan,cursor);return <line x1={a.x} y1={a.y} x2={b.x} y2={b.y}
      stroke="#245dca" strokeWidth="3" strokeDasharray="5 3" pointerEvents="none"/>;})()}
  </g>;
}
