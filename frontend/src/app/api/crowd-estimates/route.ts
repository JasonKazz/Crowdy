import "server-only";

import { proxyCrowdEstimate } from "@/lib/crowd-estimation-proxy";

export const maxDuration = 60;

export async function POST(request: Request) {
  return proxyCrowdEstimate(request);
}
