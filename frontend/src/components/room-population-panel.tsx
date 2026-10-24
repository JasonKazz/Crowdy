"use client";
import type {Scenario, FloorPlan} from "@/lib/simulation";
import {ACTIVITIES, ACTIVITY_LABELS, BUILDING_TYPES, ROOM_TYPES, roomTypeLabel,
  type PopulationPreview, type PopulationSettings} from "@/lib/room-population";

type Props = {plan: FloorPlan; scenario: Scenario; preview: PopulationPreview | null;
  loading: boolean; error: string; onChange: (scenario: Scenario) => void};

export default function RoomPopulationPanel({plan, scenario, preview, loading, error, onChange}: Props) {
  const config = scenario.population ?? {};
  const rooms = preview?.rooms.length ? preview.rooms : (plan.rooms ?? []).map(room=>({...room,count:0,usable_area:0}));
  function update(next: PopulationSettings) {onChange({...scenario,population:next});}
  return <div className="room-population-panel">
    <label className="field-label" htmlFor="building-type">Building type</label>
    <select id="building-type" value={config.buildingType ?? "auto"} onChange={event=>update({...config,
      buildingType:event.target.value as PopulationSettings["buildingType"],activity:"auto"})}>
      {BUILDING_TYPES.map(type=><option key={type} value={type}>{type==="auto"?"Detect automatically":roomTypeLabel(type)}</option>)}
    </select>
    <label className="field-label" htmlFor="activity-preset">Time / activity</label>
    <select id="activity-preset" value={config.activity ?? "auto"} onChange={event=>update({...config,
      activity:event.target.value as PopulationSettings["activity"]})}>
      {ACTIVITIES.map(activity=><option key={activity} value={activity}>{ACTIVITY_LABELS[activity]}</option>)}
    </select>
    <p className="helper">{preview?.buildingType ? `Using ${roomTypeLabel(preview.buildingType).toLowerCase()} · ${ACTIVITY_LABELS[preview.activity as keyof typeof ACTIVITY_LABELS] ?? preview.activity}. ` : "Room uses are detected from labels and furnishings. "}
      Presets are assumptions. Room overrides stay fixed; remaining people are distributed automatically.</p>
    <div className="room-population-heading"><strong>People by room</strong><button type="button" className="text-button"
      onClick={()=>update({...config,roomCounts:{},roomTypes:{}})}>Reset rooms</button></div>
    {loading && <p className="helper" role="status">Updating placement…</p>}
    {error && <p className="room-placement-error" role="alert">{error}</p>}
    {!rooms.length && <p className="helper">No room outlines yet. The whole open floor will be used. Import a plan with readable room labels for more detail.</p>}
    <div className="room-population-list">
      {rooms.map(room=><div className="room-population-row" key={room.id}>
        <label htmlFor={`room-count-${room.id}`} title={room.label}>{room.label}</label>
        <select aria-label={`Type of ${room.label}`} value={config.roomTypes?.[room.id] ?? room.room_type}
          onChange={event=>update({...config,roomTypes:{...config.roomTypes,[room.id]:event.target.value as typeof ROOM_TYPES[number]}})}>
          {ROOM_TYPES.map(type=><option key={type} value={type}>{roomTypeLabel(type)}</option>)}
        </select>
        <div className="room-count-controls">
          <input id={`room-count-${room.id}`} aria-label={`People in ${room.label}`} type="number" min="0" max="200" step="1"
            value={config.roomCounts?.[room.id] ?? room.count}
            onChange={event=>{if(event.target.value==="")return;const count=Number(event.target.value);
              if(!Number.isInteger(count)||count<0||count>200)return;
              const roomCounts={...config.roomCounts,[room.id]:count};
              const fixed=Object.values(roomCounts).reduce((a,b)=>a+b,0);
              if(fixed>200)return;
              onChange({...scenario,occupancy:Math.max(scenario.occupancy,fixed),population:{...config,roomCounts}});
            }}/>
          <button type="button" className="text-button" disabled={config.roomCounts?.[room.id]===undefined}
            aria-label={`Use automatic count for ${room.label}`} onClick={()=>{const roomCounts={...config.roomCounts};delete roomCounts[room.id];update({...config,roomCounts});}}>
            {config.roomCounts?.[room.id]===undefined?"Auto":"Fixed · reset"}</button>
        </div>
      </div>)}
    </div>
    {preview && !loading && !error && <p className="helper">{preview.people.length} / {scenario.occupancy} people placed. Changing room counts updates the preview; Run starts a new evacuation.</p>}
    {preview?.warnings.map((warning,index)=><p key={index} className="helper room-placement-warning">{warning}</p>)}
  </div>;
}
