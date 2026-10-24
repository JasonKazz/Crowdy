import {simulationRequest} from "@/lib/simulation-request";
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
    input = simulationRequest(input);
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
