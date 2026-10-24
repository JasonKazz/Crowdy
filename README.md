# Crowdy

Interactive evacuation planning from furnished floor plans, with editable layouts, scenario-based occupancy, crowd simulation, and before-and-after comparisons. Built at Cal Hacks 13.0.

## Integrated app

The Next.js workspace and JuPedSim backend run together. See [integration setup and checks](docs/integration.md) for local startup, supported imports, and remaining UI limitations. Both services deploy to Vercel as separate projects; see [deployment setup](docs/deployment.md). The standalone layout editor below is also available for detailed geometry corrections.

## Frontend

Live demo: https://crowdy-calhacks13.vercel.app

The Next.js app lives in `frontend/` and uses TypeScript, Tailwind CSS, ESLint, and the App Router. Use Node.js 22 or newer for development and the regression scripts.

The workspace includes furniture and wall/door editing, scenario controls, playback, density overlays, and baseline comparisons. Runs use the Python JuPedSim service through a same-origin API. PNG/JPEG/WebP extraction uses a configured Gemini or Claude account, with automatic scale detection and a manual measurement fallback. PDF import is not implemented. Auth0 supplies sign-in; personal workspaces remain account-scoped browser storage.

```sh
cd frontend
npm install
npm run dev
```

Open http://localhost:3000. Run `npm run lint` to check the code and `npm run build` to create a production build.

## Backend

Use Python 3.12. From the repository root:

```sh
python3.12 -m venv backend/.venv
backend/.venv/bin/python -m pip install -r backend/requirements.txt
cd backend
.venv/bin/python -m uvicorn app.api:app --host 127.0.0.1 --port 8000
```

Reuse an existing working environment. Run the frontend in a second terminal; it defaults to this backend address in development. `backend/pyproject.toml` and `uv.lock` define the smaller Vercel API environment, excluding the unused JuPedSim desktop visualizer dependencies. The existing requirements and Dockerfile remain available for local/standalone use.

## Backend structure

```text
backend/app/
├── api/
├── schemas/
├── services/
│   ├── floorplans/
│   ├── population/
│   ├── scenarios/
│   └── analysis/
├── simulation/
├── worker/
└── storage/
examples/
docs/
```

Unused backend directories retain `.gitkeep` placeholders.

## Local configuration

Copy `.env.example` to `.env` in the repository root if no local file exists, and update it locally. Keep an existing `frontend/.env.local`; Next.js reads its Auth0 and backend settings there. `.env` files, credentials, uploads, local databases, and generated results are ignored by Git. Commit only placeholder values in `.env.example`.

The API and local editor load backend settings from the repository root `.env`, with process variables taking precedence. `CROWDY_BACKEND_TOKEN` must match the Next.js server when configured. Artifacts use `backend/data/editor/` locally; setting `BLOB_READ_WRITE_TOKEN` uses private Vercel Blob for source images and extraction/calibration records. The Vercel fallback filesystem path is `/tmp/crowdy`, which is not durable storage.

## Deployment

The frontend is `crowdy-calhacks13` and the Python API is `crowdy-backend` in the `808-atoms` Vercel scope. The frontend calls the backend using server-only `CROWDY_BACKEND_URL` and a matching `CROWDY_BACKEND_TOKEN`. Private Blob keeps image overlays and pending manual calibration available across backend instances. Provider credentials still need to be configured before production image extraction; sample and JSON simulations do not require them.

See [the deployment guide](docs/deployment.md) for environment variables, backend-first deployment commands, and production checks.

## Local simulation

From `backend/`, with its Python 3.12 environment activated:

```bash
python -m app.simulation.run_example ../examples/two_exit_room.json
python -m app.simulation.animate data/two_exit_room_result.json
open data/two_exit_room_animation.html
python -m unittest discover -s tests -v
```

The original `simple_room.json` and commands without arguments still work. Results and HTML are written to the ignored `backend/data/` directory, with names based on the input file.

A scenario supplies either explicit `occupants` or `population` settings. The latter contains `count`, `seed`, and `spawn_area_ids` referencing walkable-area IDs. Placement is uniform within the selected connected area, excluding furniture and exit zones, with clearance between bodies and boundaries. It does not infer activities or seating. The saved result includes the resolved starting positions and the generation settings.

Agents choose an available exit using routes that leave room for their full body radius around walls and furniture. A visibility graph on the clearance geometry supplies safe corners; look-ahead steering follows the route while JuPedSim handles local movement and interactions. Routes are checked before simulation, so a point-sized gap cannot silently trap people. Exit choice is fixed for the run and does not optimize congestion. Results include planned paths in `assignments`, exterior-door `door_crossings`, final `evacuations`, and per-exit counts. `building_clearance_time` records when the last full body crosses the building boundary; `clearance_time` records arrival in the thin evacuation strip just outside the doorway and is null if anyone remains. The strip starts one body radius plus 2 cm beyond the wall, so the full person must clear the doorway.

