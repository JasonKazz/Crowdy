import type {
  AgentPath,
  FloorPlan,
  Point,
  Scenario,
  SimulationResult,
} from "./simulation";

import {startingPopulation} from "./room-population.ts";
const PIXELS_PER_METRE = 32;
const CANVAS_HEIGHT = 600;
const TIME_TOLERANCE = 1e-7;
// The HTTP service rounds measured coordinates to six decimal places in metres.
const POSITION_TOLERANCE = 1e-6;

type JsonRecord = Record<string, unknown>;
type Occupant = { id: string; position: [number, number] };
type Assignment = { agentId: string; exitId: string | null; initialExitId?: string | null };
type Evacuation = { agentId: string; exitId: string; time: number };
type Frame = { time: number; agents: { id: string; x: number; y: number }[] };

function invalid(reason: string): never {
  throw new Error(`The simulation service returned invalid results: ${reason}.`);
}

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value))
    invalid(`${label} must be an object`);
  return value as JsonRecord;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) invalid(`${label} must be a list`);
  return value;
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim())
    invalid(`${label} must be a nonempty ID`);
  return value;
}

function finite(value: unknown, label: string, minimum = -Infinity): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum)
    invalid(`${label} must be a finite number${minimum === 0 ? " at least zero" : ""}`);
  return value;
}

function count(value: unknown, label: string): number {
  const result = finite(value, label, 0);
  if (!Number.isSafeInteger(result)) invalid(`${label} must be a whole count`);
  return result;
}

function pixelPoint(x: number, y: number): Point {
  return {
    x: finite(x * PIXELS_PER_METRE, "converted agent x"),
    y: finite(CANVAS_HEIGHT - y * PIXELS_PER_METRE, "converted agent y"),
  };
}

function sameTime(a: number, b: number) {
  return Math.abs(a - b) <= TIME_TOLERANCE;
}

