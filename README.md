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

The environment variables are proposed configuration for the backend; configuration loading is not implemented yet. Data paths are relative to `backend/`. The future backend must explicitly load the root `.env` or receive these values through its deployment environment.

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

Agents choose an exit once, by shortest routed distance to an interior target point in each exit zone. This accounts for obstacles but does not optimize for congestion or dynamically change destinations. The result records initial `assignments`, departure `evacuations`, and `summary.per_exit_counts`. `clearance_time` is null if anyone remains at the time limit.

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
