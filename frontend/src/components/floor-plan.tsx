"use client";

import { useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import { positionAt } from "@/lib/simulation";
import { headingAt } from "@/lib/person-heading";
import type { AgentPath, FloorPlan, PlanItem, Point, SimulationResult } from "@/lib/simulation";
import type {PopulationPreview} from "@/lib/room-population";
import GeometryEditorLayer from "./geometry-editor-layer";
import {exitDoorEnds, nativeLayout, pixelPoint, type GeometrySelection, type GeometryTool} from "@/lib/native-editor";

type Props = {
  plan: FloorPlan;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onMove: (id: string, x: number, y: number) => void;
  mode: "layout" | "simulation" | "compare";
  result: SimulationResult | null;
  placement?: PopulationPreview | null;
  time: number;
  showPeople: boolean;
  showRoutes: boolean;
  showDensity: boolean;
  zoom: number;
  reference?: string | null;
  showReference?: boolean;
  blockedExitIds?: string[];
  referenceOpacity?: number;
  geometrySelection?: GeometrySelection;
  geometryTool?: GeometryTool;
  onGeometrySelect?: (selection: GeometrySelection)=>void;
  onGeometryChange?: (plan: FloorPlan)=>void;
  onGeometryToolDone?: ()=>void;
};

type Drag = {
  id: string;
  offsetX: number;
  offsetY: number;
  x: number;
  y: number;
};

function Chair({
  x,
  y,
  rotation = 0,
  scale = 1,
}: {
  x: number;
  y: number;
  rotation?: number;
  scale?: number;
}) {
  return (
    <g transform={`translate(${x} ${y}) rotate(${rotation}) scale(${scale})`}>
      <path
        d="M-11 3v6q0 4 4 4H7q4 0 4-4V3"
        fill="var(--plan-seat, #e0e5df)"
        stroke="var(--plan-seat-stroke, #aab4a9)"
        strokeWidth="1"
      />
      <rect
        x="-9"
        y="-7"
        width="18"
        height="15"
        rx="4"
        fill="var(--plan-seat, #edf0eb)"
        stroke="var(--plan-seat-stroke, #aab4a9)"
        strokeWidth="1"
      />
      <path
        d="M-12-2v9m24-9v9"
        stroke="var(--plan-seat-stroke, #aab4a9)"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </g>
  );
}

function Furniture({ item }: { item: PlanItem }) {
  const { width: w, height: h } = item;
  if (item.polygon) return <polygon points={item.polygon.map(p=>`${p.x*w},${p.y*h}`).join(" ")}
    fill="var(--plan-furniture, #dce2d7)" stroke="var(--plan-furniture-stroke, #7f8d77)" strokeWidth="1.2" />;
  if (item.kind === "plant") {
    const r = Math.min(w, h) / 2;
    return (
      <g transform={`translate(${w / 2} ${h / 2})`}>
        <circle r={r * 0.75} fill="var(--plan-furniture, #e9e5db)" stroke="var(--plan-furniture-stroke, #c1bfb3)" strokeWidth="1" />
        {[0, 60, 120, 180, 240, 300].map((rotation, index) => (
          <ellipse
            key={rotation}
            cx="0"
            cy={-r * 0.36}
            rx={r * 0.31}
            ry={r * 0.65}
            transform={`rotate(${rotation})`}
            fill={index % 2 ? "#93a78a" : "#6e8d68"}
            stroke="#6c8964"
            strokeWidth="0.55"
          />
        ))}
        <circle r="3" fill="#56734e" />
      </g>
    );
  }
  if (item.kind === "shelf") {
    const horizontal = w >= h;
    return (
      <g>
        <rect x="1" y="2" width={w} height={h} rx="2" fill="var(--plan-room, #dde1d8)" />
        <rect
          width={w}
          height={h}
          rx="2"
          fill="var(--plan-furniture, #ece8dd)"
          stroke="var(--plan-furniture-stroke, #b6b2a3)"
          strokeWidth="1.2"
        />
        {Array.from(
          { length: Math.floor((horizontal ? w : h) / 12) },
          (_, i) => (
            <rect
              key={i}
              x={horizontal ? 5 + i * 12 : 5}
              y={horizontal ? 5 : 5 + i * 12}
              width={horizontal ? 7 : w - 10}
              height={horizontal ? h - 10 : 7}
              rx="0.8"
              fill={["var(--plan-seat-stroke, #b4b9a3)", "var(--plan-furniture-stroke, #c0ac8e)", "var(--plan-furniture-stroke, #d4c6ae)", "var(--plan-seat-stroke, #a4b3ae)"][i % 4]}
            />
          ),
        )}
      </g>
    );
  }
  if (item.kind === "sofa") {
    const vertical = h > w;
    return (
      <g>
        <rect x="1" y="2" width={w} height={h} rx="7" fill="var(--plan-room, #dce0d8)" />
        <rect
          width={w}
          height={h}
          rx="7"
          fill="var(--plan-sofa, #d5ddcd)"
          stroke="var(--plan-seat-stroke, #9fae94)"
          strokeWidth="1.2"
        />
        <rect
          x="6"
          y="6"
          width={w - 12}
          height={h - 12}
          rx="4"
          fill="var(--plan-seat, #e3e8dd)"
          stroke="var(--plan-seat-stroke, #aebaa3)"
          strokeWidth="0.8"
        />
        {vertical ? (
          <>
            <path
              d={`M6 ${h / 2}h${w - 12}M${w - 10} 7v${h - 14}`}
              stroke="var(--plan-seat-stroke, #b0bba6)"
              strokeWidth="1"
            />
            <rect x="2" y="3" width={w - 4} height="7" rx="3" fill="var(--plan-sofa, #c5d0bb)" />
            <rect
              x="2"
              y={h - 10}
              width={w - 4}
              height="7"
              rx="3"
              fill="var(--plan-sofa, #c5d0bb)"
            />
          </>
        ) : (
          <>
            <path
              d={`M${w / 3} 7v${h - 14}M${(w * 2) / 3} 7v${h - 14}M7 10h${w - 14}`}
              stroke="var(--plan-seat-stroke, #b0bba6)"
              strokeWidth="1"
            />
            <rect x="3" y="2" width="8" height={h - 4} rx="3" fill="var(--plan-sofa, #c5d0bb)" />
            <rect
              x={w - 11}
              y="2"
              width="8"
              height={h - 4}
              rx="3"
              fill="var(--plan-sofa, #c5d0bb)"
            />
          </>
        )}
      </g>
    );
  }
  if (item.kind === "table") {
    const chairScale = Math.min(1, w / 48);
    return (
      <g>
        <Chair x={w * 0.25} y={-12} rotation={180} scale={chairScale} />
        <Chair x={w * 0.75} y={-12} rotation={180} scale={chairScale} />
        <Chair x={w * 0.25} y={h + 12} scale={chairScale} />
        <Chair x={w * 0.75} y={h + 12} scale={chairScale} />
        <Chair x={-12} y={h / 2} rotation={90} />
        <Chair x={w + 12} y={h / 2} rotation={-90} />
        <rect x="1" y="2" width={w} height={h} rx="15" fill="var(--plan-room, #e3e0d8)" />
        <rect
          width={w}
          height={h}
          rx="15"
          fill="var(--plan-furniture, #eee8dc)"
          stroke="var(--plan-furniture-stroke, #c3b9a7)"
          strokeWidth="1.2"
        />
        <rect
          x={w * 0.58}
          y={h * 0.24}
          width="18"
          height="13"
          rx="1"
          fill="var(--plan-furniture-stroke, #fbfaf5)"
          stroke="var(--plan-guide, #c9c6bc)"
          strokeWidth="0.7"
          transform={`rotate(-8 ${w * 0.58} ${h * 0.24})`}
        />
        <circle
          cx={w * 0.36}
          cy={h * 0.5}
          r="5"
          fill="#d4ddc9"
          stroke="#9cb28c"
          strokeWidth="0.8"
        />
      </g>
    );
  }
  if (item.kind === "desk") {
    const detailScale = Math.min(1, w / 110, h / 48);
    return (
      <g>
        <Chair x={w / 2} y={h + 12} />
        <rect x="1" y="2" width={w} height={h} rx="3" fill="var(--plan-room, #e3e1d7)" />
        <rect
          width={w}
          height={h}
          rx="3"
          fill="var(--plan-furniture, #eee8dc)"
          stroke="var(--plan-furniture-stroke, #c3b9a7)"
          strokeWidth="1.2"
        />
        <g transform={`translate(${w / 2} 0) scale(${detailScale}) translate(${-w / 2} 0)`}>
          <rect
            x={w / 2 - 17}
            y="7"
            width="34"
            height="17"
            rx="2"
            fill="var(--plan-seat, #d3d9d3)"
            stroke="var(--plan-seat-stroke, #a4ada5)"
            strokeWidth="0.9"
          />
          <rect
            x={w / 2 - 14}
            y="9"
            width="28"
            height="12"
            rx="1"
            fill="var(--plan-guide, #e5eae4)"
          />
          <path
            d={`M${w / 2} 24v4m-7 0h14`}
            stroke="var(--plan-furniture-stroke, #9ca59b)"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
          <rect
            x={w / 2 - 12}
            y="31"
            width="24"
            height="5"
            rx="1"
            fill="var(--plan-seat, #d3d6ce)"
            stroke="var(--plan-seat-stroke, #babeb3)"
            strokeWidth="0.6"
          />
          <circle
            cx={w / 2 + 42}
            cy="13"
            r="4"
            fill="var(--plan-furniture-stroke, #f8f7f1)"
            stroke="var(--plan-guide, #bcbbaa)"
            strokeWidth="0.8"
          />
        </g>
      </g>
    );
  }
  return (
    <g>
      <rect
        width={w}
        height={h}
        rx="2"
        fill="var(--plan-furniture, #e9ded2)"
        stroke="var(--plan-furniture-stroke, #b7a28c)"
        strokeWidth="1.2"
      />
      <path
        d={`M4 4L${w - 4} ${h - 4}M${w - 4} 4L4 ${h - 4}`}
        stroke="var(--plan-furniture-stroke, #cbb9a5)"
        strokeWidth="0.8"
      />
    </g>
  );
}

export default function FloorPlanView({
  plan: inputPlan,
  selectedId,
  onSelect,
  onMove,
  mode,
  result,
  time,
  showPeople,
  showRoutes,
  showDensity,
  zoom,
  reference,
  showReference=false,
  referenceOpacity=.35,
  geometrySelection=null,
  geometryTool="select",
  onGeometrySelect,
  onGeometryChange,
  onGeometryToolDone,
  blockedExitIds = [],
  placement = null,
}: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [geometryPreview,setGeometryPreview]=useState<FloorPlan|null>(null);
  const [imageError,setImageError]=useState<string|null>(null);
  const plan=geometryPreview??inputPlan;
  const isSample = plan.id === "berkeley-studio" && plan.area === 76;
  const viewWidth = plan.width || 900;
  const viewHeight = plan.height || 600;
  const metre = plan.native?.transform.pixels_per_metre ?? 32;
  const personRadius = mode === "layout" && placement ? placement.radius : result?.agentRadius ?? .23;
  const cellWidth = 2 * metre;
  const measuredPeople = result?.engine === "jupedsim" && !(mode === "layout" && placement);
  const visiblePeople: {agent: AgentPath; point: Point}[] = mode === "layout" && placement ? (placement.displayPeople ?? placement.people).map((point,id)=>({point,
      agent:{id,points:[point],duration:0,delay:0,exitId:null}})) : result
    ? result.agents.flatMap((agent) => {
        const point = positionAt(agent, time);
        return point ? [{ agent, point }] : [];
      })
    : [];
  // Each fixed 64px cell is 2m × 2m at the plan's shared 32px/m scale.
  // Keep this grid and its 0–6+ people/m² color scale identical in both views.
  const densityCells = new Map<
    string,
    { x: number; y: number; count: number }
  >();
  if (showDensity) {
    for (const { point } of visiblePeople) {
      const x = Math.floor(point.x / cellWidth) * cellWidth;
      const y = Math.floor(point.y / cellWidth) * cellWidth;
      const key = `${x},${y}`;
      const cell = densityCells.get(key) ?? { x, y, count: 0 };
      cell.count++;
      densityCells.set(key, cell);
    }
  }

  function toPlanPoint(event: PointerEvent<SVGElement>) {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const point = svg.createSVGPoint();
    point.x = event.clientX;
    point.y = event.clientY;
    const screenMatrix = svg.getScreenCTM();
    if (!screenMatrix) return { x: 0, y: 0 };
    const transformed = point.matrixTransform(screenMatrix.inverse());
    return {
      x: (transformed.x - viewWidth / 2) / zoom + viewWidth / 2,
      y: (transformed.y - viewHeight / 2) / zoom + viewHeight / 2,
    };
  }

  function beginDrag(event: PointerEvent<SVGGElement>, item: PlanItem) {
    event.stopPropagation();
    onSelect(item.id);
    if (mode !== "layout" || event.button !== 0) return;
    const point = toPlanPoint(event);
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({
      id: item.id,
      offsetX: point.x - item.x,
      offsetY: point.y - item.y,
      x: item.x,
      y: item.y,
    });
  }

  function moveDrag(event: PointerEvent<SVGSVGElement>) {
    if (!drag) return;
    const item = plan.items.find((candidate) => candidate.id === drag.id);
    if (!item) return;
    const point = toPlanPoint(event);
    setDrag({
      ...drag,
      x: Math.round(
        Math.max(0, Math.min(viewWidth - item.width, point.x - drag.offsetX)),
      ),
      y: Math.round(
        Math.max(0, Math.min(viewHeight - item.height, point.y - drag.offsetY)),
      ),
    });
  }

  function endDrag() {
    if (!drag) return;
    const item = plan.items.find((candidate) => candidate.id === drag.id);
    if (item && (item.x !== drag.x || item.y !== drag.y))
      onMove(drag.id, drag.x, drag.y);
    setDrag(null);
  }

  function handleObjectKey(event: KeyboardEvent<SVGGElement>, item: PlanItem) {
    if (mode !== "layout") return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelect(item.id);
      return;
    }
    const step = event.shiftKey ? 20 : 5;
    const movement: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    if (!movement[event.key]) return;
    event.preventDefault();
    onSelect(item.id);
    onMove(
      item.id,
      Math.max(
        0,
        Math.min(viewWidth - item.width, item.x + movement[event.key][0]),
      ),
      Math.max(
        0,
        Math.min(viewHeight - item.height, item.y + movement[event.key][1]),
      ),
    );
  }

  return (
    <svg
      ref={svgRef}
      className="floorplan-svg"
      viewBox={isSample ? "225 150 450 300" : `0 0 ${viewWidth} ${viewHeight}`}
      preserveAspectRatio="xMidYMid meet"
      role="group"
      aria-label={`${plan.name} floor plan. ${mode === "layout" ? "Select furniture to edit. Use arrow keys to move selected furniture, or drag." : "Simulation spatial view."}`}
      onPointerMove={moveDrag}
      onPointerUp={endDrag}
      onPointerCancel={() => setDrag(null)}
      onPointerDown={() => onSelect(null)}
      style={{ touchAction: drag ? "none" : "pan-y" }}
    >
      <g
        transform={`translate(${viewWidth / 2} ${viewHeight / 2}) scale(${zoom}) translate(${-viewWidth / 2} ${-viewHeight / 2})`}
      >
        {isSample ? (
          <>
            <rect x="265" y="195" width="370" height="210" fill="var(--plan-floor, #fbfcfa)" />
            <path d="M530 195h105v72.5H530z" fill="var(--plan-room, #f3f5ef)" />
            <path d="M505.5 327.5h125.5V401H505.5z" fill="var(--plan-lounge, #f6f5ef)" />
            <g fill="none" stroke="var(--plan-guide, #c9cfc5)" strokeWidth="0.8">
              <path d="M265 184h370M265 181v6m370-6v6M253.5 195v210M250.5 195h6m-6 210h6" />
            </g>
            <rect x="424" y="175" width="54" height="18" fill="var(--plan-floor, #f7f8f4)" />
            <text
              x="450"
              y="187"
              fill="var(--plan-label, #67765d)"
              fontSize="10"
              textAnchor="middle"
              fontFamily="var(--font-ibm-mono), monospace"
            >
              11.6 m
            </text>
            <text
              x="248"
              y="300"
              fill="var(--plan-label, #67765d)"
              fontSize="9"
              textAnchor="middle"
              transform="rotate(-90 248 300)"
              fontFamily="var(--font-ibm-mono), monospace"
            >
              6.6 m
            </text>
            <g
              fill="var(--plan-label, #67765d)"
              fontSize="8"
              letterSpacing="0.6"
              fontWeight="500"
            >
              <text x="314" y="210.5">
                WORKSTATIONS
              </text>
              <text x="550" y="205.5">
                MEETING ROOM
              </text>
              <text x="541" y="392">
                LOUNGE
              </text>
            </g>
          </>
        ) : plan.native ? (
          <g aria-label="Imported floor outline">{plan.native.floors.map((points,index)=><polygon key={index}
            points={points.map(p=>`${p.x},${p.y}`).join(" ")} fill="var(--plan-floor, #fbfcfa)" stroke="var(--plan-wall, #79866e)" strokeWidth="1.5" />)}</g>
        ) : (
          <rect
            x="1"
            y="1"
            width={viewWidth - 2}
            height={viewHeight - 2}
            fill="var(--plan-floor, #fbfcfa)"
            fillOpacity={reference ? 0.25 : 1}
            stroke="var(--plan-guide, #e0e4db)"
            strokeWidth="1"
          />
        )}

        {reference&&<image href={reference} width={viewWidth} height={viewHeight} opacity=".45" pointerEvents="none"/>}
        {showReference&&plan.native?.image&&(()=>{const image=plan.native.image;return imageError===image.id?
          <text x="30" y="30" fill="#9b4c32" fontSize="13">Source image unavailable on this server. Upload it again to restore the overlay.</text>:
          <image href={`/api/floorplans?image_id=${image.id}`} x={image.x} y={image.y} width={image.width} height={image.height}
            preserveAspectRatio="none" opacity={referenceOpacity} pointerEvents="none" aria-label="Original floor plan image"
            onError={()=>setImageError(image.id)}/>;})()}

        {showDensity && result ? (
          <g
            aria-label={`Crowd density snapshot at ${time.toFixed(1)} seconds. Fixed 2 meter cells; scale 0 to 6 or more people per square meter.`}
          >
            {Array.from(densityCells, ([key, cell]) => {
              const density = cell.count / 4;
              const strength = Math.min(1, density / 6);
              const color = `rgb(${Math.round(125 + 96 * strength)} ${Math.round(156 - 7 * strength)} ${Math.round(122 - 51 * strength)})`;
              return (
                <rect
                  key={key}
                  x={cell.x}
                  y={cell.y}
                  width={cellWidth}
                  height={cellWidth}
                  fill={color}
                  fillOpacity={0.12 + strength * 0.36}
                  stroke="#ffffff"
                  strokeOpacity="0.35"
                  strokeWidth="0.7"
                >
                  <title>{`${cell.count} ${cell.count === 1 ? "person" : "people"} in 4 m² · ${density.toFixed(2)} people/m²`}</title>
                </rect>
              );
            })}
          </g>
        ) : null}

        {showRoutes && result ? (
          <g
            fill="none"
            stroke="#739780"
            strokeWidth="1.25"
            strokeDasharray="4 5"
            opacity="0.55"
            aria-label={result.engine === "jupedsim" ? "Recorded movement paths" : "Routes to exits"}
          >
            {result.agents
              .filter((agent) => agent.samples?.length || agent.exitId)
              .filter(
                (_, index) =>
                  index % Math.max(1, Math.floor(result.agents.length / 8)) ===
                  0,
              )
              .slice(0, 9)
              .map((agent) => (
                <path
                  key={agent.id}
                  d={agent.points
                    .map(
                      (point, index) =>
                        `${index ? "L" : "M"}${point.x},${point.y}`,
                    )
                    .join(" ")}
                />
              ))}
          </g>
        ) : null}

        {mode === "layout" && placement && <g aria-label="Room population zones" pointerEvents="none">
          {placement.rooms.map((room,index)=><path key={room.id}
            d={room.rings.map(ring=>ring.length?`M ${ring.map(p=>`${p.x} ${p.y}`).join(" L ")} Z`:"").join(" ")}
            fill={["#539a9a","#8e83b3","#c39a55","#72994e"][index%4]} fillOpacity=".08"
            fillRule="evenodd" stroke="#66806a" strokeOpacity=".4" strokeWidth="1" strokeDasharray="4 4">
            <title>{room.label}: {room.count} people</title>
          </path>)}
        </g>}
        <g aria-label="Furniture and obstacles">
          {plan.items.map((item) => {
            const x = drag?.id === item.id ? drag.x : item.x;
            const y = drag?.id === item.id ? drag.y : item.y;
            const selected = selectedId === item.id;
            return (
              <g
                key={item.id}
                className={`plan-object${selected ? " is-selected" : ""}`}
                transform={`translate(${x} ${y})`}
                role="button"
                tabIndex={mode === "layout" ? 0 : -1}
                aria-label={`${item.label}${mode === "layout" ? ". Use arrow keys to move." : ""}`}
                aria-pressed={selected}
                onPointerDown={(event) => beginDrag(event, item)}
                onKeyDown={(event) => handleObjectKey(event, item)}
                style={{
                  cursor:
                    mode === "layout"
                      ? drag?.id === item.id
                        ? "grabbing"
                        : "grab"
                      : "default",
                }}
              >
                <rect
                  x="-5"
                  y="-5"
                  width={item.width + 10}
                  height={item.height + 10}
                  rx="4"
                  fill="transparent"
                />
                <Furniture item={item} />
                {selected ? (
                  <g pointerEvents="none">
                    <rect
                      x="-5"
                      y="-5"
                      width={item.width + 10}
                      height={item.height + 10}
                      rx="3"
                      fill="none"
                      stroke="var(--plan-selection, #3e7656)"
                      strokeWidth="1.3"
                      strokeDasharray="3 2"
                    />
                    {[
                      [-5, -5],
                      [item.width + 5, -5],
                      [-5, item.height + 5],
                      [item.width + 5, item.height + 5],
                    ].map(([cx, cy], index) => (
                      <rect
                        key={index}
                        x={cx - 2.5}
                        y={cy - 2.5}
                        width="5"
                        height="5"
                        rx="0.7"
                        fill="#fff"
                        stroke="var(--plan-selection, #3e7656)"
                        strokeWidth="1"
                      />
                    ))}
                    <rect
                      x="-5"
                      y="-27"
                      width={Math.max(78, item.label.length * 5.6 + 16)}
                      height="17"
                      rx="3"
                      fill="#315f45"
                    />
                    <text
                      x="3"
                      y="-15"
                      fill="#fff"
                      fontSize="9"
                      fontWeight="500"
                    >
                      {item.label}
                    </text>
                  </g>
                ) : null}
              </g>
            );
          })}
        </g>

        <g
          fill="none"
          stroke="var(--plan-wall, #65705f)"
          strokeWidth="7"
          strokeLinecap="square"
          strokeLinejoin="miter"
          aria-label="Walls"
        >
          {plan.walls.map((wall, index) => (
            <line
              key={index}
              x1={wall.x1}
              y1={wall.y1}
              x2={wall.x2}
              y2={wall.y2}
            />
          ))}
          {plan.native?.walls.map((points,index)=><polygon key={`native-${index}`} points={points.map(p=>`${p.x},${p.y}`).join(" ")}
            fill="var(--plan-wall, #65705f)" strokeWidth="0" />)}
        </g>

        {isSample ? (
          <g fill="none" stroke="var(--plan-guide, #b9c4b2)" strokeWidth="1">
            <path d="M565 267.5V244a23.5 23.5 0 0 1 23.5 23.5" />
            <path d="M265 286h14a14 14 0 0 1-14 14m370 0h-14a14 14 0 0 0 14 14" />
          </g>
        ) : null}

        <g aria-label="Exits">
          {plan.native && nativeLayout(plan).exits.map((exit,index)=>{
            if("polygon" in exit)return null;
            const ends=exitDoorEnds(nativeLayout(plan),exit).map(point=>pixelPoint(plan,point));
            if(ends.length!==2)return null;
            const label=`Exit ${index+1}`;
            return <g key={`opening:${exit.id}`} aria-label={`${label}, ${exit.width.toFixed(2)} meters wide`}>
              <title>{`${label} · ${exit.width.toFixed(2)} m wide`}</title>
              <line x1={ends[0].x} y1={ends[0].y} x2={ends[1].x} y2={ends[1].y} stroke="var(--plan-floor, #fbfcfa)" strokeWidth="6" />
              <line x1={ends[0].x} y1={ends[0].y} x2={ends[1].x} y2={ends[1].y} stroke="var(--plan-exit-line, #397b51)" strokeWidth="3" />
              {mode!=="layout"&&<text x={(ends[0].x+ends[1].x)/2+8} y={(ends[0].y+ends[1].y)/2-8}
                fontSize="9" fill="var(--plan-exit-label, #315f45)">{label}</text>}
            </g>;
          })}
          {plan.native ? (result?.exitZones ?? plan.native.exit_zones).map(zone=><polygon key={zone.id} points={zone.polygon.map(p=>`${p.x},${p.y}`).join(" ")}
            fill="#b9dcc1" stroke="#4d7750" strokeWidth="1"><title>{`${zone.id}${result?.exitWidths?.[zone.id] === undefined ? "" : `: ${result.exitWidths[zone.id].toFixed(2)} m wide`}`}</title></polygon>) : plan.exits.map((exit) => {
            const left = exit.x < viewWidth / 2;
            return (
              <g key={exit.id}>
                <title>{`${exit.label}${result?.exitWidths?.[exit.id] === undefined ? "" : `: ${result.exitWidths[exit.id].toFixed(2)} m wide`}`}</title>
                <line
                  x1={exit.x}
                  y1={exit.y - (isSample ? 14 : 23)}
                  x2={exit.x}
                  y2={exit.y + (isSample ? 14 : 23)}
                  stroke="#8eae8d"
                  strokeWidth="3"
                />
                <g
                  transform={`translate(${exit.x + (left ? -26 : 26)} ${exit.y})`}
                >
                  <rect
                    x="-12"
                    y="-12"
                    width="24"
                    height="24"
                    rx="4"
                    fill="#e5eee0"
                    stroke="#a0bd98"
                    strokeWidth="0.9"
                  />
                  <path
                    d={left ? "M6 0H-6m4-4-4 4 4 4" : "M-6 0H6m-4-4 4 4-4 4"}
                    fill="none"
                    stroke="#4d7750"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  <text
                    x="0"
                    y="26"
                    textAnchor="middle"
                    fill="var(--plan-exit-label, #526f4f)"
                    fontSize="8"
                    fontWeight="600"
                  >
                    {exit.label}
                  </text>
                </g>
              </g>
            );
          })}
        </g>

        <g aria-label="Blocked exits">{plan.exits.filter(exit =>
          (mode === "layout" ? blockedExitIds : result?.scenario.blockedExitIds ?? []).includes(exit.id)).map(exit =>
          <g key={exit.id} transform={`translate(${exit.x} ${exit.y})`}>
            <rect x="-14" y="-25" width="28" height="50" rx="3" fill="#f9e6df" stroke="#a43f32" />
            <path d="M-8-10 8 10M8-10-8 10" stroke="#a43f32" strokeWidth="3" />
            <title>{exit.label} blocked</title>
          </g>)}</g>
        {mode==="layout"&&plan.native&&onGeometrySelect&&onGeometryChange&&onGeometryToolDone&&<GeometryEditorLayer
          key={geometryTool} plan={plan} selection={geometrySelection} tool={geometryTool}
          onSelect={onGeometrySelect} onChange={onGeometryChange} onPreview={setGeometryPreview} onToolDone={onGeometryToolDone}/>}

        {showPeople && (result || placement) ? (
          <g
            aria-label={`${visiblePeople.length} ${visiblePeople.length === 1 ? "person" : "people"} visible in this scenario`}
          >
            {visiblePeople.map(({ agent, point }) => (
              <g
                key={agent.id}
                transform={`translate(${point.x} ${point.y}) rotate(${(mode === "layout" && placement?.facingAngles ? placement.facingAngles[agent.id] : headingAt(agent,time)) * 180 / Math.PI})`}
                data-person-state={!measuredPeople ? "preview" : agent.outcome === "trapped" ? "trapped" : time < agent.delay ? "responding" : "walking"}
              >
              <title>{!measuredPeople ? `${agent.id}: placement preview` : `${agent.sourceId ?? agent.id}${agent.outcome === "trapped" ? ": trapped, no available route" : time < agent.delay ? ": waiting to respond" : ": walking / queuing"} · response ${agent.delay.toFixed(1)} s${agent.desiredSpeed === undefined ? "" : ` · desired speed ${agent.desiredSpeed.toFixed(2)} m/s`}`}</title>
              <ellipse
                rx={metre * personRadius * .68}
                ry={metre * personRadius}
                fill={
                  agent.outcome === "trapped" ? "var(--plan-trapped, #b64235)" : measuredPeople && time < agent.delay ? "var(--plan-responding, #b98a3e)" : agent.id % 7 === 0
                    ? "var(--plan-person, #2356c4)"
                    : agent.id % 3 === 0
                      ? "var(--plan-person-alt, #007185)"
                      : "var(--plan-person, #1746a2)"
                }
                stroke="var(--plan-person-outline, #14213d)"
                strokeWidth={metre * personRadius * .12}
              />
              <path d={`M ${metre*personRadius*.4} ${-metre*personRadius*.24} L ${metre*personRadius*.4} ${metre*personRadius*.24}`}
                stroke="#fff" strokeWidth={metre*personRadius*.15} strokeLinecap="round" opacity=".9"/>
              </g>
            ))}
          </g>
        ) : null}

        <g
          transform={`translate(${isSample ? 450 : 96} ${isSample ? 426.5 : viewHeight - 47}) scale(${metre/32})`}
          fill="var(--plan-label, #67765d)"
          fontSize="10"
          fontFamily="var(--font-ibm-mono), monospace"
          aria-label="Scale: four meters"
        >
          <path
            d="M0 0h128M0-3v6m64-6v6m64-6v6"
            fill="none"
            stroke="var(--plan-guide, #8b9586)"
            strokeWidth="0.8"
          />
          <text y="16">0</text>
          <text x="61" y="16">
            2
          </text>
          <text x="122" y="16">
            4 m
          </text>
        </g>
        <g
          transform={`translate(${isSample ? 625.5 : viewWidth - 99} ${isSample ? 428.5 : viewHeight - 43})`}
          fill="var(--plan-label, #67765d)"
          fontSize="8"
          textAnchor="middle"
          aria-hidden="true"
        >
          <path d="M0-13-4-1 0-3 4-1z" fill="var(--plan-label, #7b8e76)" />
          <text y="10">N</text>
        </g>
      </g>
    </svg>
  );
}