/** Validate the service's measured trajectory; never synthesize a replacement route. */
export function adaptBackendSimulation(
  payload: unknown,
  inputPlan: FloorPlan,
  inputScenario: Scenario,
  createdAt = Date.now(),
): SimulationResult {
  const transform = inputPlan.native?.transform;
  const toCanvas = (x: number, y: number): Point => transform ? {
    x: finite(x * transform.pixels_per_metre + transform.offset_x, "converted agent x"),
    y: finite(transform.offset_y - y * transform.pixels_per_metre, "converted agent y"),
  } : pixelPoint(x, y);
  const result = record(payload, "result");
  if (result.engine !== "jupedsim") invalid("engine must be jupedsim");
  if (result.status !== "completed" && result.status !== "timed_out" && result.status !== "trapped")
    invalid("status is unsupported");
  const status = result.status;
  const backendScenario = record(result.scenario, "scenario");
  const defaults = backendScenario.agent_defaults === undefined ? undefined : record(backendScenario.agent_defaults,"agent defaults");
  const agentRadius = defaults === undefined ? .2 : finite(defaults.radius,"person radius",0);
  if (agentRadius === 0) invalid("person radius must be positive");
  if (inputScenario.bodyWidth !== undefined && Math.abs(2 * agentRadius - inputScenario.bodyWidth) > 1e-7)
    invalid("body width differs from the requested scenario");
  const engineVersion = result.engine_version === undefined
    ? undefined
    : identifier(result.engine_version, "engine version");
  let modelSettings: SimulationResult["modelSettings"];
  if (backendScenario.settings !== undefined) {
    const settings = record(backendScenario.settings, "model settings");
    const dt = finite(settings.dt, "time step", 0);
    const sampleInterval = finite(settings.sample_interval, "sample interval", 0);
    const maxTime = finite(settings.max_time, "maximum time", 0);
    if (!dt || !sampleInterval || !maxTime) invalid("model settings must be positive");
    const population = result.population_generation === null || result.population_generation === undefined
      ? undefined
      : record(result.population_generation, "population generation");
    const editor = result.editor_metadata === undefined
      ? undefined
      : record(result.editor_metadata, "editor metadata");
    const seedValue = population?.seed ?? editor?.seed;
    const seed = seedValue === undefined ? undefined : count(seedValue, "population seed");
    if (seed !== undefined && seed > 4294967295) invalid("population seed is out of range");
    modelSettings = { dt, sampleInterval, maxTime, ...(seed === undefined ? {} : { seed }) };
  }
  const occupants: Occupant[] = array(backendScenario.occupants, "occupants").map(
    (value) => {
      const occupant = record(value, "occupant");
      const position = array(occupant.position, "occupant position");
      if (position.length !== 2) invalid("occupant position must have two coordinates");
      return {
        id: identifier(occupant.id, "occupant ID"),
        position: [finite(position[0], "occupant x"), finite(position[1], "occupant y")],
      };
    },
  );
  if (!occupants.length || occupants.length !== inputScenario.occupancy)
    invalid("occupant count does not match the requested scenario");
  const occupantsById = new Map(occupants.map((occupant) => [occupant.id, occupant]));
  if (occupantsById.size !== occupants.length) invalid("occupant IDs are duplicated");
  const behaviorById = new Map<string, {delay: number; speed: number}>();
  const requestedMode = inputScenario.behaviorMode ?? "idealized";
  let behaviorVersion: number | undefined;
  if (result.behavior !== undefined) {
    const behavior = record(result.behavior, "behavior");
    if (![1,2].includes(behavior.version as number) || behavior.mode !== requestedMode || behavior.seed !== (inputScenario.seed ?? 42))
      invalid("behavior settings differ from the requested scenario");
    behaviorVersion = behavior.version as number;
    for (const value of array(behavior.agents, "agent behaviors")) {
      const person = record(value, "agent behavior");
      const id = identifier(person.agent_id, "behavior agent ID");
      const delay = finite(person.response_delay, "response delay", 0);
      const factor = finite(person.speed_factor, "speed factor", 0);
      const speed = finite(person.desired_speed, "desired speed", 0);
      if (!occupantsById.has(id) || behaviorById.has(id) || !speed ||
          (behavior.version === 2 ? delay !== 0 : delay > 12) || factor < .85 || factor > 1.15 ||
          (requestedMode === "idealized" && (delay !== 0 || factor !== 1)))
        invalid("agent behavior is inconsistent");
      const original = record(array(backendScenario.occupants, "occupants").find(value => record(value,"occupant").id === id), "occupant");
      const baseSpeed = original.desired_speed ?? defaults?.desired_speed;
      if (baseSpeed !== undefined && Math.abs(finite(baseSpeed,"base walking speed",0)*factor-speed) > 1e-6)
        invalid("behavior walking speed differs from its base speed");
      behaviorById.set(id,{delay,speed});
    }
    if (behaviorById.size !== occupants.length) invalid("behavior must cover every occupant");
  } else if (requestedMode !== "idealized") invalid("behavioral run has no recorded behavior");
  const knownExits = new Set(inputPlan.exits.map((exit) => exit.id));
  const boundaryWidths = new Map<string, number>();
  for (const value of array(backendScenario.exit_boundaries ?? [],"exit boundaries")) {
    const boundary = record(value,"exit boundary");
    const id = identifier(boundary.id,"exit boundary ID");
    const start = array(boundary.start,"exit boundary start"), end = array(boundary.end,"exit boundary end");
    if (!knownExits.has(id) || boundaryWidths.has(id) || start.length !== 2 || end.length !== 2)
      invalid("exit boundary does not match the plan");
    const width = Math.hypot(finite(end[0],"door x")-finite(start[0],"door x"),finite(end[1],"door y")-finite(start[1],"door y"));
    if (!Number.isFinite(width) || width <= 0) invalid("door width must be positive and finite");
    boundaryWidths.set(id,width);
  }
  const exitWidths = Object.fromEntries(boundaryWidths);
  const exitZones = backendScenario.exits === undefined ? undefined : array(backendScenario.exits,"compiled exits").map(value => {
    const zone = record(value,"compiled exit");
    const id = identifier(zone.id,"compiled exit ID");
    const polygon = array(zone.polygon,"compiled exit polygon").map(value => {
      const point = array(value,"compiled exit point");
      if (point.length !== 2) invalid("compiled exit point must have two coordinates");
      return toCanvas(finite(point[0],"compiled exit x"),finite(point[1],"compiled exit y"));
    });
    if (!knownExits.has(id) || polygon.length < 3) invalid("compiled exit does not match the plan");
    return {id,polygon};
  });
  if (exitZones && (exitZones.length !== knownExits.size || new Set(exitZones.map(zone=>zone.id)).size !== knownExits.size))
    invalid("compiled exits must cover the plan exits");
  const agentId = (value: unknown) => {
    const id = identifier(value, "agent ID");
    if (!occupantsById.has(id)) invalid("an unknown agent ID was returned");
    return id;
  };
  const exitId = (value: unknown) => {
    const id = identifier(value, "exit ID");
    if (!knownExits.has(id)) invalid("an unknown exit ID was returned");
    return id;
  };

  const summary = record(result.summary, "summary");
  const evacuated = count(summary.evacuated_count, "evacuated count");
  const remaining = count(summary.remaining_count, "remaining count");
  const trapped = count(summary.trapped_count ?? 0, "trapped count");
  const movingRemaining = count(summary.moving_remaining_count ?? remaining, "moving remaining count");
  if (trapped + movingRemaining !== remaining) invalid("remaining outcomes do not match the summary");
  if ((status === "trapped" && (!trapped || movingRemaining)) ||
      (status === "timed_out" && !movingRemaining)) invalid("status does not match remaining outcomes");
  const blocked = new Set(inputScenario.blockedExitIds ?? []);
  if (blocked.size !== (inputScenario.blockedExitIds ?? []).length || [...blocked].some(id => !knownExits.has(id)))
    invalid("blocked exits do not match the plan");
  const reportedBlocked = backendScenario.settings === undefined ? [] :
    array(record(backendScenario.settings, "model settings").blocked_exit_ids ?? [], "blocked exits");
  if (JSON.stringify([...reportedBlocked].sort()) !== JSON.stringify([...blocked].sort()))
    invalid("reported blocked exits differ from the requested scenario");
  const totalTime = finite(summary.simulation_time, "simulation time", 0);
  if (evacuated + remaining !== occupants.length)
    invalid("summary counts do not match the population");
  let clearanceTime: number | null = null;
  if (status === "completed") {
    clearanceTime = finite(summary.clearance_time, "clearance time", 0);
    if (remaining !== 0 || !sameTime(clearanceTime, totalTime))
      invalid("completed status does not match the summary");
  } else if (remaining === 0 || summary.clearance_time !== null) {
    invalid("timed-out status does not match the summary");
  }

  const assignments: Assignment[] = array(result.assignments, "assignments").map(
    (value) => {
      const assignment = record(value, "assignment");
      if (assignment.exit_id === null) {
        if (assignment.status !== "trapped" || assignment.route_length !== null)
          invalid("a trapped assignment must have no route");
        return { agentId: agentId(assignment.agent_id), exitId: null };
      }
      finite(assignment.route_length, "route length", 0);
      const initialExit = exitId(assignment.exit_id);
      const exit = assignment.final_exit_id === undefined ? initialExit : exitId(assignment.final_exit_id);
      if (blocked.has(initialExit) || blocked.has(exit)) invalid("an agent was assigned to a blocked exit");
      return { agentId: agentId(assignment.agent_id), exitId: exit, initialExitId: initialExit };
    },
  );
  const assignmentsById = new Map(assignments.map((assignment) => [assignment.agentId, assignment]));
  if (assignments.length !== occupants.length || assignmentsById.size !== occupants.length)
    invalid("every occupant must have exactly one assignment");
  const trappedIds = new Set(assignments.filter(a => a.exitId === null).map(a => a.agentId));
  if (trappedIds.size !== trapped) invalid("trapped assignments do not match the summary");

  const exitChanges: NonNullable<SimulationResult["exitChanges"]> = [];
  if (result.routing !== undefined) {
    const routing = record(result.routing,"routing");
    if (routing.version !== 1 || routing.mode !== (requestedMode === "behavioral" ? "adaptive" : "fixed")) invalid("routing mode differs from the request");
    const choices = new Map(assignments.map(a=>[a.agentId,a.initialExitId ?? a.exitId]));
    const lastChanges = new Map<string,number>();
    for (const raw of array(routing.exit_changes,"exit changes")) {
      const event = record(raw,"exit change");
      const id = agentId(event.agent_id), from = exitId(event.from_exit_id), to = exitId(event.to_exit_id);
      const time = finite(event.time,"exit change time",0);
      if (routing.mode !== "adaptive" || choices.get(id) !== from || from === to || blocked.has(to) ||
          time > totalTime + TIME_TOLERANCE || time - (lastChanges.get(id) ?? -Infinity) < 5 - TIME_TOLERANCE ||
          finite(event.estimated_seconds_saved,"estimated queue saving",0) <= 0) invalid("inconsistent congestion rerouting event");
      choices.set(id,to);lastChanges.set(id,time);
      exitChanges.push({agentId:id,fromExitId:from,toExitId:to,time});
    }
    for (const assignment of assignments) if (choices.get(assignment.agentId) !== assignment.exitId) invalid("final exit differs from the recorded exit changes");
  }

  const evacuations: Evacuation[] = array(result.evacuations, "evacuations").map(
    (value) => {
      const event = record(value, "evacuation");
      const id = agentId(event.agent_id);
      const exit = exitId(event.exit_id);
      const time = finite(event.time, "evacuation time", 0);
      if (time > totalTime + TIME_TOLERANCE || assignmentsById.get(id)?.exitId !== exit)
        invalid("evacuation does not match the run or assigned exit");
      return { agentId: id, exitId: exit, time };
    },
  );
  const evacuationsById = new Map(evacuations.map((event) => [event.agentId, event]));
  if (evacuationsById.size !== evacuations.length || evacuations.length !== evacuated)
    invalid("evacuation events do not match the summary");
  if (status === "completed") {
    const lastDeparture = Math.max(...evacuations.map((event) => event.time));
    // JuPedSim can report a removal on one iteration, then reach an empty
    // simulation on the next. Keep both native timestamps instead of retiming.
    const finalizationGap = totalTime - lastDeparture;
    if (finalizationGap < -TIME_TOLERANCE || finalizationGap > (modelSettings?.dt ?? 0) + TIME_TOLERANCE)
      invalid("clearance does not match the last evacuation");
  }
  const exitCounts = record(summary.per_exit_counts, "exit counts");
  if (Object.keys(exitCounts).length !== knownExits.size)
    invalid("exit counts do not cover the plan exits");
  const perExitCounts = Object.fromEntries(
    [...knownExits].map((id) => {
      const exited = count(exitCounts[id], "exit count");
      if (exited !== evacuations.filter((event) => event.exitId === id).length)
        invalid("exit counts do not match evacuation events");
      return [id, exited];
    }),
  );

  const frames: Frame[] = array(result.frames, "frames").map((value) => {
    const frame = record(value, "frame");
    return {
      time: finite(frame.time, "frame time", 0),
      agents: array(frame.agents, "frame agents").map((value) => {
        const agent = record(value, "frame agent");
        return { id: agentId(agent.id), x: finite(agent.x, "agent x"), y: finite(agent.y, "agent y") };
      }),
    };
  });
  if (!frames.length || !sameTime(frames[0].time, 0) || !sameTime(frames[frames.length - 1].time, totalTime))
    invalid("frames must cover the complete recorded time range");
  const samplesById = new Map<string, NonNullable<AgentPath["samples"]>>(
    occupants.map((occupant) => [occupant.id, []]),
  );
  let peakDensity = 0;
  let hotspot: Point = { x: inputPlan.width / 2, y: inputPlan.height / 2 };
  frames.forEach((frame, index) => {
    if ((index > 0 && frame.time <= frames[index - 1].time) || frame.time > totalTime + TIME_TOLERANCE)
      invalid("frame times must increase within the recorded run");
    const present = new Set<string>();
    const bins = new Map<string, { count: number; x: number; y: number }>();
    for (const agent of frame.agents) {
      if (present.has(agent.id)) invalid("an agent appears twice in one frame");
      present.add(agent.id);
      const evacuation = evacuationsById.get(agent.id);
      // A removal event can coincide with the last frame containing that agent.
      if (evacuation && frame.time > evacuation.time + TIME_TOLERANCE)
        invalid("an evacuated agent reappears in a frame");
      const point = toCanvas(agent.x, agent.y);
      if (trappedIds.has(agent.id)) {
        const start = occupantsById.get(agent.id)!.position;
        if (Math.abs(agent.x-start[0]) > POSITION_TOLERANCE || Math.abs(agent.y-start[1]) > POSITION_TOLERANCE)
          invalid("a trapped agent moved from its recorded starting position");
      }
      if (frame.time <= (behaviorById.get(agent.id)?.delay ?? 0)) {
        const start = occupantsById.get(agent.id)!.position;
        if (Math.abs(agent.x-start[0]) > POSITION_TOLERANCE || Math.abs(agent.y-start[1]) > POSITION_TOLERANCE)
          invalid("an agent moved before its response delay");
      }
      if (index === 0) {
        const original = occupantsById.get(agent.id)!.position;
        if (Math.abs(agent.x - original[0]) > POSITION_TOLERANCE || Math.abs(agent.y - original[1]) > POSITION_TOLERANCE)
          invalid("initial frame differs from the generated population");
      }
      samplesById.get(agent.id)!.push({ time: frame.time, point });
      // Fixed 2 m × 2 m cells, each with an area of 4 m².
      const cellWidth = 2 * (transform?.pixels_per_metre ?? 32);
      const x = Math.floor(point.x / cellWidth) * cellWidth;
      const y = Math.floor(point.y / cellWidth) * cellWidth;
      const key = `${x},${y}`;
      const bin = bins.get(key) ?? { count: 0, x, y };
      bin.count++;
      bins.set(key, bin);
      if (bin.count / 4 > peakDensity) {
        peakDensity = bin.count / 4;
        hotspot = { x: x + cellWidth / 2, y: y + cellWidth / 2 };
      }
    }
    for (const occupant of occupants) {
      const evacuation = evacuationsById.get(occupant.id);
      if ((!evacuation || frame.time < evacuation.time) && !present.has(occupant.id))
        invalid("an agent disappears without an evacuation event");
    }
  });

  const agents: AgentPath[] = occupants.map((occupant, id) => {
    const event = evacuationsById.get(occupant.id);
    const samples = samplesById.get(occupant.id)!;
    if (!samples.length) invalid("an occupant has no recorded positions");
    return {
      id,
      sourceId: occupant.id,
      points: samples.map((sample) => sample.point),
      samples,
      assignedExitId: assignmentsById.get(occupant.id)!.exitId ?? undefined,
      initialAssignedExitId: assignmentsById.get(occupant.id)!.initialExitId ?? undefined,
      outcome: event ? "evacuated" : trappedIds.has(occupant.id) ? "trapped" : "moving",
      exitId: event?.exitId ?? null,
      duration: event?.time ?? totalTime,
      delay: behaviorById.get(occupant.id)?.delay ?? 0,
      desiredSpeed: behaviorById.get(occupant.id)?.speed,
    };
  });
  return {
    id: `jupedsim-${createdAt}-${occupants.length}`,
    plan: structuredClone(inputPlan),
    scenario: structuredClone(inputScenario),
    agents,
    totalTime,
    averageTime: evacuated ? evacuations.reduce((sum, event) => sum + event.time, 0) / evacuated : 0,
    peakDensity,
    exited: evacuated,
    remaining,
    trapped,
    movingRemaining,
    startingOccupants: array(backendScenario.occupants, "occupants").map(value => {
      const person = record(value, "occupant");
      const position = occupantsById.get(identifier(person.id, "occupant ID"))!.position;
      return {id: person.id as string, position, desired_speed: person.desired_speed == null ? null : finite(person.desired_speed, "walking speed", 0)};
    }),
    reusedStarts: result.editor_metadata !== undefined && record(result.editor_metadata, "editor metadata").reused_starting_population === true,
    ...(behaviorVersion === undefined ? {} : {behaviorVersion}),
    hotspot,
    createdAt,
    engine: "jupedsim",
    agentRadius,
    placementExcludedArea: result.editor_metadata === undefined ? 0 : finite(
      record(result.editor_metadata, "editor metadata").excluded_spawn_area_m2 ?? 0,
      "excluded placement area", 0),
    ...(engineVersion === undefined ? {} : { engineVersion }),
    ...(modelSettings === undefined ? {} : { modelSettings }),
    status,
    clearanceTime,
    perExitCounts,
    exitChanges,
    exitWidths,
    ...(exitZones === undefined ? {} : {exitZones}),
  };
}

