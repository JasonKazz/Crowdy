// Run against an already-running Crowdy app: node scripts/check-auth.mjs
// AUTH_TEST_BASE_URL can target another app origin. Secrets and cookie values
// stay in memory. These checks use synthetic encrypted sessions, create no Auth0
// users, and never follow authorization/logout redirects to the provider.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { generateSessionCookie } from "@auth0/nextjs-auth0/testing";

const envFile = fileURLToPath(new URL("../.env.local", import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

let stage = "configuration";
let passed = 0;
const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const expectedFooter = `Crowdy v${version} · Cal Hacks 13.0`;

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function assertStatus(response, expected, label) {
  check(response.status === expected, label);
}

function privateResponse(response) {
  const value = response.headers.get("cache-control") ?? "";
  return (
    /(?:^|,)\s*(?:private|no-store)(?:\s|,|$)/i.test(value) &&
    !/(?:^|,)\s*public(?:\s|,|$)/i.test(value) &&
    !/(?:^|,)\s*s-maxage\s*=\s*[1-9]/i.test(value)
  );
}

function privateNoStoreResponse(response) {
  const value = response.headers.get("cache-control") ?? "";
  // Next's streamed route renderer can reduce the proxy's private,no-store
  // header to no-store. Both forbid storing the owner-specific response.
  return (
    privateResponse(response) && /(?:^|,)\s*no-store(?:\s|,|$)/i.test(value)
  );
}

function visibleMarkup(html) {
  // RSC/bootstrap scripts can contain component source strings. Inspect the
  // rendered markup, including streamed content, rather than those payloads.
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, "")
    .replace(/<template\b[^>]*>[\s\S]*?<\/template\s*>/gi, "");
}

function markupText(markup) {
  return markup
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function checkWorkspaceChrome(html) {
  const markup = visibleMarkup(html);
  const text = markupText(markup);
  for (const removed of [
    "EVACUATION PLANNING",
    "Interactive demo",
    "Made for the way people move.",
    "Browser-local workspace",
  ]) {
    check(
      !text.includes(removed),
      "Removed interface copy must not be rendered.",
    );
  }
  const footers = [
    ...markup.matchAll(/<footer\b[^>]*>([\s\S]*?)<\/footer\s*>/gi),
  ];
  check(footers.length > 0, "The page must render a footer.");
  // Streaming can include both a fallback and a completed footer. Both must
  // identify the released version and credit; visual centering is checked in-browser.
  check(
    footers.every((footer) => markupText(footer[1]) === expectedFooter),
    "Each footer must show the current Crowdy version and Cal Hacks credit.",
  );
  return text;
}

function cookies(response) {
  return response.headers.getSetCookie().map((header) => {
    const [pair, ...parts] = header.split(";");
    const equals = pair.indexOf("=");
    return {
      name: pair.slice(0, equals),
      value: pair.slice(equals + 1),
      attributes: new Map(
        parts.map((part) => {
          const [name, ...value] = part.trim().split("=");
          return [name.toLowerCase(), value.join("=")];
        }),
      ),
    };
  });
}

function cleared(cookie) {
  return (
    cookie.value === "" ||
    cookie.attributes.get("max-age") === "0" ||
    (cookie.attributes.has("expires") &&
      Date.parse(cookie.attributes.get("expires")) <= Date.now())
  );
}

function sessionCookies(response) {
  return cookies(response).filter((cookie) =>
    /^__session(?:\.\d+)?$/.test(cookie.name),
  );
}

async function main() {
  for (const key of ["AUTH0_DOMAIN", "AUTH0_CLIENT_ID", "AUTH0_SECRET"]) {
    check(
      Boolean(process.env[key]),
      "Required Auth0 test configuration is missing.",
    );
  }
  const base = new URL(
    process.env.AUTH_TEST_BASE_URL ?? "http://localhost:3000",
  );
  const appBase = new URL(process.env.APP_BASE_URL ?? base.origin);
  const tenant = new URL(
    `https://${process.env.AUTH0_DOMAIN.replace(/^https?:\/\//, "")}`,
  );
  const callback = new URL("/auth/callback", appBase).toString();
  const request = (path, cookie) =>
    fetch(new URL(path, base), {
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
      headers: cookie ? { Cookie: cookie } : undefined,
    });
  const expectRedirect = (response) =>
    check(
      [302, 303, 307, 308].includes(response.status) &&
        Boolean(response.headers.get("location")),
      "Expected an authentication redirect.",
    );

  stage = "public workspace";
  const root = await request("/");
  assertStatus(root, 200, "The guest workspace must remain available.");
  checkWorkspaceChrome(await root.text());
  passed++;

  stage = "public sample workspace";
  const sample = await request("/workspaces/berkeley-studio");
  assertStatus(
    sample,
    200,
    "The Berkeley sample must remain available to guests.",
  );
  const sampleText = checkWorkspaceChrome(await sample.text());
  check(
    sampleText.includes("Sample workspace") &&
      sampleText.includes("Berkeley studio"),
    "The public Berkeley workspace must clearly identify itself as a sample.",
  );
  passed++;

  stage = "guest personal workspace protection";
  const personalPath = "/workspaces/ws-http-check";
  const personalGuest = await request(personalPath);
  expectRedirect(personalGuest);
  const workspaceLogin = new URL(personalGuest.headers.get("location"), base);
  check(
    workspaceLogin.origin === appBase.origin &&
      workspaceLogin.pathname === "/auth/login" &&
      workspaceLogin.searchParams.get("returnTo") === personalPath,
    "A guest personal workspace must redirect to application sign-in with its exact return path.",
  );
  check(
    privateNoStoreResponse(personalGuest),
    "Personal workspace redirects must be private and must not be stored.",
  );
  await personalGuest.arrayBuffer();
  passed++;

  stage = "guest profile";
  const guest = await request("/auth/profile");
  assertStatus(guest, 401, "A guest profile must be unauthenticated.");
  check(
    privateResponse(guest),
    "The guest profile must forbid public caching.",
  );
  check(
    sessionCookies(guest).every(cleared),
    "A guest profile must not establish a session.",
  );
  await guest.arrayBuffer();
  passed++;

  async function checkLogin(path, signup) {
    const response = await request(path);
    expectRedirect(response);
    const destination = new URL(response.headers.get("location"), base);
    check(
      destination.protocol === "https:" &&
        destination.host === tenant.host &&
        destination.pathname === "/authorize",
      "Login must redirect to the configured Auth0 tenant.",
    );
    check(
      destination.searchParams.get("client_id") === process.env.AUTH0_CLIENT_ID,
      "Login must use the configured Auth0 application.",
    );
    check(
      destination.searchParams.get("redirect_uri") === callback,
      "Login must use the exact configured callback URL.",
    );
    const state = destination.searchParams.get("state");
    check(Boolean(state), "Login must include OAuth state.");
    check(
      destination.searchParams.get("code_challenge_method") === "S256" &&
        Boolean(destination.searchParams.get("code_challenge")),
      "Login must use PKCE with S256.",
    );
    if (signup)
      check(
        destination.searchParams.get("screen_hint") === "signup",
        "The signup hint must reach Auth0.",
      );
    const transaction = cookies(response).find(
      (cookie) => cookie.name === `__txn_${state}`,
    );
    check(
      Boolean(transaction?.value),
      "Login must establish a transaction cookie linked to its state.",
    );
    check(
      transaction.attributes.has("httponly"),
      "The transaction cookie must be HttpOnly.",
    );
    check(
      transaction.attributes.get("samesite")?.toLowerCase() === "lax",
      "The transaction cookie must use SameSite=Lax.",
    );
    check(
      transaction.attributes.get("path") === "/",
      "The transaction cookie must cover the callback route.",
    );
    if (base.protocol === "https:")
      check(
        transaction.attributes.has("secure"),
        "HTTPS transaction cookies must be Secure.",
      );
    await response.arrayBuffer();
  }

  stage = "login redirect and transaction";
  await checkLogin("/auth/login", false);
  passed++;
  stage = "signup redirect";
  await checkLogin("/auth/login?screen_hint=signup", true);
  passed++;

  stage = "invalid OAuth callback";
  const invalid = await request(
    "/auth/callback?code=crowdy-invalid-code&state=crowdy-invalid-state",
  );
  check(
    invalid.status >= 400 || [302, 303, 307, 308].includes(invalid.status),
    "An invalid callback must fail or redirect to error handling.",
  );
  check(
    sessionCookies(invalid).every(cleared),
    "An invalid callback must not establish a session.",
  );
  if ([302, 303, 307, 308].includes(invalid.status)) {
    const recovery = new URL(invalid.headers.get("location"), base);
    check(
      recovery.origin === appBase.origin && recovery.pathname === "/auth-error",
      "An invalid callback must redirect only to the application error page.",
    );
    const recoveryPage = await request(recovery.pathname);
    assertStatus(
      recoveryPage,
      200,
      "The authentication error page must remain available to guests.",
    );
    check(
      (await recoveryPage.text()).includes("/auth/login"),
      "The authentication error page must offer a sign-in recovery action.",
    );
  }
  await invalid.arrayBuffer();
  passed++;

  stage = "disabled guest access-token endpoint";
  const tokenGuest = await request("/auth/access-token");
  assertStatus(
    tokenGuest,
    404,
    "The browser access-token endpoint must be disabled.",
  );
  await tokenGuest.arrayBuffer();
  passed++;

  const fixture = {
    user: {
      sub: "auth0|crowdy-http-check-fixture",
      email: "crowdy-http-check@example.invalid",
      name: "Crowdy HTTP check",
    },
    tokenSet: {
      accessToken: "crowdy-synthetic-access-marker",
      refreshToken: "crowdy-synthetic-refresh-marker",
      idToken: "crowdy-synthetic-id-marker",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    },
    internal: {
      sid: "crowdy-http-check-session",
      createdAt: Math.floor(Date.now() / 1000),
    },
  };
  const fixtureCookie = `__session=${await generateSessionCookie(fixture, { secret: process.env.AUTH0_SECRET })}`;

  stage = "personal workspace owner isolation";
  const otherFixture = {
    ...fixture,
    user: {
      sub: "auth0|crowdy-other-http-check-fixture",
      email: "crowdy-other-http-check@example.invalid",
      name: "Other Crowdy HTTP check",
    },
  };
  const otherCookie = `__session=${await generateSessionCookie(otherFixture, { secret: process.env.AUTH0_SECRET })}`;
  for (const [identity, cookie, excluded] of [
    [fixture, fixtureCookie, otherFixture],
    [otherFixture, otherCookie, fixture],
  ]) {
    const personal = await request(personalPath, cookie);
    assertStatus(
      personal,
      200,
      "A signed-in account must reach the personal workspace shell.",
    );
    check(
      privateNoStoreResponse(personal),
      "Personal workspace responses must be private and must not be stored.",
    );
    const html = await personal.text();
    checkWorkspaceChrome(html);
    check(
      html.includes(identity.user.sub) && !html.includes(excluded.user.sub),
      "The personal workspace payload must contain only the current authenticated owner.",
    );
    check(
      !html.includes(identity.user.email),
      "The workspace shell must receive only the owner identifier it needs.",
    );
    for (const marker of Object.values(identity.tokenSet).filter(
      (value) => typeof value === "string",
    )) {
      check(
        !html.includes(marker),
        "Workspace HTML must not expose OAuth tokens.",
      );
    }
  }
  passed++;

  stage = "authenticated profile and token isolation";
  const authenticated = await request("/auth/profile", fixtureCookie);
  assertStatus(
    authenticated,
    200,
    "The SDK must recognize a correctly encrypted test session.",
  );
  check(
    privateResponse(authenticated),
    "An authenticated profile must forbid public caching.",
  );
  const profileText = await authenticated.text();
  const profile = JSON.parse(profileText);
  check(
    profile.sub === fixture.user.sub && profile.email === fixture.user.email,
    "The profile must contain the expected synthetic identity.",
  );
  for (const marker of Object.values(fixture.tokenSet).filter(
    (value) => typeof value === "string",
  )) {
    check(
      !profileText.includes(marker),
      "OAuth tokens must never appear in the browser profile.",
    );
  }
  check(
    !("tokenSet" in profile) && !("internal" in profile),
    "The browser profile must exclude SDK session internals.",
  );
  for (const key of ["AUTH0_SECRET", "AUTH0_CLIENT_SECRET"]) {
    if (process.env[key])
      check(
        !profileText.includes(process.env[key]),
        "The profile must not expose server credentials.",
      );
  }
  passed++;

  stage = "disabled authenticated access-token endpoint";
  const tokenAuthenticated = await request("/auth/access-token", fixtureCookie);
  assertStatus(
    tokenAuthenticated,
    404,
    "Authentication must not enable the browser access-token endpoint.",
  );
  await tokenAuthenticated.arrayBuffer();
  passed++;

  stage = "cross-request profile isolation";
  const nextGuest = await request("/auth/profile");
  assertStatus(
    nextGuest,
    401,
    "A fresh guest must not inherit a prior authenticated profile.",
  );
  check(
    privateResponse(nextGuest),
    "A fresh guest profile must forbid public caching.",
  );
  await nextGuest.arrayBuffer();
  passed++;

  stage = "logout session clearing";
  // Omit refresh/id tokens here: the SDK proactively revokes refresh tokens on
  // logout. This keeps the fixture check free of provider-side token mutations.
  const logoutFixture = {
    ...fixture,
    tokenSet: {
      accessToken: "crowdy-synthetic-logout-access",
      expiresAt: fixture.tokenSet.expiresAt,
    },
  };
  const logoutCookie = `__session=${await generateSessionCookie(logoutFixture, { secret: process.env.AUTH0_SECRET })}`;
  const logout = await request("/auth/logout", logoutCookie);
  expectRedirect(logout);
  const logoutDestination = new URL(logout.headers.get("location"), base);
  check(
    logoutDestination.protocol === "https:" &&
      logoutDestination.host === tenant.host,
    "Logout must redirect to the configured Auth0 tenant.",
  );
  const logoutReturn =
    logoutDestination.searchParams.get("post_logout_redirect_uri") ??
    logoutDestination.searchParams.get("returnTo");
  check(
    Boolean(logoutReturn) &&
      new URL(logoutReturn).toString() === appBase.toString(),
    "Logout must return to the configured application URL.",
  );
  const removed = sessionCookies(logout);
  check(
    removed.length > 0 && removed.every(cleared),
    "Logout must clear the SDK session cookie.",
  );
  await logout.arrayBuffer();
  passed++;

  console.log(
    `Auth checks passed: ${passed} HTTP checks covering public samples, personal workspace ownership, guest access, OAuth redirects, session privacy, invalid callback rejection, and logout.`,
  );
  console.log(
    "Synthetic session fixtures do not validate a real user's complete Auth0 login/callback flow.",
  );
}

try {
  await main();
} catch {
  console.error(
    `Auth check failed during ${stage}. Confirm the running app and Auth0 configuration; no credential or cookie values were logged.`,
  );
  process.exitCode = 1;
}
