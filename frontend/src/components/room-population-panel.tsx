"use client";
import type {Scenario,FloorPlan} from "@/lib/simulation";
import {ROOM_TYPES,roomTypeLabel,type PopulationPreview} from "@/lib/room-population";

type Props={plan:FloorPlan;scenario:Scenario;preview:PopulationPreview|null;loading:boolean;error:string;
  onChange:(scenario:Scenario)=>void};
export default function RoomPopulationPanel({plan,scenario,preview,loading,error,onChange}:Props){
  const config=scenario.population??{};
  const rooms=preview?.rooms.length?preview.rooms:(plan.rooms??[]).map(room=>({...room,count:0}));
  return <div className="room-population-panel">
    <p className="helper">People occupy usable chairs, desk positions, meeting tables and couches, with a small circulating group. Furniture-based seats are inferred when chairs are missing.</p>
    <p className="helper">The layout shows pre-alarm seated poses. Run starts from the adjacent clear standing positions; a sit-to-stand motion is not simulated.</p>
    {loading&&<p className="helper" role="status">Updating placement…</p>}
    {error&&<p className="room-placement-error" role="alert">{error}</p>}
    {preview&&!loading&&!error&&<p className="helper">{preview.seatedCount??0} seated / at desks · {preview.circulatingCount??preview.people.length} in circulation.</p>}
    <details><summary>Adjust room counts (optional)</summary>
      <div className="room-population-heading"><strong>People by room</strong>
        <button type="button" className="text-button" onClick={()=>onChange({...scenario,population:{...config,roomCounts:{},roomTypes:{}}})}>Reset rooms</button></div>
      <div className="room-population-list">{rooms.map(room=><div className="room-population-row" key={room.id}>
        <label htmlFor={`room-count-${room.id}`}>{room.label}</label>
        <select aria-label={`Type of ${room.label}`} value={config.roomTypes?.[room.id]??room.room_type}
          onChange={event=>onChange({...scenario,population:{...config,roomTypes:{...config.roomTypes,[room.id]:event.target.value as typeof ROOM_TYPES[number]}}})}>
          {ROOM_TYPES.map(type=><option key={type} value={type}>{roomTypeLabel(type)}</option>)}
        </select>
        <div className="room-count-controls"><input id={`room-count-${room.id}`} aria-label={`People in ${room.label}`}
          type="number" min="0" max="200" step="1" value={config.roomCounts?.[room.id]??room.count}
          onChange={event=>{if(event.target.value==='')return;const count=Number(event.target.value);if(!Number.isInteger(count)||count<0||count>200)return;
            const roomCounts={...config.roomCounts,[room.id]:count};const fixed=Object.values(roomCounts).reduce((a,b)=>a+b,0);if(fixed>200)return;
            onChange({...scenario,occupancy:Math.max(scenario.occupancy,fixed),population:{...config,roomCounts}});}}/>
          <button type="button" className="text-button" disabled={config.roomCounts?.[room.id]===undefined}
            aria-label={`Use automatic count for ${room.label}`} onClick={()=>{const roomCounts={...config.roomCounts};delete roomCounts[room.id];onChange({...scenario,population:{...config,roomCounts}});}}>
            {config.roomCounts?.[room.id]===undefined?'Auto':'Fixed · reset'}</button></div>
      </div>)}</div>
    </details>
    {preview?.warnings.map((warning,index)=><p key={index} className="helper room-placement-warning">{warning}</p>)}
  </div>;
}
