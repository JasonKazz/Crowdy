import "server-only";

import { proxyLiveCrowd } from "@/lib/live-crowd-proxy";

export const maxDuration = 60;

type Context = { params: Promise<{ path: string[] }> };

async function handle(request: Request, context: Context) {
  const { path } = await context.params;
  return proxyLiveCrowd(request, path);
}

export { handle as GET, handle as POST, handle as DELETE };
