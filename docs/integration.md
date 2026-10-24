# Frontend and backend integration

This branch combines `feat/auth` with `backend/routing-editor-fixes`, retaining both histories and test suites. The previous native service bridge now uses the current body-clear routing engine and near-door evacuation strips. Per-person walking speeds from the frontend branch are preserved.

## Local startup

Use Python 3.12 and Node.js 22 or newer. From the repository root, in the first terminal:

```sh
cd backend
python3.12 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
python -m uvicorn app.api:app --host 127.0.0.1 --port 8000
```

Reuse an existing working virtual environment instead of recreating it. The API loads provider keys from the repository root `.env`, with process environment values taking precedence. Do not put real values in `.env.example`.

In the second terminal, from the repository root:

```sh
cd frontend
npm ci
npm run dev
```

Keep an existing `.env.local`. If none exists, copy `frontend/.env.example` to `frontend/.env.local` and fill in the team's Auth0 credentials. The public sample is at `http://localhost:3000/workspaces/berkeley-studio`; personal workspaces require the team's Auth0 configuration. The Python service defaults to port 8000 in development. For another port or a production deployment, set the server-only `CROWDY_BACKEND_URL` in the frontend environment. If Python has `CROWDY_BACKEND_TOKEN`, set the same token on Next.js.

## Data flow

1. The existing sample and frontend JSON files use their original 32 px/m adapter.
2. Backend layout/scenario JSON imports go through `/api/floorplans`. The response includes the canonical metre layout, a fitted canvas projection, polygon furniture, compiled wall polygons with real door gaps, floor outlines, and near-door exit zones.
3. Image uploads use the same route with a provider and confirmed full-image width in metres. It reuses the existing image validation, extraction, conversion, and local provenance storage. The frontend accepts PNG/JPEG/WebP up to 10 MB and JSON up to 1 MB. A missing key, provider failure, or invalid extraction is displayed without replacing the current layout.
4. Furniture edits remain relative to their polygon bounding boxes. On Run, Python reconstructs those exact polygons in metres and compiles the canonical floor, walls, and doors. It regenerates clear starting positions with the submitted occupancy, seed, distribution, and walking profile, then runs the native engine.
5. Native samples retain their original timestamps and evacuation events. The frontend applies the saved projection to playback, routes, people size, density cells, and scale labels. Failed or incomplete runs retain their actual outcome.

The UI currently supports 10–200 people. Backend files may contain larger populations, but the scenario controls determine the submitted population. Imported manual starts are regenerated for interactive editing; original source files remain untouched. The standalone editor supports explicit fixed starts for comparisons.

## Remaining limitations

- The Next.js canvas edits furniture. Wall/door editing, individual polygon corners, source-image comparison, and two-point scale calibration remain in the standalone backend editor. Export corrected backend layout JSON from that editor and import it into Next.js.
- The image dialog uses the real-world width of the entire image, including margins. It is not an automatic scale estimate. Invalid extracted geometry must be corrected before importing into this workspace.
- Auth0 identity is integrated, but personal layouts are still stored in account-scoped local browser storage. They do not sync between devices. Runs and baselines last for the current session.
- The Python service must be hosted separately from Vercel. The included Dockerfile needs linux/amd64 for the pinned JuPedSim wheel and a writable/persistent data directory for image artifacts. Set production Auth0 credentials, backend URL, provider keys, and matching backend token on their respective hosts.
- Native runs execute synchronously with one active simulation per Python process. The frontend proxy has a 55-second run timeout. Image extraction has a separate, longer timeout; the host must allow its configured duration.

## Validation

From `backend/`: `python -m unittest discover -s tests`, plus the four `node tests/editor_*.test.cjs` scripts listed in the root README.

From `frontend/`: `npm run lint`, `npm run build`, `npm run test:simulation`, `npm run test:backend-simulation`, and `npm run test:workspaces`. With both services running, run `npm run test:backend-api` and `npm run test:auth`.

The checks include real native evacuation through both geometry formats, edited polygon furniture, calibrated playback, stable seeds, mixed speeds, retained workspace geometry, invalid input recovery, and image extraction using a mocked provider. Synthetic Auth0 sessions test the application's session handling; they do not verify the team's actual login/callback configuration. Real image-provider requests are not needed for the integration regression suite.
