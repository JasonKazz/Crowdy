import type { NextRequest } from "next/server";
import { auth0 } from "@/lib/auth0";
import { NextResponse } from "next/server";
import { SAMPLE_WORKSPACE_ID } from "@/lib/workspace-store";

export async function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname.replace(/\/$/, "") || "/";
  const personalWorkspace =
    path.startsWith("/workspaces/") &&
    path !== `/workspaces/${SAMPLE_WORKSPACE_ID}`;
  if (personalWorkspace) {
    const session = await auth0.getSession(request);
    if (!session?.user.sub) {
      const destination = new URL("/auth/login", process.env.APP_BASE_URL!);
      destination.searchParams.set("returnTo", path);
      const response = NextResponse.redirect(destination);
      response.headers.set("Cache-Control", "private, no-store");
      return response;
    }
  }
  const response = await auth0.middleware(request);
  if (path.startsWith("/auth/") || personalWorkspace) {
    response.headers.set(
      "Cache-Control",
      "private, no-store, max-age=0, must-revalidate",
    );
  }
  return response;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|icon.svg|sitemap.xml|robots.txt).*)",
  ],
};
