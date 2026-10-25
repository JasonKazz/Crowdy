"use client";

import {useState} from "react";
import type {Point} from "@/lib/simulation";
import {calibrationPreview, measurementPoint, type MeasurementCoordinates} from "@/lib/scale-calibration";

export type PendingCalibration = {needs_scale: true; extraction_id: string; image_id: string;
  width_px: number; height_px: number; reason: string; current_width_m?: number};

const meters = new Intl.NumberFormat("en-US", {maximumSignificantDigits: 4});
const emptyPoints = (): [MeasurementCoordinates, MeasurementCoordinates] => [{x: "", y: ""}, {x: "", y: ""}];

export default function ScaleCalibrator({pending,busy,onApply}: {pending: PendingCalibration; busy: boolean;
  onApply: (reference: {kind: "dimension"; label: string; start: Point; end: Point; distance: number; unit: string})=>void}) {
  const [coordinates,setCoordinates]=useState(emptyPoints);
  const [length,setLength]=useState("");
  const [unit,setUnit]=useState("m");
  const [imageError,setImageError]=useState(false);
  const [imageWidth,setImageWidth]=useState(pending.current_width_m?.toString()??"");
  const points=coordinates.map(measurementPoint);
  const measurement=calibrationPreview(pending,points[0],points[1],Number(length),unit);
  const fullWidth=calibrationPreview(pending,{x:0,y:0},{x:pending.width_px,y:0},Number(imageWidth),"m");
  function sizeSummary(preview: {width_m: number; height_m: number}) {
    return `Full image size: ${meters.format(preview.width_m)} m wide × ${meters.format(preview.height_m)} m high, including margins.`;
  }
  return <section className="scale-calibrator" aria-label="Set a known distance">
    <p role="status">{pending.reason}</p>
    <p className="muted">The image stays fitted to the canvas. Scale sets real-world floor and door sizes and the space available for people.</p>
    {pending.current_width_m!==undefined&&<div className="scale-width-adjustment">
      <label>Full image width (meters)<input type="number" min="0.001" max="1000" step="any" value={imageWidth}
        disabled={busy} onChange={event=>setImageWidth(event.target.value)}/></label>
      <p className="muted">Use the width of the entire image, including its margins, only if you know that distance.</p>
      <p className="scale-preview" aria-live="polite">{fullWidth.ok?sizeSummary(fullWidth):
        imageWidth.trim()?fullWidth.reason:"Enter the full image width in meters."}</p>
      <button className="button secondary" disabled={busy||!fullWidth.ok||imageError}
        onClick={()=>{
          if(busy||imageError||!fullWidth.ok)return;
          onApply({kind:"dimension",label:`Entered full image width: ${imageWidth} m`,
            start:{x:0,y:0},end:{x:pending.width_px,y:0},distance:Number(imageWidth),unit:"m"});
        }}>
        {busy?"Applying scale…":"Apply image width"}</button>
      <p>Or use a measurement between two points below.</p>
    </div>}
    <p>Use a verified real-world distance, such as a wall length from a dimensioned plan. Click its two ends, then enter the length and units. Your extraction is saved; this does not call the model again.</p>
    <svg viewBox={`0 0 ${pending.width_px} ${pending.height_px}`} className="calibration-image"
      role="group" aria-label="Mark measurement endpoints on the source image"
      onPointerDown={event=>{
        if(busy||imageError) return;
        const matrix=event.currentTarget.getScreenCTM();if(!matrix)return;
        const p=new DOMPoint(event.clientX,event.clientY).matrixTransform(matrix.inverse());
        if(!Number.isFinite(p.x)||!Number.isFinite(p.y)||p.x<0||p.x>pending.width_px||p.y<0||p.y>pending.height_px)return;
        const point={x:p.x.toFixed(2),y:p.y.toFixed(2)};
        setCoordinates(current=>{
          if(current.every(value=>measurementPoint(value)!==undefined))return [point,{x:"",y:""}];
          return measurementPoint(current[0])===undefined?[point,current[1]]:[current[0],point];
        });
      }}>
      <image href={`/api/floorplans?image_id=${pending.image_id}`} width={pending.width_px} height={pending.height_px}
        onError={()=>setImageError(true)} onLoad={()=>setImageError(false)} />
      {points[0]&&points[1]&&[points[0].x,points[0].y,points[1].x,points[1].y].every(Number.isFinite)&&
        <line x1={points[0].x} y1={points[0].y} x2={points[1].x} y2={points[1].y}
        stroke="#245dca" strokeWidth="3" vectorEffect="non-scaling-stroke" />}
      {points.map((p,i)=>p&&Number.isFinite(p.x)&&Number.isFinite(p.y)&&<g key={i}>
        <circle cx={p.x} cy={p.y} r={pending.width_px/100} fill="#245dca" stroke="white" strokeWidth="2"/>
        <text x={p.x+12} y={p.y-12} fill="#173e92" fontSize={pending.width_px/35}>{i+1}</text></g>)}
    </svg>
    {imageError&&<p role="alert">The source image is unavailable. Upload it again to restore it.</p>}
    <p className="muted">{points.filter(Boolean).length}/2 points marked. After two points, click again to start over. Pixel coordinates are editable below.</p>
    <div className="measurement-points">{coordinates.map((point,i)=><fieldset disabled={busy} key={i}><legend>Point {i+1}</legend>
      {(["x","y"] as const).map(axis=><label key={axis}>{axis.toUpperCase()}<input type="number" min="0" step="any"
        max={axis==="x"?pending.width_px:pending.height_px} aria-label={`Measurement point ${i+1} ${axis}`}
        value={point[axis]} onChange={event=>setCoordinates(current=>{
          const next: [MeasurementCoordinates,MeasurementCoordinates]=[...current];
          next[i]={...next[i],[axis]:event.target.value};return next;
        })}/></label>)}</fieldset>)}</div>
    <div className="measurement-input"><label>Known distance<input type="number" min="0.001" step="any" value={length}
      disabled={busy} onChange={e=>setLength(e.target.value)}/></label>
      <label>Units<select value={unit} disabled={busy} onChange={e=>setUnit(e.target.value)}>
        <option value="m">Meters</option><option value="cm">Centimeters</option><option value="mm">Millimeters</option>
        <option value="ft">Feet</option><option value="in">Inches</option></select></label></div>
    <p className="scale-preview" aria-live="polite">{measurement.ok?sizeSummary(measurement):measurement.reason}</p>
    <button className="button primary" disabled={busy||!measurement.ok||imageError}
      onClick={()=>{
        if(busy||imageError||!measurement.ok||!points[0]||!points[1])return;
        onApply({kind:"dimension",label:`User measurement: ${length} ${unit}`,start:points[0],end:points[1],distance:Number(length),unit});
      }}>
      {busy?"Applying scale…":"Apply scale and open layout"}</button>
  </section>;
}
