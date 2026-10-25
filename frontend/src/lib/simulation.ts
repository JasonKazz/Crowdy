/**
 * Browser-local demonstration model. A grid flow field routes people around
 * furniture, with a simple exit-service queue. It is not a validated evacuation
 * solver and must not be used to certify a real space.
 */
import type {PlanRoom, PopulationSettings} from "./room-population";
export type Point = { x: number; y: number };
export type PlanItem = {
  id: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  kind: "desk" | "table" | "shelf" | "sofa" | "plant" | "obstacle" | "chair";
  polygon?: Point[];
};
export type Wall = { x1: number; y1: number; x2: number; y2: number };
export type Exit = { id: string; label: string; x: number; y: number };
export type FloorPlan = {
  id: string;
  name: string;
  width: number;
  height: number;
  area: number;
  capacity?: number | null;
  items: PlanItem[];
  walls: Wall[];
  exits: Exit[];
  rooms?: PlanRoom[];
  native?: {
    layout: Record<string, unknown>;
    transform: {pixels_per_metre: number; offset_x: number; offset_y: number};
    floors: Point[][];
    walls: Point[][];
    exit_zones: {id: string; polygon: Point[]}[];
    issues?: string[];
    image?: {id: string; x: number; y: number; width: number; height: number} | null;
  };
};
export type Scenario = {
  occupancy: number;
  mobility: "standard" | "mixed";
  distribution: "uniform" | "workstations" | "rooms" | "normal";
  population?: PopulationSettings;
  seed?: number;
  blockedExitIds?: string[];
  behaviorMode?: "idealized" | "behavioral";
  /** Shoulder width / circular collision diameter, in metres. */
  bodyWidth?: number;
};
export type AgentPath = {
  id: number;
  /** Stable identity supplied by the simulation service, when available. */
  sourceId?: string;
  points: Point[];
  exitId: string | null;
  /** Intended exit; unlike exitId, this does not imply an evacuation. */
  assignedExitId?: string;
  initialAssignedExitId?: string;
  outcome?: "evacuated" | "trapped" | "moving";
  /** Final simulation time at which this person passes the exit. */
  duration: number;
  /** Initial reaction time, before walking begins. */
  delay: number;
  desiredSpeed?: number;
  travelTime?: number;
  /** Measured positions at their original simulation timestamps. */
  samples?: { time: number; point: Point }[];
};
export type SimulationResult = {
  id: string;
  plan: FloorPlan;
  scenario: Scenario;
  agents: AgentPath[];
  totalTime: number;
  averageTime: number;
  peakDensity: number;
  exited: number;
  remaining: number;
  hotspot: Point;
  createdAt: number;
  engine?: "jupedsim" | "browser";
  engineVersion?: string;
  execution?: {
    mode: "full_agent";
    populationCount: number;
    wallTimeSeconds: number;
    wallTimeLimitSeconds: number | null;
    runtimeLimited: boolean;
    stopReason: "completed" | "simulation_time_limit" | "wall_time_limit" | "trapped";
    playbackTemporallyThinned: boolean;
    playbackSampleInterval: number;
  };
  /** Physical collision-body radius in metres from the native engine. */
  agentRadius?: number;
  placementExcludedArea?: number;
  trapped?: number;
  movingRemaining?: number;
  startingOccupants?: {id: string; position: [number, number]; desired_speed?: number | null}[];
  reusedStarts?: boolean;
  behaviorVersion?: number;
  modelSettings?: {
    dt: number;
    sampleInterval: number;
    maxTime: number;
    seed?: number;
  };
  status?: "completed" | "timed_out" | "trapped";
  /** Null when the recorded run ended with people still inside. */
  clearanceTime?: number | null;
  perExitCounts?: Record<string, number>;
  exitWidths?: Record<string, number>;
  exitChanges?: {agentId:string;fromExitId:string;toExitId:string;time:number}[];
  /** Compiled target strips for this run's body size, in canvas coordinates. */
  exitZones?: {id: string; polygon: Point[]}[];
};

