# Azure backend and Vercel frontend

Crowdy runs its Next.js frontend as `crowdy-calhacks13` in the `808-atoms` Vercel scope. Terraform in `infra/` deploys the Python backend to Azure Container Apps in the Azure for Students subscription and provisions private Azure Blob Storage. See [the infrastructure guide](../infra/README.md) for the exact resources, student subscription, region, cost estimates, state handling, and deployment script.

The browser calls same-origin Next.js routes. The server forwards simulations, floor-plan imports, source images, and workspace requests with a server-only backend token. Workspace ownership derives from the authenticated Auth0 session; browser request fields or headers cannot select another owner. Private Blob Storage holds workspace manifests, native geometry drafts, scenarios, venue images, source floor-plan images, and extraction/calibration artifacts. A signed-in account can reopen its personal workspaces from another browser or device.

## Backend configuration

`backend/Dockerfile` builds a Python 3.12 image with the native JuPedSim runtime. Terraform uses a private Container Registry, one Container Apps replica, and managed identity for registry pulls and Blob access. No database server is needed for this initial deployment: private workspace manifests use Azure ETags to coordinate writes, and layout revisions prevent stale browser saves from overwriting newer edits. Deletion tombstones prevent old browser migrations from resurrecting removed workspaces or source images.

Terraform supplies these backend settings:

| Variable | Value |
| --- | --- |
| `CROWDY_BACKEND_TOKEN` | Generated shared secret matching the frontend server. |
| `AZURE_STORAGE_ACCOUNT_URL` | The provisioned storage account's HTTPS Blob endpoint. |
| `AZURE_STORAGE_CONTAINER` | Private `crowdy` container. |
| `AZURE_CLIENT_ID` | The user-assigned managed identity's client ID. |
| `GEMINI_API_KEY` | Optional secret; enables Gemini floor-plan extraction. |
| `ANTHROPIC_API_KEY` | Optional secret; enables Claude floor-plan extraction. |
| `AI_GATEWAY_API_KEY` | Optional Vercel AI Gateway secret; enables Gemini and Claude and takes precedence over native keys. |

Configure `TF_VAR_ai_gateway_api_key` for both providers through Vercel AI Gateway,
or `TF_VAR_gemini_api_key` / `TF_VAR_anthropic_api_key` for direct provider access.
The deploy script privately preserves all three in ignored
`infra/secrets.auto.tfvars.json`; omitted exports retain saved keys. Gateway
requests use the fixed `https://ai-gateway.vercel.sh/v1/chat/completions` endpoint.
Its defaults are `google/gemini-3.8-flash` and `anthropic/claude-sonnet-5.5`, with
separate backend `AI_GATEWAY_GEMINI_MODEL` / `AI_GATEWAY_ANTHROPIC_MODEL` overrides.
Native `GEMINI_MODEL` / `ANTHROPIC_MODEL` settings remain independent, and
`CLAUDE_API_KEY` is accepted when `ANTHROPIC_API_KEY` is absent. Models must be
available to the credential's account. Sample and JSON simulations need no
provider credentials. Keep extraction keys only on the Python backend; the
frontend server still uses its separate backend bearer token.

Azure storage is authoritative when configured. Storage failures are reported instead of falling back to ephemeral files. Local development without Azure settings uses `data/editor/` for artifacts and `data/persistent/` for account workspaces relative to the backend working directory; `CROWDY_STORAGE_DIR` overrides that local root. Legacy `BLOB_READ_WRITE_TOKEN` support remains for older Vercel artifact deployments, but is not the Azure persistence configuration.

## Frontend configuration

Keep the existing Auth0 values in the frontend's **Production** environment and configure:

| Variable | Value |
| --- | --- |
| `APP_BASE_URL` | `https://crowdy-calhacks13.vercel.app` |
| `AUTH0_DOMAIN`, `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET`, `AUTH0_SECRET` | Existing Auth0 application and session settings. |
| `CROWDY_BACKEND_URL` | Azure backend URL from the Terraform `backend_url` output. |
| `CROWDY_BACKEND_TOKEN` | Terraform's sensitive `backend_token` output. |
| `CROWDY_CROWD_ESTIMATION_URL` | Separate YOLO service URL from `crowd_estimation_url`, when enabled. |
| `CROWDY_CROWD_ESTIMATION_TOKEN` | Separate sensitive `crowd_estimation_token` output. |

Set the same backend URL/token in `frontend/.env.local` for local frontend development against Azure, then restart Next.js. Retrieve the token privately and keep real environment files and Terraform state out of Git. Never use a `NEXT_PUBLIC_` prefix. Auth0's production callback remains `https://crowdy-calhacks13.vercel.app/auth/callback`, and its logout URL remains `https://crowdy-calhacks13.vercel.app/`. The backend origin needs no Auth0 callback registration.

## Deploy and check

Deploy the Azure backend first using the Terraform script from the repository root:

```sh
./infra/scripts/check.sh
./infra/scripts/deploy.sh deploy
```

