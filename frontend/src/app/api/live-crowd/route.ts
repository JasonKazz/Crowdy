import "server-only";

import { proxyLiveCrowd } from "@/lib/live-crowd-proxy";

export const maxDuration = 60;

export async function POST(request: Request) {
  return proxyLiveCrowd(request);
}
