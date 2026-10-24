import {failure, forwardBackend, readBackendBody} from "@/lib/backend-proxy";
import {simulationRequest} from "@/lib/simulation-request";
export const maxDuration = 60;

export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && ![new URL(request.url).origin, process.env.APP_BASE_URL].includes(origin))
    return failure("Open Crowdy to preview a population.", 403);
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    return failure("Send a JSON floor plan and scenario.", 415);
  try {
    const body = await readBackendBody(request);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Choose a floor plan and scenario.");
    return await forwardBackend(request, "/api/populations/preview", simulationRequest(body), undefined);
  } catch (error) {
    return failure(error instanceof Error ? error.message : "Could not preview placement.", error instanceof RangeError ? 413 : 400);
  }
}
