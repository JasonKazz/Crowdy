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

Identity scopes are limited to `openid profile email`, and the browser access-token endpoint is disabled. Personal workspace pages and APIs check the Auth0 session on the server. The server forwards the session subject to the protected backend; browser-supplied owner identifiers cannot select another account.

## Workspace home

The home page at `/` uses a single workspace grid. Berkeley studio appears in that grid with a **Sample** tag for everyone; signed-in users see their personal workspaces alongside it under **Your workspaces**. Guests can open the sample and sign in to create their own workspaces. Signed-in users can create an empty layout, copy the sample or an existing workspace, and delete personal workspaces with confirmation.

Inside a workspace, the left sidebar has **Sources** and **Editing** tabs. Sources contains the current floor plan, floor-plan import, and venue-image uploads with previews and removal. Venue images are sent through the same-origin `/api/crowd-estimates` route to the separate Ultralytics YOLO service. It counts visible detected people in each still image and uses the largest individual image count across all current views; overlapping views are never summed. Estimates from 1 to 200 people update scenario occupancy after all images finish successfully. Zero detections, counts above the simulation limit, or a failed upload/estimate keep the current occupancy and show manual-review guidance. Added images remain available after an estimation failure. Saved images can be estimated again using **Estimate crowd**. People hidden from view or too small may be missed; review occupancy before running. Personal venue images are stored in private Azure Blob Storage for that account and workspace; sample uploads are temporary. Images are normalized to at most 3 MiB before upload. Editing contains the layout tools and scenario settings, and opens automatically when an object is selected on the canvas.

Berkeley studio is the shared sample at `/workspaces/berkeley-studio`, available to everyone. It always starts from the original plan and scenario. Edits in the sample are temporary and never overwrite that shared starting point. Use **Make a copy** while signed in to save a personal version, or export the current layout as JSON.

Personal workspaces open at `/workspaces/:workspaceId`. The server requires sign-in, then loads the authenticated account's records through the same-origin `/api/workspaces` API. Layouts, native geometry drafts, scenarios, and venue images are saved in private Azure Blob Storage and available on other devices after signing in to the same account. Another account cannot load them.

## Layout and simulation

Each workspace uses a 900 × 600 view. Import a frontend Crowdy JSON plan, a backend layout/scenario JSON, or a PNG/JPEG/WebP floor plan. Backend layouts retain their polygon outlines, attached doors, wall thicknesses, and metre coordinates. The canvas projection is saved with the workspace; moving or resizing polygon furniture updates the actual geometry submitted to Python. **Export workspace** saves the current layout, scenario, and available result summary as JSON.

Select furniture to drag it, move it with the arrow keys, or edit its coordinates. Adjust occupancy, walking profile, and distribution before running. Inspect playback, routes, and density; pin a run as a baseline to compare a subsequent change.

Runs use the current Python backend's JuPedSim Collision Free Speed Model and body-clear visibility routes. The browser sends a snapshot to the same-origin `POST /api/simulations` route, which validates and forwards it to FastAPI. Playback follows returned trajectories and evacuation events with the correct layout projection. Clearance time is available only when everyone exits; a timed-out run retains its remaining count. Placement seed, occupancy, mixed walking speeds, and workstation distribution reach Python. Results describe the model assumptions and are not a safety assessment.

In **Upload floor plan**, choose Gemini or Claude and select a PNG/JPEG/WebP image up to 10 MiB. The browser corrects orientation, adds a white background, and resizes to at most 3072 pixels per side, preserving detail for staged extraction. PNG encoding, with a JPEG fallback, keeps the processed image within 3 MiB so its base64 request fits Vercel's 4.5 MB limit. The backend sends the processed image to the selected provider; credentials stay in the root `.env` locally or the backend's Azure environment. Local image imports show stage progress while the Python process works. Production provider keys still need configuration. Export PDF pages as images first.

Printed dimensions or scale bars set the scale automatically when they agree. With no printed reference, several agreeing doors and furniture items can provide a labeled scale estimate. Otherwise mark a known distance in the measurement tool; it reuses the saved extraction. **Edit scale** accepts a known length or full image width and preserves geometry edits. Imported native layouts support **Walls & doors** tools for wall endpoints/thickness, interior doors, and exterior exits, alongside furniture edits. **Check layout** reports geometry issues before a run. The original Berkeley pixel-plan sample retains furniture editing; import a native layout or image for structural tools. See [integration details](../docs/integration.md).

