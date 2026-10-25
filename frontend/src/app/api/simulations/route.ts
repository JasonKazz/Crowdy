import {simulationRequest} from "@/lib/simulation-request";
import {failure, readBackendBody as readBody, forwardBackend as forward} from "@/lib/backend-proxy";
export const maxDuration = 60;

export async function GET(request: Request) {
  const query=new URL(request.url).searchParams;
  if (query.size) {
    const id=query.get("job_id");
    if (query.size!==1 || query.getAll("job_id").length!==1 || !id || !/^[a-f0-9]{32}$/.test(id))
      return failure("Choose a valid simulation job.",400);
    return forward(request,`/api/simulations?job_id=${id}`,undefined,15_000);
  }
  return forward(request, "/health");
}

export async function DELETE(request: Request) {
  const origin=request.headers.get("origin");
  if ((origin && ![new URL(request.url).origin,process.env.APP_BASE_URL].includes(origin)) || request.headers.get("sec-fetch-site")==="cross-site")
    return failure("Open Crowdy to cancel a simulation.",403);
  const query=new URL(request.url).searchParams,id=query.get("job_id");
  if (query.size!==1 || query.getAll("job_id").length!==1 || !id || !/^[a-f0-9]{32}$/.test(id))
    return failure("Choose a valid simulation job.",400);
  return forward(request,`/api/simulations?job_id=${id}`,undefined,15_000,"DELETE");
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
    const asyncRun=(input as Record<string,unknown>).async_run;
    if (asyncRun!==undefined && typeof asyncRun!=="boolean") throw new Error("Choose a valid simulation mode.");
    input = {...simulationRequest(input),...(asyncRun===true?{async_run:true}:{})};
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
