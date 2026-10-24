# Frontend and backend integration

The Next.js workspace uses the native JuPedSim service for body-clear routing and near-door evacuation strips. Per-person walking speeds, editable geometry, and layout scale pass through the same bridge. The two services deploy as separate Vercel projects; see [deployment setup](deployment.md).

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
3. Image uploads use the same route with a provider. Printed dimensions and graphical scale bars are extracted with the geometry; Python computes metres per pixel. If printed evidence is absent, several agreeing doors and furniture items can provide a labeled scale estimate. Missing or inconsistent scale evidence opens a measurement tool, which resumes the saved extraction without another provider request. The frontend accepts PNG/JPEG/WebP source files up to 10 MiB and JSON up to 1 MiB. Before upload, the browser corrects orientation, adds a white background, and resizes images to at most 3072 pixels per side. It encodes PNG, falling back to JPEG if needed, within a 3 MiB image budget so the base64 JSON fits Vercel's 4.5 MB request limit. Uploads request an asynchronous job and poll stage progress; images larger than 1092 pixels use the staged extraction pipeline described in [staged extraction](staged-extraction.md). Provider failures leave the current plan in place; geometrically invalid drafts can open for wall/door corrections, while simulations remain strictly validated.
4. Furniture edits remain relative to their polygon bounding boxes. On Run, Python reconstructs those exact polygons in metres and compiles the canonical floor, walls, and doors. It regenerates clear starting positions with the submitted occupancy, seed, distribution, and walking profile, then runs the native engine.
5. Native samples retain their original timestamps and evacuation events. The frontend applies the saved projection to playback, routes, people size, density cells, and scale labels. Failed or incomplete runs retain their actual outcome.

People are drawn using the native collision-body radius and the canvas metre scale, including the original sample. Boundary exits in the original pixel-plan format use the measured gap between exterior wall segments; an unmeasured bare-edge marker retains a 1.4 m default opening. If crowd movement blocks a person's current route near a door jamb, the engine replans locally from their actual position to the same destination instead of retreating to an old waypoint. Short avoidance movements can still occur; this is not an explicit first-in-first-out queue model.

The UI currently supports 1–200 people. Backend files may contain larger populations, but the scenario controls determine the submitted population. Imported manual starts are regenerated for interactive editing; original source files remain untouched. Pinning a native run in the integrated workspace freezes its starting IDs, positions, body radius, and per-person speeds for subsequent layout/exit comparisons. The standalone editor also supports explicit fixed starts.

## Remaining limitations

- Imported native layouts support furniture movement, wall movement and endpoints/thickness, adding/removing walls, sliding interior doors and changing their widths/parent walls, and adding/moving exterior exits. **Check layout** reports compiler issues; **Run** always recompiles the edited canonical geometry. The original pixel-only Berkeley sample retains furniture editing; import an image or backend layout JSON to use structural editing. Individual floor/furniture polygon vertices still require the standalone editor or JSON.
- The processed source image is available as a fixed, correctly projected overlay with adjustable opacity. Printed furniture and door swings remain part of that reference image; turning off the overlay hides them. Source PNGs and extraction/calibration records use private Blob when configured, or the local data directory otherwise. Exported JSON references an image ID; a different backend must share the same artifact store or receive a new upload.
- Automatic calibration prefers explicit lengths and units. With no printed references, a labeled object-size estimate can use at least three agreeing doors/chairs/desks across two types. Conflicting printed references (>8% difference from their median), or weak/conflicting object evidence, fall back to a manual measurement. Estimates retain assumptions and remain marked unconfirmed; simulation explicitly supports that labeled state. **Edit scale** accepts a known two-point length or full image width and retains geometry edits. PDF import and perspective correction are not implemented.
- Auth0 identity is integrated, but personal layouts are still stored in account-scoped local browser storage. They do not sync between devices. Runs and baselines last for the current session.
- Vercel hosts the frontend and Python API as separate projects. The API uses Python 3.12 and a locked runtime dependency set without the unused Qt/VTK desktop packages. Private Blob is required for durable production image artifacts; `/tmp/crowdy` alone is temporary and instance-local. The Dockerfile remains an alternative for Linux x86-64 hosting.
- Native runs execute synchronously with one active simulation per Python process; locks do not coordinate different Vercel instances. The frontend proxy has a 55-second run timeout and a 16 MiB playback-response budget; other JSON responses retain a 4 MiB budget. Individual extraction requests have a 175-second provider budget; synchronous requests retain a 190-second frontend timeout and a 200-second Vercel function duration. Asynchronous imports stop starting new stages after ten minutes, while an already-running request may finish within its provider budget; the browser polls for at most fifteen minutes. Jobs and provider locks are process-local and are lost on restart. When `VERCEL` is set, an `async_import: true` upload falls back to the synchronous path and returns its result or error directly; it never creates a process-local job. Compact imports therefore retain the existing Vercel request lifecycle. Large staged imports can exceed the 190-second frontend timeout or 200-second function duration, so reliable long-running staged imports require a persistent single-process backend, or a durable queue and worker lifecycle for multiple instances. Production extraction also requires provider keys and an available model on the backend.