Start the Python 3.12 service using the [root setup instructions](../README.md#backend). Development defaults to `http://127.0.0.1:8000`, so no backend URL is needed locally. To use another service, add these server-only settings to `frontend/.env.local` and restart Next.js:

```dotenv
CROWDY_BACKEND_URL=http://127.0.0.1:8000
# Required for personal workspace storage; must match the Python service.
CROWDY_BACKEND_TOKEN=
```

The crowd estimator runs as a separate service. Its `POST /v1/estimates` endpoint accepts multipart field `image`; the browser sends the prepared image (at most 3 MiB) to Next.js, which forwards it with the server-only bearer token. Configure these values in `frontend/.env.local` or the frontend deployment environment:

```dotenv
CROWDY_CROWD_ESTIMATION_URL=http://127.0.0.1:8001
CROWDY_CROWD_ESTIMATION_TOKEN=
```

The token is required in every environment, including local development, and must match the estimator. Missing credentials return `503` without forwarding an image. Development defaults to port 8001 when the URL is omitted; production requires an explicit URL. The proxy bounds request and response streams, enforces a 55-second deadline, rejects cross-site uploads, and preserves a busy service's `503` and `Retry-After`. The browser never receives the service token. Live video is not connected yet.

`GET /api/simulations` checks the backend's `/health` endpoint through the same proxy. The browser never needs the backend token or a direct backend URL. A failed or cancelled request keeps the current setup available for another attempt.

Personal layouts and scenarios autosave to the backend after 150 ms of inactivity. Writes are serialized per workspace and include the last acknowledged revision so older saves cannot overwrite newer edits. A conflicting edit in another tab requires reloading. If a save fails, the editor keeps the current changes visible, reports that they are unsaved, and offers retry and export. Navigation from the editor waits for saving; closing the page warns while changes are pending and attempts a bounded best-effort keepalive save. Runs and baselines remain for the current editor session.

Floor-plan source images, extraction/calibration records, workspace manifests, and venue images use private Azure Blob Storage so they survive backend instance changes. See [Azure infrastructure setup](../infra/README.md) to provision and connect the service. A missing backend configuration or failed request never silently falls back to browser persistence.

On the first library load or personal workspace open, valid legacy account-scoped browser workspaces migrate with their original IDs. Existing cloud records win conflicts. Only server-acknowledged local snapshots are removed; failed or corrupt entries remain for recovery, and durable deletion tombstones prevent resurrection. Legacy account/workspace-scoped IndexedDB venue images transfer after the cloud workspace is available, at most eight images and twenty seconds per Sources load. Cloud acknowledgements or durable source tombstones permit deleting only the corresponding original; failed uploads or local cleanup leave originals intact and show a retry notice. Reopening Sources retries remaining images. The older unowned single-workspace key remains untouched for recovery. IndexedDB is not used for active persistence. Browser storage being blocked does not disable cloud workspaces.

## Checks

```sh
npm run lint
npm run build
```

With Node.js 22 or newer, run the simulation, workspace-store, and auth checks. Keep `npm run dev` running in another terminal for `test:auth`; `test:backend-api` also needs the Python service running. `test:cloud-workspaces` needs the configured protected backend and writes then deletes isolated synthetic fixtures:

```sh
npm run test:simulation
npm run test:backend-simulation
npm run test:backend-api
npm run test:workspaces
npm run test:workspace-sources
npm run test:crowd-estimates
npm run test:native-editor
npm run test:image-upload
npm run test:auth
npm run test:cloud-workspaces
```

The workspace-store checks use isolated HTTP fixtures to verify account isolation, shared-sample protection, native draft preservation, immutable snapshots, ordered writes, optimistic conflicts, cancellation, offline errors, and safe legacy migration. The auth checks use local session fixtures and read-only requests against the running app, including public sample access and server authentication for personal workspace routes. They do not create Auth0 users or change tenant configuration.

The source checks cover accepted image formats and sizes, account/workspace scoping, cloud acknowledgement, blob round trips, cancellation, and offline errors without local storage or IndexedDB. Crowd-estimation checks use isolated transport fixtures to cover multipart requests, zero counts, max across overlapping views, invalid results, streaming byte limits, origin rejection, bearer forwarding, cancellation, deadlines, unavailable/busy services, and required production configuration. Live cloud checks cover the authenticated Next-to-backend connection, session-derived ownership, mutation origin checks, private images, revision conflicts, and deletion tombstones.

The backend adapter checks include recorded native completed and timed-out runs. HTTP checks exercise the full Next.js-to-Python connection, actual two-exit results, request limits, and invalid-layout recovery. Image-upload checks cover dimensions, the complete base64 request budget, PNG/JPEG fallback, and oversized/non-JSON error handling. Run `.venv/bin/python -m unittest discover -s tests -v` from `backend/` for the Python engine, API, and artifact-storage tests.

## Deploy to Vercel

The `crowdy-calhacks13` frontend runs on Vercel in the `808-atoms` scope; the Python backend runs on Azure Container Apps. Configure the five Auth0 environment variables on the frontend, with production `APP_BASE_URL=https://crowdy-calhacks13.vercel.app`. Set `CROWDY_BACKEND_URL` to the Azure backend URL and `CROWDY_BACKEND_TOKEN` to the matching Terraform output. Set `CROWDY_CROWD_ESTIMATION_URL` to the separate Azure estimator URL and `CROWDY_CROWD_ESTIMATION_TOKEN` to its matching bearer token. Keep these server-only values in Vercel environment settings, not tracked files.

The backend uses managed identity to access private Azure Blob Storage for workspaces and image artifacts. Provider keys and available model IDs belong on that backend; they are still needed before production image extraction. Environment changes require redeployment. See [deployment setup](../docs/deployment.md) for the complete environment matrix and backend-first deployment sequence. Production never falls back to localhost.

From `frontend/`, with the Vercel CLI authenticated:

```sh
vercel --prod --scope 808-atoms
```

The included `vercel.json` selects the Next.js framework preset. Register any additional deployment origins in Auth0 before testing sign-in from those origins.
