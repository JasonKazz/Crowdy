import { validatePlan } from "@/lib/plan-validation";

export const maxDuration = 60;

const MAX_BODY_BYTES = 1024 * 1024;
const headers = { "Cache-Control": "private, no-store" };

function backendUrl(path: string) {
  const base =
    process.env.CROWDY_BACKEND_URL ||
    (process.env.NODE_ENV === "development" ? "http://127.0.0.1:8000" : "");
  if (!base) return null;
  const url = new URL(base.replace(/\/$/, "") + path);
  if (!["http:", "https:"].includes(url.protocol)) return null;
  return url;
}

function failure(error: string, status: number) {
  return Response.json({ error }, { status, headers });
}

async function readBody(request: Request) {
  if (Number(request.headers.get("content-length")) > MAX_BODY_BYTES)
    throw new RangeError("The workspace is too large to simulate.");
  const reader = request.body?.getReader();
  if (!reader) throw new Error("Choose a floor plan and scenario first.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new RangeError("The workspace is too large to simulate.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function forward(request: Request, path: string, body?: unknown) {
  let url: URL | null;
  try {
    url = backendUrl(path);
  } catch {
    return failure("Simulation service configuration is invalid.", 503);
  }
  if (!url)
    return failure("Simulation service is not configured for this deployment.", 503);
  const token = process.env.CROWDY_BACKEND_TOKEN;
  try {
    const response = await fetch(url, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(55_000)]),
    });
    const data = await response.json();
    if (!response.ok) {
      const message =
        typeof data.error === "string"
          ? data.error.slice(0, 600)
          : typeof data.detail === "string"
            ? data.detail.slice(0, 600)
          : "The simulation could not run. Check the layout and try again.";
      return failure(message, response.status >= 500 ? 502 : response.status);
    }
    const payload = JSON.stringify(data);
    if (Buffer.byteLength(payload) > 4 * 1024 * 1024)
      return failure(
        "This run produced too much playback data. Reduce occupancy and try again.",
        502,
      );
    return new Response(payload, {
      headers: { ...headers, "Content-Type": "application/json" },
    });
  } catch (error) {
    if (request.signal.aborted)
      return failure("Run cancelled. Your current setup is unchanged.", 499);
    if (error instanceof Error && error.name === "TimeoutError")
      return failure("The run took too long. Reduce occupancy and try again.", 504);
    return failure(
      "The simulation service is unavailable. Your current setup is unchanged; try again shortly.",
      503,
    );
  }
}

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
      !["uniform", "workstations"].includes(scenario.distribution)
    )
      throw new Error("Choose 1–200 people and valid scenario settings.");
    input = {
      // Imports may carry extra metadata; send only the editor geometry contract.
      plan: {
        id: plan.id,
        name: plan.name,
        width: plan.width,
        height: plan.height,
        area: plan.area,
        items: plan.items.map(({ id, label, kind, x, y, width, height }) => ({
          id, label, kind, x, y, width, height,
        })),
        walls: plan.walls.map(({ x1, y1, x2, y2 }) => ({ x1, y1, x2, y2 })),
        exits: plan.exits.map(({ id, label, x, y }) => ({ id, label, x, y })),
      },
      scenario: {
        occupancy: scenario.occupancy,
        mobility: scenario.mobility,
        distribution: scenario.distribution,
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
