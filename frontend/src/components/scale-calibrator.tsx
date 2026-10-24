"use client";

import {useState} from "react";
import type {Point} from "@/lib/simulation";

export type PendingCalibration = {needs_scale: true; extraction_id: string; image_id: string;
  width_px: number; height_px: number; reason: string};

export default function ScaleCalibrator({pending,busy,onApply}: {pending: PendingCalibration; busy: boolean;
  onApply: (reference: {kind: "dimension"; label: string; start: Point; end: Point; distance: number; unit: string})=>void}) {
  const [points,setPoints]=useState<Point[]>([]);
  const [length,setLength]=useState("");
  const [unit,setUnit]=useState("m");
  const [imageError,setImageError]=useState(false);
  return <section className="scale-calibrator" aria-label="Set a known distance">
    <p role="status">{pending.reason}</p>
    <p>Click the two ends of a known measurement, then enter its length. Your extraction is saved; this does not call the model again.</p>
    <svg viewBox={`0 0 ${pending.width_px} ${pending.height_px}`} className="calibration-image"
      role="group" aria-label="Mark measurement endpoints on the source image"
      onPointerDown={event=>{
        if(busy) return;
        const matrix=event.currentTarget.getScreenCTM();if(!matrix)return;
        const p=new DOMPoint(event.clientX,event.clientY).matrixTransform(matrix.inverse());
        if(p.x<0||p.x>pending.width_px||p.y<0||p.y>pending.height_px)return;
        setPoints(current=>current.length===2?[{x:p.x,y:p.y}]:[...current,{x:p.x,y:p.y}]);
      }}>
      <image href={`/api/floorplans?image_id=${pending.image_id}`} width={pending.width_px} height={pending.height_px}
        onError={()=>setImageError(true)} />
      {points.length===2&&<line x1={points[0].x} y1={points[0].y} x2={points[1].x} y2={points[1].y}
        stroke="#245dca" strokeWidth="3" vectorEffect="non-scaling-stroke" />}
      {points.map((p,i)=><g key={i}><circle cx={p.x} cy={p.y} r={pending.width_px/100} fill="#245dca" stroke="white" strokeWidth="2"/>
        <text x={p.x+12} y={p.y-12} fill="#173e92" fontSize={pending.width_px/35}>{i+1}</text></g>)}
    </svg>
    {imageError&&<p role="alert">The source image is unavailable. Upload it again to restore it.</p>}
    <p className="muted">{points.length}/2 points marked. You can also enter pixel coordinates below.</p>
    <div className="measurement-points">{[0,1].map(i=><fieldset disabled={busy} key={i}><legend>Point {i+1}</legend>
      {(["x","y"] as const).map(axis=><label key={axis}>{axis.toUpperCase()}<input type="number" min="0"
        max={axis==="x"?pending.width_px:pending.height_px} aria-label={`Measurement point ${i+1} ${axis}`}
        value={points[i]?.[axis]??""} onChange={event=>setPoints(current=>{
          const next=[current[0]??{x:0,y:0},current[1]??{x:0,y:0}];next[i]={...next[i],[axis]:Number(event.target.value)};return next;
        })}/></label>)}</fieldset>)}</div>
    <div className="measurement-input"><label>Known distance<input type="number" min="0.001" step="any" value={length}
      disabled={busy} onChange={e=>setLength(e.target.value)}/></label>
      <label>Units<select value={unit} disabled={busy} onChange={e=>setUnit(e.target.value)}>
        <option value="m">Meters</option><option value="cm">Centimeters</option><option value="mm">Millimeters</option>
        <option value="ft">Feet</option><option value="in">Inches</option></select></label></div>
    <button className="button primary" disabled={busy||points.length!==2||!(Number(length)>0)||imageError}
      onClick={()=>onApply({kind:"dimension",label:`User measurement: ${length} ${unit}`,start:points[0],end:points[1],distance:Number(length),unit})}>
      {busy?"Applying scale…":"Apply scale and open layout"}</button>
  </section>;
}
