import {validatePlan} from "./plan-validation.ts";
import {populationConfig, validPopulationSettings} from "./room-population.ts";

export function simulationRequest(input: Record<string, unknown>) {
    const plan = validatePlan(input.plan);
    const scenario = input.scenario as import("./simulation").Scenario & {blocked_exit_ids?: unknown};
    if (
      !scenario ||
      !Number.isInteger(scenario.occupancy) ||
      scenario.occupancy < 1 ||
      scenario.occupancy > 200 ||
      !["standard", "mixed"].includes(scenario.mobility) ||
      !["uniform", "workstations", "rooms", "normal"].includes(scenario.distribution) ||
      (scenario.behaviorMode !== undefined && !["idealized", "behavioral"].includes(scenario.behaviorMode)) ||
      (scenario.bodyWidth !== undefined && (typeof scenario.bodyWidth !== "number" || !Number.isFinite(scenario.bodyWidth) || scenario.bodyWidth < .4 || scenario.bodyWidth > .7)) ||
      (scenario.seed !== undefined && (!Number.isInteger(scenario.seed) || scenario.seed < 0 || scenario.seed > 4294967295))
    )
      throw new Error("Choose 1–200 people and valid scenario settings.");
    if (scenario.population !== undefined && !validPopulationSettings(scenario.population))
      throw new Error("Choose valid building, activity and room counts.");
    const blocked = scenario.blocked_exit_ids ?? [];
    if (!Array.isArray(blocked) || blocked.length > 30 || new Set(blocked).size !== blocked.length ||
        blocked.some(id => typeof id !== "string" || !plan.exits.some(exit => exit.id === id)))
      throw new Error("Choose valid, unique exits to block.");
    const startingPopulation = input.starting_population;
    return {
      ...(startingPopulation === undefined ? {} : {starting_population: startingPopulation}),
      // Imports may carry extra metadata; send only the editor geometry contract.
      plan: {
        id: plan.id,
        name: plan.name,
        width: plan.width,
        height: plan.height,
        area: plan.area,
        ...(plan.native ? {native: {layout: plan.native.layout, transform: plan.native.transform}} : {}),
        items: plan.items.map(({ id, label, kind, x, y, width, height, polygon }) => ({
          id, label, kind, x, y, width, height, ...(polygon ? {polygon} : {}),
        })),
        walls: plan.walls.map(({ x1, y1, x2, y2 }) => ({ x1, y1, x2, y2 })),
        ...(plan.rooms ? {rooms: plan.rooms.map(({id, label, room_type, polygon}) => ({id, label, room_type, polygon}))} : {}),
        exits: plan.exits.map(({ id, label, x, y }) => ({ id, label, x, y })),
      },
      scenario: {
        occupancy: scenario.occupancy,
        mobility: scenario.mobility,
        distribution: scenario.distribution,
        seed: scenario.seed ?? 42,
        blocked_exit_ids: blocked,
        behavior_mode: scenario.behaviorMode ?? "idealized",
        body_width: scenario.bodyWidth ?? .46,
        population_config: populationConfig(scenario),
      },
    };
}