## Workspace sources and editing

The left sidebar has **Sources** and **Editing** tabs. Sources contains the floor-plan import and scale controls plus venue-image uploads with previews. Editing contains geometry tools and scenario settings. Selecting furniture or geometry opens Editing. Venue images are saved in account- and workspace-scoped browser IndexedDB for personal workspaces; sample workspace uploads remain session-only.

Venue-image crowd estimation is a placeholder: every image and venue area returns **80 people**. Applying the estimate updates scenario occupancy. It does not inspect image contents or call an image-estimation backend. Floor-plan extraction and native simulation use the real backend routes above.

## Validation

From `backend/`: `python -m unittest discover -s tests`, plus the four `node tests/editor_*.test.cjs` scripts listed in the root README.

From `frontend/`: `npm run lint`, `npm run build`, `npm run test:simulation`, `npm run test:backend-simulation`, `npm run test:workspaces`, `npm run test:native-editor`, `npm run test:image-upload`, `npm run test:floorplan-import`, and `npm run test:workspace-sources`. With both services running, run `npm run test:backend-api` and `npm run test:auth`.

The checks include real native evacuation through both geometry formats, edited polygon furniture, calibrated playback, stable seeds, mixed speeds, retained workspace geometry, invalid input recovery, upload request-size budgets, asynchronous import progress/failures, venue-source storage and fixed 80-person estimates, and image extraction using a mocked provider. Storage tests cover private Blob round trips and filesystem fallback. Synthetic Auth0 sessions test the application's session handling; they do not verify the team's actual login/callback configuration. Real image-provider requests are not needed for the integration regression suite.

## Blocked exits and matched comparisons

In Scenario, mark exits unavailable for the entire run. Every exit may be blocked. This removes destinations from routing without adding a physical barricade or simulating a timed closure. Automatic initial placement considers the original floor and all entrances, independent of which exits are blocked; blocking an exit therefore does not regenerate people in more favorable locations.

People with no body-clear route to an available exit at the start are `trapped`: they remain stationary as collision bodies and remain in every recorded frame. Other people continue evacuating. Summary fields separate `trapped_count` and `moving_remaining_count`, with their sum equal to `remaining_count`. `moving_remaining_count` means a person has a route but has not evacuated by the time limit, including waiting in a queue. It does not guarantee nonzero instantaneous velocity.

Status is `completed` if everyone leaves, `trapped` when only trapped people remain, or `timed_out` when routed people remain at the configured limit. An all-trapped run is classified at time zero. Full clearance time is null whenever anyone remains; it is never reported as a successful zero-second evacuation. Trapped is geometric reachability for the configured circular body, not injury, survivability, panic, or a prediction of human decisions. Geometry must still form one connected walkable polygon; disconnected-floor support is not added here.

Run with all exits available, then choose **Pin current run as baseline**. Population controls freeze while exit availability and geometry remain editable. The next request sends `starting_population` (occupants, radius, mobility, distribution, seed) to Python. The backend validates the settings and original positions against the edited geometry; it does not relocate a person who now overlaps furniture. A new image import or layout reset clears the baseline.

The frontend verifies identical starting IDs, positions, per-person speeds and radius before enabling comparison. Playback uses one shared clock. The comparison shows evacuated/trapped/still-moving counts, peak sampled density, per-exit totals, and clearance-time change only when both runs fully evacuate. Export includes both run snapshots and the matched initial population. Starts and baselines remain session-only; saved workspace setup retains exit selections.

The simulation POST scenario accepts `blocked_exit_ids` (unique known exit IDs) and an optional `starting_population`. The native CLI comparison also supports all-exits-blocked cases and reports outcome-count changes.

## Directional people and evacuation modes

