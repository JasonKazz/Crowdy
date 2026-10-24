"use client";

import { useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import { positionAt } from "@/lib/simulation";
import type { FloorPlan, PlanItem, SimulationResult } from "@/lib/simulation";

type Props = {
  plan: FloorPlan;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onMove: (id: string, x: number, y: number) => void;
  mode: "layout" | "simulation" | "compare";
  result: SimulationResult | null;
  time: number;
  showPeople: boolean;
  showRoutes: boolean;
  showDensity: boolean;
  zoom: number;
  reference?: string | null;
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
}: {
  x: number;
  y: number;
  rotation?: number;
}) {
  return (
    <g transform={`translate(${x} ${y}) rotate(${rotation})`}>
      <path
        d="M-11 3v6q0 4 4 4H7q4 0 4-4V3"
        fill="#e0e5df"
        stroke="#aab4a9"
        strokeWidth="1"
      />
      <rect
        x="-9"
        y="-7"
        width="18"
        height="15"
        rx="4"
        fill="#edf0eb"
        stroke="#aab4a9"
        strokeWidth="1"
      />
      <path
        d="M-12-2v9m24-9v9"
        stroke="#aab4a9"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </g>
  );
}

function Furniture({ item }: { item: PlanItem }) {
  const { width: w, height: h } = item;
  if (item.polygon) return <polygon points={item.polygon.map(p=>`${p.x*w},${p.y*h}`).join(" ")}
    fill="#dce2d7" stroke="#7f8d77" strokeWidth="1.2" />;
  if (item.kind === "plant") {
    const r = Math.min(w, h) / 2;
    return (
      <g transform={`translate(${w / 2} ${h / 2})`}>
        <circle r={r * 0.75} fill="#e9e5db" stroke="#c1bfb3" strokeWidth="1" />
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
        <rect x="1" y="2" width={w} height={h} rx="2" fill="#dde1d8" />
        <rect
          width={w}
          height={h}
          rx="2"
          fill="#ece8dd"
          stroke="#b6b2a3"
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
              fill={["#b4b9a3", "#c0ac8e", "#d4c6ae", "#a4b3ae"][i % 4]}
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
        <rect x="1" y="2" width={w} height={h} rx="7" fill="#dce0d8" />
        <rect
          width={w}
          height={h}
          rx="7"
          fill="#d5ddcd"
          stroke="#9fae94"
          strokeWidth="1.2"
        />
        <rect
          x="6"
          y="6"
          width={w - 12}
          height={h - 12}
          rx="4"
          fill="#e3e8dd"
          stroke="#aebaa3"
          strokeWidth="0.8"
        />
        {vertical ? (
          <>
            <path
              d={`M6 ${h / 2}h${w - 12}M${w - 10} 7v${h - 14}`}
              stroke="#b0bba6"
              strokeWidth="1"
            />
            <rect x="2" y="3" width={w - 4} height="7" rx="3" fill="#c5d0bb" />
            <rect
              x="2"
              y={h - 10}
              width={w - 4}
              height="7"
              rx="3"
              fill="#c5d0bb"
            />
          </>
        ) : (
          <>
            <path
              d={`M${w / 3} 7v${h - 14}M${(w * 2) / 3} 7v${h - 14}M7 10h${w - 14}`}
              stroke="#b0bba6"
              strokeWidth="1"
            />
            <rect x="3" y="2" width="8" height={h - 4} rx="3" fill="#c5d0bb" />
            <rect
              x={w - 11}
              y="2"
              width="8"
              height={h - 4}
              rx="3"
              fill="#c5d0bb"
            />
          </>
        )}
      </g>
    );
  }
  if (item.kind === "table") {
    return (
      <g>
        <Chair x={w * 0.25} y={-12} rotation={180} />
        <Chair x={w * 0.75} y={-12} rotation={180} />
        <Chair x={w * 0.25} y={h + 12} />
        <Chair x={w * 0.75} y={h + 12} />
        <Chair x={-12} y={h / 2} rotation={90} />
        <Chair x={w + 12} y={h / 2} rotation={-90} />
        <rect x="1" y="2" width={w} height={h} rx="15" fill="#e3e0d8" />
        <rect
          width={w}
          height={h}
          rx="15"
          fill="#eee8dc"
          stroke="#c3b9a7"
          strokeWidth="1.2"
        />
        <rect
          x={w * 0.58}
          y={h * 0.24}
          width="18"
          height="13"
          rx="1"
          fill="#fbfaf5"
          stroke="#c9c6bc"
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
    return (
      <g>
        <Chair x={w / 2} y={h + 12} />
        <rect x="1" y="2" width={w} height={h} rx="3" fill="#e3e1d7" />
        <rect
          width={w}
          height={h}
          rx="3"
          fill="#eee8dc"
          stroke="#c3b9a7"
          strokeWidth="1.2"
        />
        <rect
          x={w / 2 - 17}
          y="7"
          width="34"
          height="17"
          rx="2"
          fill="#d3d9d3"
          stroke="#a4ada5"
          strokeWidth="0.9"
        />
        <rect
          x={w / 2 - 14}
          y="9"
          width="28"
          height="12"
          rx="1"
          fill="#e5eae4"
        />
        <path
          d={`M${w / 2} 24v4m-7 0h14`}
          stroke="#9ca59b"
          strokeWidth="1.4"
          strokeLinecap="round"
        />
        <rect
          x={w / 2 - 12}
          y="31"
          width="24"
          height="5"
          rx="1"
          fill="#d3d6ce"
          stroke="#babeb3"
          strokeWidth="0.6"
        />
        <circle
          cx={w - 13}
          cy="13"
          r="4"
          fill="#f8f7f1"
          stroke="#bcbbaa"
          strokeWidth="0.8"
        />
      </g>
    );
  }
  return (
    <g>
      <rect
        width={w}
        height={h}
        rx="2"
        fill="#e9ded2"
        stroke="#b7a28c"
        strokeWidth="1.2"
      />
      <path
        d={`M4 4L${w - 4} ${h - 4}M${w - 4} 4L4 ${h - 4}`}
        stroke="#cbb9a5"
        strokeWidth="0.8"
      />
    </g>
  );
}

export default function FloorPlanView({
  plan,
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
}: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const isSample = plan.id === "berkeley-studio";
  const viewWidth = plan.width || 900;
  const viewHeight = plan.height || 600;
  const metre = plan.native?.transform.pixels_per_metre ?? 32;
  const personRadius = result?.agentRadius ?? .2;
  const cellWidth = 2 * metre;
  const visiblePeople = result
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
      viewBox={`0 0 ${viewWidth} ${viewHeight}`}
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
        {reference ? (
          <image
            href={reference}
            width={viewWidth}
            height={viewHeight}
            preserveAspectRatio="xMidYMid meet"
            opacity="0.45"
          />
        ) : null}
        {isSample ? (
          <>
            <rect x="80" y="90" width="740" height="420" fill="#fbfcfa" />
            <path d="M610 90h210v145H610z" fill="#f3f5ef" />
            <path d="M561 355h251v147H561z" fill="#f6f5ef" />
            <g fill="none" stroke="#c9cfc5" strokeWidth="0.8">
              <path d="M80 68h740M80 62v12m740-12v12M57 90v420M51 90h12m-12 420h12" />
            </g>
            <rect x="424" y="58" width="54" height="18" fill="#f7f8f4" />
            <text
              x="450"
              y="71"
              fill="#67765d"
              fontSize="10"
              textAnchor="middle"
              fontFamily="var(--font-ibm-mono), monospace"
            >
              23.1 m
            </text>
            <text
              x="46"
              y="300"
              fill="#67765d"
              fontSize="9"
              textAnchor="middle"
              transform="rotate(-90 46 300)"
              fontFamily="var(--font-ibm-mono), monospace"
            >
              13.1 m
            </text>
            <g
              fill="#67765d"
              fontSize="10"
              letterSpacing="1.2"
              fontWeight="500"
            >
              <text x="178" y="121">
                WORKSTATIONS
              </text>
              <text x="670" y="111">
                MEETING ROOM
              </text>
              <text x="632" y="484">
                LOUNGE
              </text>
            </g>
          </>
        ) : plan.native ? (
          <g aria-label="Imported floor outline">{plan.native.floors.map((points,index)=><polygon key={index}
            points={points.map(p=>`${p.x},${p.y}`).join(" ")} fill="#fbfcfa" stroke="#79866e" strokeWidth="1.5" />)}</g>
        ) : (
          <rect
            x="1"
            y="1"
            width={viewWidth - 2}
            height={viewHeight - 2}
            fill="#fbfcfa"
            fillOpacity={reference ? 0.25 : 1}
            stroke="#e0e4db"
            strokeWidth="1"
          />
        )}

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
                      stroke="#3e7656"
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
                        stroke="#3e7656"
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
          stroke="#65705f"
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
            fill="#65705f" strokeWidth="0" />)}
        </g>

        {isSample ? (
          <g fill="none" stroke="#b9c4b2" strokeWidth="1">
            <path d="M680 235v-47a47 47 0 0 1 47 47" />
            <path d="M80 272h28a28 28 0 0 1-28 28m740 0h-28a28 28 0 0 0 28 28" />
          </g>
        ) : null}

        <g aria-label="Exits">
          {plan.native ? plan.native.exit_zones.map(zone=><polygon key={zone.id} points={zone.polygon.map(p=>`${p.x},${p.y}`).join(" ")}
            fill="#b9dcc1" stroke="#4d7750" strokeWidth="1"><title>{zone.id}</title></polygon>) : plan.exits.map((exit) => {
            const left = exit.x < viewWidth / 2;
            return (
              <g key={exit.id}>
                <line
                  x1={exit.x}
                  y1={exit.y - 23}
                  x2={exit.x}
                  y2={exit.y + 23}
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
                    fill="#526f4f"
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

        {showPeople && result ? (
          <g
            aria-label={`${visiblePeople.length} ${visiblePeople.length === 1 ? "person" : "people"} visible in this scenario`}
          >
            {visiblePeople.map(({ agent, point }) => (
              <circle
                key={agent.id}
                cx={point.x}
                cy={point.y}
                r={metre * personRadius}
                fill={
                  agent.id % 7 === 0
                    ? "#bb8e61"
                    : agent.id % 3 === 0
                      ? "#81978b"
                      : "#4e786b"
                }
                stroke="#fff"
                strokeWidth="1"
                opacity="0.95"
              />
            ))}
          </g>
        ) : null}

        <g
          transform={`translate(96 ${viewHeight - 47}) scale(${metre/32})`}
          fill="#67765d"
          fontSize="10"
          fontFamily="var(--font-ibm-mono), monospace"
          aria-label="Scale: four meters"
        >
          <path
            d="M0 0h128M0-3v6m64-6v6m64-6v6"
            fill="none"
            stroke="#8b9586"
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
          transform={`translate(${viewWidth - 99} ${viewHeight - 43})`}
          fill="#67765d"
          fontSize="8"
          textAnchor="middle"
          aria-hidden="true"
        >
          <path d="M0-13-4-1 0-3 4-1z" fill="#7b8e76" />
          <text y="10">N</text>
        </g>
      </g>
    </svg>
  );
}
