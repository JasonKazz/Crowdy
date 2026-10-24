import type {FloorPlan, Point, Scenario, SimulationResult} from "./simulation";

export const BUILDING_TYPES = ["auto", "office", "school", "venue", "residential", "other"] as const;
export const ROOM_TYPES = ["office", "classroom", "meeting", "cafeteria", "kitchen", "lounge", "corridor", "lobby", "auditorium", "bedroom", "restroom", "storage", "unknown"] as const;
export const ACTIVITIES = ["auto", "workday", "meeting", "lunch", "class_time", "passing_period", "assembly", "event", "residential_day", "residential_evening"] as const;
export type RoomType = typeof ROOM_TYPES[number];
export type PopulationSettings = {
  buildingType?: typeof BUILDING_TYPES[number];
  activity?: typeof ACTIVITIES[number];
  roomCounts?: Record<string, number>;
  roomTypes?: Record<string, RoomType>;
};
export type PlanRoom = {id: string; label: string; room_type: RoomType; polygon: Point[];
  rings?: Point[][]; area?: number; source?: string};
export type RoomSummary = {id: string; label: string; room_type: RoomType; source: string; area: number;
  usable_area: number; count: number; fixed: boolean; rings: Point[][]};
export type PopulationPreview = {key: string; radius: number; people: Point[];
  rooms: RoomSummary[]; buildingType?: string; activity?: string; warnings: string[];
  displayPeople?: Point[]; facingAngles?: number[]; seatedCount?: number; circulatingCount?: number};
export const ACTIVITY_LABELS: Record<typeof ACTIVITIES[number], string> = {
  auto: "Automatic activity", workday: "Workday · at desks", meeting: "Meeting time", lunch: "Lunch / break",
  class_time: "During class", passing_period: "Between classes", assembly: "Assembly", event: "Event in progress",
  residential_day: "At home · daytime", residential_evening: "At home · evening",
};
export const roomTypeLabel = (kind: string) => kind === "unknown" ? "Unknown / open space" : kind.charAt(0).toUpperCase() + kind.slice(1);

export function validPlanRooms(value: unknown): value is PlanRoom[] | undefined {
  if (value === undefined) return true;
  if (!Array.isArray(value) || value.length > 100) return false;
  const ids = new Set<string>();
  for (const room of value) {
    if (!room || typeof room !== "object" || typeof room.id !== "string" || !room.id.trim() || room.id.length > 128 ||
        ids.has(room.id) || typeof room.label !== "string" || !room.label.trim() || room.label.length > 80 ||
        !ROOM_TYPES.includes(room.room_type) || !Array.isArray(room.polygon) || room.polygon.length < 3 || room.polygon.length > 1200 ||
        room.polygon.some((p: Point)=>!p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || p.x<0 || p.x>900 || p.y<0 || p.y>600)) return false;
    ids.add(room.id);
  }
  return true;
}

export function validPopulationSettings(value: unknown): value is PopulationSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as PopulationSettings;
  if (v.buildingType !== undefined && !BUILDING_TYPES.includes(v.buildingType)) return false;
  if (v.activity !== undefined && !ACTIVITIES.includes(v.activity)) return false;
  for (const [name, values] of [["counts", v.roomCounts], ["types", v.roomTypes]] as const) {
    if (values === undefined) continue;
    if (!values || typeof values !== "object" || Array.isArray(values) || Object.keys(values).length > 101) return false;
    for (const [key, item] of Object.entries(values)) {
      if (!key || key.length > 128) return false;
      if (name === "counts" ? typeof item !== "number" || !Number.isInteger(item) || item < 0 || item > 200 :
        !ROOM_TYPES.includes(item as RoomType)) return false;
    }
  }
  return true;
}

export function populationConfig(scenario: Scenario) {
  const value = scenario.population ?? {};
  return {building_type: value.buildingType ?? "auto", activity: value.activity ?? "auto",
    room_counts: value.roomCounts ?? {}, room_types: value.roomTypes ?? {}};
}