/** Submit the editor snapshot to the same-origin server proxy. */
export async function runBackendSimulation(
  inputPlan: FloorPlan,
  inputScenario: Scenario,
  { signal, baseline }: { signal?: AbortSignal; baseline?: SimulationResult } = {},
): Promise<SimulationResult> {
  const plan = structuredClone(inputPlan);
  const scenario = structuredClone(inputScenario);
  const createdAt = Date.now();
  let response: Response;
  try {
    response = await fetch("/api/simulations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan, scenario: {...scenario, blocked_exit_ids: scenario.blockedExitIds ?? []},
        ...(baseline ? {starting_population: startingPopulation(baseline)} : {}) }),
      signal,
      cache: "no-store",
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error("Unable to reach the simulation service. Please try again.");
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error("The simulation service returned an unreadable response. Please try again.");
  }
  if (!response.ok) {
    const message = payload && typeof payload === "object" && "error" in payload
      ? payload.error
      : undefined;
    throw new Error(typeof message === "string" && message.trim()
      ? message
      : `Simulation failed (HTTP ${response.status}). Please try again.`);
  }
  const result = adaptBackendSimulation(payload, plan, scenario, createdAt);
  if (baseline && (!result.reusedStarts || !sameStartingPopulation(baseline, result)))
    throw new Error("The comparison did not preserve the baseline starting people. Clear the baseline and retry.");
  return result;
}

export function sameStartingPopulation(a: SimulationResult, b: SimulationResult): boolean {
  if (!a.startingOccupants || !b.startingOccupants || a.agentRadius !== b.agentRadius) return false;
  const sorted = (run: SimulationResult) => [...run.startingOccupants!].sort((x,y) => x.id.localeCompare(y.id));
  return JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
}