// Schematic 11.5625 x 6.5625 m studio at 32 px/m. The 28 px exterior
// openings are 0.875 m wide; keep the default 0.46 m body width unchanged.
export const SAMPLE_PLAN: FloorPlan = {
  id: "berkeley-studio",
  name: "Berkeley studio",
  width: 900,
  height: 600,
  area: 76,
  rooms: [
    {id:"work-area",label:"Workstations",room_type:"office",polygon:[{x: 265,y: 195},{x: 530,y: 195},{x: 530,y: 325},{x: 265,y: 325}]},
    {id:"meeting-room",label:"Meeting room",room_type:"meeting",polygon:[{x: 530,y: 195},{x: 635,y: 195},{x: 635,y: 267.5},{x: 530,y: 267.5}]},
    {id:"lounge",label:"Lounge",room_type:"lounge",polygon:[{x: 265,y: 325},{x: 635,y: 325},{x: 635,y: 405},{x: 265,y: 405}]},
    {id:"circulation",label:"Circulation",room_type:"corridor",polygon:[{x: 530,y: 267.5},{x: 635,y: 267.5},{x: 635,y: 325},{x: 530,y: 325}]},
  ],
  walls: [
    { x1: 265, y1: 195, x2: 635, y2: 195 },
    { x1: 265, y1: 405, x2: 635, y2: 405 },
    { x1: 265, y1: 195, x2: 265, y2: 286 },
    { x1: 265, y1: 314, x2: 265, y2: 405 },
    { x1: 635, y1: 195, x2: 635, y2: 286 },
    { x1: 635, y1: 314, x2: 635, y2: 405 },
    { x1: 530, y1: 195, x2: 530, y2: 267.5 },
    { x1: 530, y1: 267.5, x2: 565, y2: 267.5 },
    { x1: 591, y1: 267.5, x2: 635, y2: 267.5 },
  ],
  exits: [
    { id: "exit-a", label: "Exit A", x: 265, y: 300 },
    { id: "exit-b", label: "Exit B", x: 635, y: 300 },
  ],
  items: [
    {
      id: "desk-1",
      label: "Workstation 01",
      x: 315,
      y: 227.5,
      width: 55,
      height: 24,
      kind: "desk",
    },
    {
      id: "desk-2",
      label: "Workstation 02",
      x: 400,
      y: 227.5,
      width: 55,
      height: 24,
      kind: "desk",
    },
    {
      id: "desk-3",
      label: "Workstation 03",
      x: 315,
      y: 352,
      width: 55,
      height: 24,
      kind: "desk",
    },
    {
      id: "desk-4",
      label: "Workstation 04",
      x: 400,
      y: 352,
      width: 55,
      height: 24,
      kind: "desk",
    },
    {
      id: "meeting-table",
      label: "Meeting table",
      x: 558.75,
      y: 220,
      width: 45,
      height: 22,
      kind: "table",
    },
    {
      id: "collaboration-table",
      label: "Collaboration table",
      x: 407.5,
      y: 291,
      width: 67.5,
      height: 30,
      kind: "table",
    },
    {
      id: "sofa-1",
      label: "Lounge sofa",
      x: 522.5,
      y: 351,
      width: 65,
      height: 22.5,
      kind: "sofa",
    },
    {
      id: "sofa-2",
      label: "Lounge chair",
      x: 599,
      y: 330.5,
      width: 21,
      height: 45.5,
      kind: "sofa",
    },
    {
      id: "shelf-1",
      label: "Storage shelf",
      x: 277.5,
      y: 212.5,
      width: 12,
      height: 52.5,
      kind: "shelf",
    },
    {
      id: "shelf-2",
      label: "Storage shelf",
      x: 485,
      y: 206,
      width: 28.5,
      height: 12,
      kind: "shelf",
    },
    {
      id: "plant-1",
      label: "Planter",
      x: 480,
      y: 360,
      width: 13,
      height: 13,
      kind: "plant",
    },
    {
      id: "plant-2",
      label: "Planter",
      x: 610,
      y: 265,
      width: 13,
      height: 13,
      kind: "plant",
    },
  ],
};

const CELL = 10;
const PX_PER_METRE = 32;
const DIRECTIONS = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
] as const;

