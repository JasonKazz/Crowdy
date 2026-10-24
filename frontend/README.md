# Crowdy frontend

Crowdy organizes floor-plan layouts and evacuation scenarios into workspaces. Built with Next.js 16.4.3, TypeScript, and Tailwind CSS. Requires Node.js 20.9 or newer.

## Run locally

From `frontend/`:

```sh
cp .env.example .env.local
npm ci
npm run dev
```

Fill in the local Auth0 credentials before starting the server. If onboarding already created `.env.local`, keep that file instead of copying over it. Open http://localhost:3000.

## Auth0

Auth0 MCP onboarding created Crowdy as a Regular Web Application in `dev-zag8fvtpirhmkbag.us.auth0.com`. The app uses `@auth0/nextjs-auth0` 4.33 and the Next.js `src/proxy.ts` entry point. The SDK handles `/auth/login`, `/auth/callback`, `/auth/logout`, and `/auth/profile`; a separate auth route handler is not needed. The client profile hook supplies the account controls.

The included `.env.example` lists the Auth0 and simulation-service settings. A local Auth0 configuration has this shape; replace the placeholders with the application's credentials:

```dotenv
APP_BASE_URL=http://localhost:3000
AUTH0_DOMAIN=dev-zag8fvtpirhmkbag.us.auth0.com
AUTH0_CLIENT_ID=your-auth0-client-id
AUTH0_CLIENT_SECRET=your-auth0-client-secret
AUTH0_SECRET=your-generated-session-secret
```

Generate `AUTH0_SECRET` with `openssl rand -hex 32`. Keep real credentials in the ignored `.env.local` file or deployment environment variables. Do not commit them or prefix secrets with `NEXT_PUBLIC_`.

The application's Auth0 allowlists must include these exact URLs:

| Environment | Allowed callback URL | Allowed logout URL |
| --- | --- | --- |
| Local | `http://localhost:3000/auth/callback` | `http://localhost:3000/` |
| Production | `https://crowdy-calhacks13.vercel.app/auth/callback` | `https://crowdy-calhacks13.vercel.app/` |

Identity scopes are limited to `openid profile email`, and the browser access-token endpoint is disabled. Personal workspace routes check the Auth0 session on the server before opening the account's browser-local record.

## Workspace home

The home page at `/` uses a single workspace grid. Berkeley studio appears in that grid with a **Sample** tag for everyone; signed-in users see their personal workspaces alongside it under **Your workspaces**. Guests can open the sample and sign in to create their own workspaces. Signed-in users can create an empty layout, copy the sample or an existing workspace, and delete personal workspaces with confirmation.

Berkeley studio is the shared sample at `/workspaces/berkeley-studio`, available to everyone. It always starts from the original plan and scenario. Edits in the sample are temporary and never overwrite that shared starting point. Use **Make a copy** while signed in to save a personal version, or export the current layout as JSON.

Personal workspaces open at `/workspaces/:workspaceId`. The server requires sign-in, then the browser loads the record stored for the authenticated Auth0 subject. Another account or device will not find that record. Workspace lists and contents are saved on this device; there is no database or cloud synchronization.

## Layout and simulation

Each workspace uses a 900 × 600 canvas. Import a Crowdy JSON floor plan or use the sample to explore. Download the sample JSON in the upload dialog for the supported geometry format. **Export workspace** saves the current layout, scenario, and available result summary as JSON.

Select furniture to drag it, move it with the arrow keys, or edit its coordinates. Adjust occupancy, walking profile, and distribution before running. Inspect playback, routes, and density; pin a run as a baseline to compare a subsequent change.

Runs use the Python backend's JuPedSim Collision Free Speed Model. The browser sends a snapshot of the layout and scenario to the same-origin `POST /api/simulations` route; Next.js validates it and forwards it to FastAPI. Playback follows the returned sampled trajectories and evacuation events. Clearance time is available only when everyone exits; a run that reaches its time limit retains its remaining count. Results describe the shown model assumptions and are not a safety assessment. Image/PDF floor-plan interpretation is not connected.

Start the Python 3.12 service using the [root setup instructions](../README.md#backend). Development defaults to `http://127.0.0.1:8000`, so no backend URL is needed locally. To use another service, add these server-only settings to `frontend/.env.local` and restart Next.js:

```dotenv
CROWDY_BACKEND_URL=http://127.0.0.1:8000
# Optional; must match the Python service when configured there.
CROWDY_BACKEND_TOKEN=
```

`GET /api/simulations` checks the backend's `/health` endpoint through the same proxy. The browser never needs the backend token or a direct backend URL. A failed or cancelled request keeps the current setup available for another attempt.

Personal layouts and scenarios autosave in account-scoped browser storage. If a save fails, the editor keeps the current changes visible, reports that they are unsaved, and offers export so the work can be kept separately. Runs and baselines remain for the current editor session. Clearing browser storage removes personal workspaces from that device, so export copies you need to retain.

The earlier single-workspace browser-storage key is retained, but its layout is not automatically assigned or migrated to an account.

## Checks

```sh
npm run lint
npm run build
```

With Node.js 22 or newer, run the simulation, workspace-store, and auth checks. Keep `npm run dev` running in another terminal for `test:auth`; `test:backend-api` also needs the Python service running:

```sh
npm run test:simulation
npm run test:backend-simulation
npm run test:backend-api
npm run test:workspaces
npm run test:auth
```

The workspace-store checks use isolated in-memory storage fixtures to verify account isolation, shared-sample protection, saved-data cloning, and recoverable storage failures. The auth checks use local session fixtures and read-only requests against the running app, including public sample access and server authentication for personal workspace routes. They do not create Auth0 users or change tenant configuration.

The backend adapter checks include recorded native completed and timed-out runs. HTTP checks exercise the full Next.js-to-Python connection, actual two-exit results, request limits, and invalid-layout recovery. Run `.venv/bin/python -m unittest discover -s tests -v` from `backend/` for the Python engine and API tests.

## Deploy to Vercel

Configure the five Auth0 environment variables in the `crowdy-calhacks13` Vercel project. Set production `APP_BASE_URL` to `https://crowdy-calhacks13.vercel.app` and use the application's Auth0 credentials. Also set `CROWDY_BACKEND_URL` to the hosted Python service's HTTPS base URL and, if enabled there, the matching `CROWDY_BACKEND_TOKEN`. These are server-only variables. Keep deployment secrets in Vercel environment settings, not tracked files.

A hosted Python service has not been configured by this change. Deploying Next.js alone does not host JuPedSim, and production does not fall back to localhost. See the root README for the backend Docker image and startup command.

From `frontend/`, with the Vercel CLI authenticated:

```sh
vercel --prod
```

The included `vercel.json` selects the Next.js framework preset. Register any additional deployment origins in Auth0 before testing sign-in from those origins.
