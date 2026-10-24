import "server-only";

import { Auth0Client } from "@auth0/nextjs-auth0/server";
import { NextResponse } from "next/server";

export const auth0 = new Auth0Client({
  authorizationParameters: {
    scope: "openid profile email",
  },
  // Crowdy only needs the user's identity; keep OAuth tokens on the server.
  enableAccessTokenEndpoint: false,
  async onCallback(error, context) {
    const baseUrl = new URL(process.env.APP_BASE_URL!);
    if (error) {
      return NextResponse.redirect(new URL("/auth-error", baseUrl));
    }

    // Keep post-login navigation within Crowdy, including user-supplied returnTo.
    const destination = new URL(context.returnTo || "/", baseUrl);
    return NextResponse.redirect(
      destination.origin === baseUrl.origin
        ? destination
        : new URL("/", baseUrl),
    );
  },
});