function randomGenerator(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function wallDistance(point: Point, wall: Wall) {
  const dx = wall.x2 - wall.x1;
  const dy = wall.y2 - wall.y1;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared
    ? Math.max(
        0,
        Math.min(
          1,
          ((point.x - wall.x1) * dx + (point.y - wall.y1) * dy) / lengthSquared,
        ),
      )
    : 0;
  return Math.hypot(point.x - wall.x1 - t * dx, point.y - wall.y1 - t * dy);
}

function simplifyPath(points: Point[]) {
  if (points.length < 3) return points;
  const simplified = [points[0]];
  for (let index = 1; index < points.length - 1; index++) {
    const previous = points[index - 1];
    const current = points[index];
    const next = points[index + 1];
    if (
      (current.x - previous.x) * (next.y - current.y) !==
      (current.y - previous.y) * (next.x - current.x)
    )
      simplified.push(current);
  }
  simplified.push(points[points.length - 1]);
  return simplified;
}

function pathLength(points: Point[]) {
  return points
    .slice(1)
    .reduce(
      (sum, point, index) =>
        sum + Math.hypot(point.x - points[index].x, point.y - points[index].y),
      0,
    );
}

export function positionAt(agent: AgentPath, time: number): Point | null {
  if (agent.samples?.length) {
    if (agent.exitId && time >= agent.duration) return null;
    const samples = agent.samples;
    if (time <= samples[0].time) return samples[0].point;
    let low = 0;
    let high = samples.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (samples[middle].time <= time) low = middle;
      else high = middle - 1;
    }
    const start = samples[low];
    const end = samples[low + 1];
    if (!end) return start.point;
    const fraction = (time - start.time) / (end.time - start.time);
    return {
      x: start.point.x + (end.point.x - start.point.x) * fraction,
      y: start.point.y + (end.point.y - start.point.y) * fraction,
    };
  }
  if (!agent.points.length) return null;
  if (agent.exitId && time >= agent.duration) return null;
  if (!agent.exitId || time <= agent.delay) return agent.points[0];
  const travelTime =
    agent.travelTime ?? Math.max(0.1, agent.duration - agent.delay);
  const progress = Math.max(0, Math.min(1, (time - agent.delay) / travelTime));
  // People waiting for an exit remain immediately inside its opening.
  let remainingDistance = pathLength(agent.points) * Math.min(progress, 0.98);
  for (let index = 1; index < agent.points.length; index++) {
    const start = agent.points[index - 1];
    const end = agent.points[index];
    const length = Math.hypot(end.x - start.x, end.y - start.y);
    if (remainingDistance <= length && length > 0) {
      const fraction = remainingDistance / length;
      return {
        x: start.x + (end.x - start.x) * fraction,
        y: start.y + (end.y - start.y) * fraction,
      };
    }
    remainingDistance -= length;
  }
  return agent.points[agent.points.length - 1];
}

export function getEvacuatedCount(result: SimulationResult, time: number) {
  return result.agents.filter(
    (agent) => agent.exitId !== null && agent.duration <= time,
  ).length;
}