Follow the [infrastructure prerequisites](../infra/README.md#prerequisites) to authenticate to the student subscription. The script creates the foundation, builds the backend image, then applies a saved plan to deploy that image. It does not deploy the frontend or configure its Vercel environment.

After setting the frontend environment variables, deploy it with the authenticated Vercel CLI:

```sh
vercel --cwd frontend --prod --scope 808-atoms
```

For a fresh checkout, link only the frontend with `vercel link --cwd frontend --project crowdy-calhacks13 --scope 808-atoms`. Existing `backend/vercel.json` and related files support older deployments; the current backend deployment uses the Azure image instead. Environment changes require a frontend restart/redeployment or an updated backend deployment.

Check the backend's anonymous `/health` endpoint using the Terraform `backend_url` and the frontend's `/api/simulations` health proxy. Both should report the JuPedSim runtime and ready state when no simulation is active. Open the Berkeley sample and inspect an actual simulation's playback and counts. Sign in, create a personal workspace, upload a venue image, and reopen it in another browser session with the same account. Verify that another account cannot load its workspace or images.

With the frontend running and its protected backend configured, run:

```sh
cd frontend
npm run test:auth
npm run test:cloud-workspaces
```

The auth checks use encrypted synthetic sessions without changing Auth0 users or tenant configuration. The cloud checks create isolated synthetic-account fixtures, exercise workspace CRUD, private source-image round trips, account isolation, mutation origin checks, revision conflicts, and tombstones, then delete the fixtures. No credentials or cookie values are logged. A real browser login/callback still needs a manual Auth0 check. After adding a provider key, separately verify extraction, overlay alignment, scale, and manual measurement.

## Separate crowd-estimation deployment

The still-image and live-frame service lives in `services/crowd-estimation/` and deploys as a
separate Container App sharing the registry/environment. It uses its own
identity with registry-pull access, bearer token, image version, and replica
settings. It has no workspace-storage access. The model weights are included
in the image; `/readyz` succeeds after model loading and warmup, and `/healthz`
supplies liveness.

After the existing Azure foundation is available, use
`./infra/scripts/deploy-crowd-estimation.sh plan` to review current intent, then
`./infra/scripts/deploy-crowd-estimation.sh deploy` to build, push, plan, and
deploy the service. Preserve both ignored deployment-intent files for future
Terraform runs; see [the infrastructure guide](../infra/README.md). Configure
the two crowd-estimation frontend values above and redeploy Next.js to connect
it. Live camera sessions require exactly one warm replica and one Uvicorn
worker; Terraform enforces minimum and maximum replicas of one. Existing local
tfvars with zero/two overrides must be changed to one/one. Sessions live in memory
and expire on service restart or deployment. Deploy both the estimator image and
frontend for the iPhone flow, using an HTTPS frontend address reachable by both devices.

See [the service guide](../services/crowd-estimation/README.md) for local
startup, authenticated requests, upload limits, independent tests, and model
accuracy limitations. Crowd images use multipart data through the frontend;
they retain the browser's 3 MiB prepared-image budget. Video is not implemented.

## Persistence and request limits

Personal layouts and scenarios autosave through `/api/workspaces`; a failed request never falls back to browser storage. The editor keeps failed changes visible with retry/export controls. Runs and baselines remain temporary for the current editor session. Berkeley studio remains a public, temporary sample.

Valid account-scoped browser workspaces migrate with their original IDs after sign-in. Existing cloud records win, and local snapshots are removed only after cloud acknowledgement or a durable deletion tombstone. Legacy IndexedDB venue images migrate in bounded batches after their workspace exists in the cloud. Failed uploads or local cleanup retain originals and show a retry notice. Reopen Sources to continue a pending batch. Browser storage is not required for active cloud persistence.

The Vercel frontend's 4.5 MB request/response limit still applies. Image uploads accept PNG/JPEG/WebP files up to 10 MiB, normalize orientation and dimensions, and encode to at most 3 MiB before transfer; the JSON/base64 envelope stays below the hosting limit. Workspace JSON requests are limited to 2 MiB. Workspace/image proxy responses have a 4 MiB budget and return a clear error if the library is too large to load at once. The current library API includes plan data in its collection response; large libraries will need pagination or summary endpoints.

Simulation requests retain a 55-second frontend timeout. Large playback trajectories can exceed Vercel's response allowance even when the backend succeeds; reduce occupancy or use hosting with a larger response allowance. Image imports run as background jobs on the persistent Azure process with progress polling. Job state, active provider work, and simulation locks remain process-local: the deployment fixes the backend at one replica, and interrupted jobs should be retried after a restart or redeployment. Multiple replicas require a durable job queue and coordinated work scheduling.

Run the [integration checks](integration.md#validation), frontend build/lint, and backend tests before deploying. Unit tests mock cloud calls; a live private Blob round trip verifies managed identity and deployed storage access. Provider fixture tests do not verify a live account's model access.

Interactive floor-plan imports use the full canonical image with at most one conditional structural follow-up, rather than automatically starting tiled extraction. The API starts a 90-second worker budget before image decoding/storage; provider calls have a 75-second cap within an 85-second extraction scope. The floor-plan proxy allows 105 seconds, its Vercel duration is 110 seconds, and browser preparation/upload/polling share a 110-second limit. Keep `CROWDY_FLOORPLAN_EXTRACTION_MODE` unset or `interactive` in production. `diagnostic_staged` is for explicit offline evaluation and still inherits the API budget when invoked through HTTP.
