# Vercel deployment

Crowdy uses two Vercel projects in the `808-atoms` scope:

| Project | Root directory | Production URL |
| --- | --- | --- |
| `crowdy-calhacks13` | `frontend/` | https://crowdy-calhacks13.vercel.app |
| `crowdy-backend` | `backend/` | https://crowdy-backend.vercel.app |

The browser calls the Next.js origin. Its API routes forward simulations, floor-plan imports, and source-image requests to the Python service with a server-only bearer token. Private Vercel Blob stores source PNGs and extraction/calibration records across backend instances. Personal workspaces are still saved in account-scoped browser storage; Blob does not synchronize those workspaces.

## Backend configuration

The backend project uses the FastAPI framework preset. `pyproject.toml` selects `app.api:app`, `.python-version` selects Python 3.12, and `uv.lock` pins the API dependencies. The JuPedSim dependency metadata excludes the unused PySide6/VTK desktop visualizer packages. Local and standalone setup can continue to use `requirements.txt` and the existing Dockerfile.

`backend/vercel.json` gives the resolved `app/api/__init__.py` function a 200-second duration. `.vercelignore` excludes local environments, data, tests, real environment files, and the standalone requirements manifest from the deployment upload.

Set these backend **Production** environment variables in Vercel:

| Variable | Value |
| --- | --- |
| `CROWDY_BACKEND_TOKEN` | Shared secret matching the frontend's value. |
| `BLOB_READ_WRITE_TOKEN` | Token supplied by the linked private Blob store. Keep it on the backend only. |
| `GEMINI_API_KEY` | Gemini credential, required to use Gemini extraction. |
| `GEMINI_MODEL` | An image/structured-output model ID available to that Gemini account. |
| `ANTHROPIC_API_KEY` | Anthropic credential, required to use Claude extraction. |
| `ANTHROPIC_MODEL` | An image/structured-output model ID available to that Anthropic account. |

The backend project has its private Blob store linked. Provider keys are not configured yet; add the desired provider's key and model before using production image extraction. Sample and JSON simulations do not need provider credentials. `CLAUDE_API_KEY` is accepted when `ANTHROPIC_API_KEY` is absent.

Without `BLOB_READ_WRITE_TOKEN`, local artifacts use `data/editor/` relative to the backend working directory. On Vercel, the filesystem fallback is `/tmp/crowdy/editor/`; it is temporary and isolated per instance. `CROWDY_STORAGE_DIR` overrides that filesystem root, but does not provide shared persistence. With Blob configured, image and extraction artifacts are stored privately under `crowdy/editor/`; storage errors are reported rather than silently falling back to disk.

## Frontend configuration

Keep the existing Auth0 values in the `crowdy-calhacks13` project's **Production** environment and configure:

| Variable | Value |
| --- | --- |
| `APP_BASE_URL` | `https://crowdy-calhacks13.vercel.app` |
| `AUTH0_DOMAIN`, `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET`, `AUTH0_SECRET` | Existing Auth0 application and session settings. |
| `CROWDY_BACKEND_URL` | `https://crowdy-backend.vercel.app` |
| `CROWDY_BACKEND_TOKEN` | The same shared secret as the backend. |

These settings remain server-side; do not add a `NEXT_PUBLIC_` prefix. Auth0's allowed callback is `https://crowdy-calhacks13.vercel.app/auth/callback`, and its allowed logout URL is `https://crowdy-calhacks13.vercel.app/`. The backend origin does not need Auth0 callback registration.

## Deploy and check

Environment changes take effect on the next deployment. With the CLI authenticated and each directory linked to the project above, deploy the backend first, then the frontend. From the repository root:

```sh
vercel --cwd backend --prod --scope 808-atoms
vercel --cwd frontend --prod --scope 808-atoms
```

For a fresh checkout, run `vercel link --cwd backend --project crowdy-backend --scope 808-atoms` and `vercel link --cwd frontend --project crowdy-calhacks13 --scope 808-atoms` first. Local `.vercel/` project links and real environment files stay ignored by Git.

Check the native service directly and through the frontend proxy:

```sh
curl --fail --silent --show-error https://crowdy-backend.vercel.app/health
curl --fail --silent --show-error https://crowdy-calhacks13.vercel.app/api/simulations
```

Both should report JuPedSim 1.4.2 and `ready` when no simulation is active. Open the public Berkeley sample, run a simulation, and inspect playback and the evacuation counts. After configuring a provider, import an image, verify its overlay and scale, and test a manual measurement when no reliable printed dimension is present. Sign-in/callback behavior needs a real Auth0 browser check in addition to the synthetic regression tests.

## Request limits and checks

Vercel Functions have a 4.5 MB request/response limit. The website accepts source images up to 10 MiB, then corrects orientation, adds a white background, and resizes to at most 1092 pixels per side before sending. It prefers PNG and falls back to JPEG to keep the encoded image within 3 MiB; the complete base64 JSON request stays below the hosting limit. Images that cannot fit are rejected before upload. The backend stores the processed source as PNG for provider calls and overlays.

Simulation requests have a 55-second frontend timeout and playback responses have a 4 MiB proxy budget. Image extraction has a 175-second provider deadline and a 190-second frontend timeout. Simulation and extraction locks are per Python process, so their busy state does not coordinate every Vercel instance.

Run the [integration checks](integration.md#validation) before deploying, including `npm run test:image-upload` from `frontend/` and `python -m unittest discover -s tests -v` from `backend/`. The storage suite uses mocked Blob calls; a deployed health check and real simulation confirm the native runtime, while a private Blob round trip confirms production storage access. Provider regression tests use fixtures and do not verify a live account's model access.

See Vercel's [FastAPI deployment guide](https://vercel.com/docs/frameworks/backend/fastapi), [Python runtime](https://vercel.com/docs/functions/runtimes/python), and [function limits](https://vercel.com/docs/functions/limitations) for hosting configuration.