export function runSimulation(
  inputPlan: FloorPlan,
  inputScenario: Scenario,
  createdAt = 0,
): SimulationResult {
  const plan: FloorPlan = structuredClone(inputPlan);
  const scenario = {
    ...inputScenario,
    occupancy: Math.max(1, Math.min(400, Math.round(inputScenario.occupancy))),
  };
  const columns = Math.floor(plan.width / CELL) + 1;
  const rows = Math.floor(plan.height / CELL) + 1;
  const count = columns * rows;
  const blocked = new Uint8Array(count);
  const geometryBlocked = new Uint8Array(count);
  const wallXs = plan.walls.flatMap((wall) => [wall.x1, wall.x2]);
  const wallYs = plan.walls.flatMap((wall) => [wall.y1, wall.y2]);
  const minX = wallXs.length ? Math.min(...wallXs) : 0;
  const maxX = wallXs.length ? Math.max(...wallXs) : plan.width;
  const minY = wallYs.length ? Math.min(...wallYs) : 0;
  const maxY = wallYs.length ? Math.max(...wallYs) : plan.height;
  const pointFor = (index: number): Point => ({
    x: (index % columns) * CELL,
    y: Math.floor(index / columns) * CELL,
  });
  const indexFor = (point: Point) =>
    Math.max(0, Math.min(rows - 1, Math.round(point.y / CELL))) * columns +
    Math.max(0, Math.min(columns - 1, Math.round(point.x / CELL)));

  for (let index = 0; index < count; index++) {
    const point = pointFor(index);
    const outside =
      point.x < minX || point.x > maxX || point.y < minY || point.y > maxY;
    const furniture = plan.items.some(
      (item) =>
        point.x >= item.x - 5 &&
        point.x <= item.x + item.width + 5 &&
        point.y >= item.y - 5 &&
        point.y <= item.y + item.height + 5,
    );
    geometryBlocked[index] = Number(
      outside || plan.walls.some((wall) => wallDistance(point, wall) < 6),
    );
    blocked[index] = Number(geometryBlocked[index] || furniture);
  }

  const neighbors = (index: number) => {
    const x = index % columns;
    const y = Math.floor(index / columns);
    return DIRECTIONS.flatMap(([dx, dy]) => {
      const nx = x + dx;
      const ny = y + dy;
      const next = ny * columns + nx;
      return nx >= 0 && nx < columns && ny >= 0 && ny < rows && !blocked[next]
        ? [next]
        : [];
    });
  };

  const fields = plan.exits.map((exit) => {
    const distances = new Int32Array(count).fill(-1);
    const source = indexFor(exit);
    if (blocked[source]) return distances;
    const queue = new Int32Array(count);
    let head = 0;
    let tail = 1;
    queue[0] = source;
    distances[source] = 0;
    while (head < tail) {
      const current = queue[head++];
      for (const next of neighbors(current)) {
        if (distances[next] >= 0) continue;
        distances[next] = distances[current] + 1;
        queue[tail++] = next;
      }
    }
    return distances;
  });

  // Preferred positions are sampled from a furniture-independent grid. Moving
  // an obstacle therefore cannot reshuffle everyone's starting distribution.
  const preferredCandidates: number[] = [];
  const candidates: number[] = [];
  for (let index = 0; index < count; index++) {
    const point = pointFor(index);
    if (
      geometryBlocked[index] ||
      point.x < minX + 15 ||
      point.x > maxX - 15 ||
      point.y < minY + 15 ||
      point.y > maxY - 15
    )
      continue;
    preferredCandidates.push(index);
    if (!blocked[index]) candidates.push(index);
  }
  const workstations = plan.items
    .filter((item) => item.kind === "desk")
    .sort((a, b) => a.id.localeCompare(b.id));
  const workstationPools = workstations.map((desk) =>
    preferredCandidates.filter((index) => {
      const point = pointFor(index);
      const near =
        Math.hypot(
          point.x - desk.x - desk.width / 2,
          point.y - desk.y - desk.height / 2,
        ) < 110;
      const inside =
        point.x >= desk.x - 5 &&
        point.x <= desk.x + desk.width + 5 &&
        point.y >= desk.y - 5 &&
        point.y <= desk.y + desk.height + 5;
      return near && !inside;
    }),
  );
  const preferredUsed = new Set<number>();
  const preferredStarts = Array.from(
    { length: scenario.occupancy },
    (_, id) => {
      const placementRandom = randomGenerator(
        18317 + Math.imul(id + 1, 2654435761),
      );
      const workstationPool = workstationPools.length
        ? workstationPools[id % workstationPools.length]
        : [];
      const pool =
        scenario.distribution === "workstations" && workstationPool.length
          ? workstationPool
          : preferredCandidates;
      if (!pool.length) return undefined;
      const first = Math.floor(placementRandom() * pool.length);
      for (let offset = 0; offset < pool.length; offset++) {
        const candidate = pool[(first + offset) % pool.length];
        if (preferredUsed.has(candidate)) continue;
        preferredUsed.add(candidate);
        return candidate;
      }
      return pool[first];
    },
  );
  // Reserve every unobstructed preferred point before relocating blocked ones,
  // so a relocation cannot displace another person's otherwise-valid start.
  const occupied = new Set(
    preferredStarts.filter(
      (index): index is number => index !== undefined && !blocked[index],
    ),
  );
  const starts = preferredStarts.map((preferred) => {
    if (preferred === undefined || !blocked[preferred]) return preferred;
    const origin = pointFor(preferred);
    let closest: number | undefined;
    let closestDistance = Infinity;
    for (const candidate of candidates) {
      if (occupied.has(candidate)) continue;
      const point = pointFor(candidate);
      const distance = (point.x - origin.x) ** 2 + (point.y - origin.y) ** 2;
      if (distance < closestDistance) {
        closest = candidate;
        closestDistance = distance;
      }
    }
    if (closest !== undefined) occupied.add(closest);
    return closest;
  });
  const assigned = plan.exits.map(() => 0);
  const agents: AgentPath[] = [];
  const serviceTime = scenario.mobility === "mixed" ? 0.86 : 0.64;

  for (let id = 0; id < scenario.occupancy; id++) {
    const start = starts[id];
    // Personal walking speed and reaction delay never depend on how many
    // placement retries or layout changes preceded this person.
    const movementRandom = randomGenerator(
      71119 + Math.imul(id + 1, 2246822519),
    );
    const slower = scenario.mobility === "mixed" && id % 4 === 0;
    const speed =
      (slower ? 0.72 : 1.2) * PX_PER_METRE * (0.92 + movementRandom() * 0.16);
    const delay =
      1.5 + movementRandom() * (scenario.mobility === "mixed" ? 5 : 3);
    if (start === undefined) {
      agents.push({
        id,
        points: [{ x: plan.width / 2, y: plan.height / 2 }],
        exitId: null,
        duration: 0,
        delay,
      });
      continue;
    }
    let selectedExit = -1;
    let bestCost = Infinity;
    for (let exitIndex = 0; exitIndex < fields.length; exitIndex++) {
      const distance = fields[exitIndex][start];
      if (distance < 0) continue;
      const cost =
        (distance * CELL) / speed + assigned[exitIndex] * serviceTime * 0.35;
      if (cost < bestCost) {
        selectedExit = exitIndex;
        bestCost = cost;
      }
    }
    if (selectedExit < 0) {
      agents.push({
        id,
        points: [pointFor(start)],
        exitId: null,
        duration: 0,
        delay,
      });
      continue;
    }
    assigned[selectedExit]++;
    const distances = fields[selectedExit];
    const points = [pointFor(start)];
    let current = start;
    let previousDirection = -1;
    for (let step = 0; distances[current] > 0 && step < count; step++) {
      const options = neighbors(current).filter(
        (next) => distances[next] === distances[current] - 1,
      );
      const next =
        options.find(
          (candidate) => candidate - current === previousDirection,
        ) ?? options[(id + step) % options.length];
      if (next === undefined) break;
      previousDirection = next - current;
      current = next;
      points.push(pointFor(current));
    }
    const route = simplifyPath(points);
    const travelTime = pathLength(route) / speed;
    agents.push({
      id,
      points: route,
      exitId: plan.exits[selectedExit].id,
      duration: delay + travelTime,
      delay,
      travelTime,
    });
  }

  // Process each exit in arrival order; no person leaves faster than the
  // illustrative doorway service rate. Queue time increases with occupancy.
  for (const exit of plan.exits) {
    const queue = agents
      .filter((agent) => agent.exitId === exit.id)
      .sort((a, b) => a.duration - b.duration);
    let available = 0;
    for (const agent of queue) {
      agent.duration = Math.max(agent.duration, available) + serviceTime;
      available = agent.duration;
    }
  }
  const completed = agents.filter((agent) => agent.exitId !== null);
  const totalTime = Math.max(0, ...completed.map((agent) => agent.duration));
  let peakDensity = 0;
  let hotspot: Point = { x: plan.width / 2, y: plan.height / 2 };
  for (let sample = 0; sample <= 16; sample++) {
    const bins = new Map<string, { count: number; x: number; y: number }>();
    for (const agent of agents) {
      const point = positionAt(agent, (totalTime * sample) / 16);
      if (!point) continue;
      const x = Math.floor(point.x / 64) * 64;
      const y = Math.floor(point.y / 64) * 64;
      const key = `${x},${y}`;
      const bin = bins.get(key) ?? { count: 0, x, y };
      bin.count++;
      bins.set(key, bin);
      const density = bin.count / 4;
      if (density > peakDensity) {
        peakDensity = density;
        hotspot = { x: x + 32, y: y + 32 };
      }
    }
  }
  return {
    id: `run-${createdAt}-${scenario.occupancy}`,
    plan,
    scenario,
    agents,
    totalTime: Math.ceil(totalTime * 10) / 10,
    averageTime: completed.length
      ? Math.round(
          (completed.reduce((sum, agent) => sum + agent.duration, 0) /
            completed.length) *
            10,
        ) / 10
      : 0,
    peakDensity: Math.round(peakDensity * 10) / 10,
    exited: completed.length,
    remaining: scenario.occupancy - completed.length,
    agentRadius: (scenario.bodyWidth ?? .46) / 2,
    hotspot,
    createdAt,
  };
}
