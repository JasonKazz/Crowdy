"use client";

import type {FloorPlan} from "@/lib/simulation";
import {distance,nativeLayout,withNativeLayout,type GeometrySelection,type GeometryTool} from "@/lib/native-editor";

export default function GeometryPanel({plan,selection,tool,busy,onChange,onSelect,onTool,onCheck,overlay,onOverlay,opacity,onOpacity}:
  {plan:FloorPlan;selection:GeometrySelection;tool:GeometryTool;busy:boolean;onChange:(p:FloorPlan)=>void;
    onSelect:(s:GeometrySelection)=>void;onTool:(t:GeometryTool)=>void;onCheck:()=>void;
    overlay:boolean;onOverlay:(value:boolean)=>void;opacity:number;onOpacity:(value:number)=>void}) {
  if(!plan.native)return <p className="helper">Import an image or backend layout JSON to edit walls and doors.</p>;
  const layout=nativeLayout(plan);
  const wall=selection?.kind==="wall"?layout.walls.find(w=>w.id===selection.id):undefined;
  const door=selection?.kind==="door"?layout.doors.find(d=>d.id===selection.id):undefined;
  const exit=selection?.kind==="exit"?layout.exits.find(e=>e.id===selection.id):undefined;
  function update(change:(next:typeof layout)=>void){const next=structuredClone(layout);change(next);onChange(withNativeLayout(plan,next));}
  function field(label:string,value:number,change:(value:number)=>void,min?:number) {
    return <label key={label}>{label}<input type="number" aria-label={label} step="0.01" min={min}
      value={Number(value.toFixed(3))} onChange={e=>{const v=Number(e.target.value);if(Number.isFinite(v)&&(!min||v>=min))change(v);}}/></label>;
  }
  return <fieldset className="geometry-panel" disabled={busy}>
    <legend>Walls &amp; doors</legend>
    <label className="geometry-picker">Selected element<select aria-label="Selected geometry element"
      value={selection?JSON.stringify(selection):""} onChange={event=>onSelect(event.target.value?JSON.parse(event.target.value):null)}>
      <option value="">Choose an element</option>
      {layout.walls.map((item,i)=><option key={`wall:${item.id}`} value={JSON.stringify({kind:"wall",id:item.id})}>Wall {i+1}</option>)}
      {layout.doors.map((item,i)=><option key={`door:${item.id}`} value={JSON.stringify({kind:"door",id:item.id})}>Interior door {i+1}</option>)}
      {layout.exits.map((item,i)=><option key={`exit:${item.id}`} value={JSON.stringify({kind:"exit",id:item.id})}>Exterior exit {i+1}</option>)}
    </select></label>
    <div className="geometry-tools">{([["select","Select"],["wall","Draw wall"],["door","Add door"],["exit","Add exit"]] as const)
      .map(([value,label])=><button key={value} type="button" className={`button subtle${tool===value?" active":""}`}
        aria-pressed={tool===value} onClick={()=>{onTool(value);onSelect(null);}}>{label}</button>)}</div>
    <p className="helper">{tool==="wall"?"Click two endpoints. Hold Shift for a horizontal or vertical wall.":
      tool==="door"?"Click a wall to add an interior door.":tool==="exit"?"Click the exterior outline to add an exit.":
      "Drag a wall or its endpoint handles. Drag doors along their walls, and exits along the exterior outline."}</p>
    {wall&&<div className="geometry-properties"><strong>Interior wall</strong>
      {(["start","end"] as const).flatMap(end=>([0,1] as const).map(axis=>field(`Wall ${end} ${axis===0?"X":"Y"} (m)`,wall[end][axis],v=>update(next=>{
        next.walls.find(w=>w.id===wall.id)![end][axis]=v;
      }))))}
      {field("Wall thickness (m)",wall.thickness,v=>update(next=>{next.walls.find(w=>w.id===wall.id)!.thickness=v;}),.01)}
      <p className="helper">Moving a wall also moves its attached doors.</p>
    </div>}
    {door&&<div className="geometry-properties"><strong>Interior door</strong>
      <label>Parent wall<select aria-label="Door parent wall" value={door.wall_id} onChange={e=>update(next=>{
        const d=next.doors.find(d=>d.id===door.id)!,w=next.walls.find(w=>w.id===e.target.value)!;
        d.wall_id=w.id;d.offset=distance(w.start,w.end)/2;
      })}>{layout.walls.map((w,i)=><option key={w.id} value={w.id}>Wall {i+1}</option>)}</select></label>
      {field("Door position along wall (m)",door.offset,v=>update(next=>{next.doors.find(d=>d.id===door.id)!.offset=v;}),0)}
      {field("Door width (m)",door.width,v=>update(next=>{next.doors.find(d=>d.id===door.id)!.width=v;}),.05)}
    </div>}
    {exit&&!("polygon" in exit)&&<div className="geometry-properties"><strong>Exterior exit</strong>
      {field("Exit position along edge (m)",exit.offset,v=>update(next=>{const e=next.exits.find(e=>e.id===exit.id)!;if("offset" in e)e.offset=v;}),0)}
      {field("Exit width (m)",exit.width,v=>update(next=>{const e=next.exits.find(e=>e.id===exit.id)!;if("width" in e)e.width=v;}),.05)}
    </div>}
    {selection&&<button type="button" className="text-button" onClick={()=>{
      update(next=>{if(selection.kind==="wall"){next.walls=next.walls.filter(w=>w.id!==selection.id);next.doors=next.doors.filter(d=>d.wall_id!==selection.id);}
        else if(selection.kind==="door")next.doors=next.doors.filter(d=>d.id!==selection.id);
        else next.exits=next.exits.filter(e=>e.id!==selection.id);});onSelect(null);
    }}>Remove selected {selection.kind}</button>}
    {plan.native.image&&<div className="source-image-controls">
      <label><input type="checkbox" checked={overlay} onChange={e=>onOverlay(e.target.checked)}/> Source image overlay</label>
      {overlay&&<><label>Image opacity<input type="range" min="0.1" max="0.8" step="0.05" value={opacity}
        onChange={e=>onOpacity(Number(e.target.value))}/></label><p className="helper">The original image stays fixed while editable geometry moves.</p></>}
    </div>}
    <button type="button" className="button subtle" onClick={onCheck}>Check layout</button>
    {plan.native.issues?.length?<div className="geometry-status" role="status">{plan.native.issues.map((issue,i)=><p key={i}>{issue}</p>)}</div>:
      <p className="helper geometry-valid" role="status">Geometry checks passed.</p>}
  </fieldset>;
}
