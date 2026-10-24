import { proxyWorkspace } from "@/lib/workspace-proxy";

export const maxDuration = 60;

type Context = { params: Promise<{ path?: string[] }> };
async function handle(request: Request, context: Context) {
  const { path = [] } = await context.params;
  return proxyWorkspace(request, path);
}
export { handle as GET, handle as POST, handle as PUT, handle as DELETE };