export function startingPopulation(baseline?: SimulationResult) {
  return baseline ? {occupants: baseline.startingOccupants, radius: baseline.agentRadius,
    mobility: baseline.scenario.mobility, distribution: baseline.scenario.distribution,
    seed: baseline.scenario.seed ?? 42, population_config: populationConfig(baseline.scenario)} : undefined;
}

export function placementKey(plan: FloorPlan, scenario: Scenario, baseline?: SimulationResult | null) {
  // Evacuation behavior/closure changes must not reshuffle the starting crowd.
  return JSON.stringify([plan, scenario.occupancy, scenario.distribution, scenario.mobility, scenario.seed ?? 42,
    scenario.bodyWidth ?? .46, scenario.population ?? {}, baseline?.startingOccupants ?? null]);
}

export function adaptPopulationPreview(payload: unknown, plan: FloorPlan, key: string): PopulationPreview {
  if (!payload || typeof payload !== "object") throw new Error("The placement service returned unreadable data.");
  const value = payload as {radius: number; occupants: {position: number[]}[]; room_population?: {
    rooms: RoomSummary[]; building_type: string; activity: string; warnings: string[];
    normal_placements?: {seat_position:number[];standing_position:number[];facing:number[];kind:string}[];
    seated_count?:number;circulating_count?:number}};
  if (!Number.isFinite(value.radius) || value.radius <= 0 || !Array.isArray(value.occupants) ||
      value.occupants.some(p => !p || !Array.isArray(p.position) || p.position.length !== 2 || p.position.some(n => !Number.isFinite(n))))
    throw new Error("The placement service returned invalid starting positions.");
  const summary = value.room_population;
  if (summary && (!Array.isArray(summary.rooms) || !Array.isArray(summary.warnings) ||
      summary.warnings.some(warning=>typeof warning !== "string") ||
      summary.rooms.some(room=>!room || typeof room.id !== "string" || typeof room.label !== "string" ||
        !ROOM_TYPES.includes(room.room_type) || !Number.isInteger(room.count) || room.count<0 ||
        !Array.isArray(room.rings) || room.rings.some(ring=>!Array.isArray(ring) || ring.length<3 ||
          ring.some(p=>!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)))) ||
      summary.rooms.reduce((sum,room)=>sum+room.count,0) !== value.occupants.length))
    throw new Error("The placement service returned invalid room counts or outlines.");
  const transform = plan.native?.transform;
  const people = value.occupants.map(({position: [x, y]}) => transform ?
    {x: x * transform.pixels_per_metre + transform.offset_x, y: transform.offset_y - y * transform.pixels_per_metre} :
    {x: x * 32, y: 600 - y * 32});
  const poses = summary?.normal_placements;
  if (poses && (!Array.isArray(poses) || poses.length !== people.length || poses.some(p=>
      !p || !Array.isArray(p.seat_position) || p.seat_position.length!==2 || p.seat_position.some(n=>!Number.isFinite(n)) ||
      !Array.isArray(p.facing) || p.facing.length!==2 || p.facing.some(n=>!Number.isFinite(n)))))
    throw new Error("The placement service returned invalid seating poses.");
  const displayPeople = poses?.map(p=>transform ?
    {x:p.seat_position[0]*transform.pixels_per_metre+transform.offset_x,y:transform.offset_y-p.seat_position[1]*transform.pixels_per_metre} :
    {x:p.seat_position[0]*32,y:600-p.seat_position[1]*32});
  return {key, radius: value.radius, people, displayPeople, facingAngles:poses?.map(p=>Math.atan2(-p.facing[1],p.facing[0])),
    seatedCount:summary?.seated_count,circulatingCount:summary?.circulating_count, rooms: value.room_population?.rooms ?? [],
    buildingType: value.room_population?.building_type, activity: value.room_population?.activity,
    warnings: value.room_population?.warnings ?? []};
}
