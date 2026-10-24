import { validatePlan } from "@/lib/plan-validation";
import {failure, readBackendBody as readBody, forwardBackend as forward} from "@/lib/backend-proxy";
export const maxDuration = 60;

export async function GET(request: Request) {
  return forward(request, "/health");
}

export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  const allowed = [new URL(request.url).origin, process.env.APP_BASE_URL];
  if (origin && !allowed.includes(origin))
    return failure("Open Crowdy to run a simulation.", 403);
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    return failure("Send a JSON workspace to run a simulation.", 415);
  let input;
  try {
    input = await readBody(request);
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new Error("Choose a valid floor plan and scenario.");
    const plan = validatePlan(input.plan);
    const scenario = input.scenario;
    if (
      !scenario ||
      !Number.isInteger(scenario.occupancy) ||
      scenario.occupancy < 1 ||
      scenario.occupancy > 200 ||
      !["standard", "mixed"].includes(scenario.mobility) ||
      !["uniform", "workstations"].includes(scenario.distribution) ||
      (scenario.behaviorMode !== undefined && !["idealized", "behavioral"].includes(scenario.behaviorMode)) ||
      (scenario.bodyWidth !== undefined && (typeof scenario.bodyWidth !== "number" || !Number.isFinite(scenario.bodyWidth) || scenario.bodyWidth < .4 || scenario.bodyWidth > .7)) ||
      (scenario.seed !== undefined && (!Number.isInteger(scenario.seed) || scenario.seed < 0 || scenario.seed > 4294967295))
    )
      throw new Error("Choose 1–200 people and valid scenario settings.");
    const blocked = scenario.blocked_exit_ids ?? [];
    if (!Array.isArray(blocked) || blocked.length > 30 || new Set(blocked).size !== blocked.length ||
        blocked.some(id => typeof id !== "string" || !plan.exits.some(exit => exit.id === id)))
      throw new Error("Choose valid, unique exits to block.");
    const startingPopulation = input.starting_population;
    input = {
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
      },
    };
  } catch (error) {
    return failure(
      error instanceof SyntaxError
        ? "This workspace is not valid JSON."
        : error instanceof Error
          ? error.message
          : "Choose a valid floor plan and scenario.",
      error instanceof RangeError ? 413 : 400,
    );
  }
  return forward(request, "/api/simulations", input);
}
