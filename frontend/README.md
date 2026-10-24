# Crowdy frontend

Crowdy organizes floor-plan layouts and evacuation scenarios into workspaces. Built with Next.js 16.4.3, TypeScript, and Tailwind CSS. Use Node.js 22 or newer for development and the regression scripts.

## Run locally

From `frontend/`, copy `.env.example` to `.env.local` only if no local file exists, then run:

```sh
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

Each workspace uses a 900 × 600 view. Import a frontend Crowdy JSON plan, a backend layout/scenario JSON, or a PNG/JPEG/WebP floor plan. Backend layouts retain their polygon outlines, attached doors, wall thicknesses, and metre coordinates. The canvas projection is saved with the workspace; moving or resizing polygon furniture updates the actual geometry submitted to Python. **Export workspace** saves the current layout, scenario, and available result summary as JSON.

Select furniture to drag it, move it with the arrow keys, or edit its coordinates. Adjust occupancy, walking profile, and distribution before running. Inspect playback, routes, and density; pin a run as a baseline to compare a subsequent change.

Runs use the current Python backend's JuPedSim Collision Free Speed Model and body-clear visibility routes. The browser sends a snapshot to the same-origin `POST /api/simulations` route, which validates and forwards it to FastAPI. Playback follows returned trajectories and evacuation events with the correct layout projection. Clearance time is available only when everyone exits; a timed-out run retains its remaining count. Placement seed, occupancy, mixed walking speeds, and workstation distribution reach Python. Results describe the model assumptions and are not a safety assessment.

In **Upload floor plan**, choose Gemini or Claude and select a PNG/JPEG/WebP image up to 10 MiB. The browser corrects orientation, adds a white background, and resizes to at most 1092 pixels per side. PNG encoding, with a JPEG fallback, keeps the processed image within 3 MiB so its base64 request fits Vercel's 4.5 MB limit. The backend sends the processed image to the selected provider; credentials stay in the root `.env` locally or the backend's Vercel environment. Production provider keys still need configuration. Export PDF pages as images first.

Printed dimensions or scale bars set the scale automatically when they agree. Otherwise mark a known distance in the measurement tool; it reuses the saved extraction. **Edit scale** preserves geometry edits. Imported native layouts support **Walls & doors** tools for wall endpoints/thickness, interior doors, and exterior exits, alongside furniture edits. **Check layout** reports geometry issues before a run. The original Berkeley pixel-plan sample retains furniture editing; import a native layout or image for structural tools. See [integration details](../docs/integration.md).

Start the Python 3.12 service using the [root setup instructions](../README.md#backend). Development defaults to `http://127.0.0.1:8000`, so no backend URL is needed locally. To use another service, add these server-only settings to `frontend/.env.local` and restart Next.js:

```dotenv
CROWDY_BACKEND_URL=http://127.0.0.1:8000
# Optional; must match the Python service when configured there.
CROWDY_BACKEND_TOKEN=
```

`GET /api/simulations` checks the backend's `/health` endpoint through the same proxy. The browser never needs the backend token or a direct backend URL. A failed or cancelled request keeps the current setup available for another attempt.

Personal layouts and scenarios autosave in account-scoped browser storage. If a save fails, the editor keeps the current changes visible, reports that they are unsaved, and offers export so the work can be kept separately. Runs and baselines remain for the current editor session. Clearing browser storage removes personal workspaces from that device, so export copies you need to retain.

Source PNGs and extraction/calibration records use private Blob in production so image overlays and pending measurements survive backend instance changes. This artifact storage does not synchronize personal workspaces between browsers.

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
npm run test:native-editor
npm run test:image-upload
npm run test:auth
```

The workspace-store checks use isolated in-memory storage fixtures to verify account isolation, shared-sample protection, saved-data cloning, and recoverable storage failures. The auth checks use local session fixtures and read-only requests against the running app, including public sample access and server authentication for personal workspace routes. They do not create Auth0 users or change tenant configuration.

The backend adapter checks include recorded native completed and timed-out runs. HTTP checks exercise the full Next.js-to-Python connection, actual two-exit results, request limits, and invalid-layout recovery. Image-upload checks cover dimensions, the complete base64 request budget, PNG/JPEG fallback, and oversized/non-JSON error handling. Run `.venv/bin/python -m unittest discover -s tests -v` from `backend/` for the Python engine, API, and artifact-storage tests.

## Deploy to Vercel

The `crowdy-calhacks13` frontend and `crowdy-backend` Python service are separate Vercel projects in the `808-atoms` scope. Configure the five Auth0 environment variables on the frontend, with production `APP_BASE_URL=https://crowdy-calhacks13.vercel.app`. Set `CROWDY_BACKEND_URL=https://crowdy-backend.vercel.app` and the same `CROWDY_BACKEND_TOKEN` as the backend. Keep these server-only values in Vercel environment settings, not tracked files.

The backend uses private Blob for image artifacts. Provider keys and available model IDs belong on that backend; they are still needed before production image extraction. Environment changes require redeployment. See [deployment setup](../docs/deployment.md) for the complete environment matrix and backend-first deployment sequence. Production never falls back to localhost.

From `frontend/`, with the Vercel CLI authenticated:

```sh
vercel --prod --scope 808-atoms
```

The included `vercel.json` selects the Next.js framework preset. Register any additional deployment origins in Auth0 before testing sign-in from those origins.