The example uses meters, with x increasing right and y increasing up. The current geometry validator requires one connected walkable polygon; population placement also requires one connected spawn polygon.

## Blocked-exit comparison

From `backend/`, compare the same starting population with both exits available and with the east exit unavailable:

```bash
python -m app.simulation.compare_exits ../examples/two_exit_room.json --block-exit exit-east
python -m app.simulation.animate data/two_exit_room_baseline_result.json
python -m app.simulation.animate data/two_exit_room_blocked_result.json
open data/two_exit_room_baseline_animation.html
open data/two_exit_room_blocked_animation.html
```

This writes two result snapshots and `data/two_exit_room_comparison.json`. The comparison resolves the population once and reuses the exact IDs, positions, geometry, speeds, and time settings. The clearance-time difference is only reported when both runs evacuate everyone. Repeating a comparison for the same input filename replaces its previous comparison files.

For an individual run, set `settings.blocked_exit_ids` to a list of exit IDs. Unknown IDs, duplicate IDs, and blocking every exit are rejected. Closure means the exit is unavailable as a destination for the entire simulation; it does not remove its landing from the floor or model a physical barricade, changing hazard, or timed closure. People choose among the available exits at the start. Playback shows blocked exit zones in red and counts departures per exit.

## Local layout editor

The backend includes a standalone browser page for testing layout edits against the real Python simulator. Manual JSON editing needs no API keys. Image extraction uses Gemini, Claude, or both; no running Next.js app or JavaScript dependencies are needed.

From `backend/`, with the Python environment activated:

```bash
python -m app.simulation.editor
```

Open http://127.0.0.1:8765 and leave the terminal running. Press Ctrl+C to stop the editor. If that port is already in use, add `--port 8766` and open the matching address.

The example office has furniture, an interior partition with a sliding door opening, and two exits. Drag furniture, walls, and exits; drag a door along its parent wall. The inspector edits object size and position, wall endpoints and thickness, and door width. Add/remove objects, undo/redo, preview seeded people with **Check layout**, and choose **Run simulation** followed by **Open animation**. Invalid geometry is reported before simulation.

**Export editable layout** saves unfinished work as JSON. **Import JSON** accepts editable layouts or the existing scenario examples. To start with another file:

```bash
python -m app.simulation.editor ../examples/two_exit_room.json
```

Each run saves `layout.json`, `scenario.json`, `result.json`, and `playback.html` in a separate `backend/data/editor/<run_id>/` directory. Existing saved files remain after restarting; run links are available during the current server session. Source examples are never overwritten. See [the editor guide](docs/layout-editor.md) for the geometry format and limitations.

The canvas offers Select/Move, Resize, Rotate, Vertices, Pan, drawing furniture and walls, placing doors and exits, zoom, layers/locks, duplicate/delete, and undo/redo. Floors start locked. **Check layout** can display the planned routes. Green evacuation strips sit immediately outside their doorways. People disappear after their full body clears the wall; they do not walk to the far side of an invented outside hallway. Previously saved exterior-geometry settings remain readable, but do not move the evacuation strip.

Run the Python checks with `python -m unittest discover -s tests -v`. Node checks: `node tests/editor_geometry.test.cjs`, `node tests/editor_startup.test.cjs`, `node tests/editor_image_tools.test.cjs`, and `node tests/editor_population.test.cjs`. `examples/narrow_table_regression.json` preserves the 40 starting people from the formerly stuck table layout. The browser defaults to automatic placement so People and Seed are editable; to inspect the exact regression positions, disable automatic placement and import this JSON. Backend simulation commands and API imports preserve fixed positions.

## Start from an image

Install the updated requirements with `python -m pip install -r requirements.txt` from `backend/`. Put real `GEMINI_API_KEY` and `ANTHROPIC_API_KEY` values in the root `.env` and restart the editor. `.env.example` contains placeholders and configurable `GEMINI_MODEL`/`ANTHROPIC_MODEL` defaults. The page shows configured/missing status, never key values.

Choose **Upload floor plan image** (PNG, JPEG, or WebP, up to 10 MiB), enter a known distance in meters, and choose **Mark two points to set scale**. Click the two ends of that distance on the image. Choose a provider and **Extract layout**, or **Compare both models** to make one request to each provider. Inspect the candidates, choose a layout, and adjust its walls, doors, furniture, floor corners, and exits over the image before checking and simulating it. Room labels are observations; population placement remains uniform.

Both providers use the same canonical PNG; large images now use structure, scale, and overlapping detail passes with progress reporting. See [the staged pipeline and venue-image evaluation](docs/staged-extraction.md). Extractions and geometry warnings are saved separately; neither a faster response nor a passed geometry check establishes extraction accuracy. Scale uses printed dimensions first, then a clearly labeled estimate from agreeing doors and furniture. Weak or conflicting evidence requires a known measurement. Edit scale replaces an estimate without losing layout edits; unrecognized exterior exits must be added manually. See [image extraction details](docs/image-extraction.md).
