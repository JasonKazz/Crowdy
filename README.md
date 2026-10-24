# Crowdy
Interactive evacuation planning from furnished floor plans, with editable layouts, scenario-based occupancy, crowd simulation, and before-and-after comparisons. Built at Cal Hacks 13.0.

## Frontend

Live demo: https://crowdy-calhacks13.vercel.app

The Next.js app lives in `frontend/` and uses TypeScript, Tailwind CSS, ESLint, and the App Router. Use Node.js 20.9 or newer.

The workspace includes furniture editing, scenario controls, playback, density overlays, and baseline comparisons. The simulation is an illustrative browser-local model; backend analysis and image/PDF interpretation are not connected yet.

```sh
cd frontend
npm install
npm run dev
```

Open http://localhost:3000. Run `npm run lint` to check the code and `npm run build` to create a production build.

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

Copy `.env.example` to `.env` in the repository root and update it locally. `.env` files, credentials, uploads, local databases, and generated results are ignored by Git. Commit only placeholder values in `.env.example`.

The local editor loads image-provider keys and model names from the repository root `.env` with existing process variables taking precedence. Other `CROWDY_*` variables remain proposed configuration. Data paths are relative to `backend/`.

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

Agents choose an available exit using routes that leave room for their full body radius around walls and furniture. A visibility graph on the clearance geometry supplies safe corners; look-ahead steering follows the route while JuPedSim handles local movement and interactions. Routes are checked before simulation, so a point-sized gap cannot silently trap people. Exit choice is fixed for the run and does not optimize congestion. Results include planned paths in `assignments`, exterior-door `door_crossings`, final `evacuations`, and per-exit counts. `building_clearance_time` records when the last full body crosses the building boundary; `clearance_time` includes discharge through the modeled exterior area and is null if anyone remains.

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

The canvas offers Select/Move, Resize, Rotate, Vertices, Pan, drawing furniture and walls, placing doors and exits, zoom, layers/locks, duplicate/delete, and undo/redo. Floors start locked. **Check layout** can display the planned routes. Exterior exits support **Open area** (a wide clearing with spread destinations) or **Corridor** (door-width discharge). Open clearings are finite local approximations; model a real constrained exterior as a corridor or explicit geometry.

Run the Python checks with `python -m unittest discover -s tests -v`. Node checks: `node tests/editor_geometry.test.cjs`, `node tests/editor_startup.test.cjs`, and `node tests/editor_image_tools.test.cjs`. `examples/narrow_table_regression.json` preserves the 40 starting people from the formerly stuck table layout; run it in the editor to inspect the detours.

## Start from an image

Install the updated requirements with `python -m pip install -r requirements.txt` from `backend/`. Put real `GEMINI_API_KEY` and `ANTHROPIC_API_KEY` values in the root `.env` and restart the editor. `.env.example` contains placeholders and configurable `GEMINI_MODEL`/`ANTHROPIC_MODEL` defaults. The page shows configured/missing status, never key values.

Choose **Upload floor plan image** (PNG, JPEG, or WebP, up to 10 MiB), enter a known distance in meters, and choose **Mark two points to set scale**. Click the two ends of that distance on the image. Choose a provider and **Extract layout**, or **Compare both models** to make one request to each provider. Inspect the candidates, choose a layout, and adjust its walls, doors, furniture, floor corners, and exits over the image before checking and simulating it. Room labels are observations; population placement remains uniform.

Both providers receive the same resized PNG. Extractions and geometry warnings are saved separately; neither a faster response nor a passed geometry check establishes extraction accuracy. Scale must be confirmed before simulation, and unrecognized exterior exits must be added manually. See [image extraction details](docs/image-extraction.md).
