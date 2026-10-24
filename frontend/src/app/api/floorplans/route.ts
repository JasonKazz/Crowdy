import {failure, forwardBackend, forwardBackendImage, readBackendBody} from "@/lib/backend-proxy";

export const maxDuration = 200;

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const jobId = params.get("job_id");
  if (jobId !== null) {
    if (!/^[a-f0-9]{32}$/.test(jobId)) return failure("Invalid import job reference.", 400);
    return forwardBackend(request, `/api/floorplans/jobs/${jobId}`);
  }
  const imageId = params.get("image_id");
  if (imageId !== null) return forwardBackendImage(request, imageId);
  return forwardBackend(request, "/api/floorplans");
}

export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && ![new URL(request.url).origin, process.env.APP_BASE_URL].includes(origin))
    return failure("Open Crowdy to import a floor plan.", 403);
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    return failure("Choose an image or Crowdy JSON floor plan.", 415);
  try {
    const body = await readBackendBody(request, 14 * 1024 * 1024);
    return await forwardBackend(request, "/api/floorplans", body, 190_000);
  } catch (error) {
    return failure(error instanceof RangeError ? "Choose an image smaller than 10 MB." :
      "The floor plan request could not be read.", error instanceof RangeError ? 413 : 400);
  }
}