The integrated workspace draws shoulder ellipses facing the measured direction of travel. Their lateral semi-axis equals the native collision radius; front/back depth is 0.68 times that radius. The entire ellipse fits inside the circular collision body. Heading is smoothed with turns bounded to 180°/s, retains the previous direction during a stop, and is deterministic when seeking backward or replaying. This is a visual change; collision and route clearance still use circles, with no sideways squeezing or orientation-dependent doorway clearance.

The selector offers **Direct · nearest exit** (base speeds, fixed initial nearest reachable exit) and **Natural · avoids crowded exits** (speed variation and congestion-aware exit switching). Both start immediately. Natural mode compares remaining route travel time plus estimated doorway queue service once per simulated second. Switching requires a meaningful estimated gain, a body-clear alternative route and an available exit. A five-second cooldown, a near-exit commitment zone and a three-switch limit reduce oscillation. These are illustrative assumptions, not calibrated predictions.

Natural speeds use a seeded triangular factor from 0.85–1.15 (mode 1), applied once to the intrinsic speed. Response delay is zero. `Scenario.behaviorMode` persists as `idealized` or `behavioral`; the proxy sends `behavior_mode`, and the placement seed supplies `behavior_seed`.

Results now contain `behavior: {version: 2, mode, seed, agents: [{agent_id, response_delay, speed_factor, desired_speed}]}` and `routing: {version: 1, mode: "fixed" | "adaptive", exit_changes: [...]}`. Each switch records agent, source/destination exit, simulation time and estimated saving. Assignments retain their original route/exit and add `final_exit_id`. Door-crossing and evacuation events use the final exit. The frontend validates switch chains and preserves measured frames. Older version-1 recorded behavior remains readable.

Pin a run, change mode and run again to compare the same people and intrinsic speeds. The model still uses circular collision bodies; directional glyphs do not implement sideways squeezing. See [placement and natural-mode assumptions](room-population.md) for the queue heuristic and limitations.

## Body width and doorway proportions

Interactive runs now default to a **0.46 m body diameter / shoulder width** (radius 0.23 m), replacing the earlier 0.40 m diameter. The Scenario control allows 40–70 cm. `Scenario.bodyWidth` is persisted and forwarded as `EditorSettings.body_width`; the control is frozen when a baseline is pinned. The renderer uses the returned radius, and the adapter checks an explicitly requested width against the response. Changing body width invalidates matched-population reuse rather than silently shrinking or relocating people.

Both pixel and imported-plan runs use the selected radius for native collisions, body-clear routing, placement eligibility, spawn clearance (radius + 5 cm), initial separation (diameter + 5 cm), and the near-door removal strip (radius + 2 cm). Interactive runs override an older imported document's agent-radius default without changing the drawing's metres, furniture, or door widths. New image layouts also default to radius 0.23 m. Standalone/native JSON simulations continue honoring their explicit agent defaults.

The Berkeley sample's exits are **1.75 m wide**, so they legitimately permit people abreast. They are not 90 cm single-door examples. Run overview reports the simulated body width and each boundary exit's actual width, computed from its endpoints; those measurements and compiled target polygons remain separate from decorative exit icons. Imported playback uses the run's compiled removal strips, which can move slightly when body size changes, rather than stale strips from the imported default. These are modeling settings, not calibrated population measurements. An incorrectly estimated drawing scale can still produce incorrect physical doorway widths; review scale evidence when proportions look wrong.

Native regressions compare the same two 46 cm bodies approaching 0.80 m and 0.90 m doorways versus a 1.40 m doorway. The narrow case passes single file, the wide case permits simultaneous passage, and recorded bodies remain non-overlapping. Placement regressions cover both geometry formats and 46/60 cm bodies.

Upload `examples/single_door_room.json` and select 20 people to inspect a measured 90 cm doorway in an 8 m × 6 m room. Larger bodies can lengthen queues or expose deadlocks in the current local-avoidance model. A stress run with 200 people configured at 50 cm width left two people unresolved even after 120 s. Such runs retain their incomplete status rather than reporting successful clearance.

## Starting placement

New imports and workspaces default to **Normal**, using visible chairs and inferred desk/table/couch seating with a small circulating group. **Random** scatters people across walkable space. Building/activity menus have been removed from the main flow. Optional room counts remain behind a disclosure. Both modes use the same backend preview/run placement path. Normal previews expose separate pre-alarm seated poses and body-clear physical standing starts; sit-to-stand motion is not simulated. Legacy activity-weighted room requests remain supported by the API. See [placement controls, extraction safeguards and live interaction limits](room-population.md).
