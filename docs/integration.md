# Frontend and backend integration

The Next.js workspace uses the native JuPedSim service for body-clear routing and near-door evacuation strips. Per-person walking speeds, editable geometry, and layout scale pass through the same bridge. The frontend runs on Vercel and the persistent backend runs on Azure Container Apps; see [deployment setup](deployment.md).

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

Set backend `AI_GATEWAY_API_KEY` to enable both Gemini and Claude through Vercel
AI Gateway. It takes precedence over native `GEMINI_API_KEY` / `ANTHROPIC_API_KEY`.
Gateway model overrides use `AI_GATEWAY_GEMINI_MODEL` /
`AI_GATEWAY_ANTHROPIC_MODEL`; native model settings retain their existing names.
See [image provider setup](image-extraction.md) and the placeholder `.env.example`.

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
3. Image uploads use the same route with a provider. Printed dimensions and graphical scale bars are extracted with the geometry; Python computes metres per pixel. If printed evidence is absent, several agreeing doors and furniture items can provide a labeled scale estimate. Missing or inconsistent scale evidence opens a measurement tool, which resumes the saved extraction without another provider request. The frontend accepts PNG/JPEG/WebP source files up to 10 MiB and JSON up to 1 MiB. Before upload, the browser corrects orientation, adds a white background, and resizes images to at most 3072 pixels per side. It encodes PNG, falling back to JPEG if needed, within a 3 MiB image budget so the base64 JSON fits Vercel's 4.5 MB request limit. Uploads request an asynchronous job and poll progress. Interactive imports read the whole image, with one structural check when exits or partitions are missing. Misaligned interior door observations can request up to two focused parent-wall reviews. Gemini imports can use a configured Claude model for this narrow check; progress and import notes identify the secondary provider. Door gaps reference adjacent surveyed wall vertices, and proposed solid fragments must have continuous source-image linework before replacing the inconsistent parent. Missing, incomplete, or poorly attached exterior openings trigger up to six closer views of the actual perimeter. All reviews share the same extraction deadline. Verified jambs can refine a coarse curved outline; unsupported openings remain explicit review notes. Image size alone does not start a tiled multi-pass import; [diagnostic staged extraction](staged-extraction.md) is an explicit server opt-in for offline evaluation. Provider failures leave the current plan in place; geometrically invalid drafts can open for wall/door corrections, while simulations remain strictly validated.
4. Furniture edits remain relative to their polygon bounding boxes. On Run, Python reconstructs those exact polygons in metres and compiles the canonical floor, walls, and doors. It regenerates clear starting positions with the submitted occupancy, seed, distribution, and walking profile, then runs the native engine.
5. Native samples retain their original timestamps and evacuation events. The frontend applies the saved projection to playback, routes, people size, density cells, and scale labels. Failed or incomplete runs retain their actual outcome.

For the POFA presentation, choose **Replace floor plan → Load verified POFA demo**. It opens the saved JSON with 15 mapped exits, the saved 100 m demo measurement, and a fixed 24-person scenario without calling an image model. Uploading the original POFA PNG also selects this saved layout by its exact SHA-256 content hash; filenames and similar images cannot trigger the substitution. The source overlay uses the shared private artifact store. This is a verified simulation fixture, not a surveyed building measurement; **Edit scale** remains available. Other image uploads use AI extraction and retain review requirements when the source is unclear.

Initial image observations represent interior doors as adjacent vertices of their parent wall run, then expand into the existing canonical wall/door format. This prevents independently rounded jamb coordinates from drifting off their parent line. Unresolved legacy observations are rejected before asking for a scale measurement. Exterior overlap checks compare the actual finite jamb spans, allowing neighboring angled openings to share a jamb while rejecting overlapping openings.

People are drawn using the native collision-body radius and the canvas metre scale, including the original sample. Boundary exits in the original pixel-plan format use the measured gap between exterior wall segments; an unmeasured bare-edge marker retains a 1.4 m default opening. If crowd movement blocks a person's current route near a door jamb, the engine replans locally from their actual position to the same destination instead of retreating to an old waypoint. Short avoidance movements can still occur; this is not an explicit first-in-first-out queue model.

The UI currently supports 1–200 people. Backend files may contain larger populations, but the scenario controls determine the submitted population. Imported manual starts are regenerated for interactive editing; original source files remain untouched. Pinning a native run in the integrated workspace freezes its starting IDs, positions, body radius, and per-person speeds for subsequent layout/exit comparisons. The standalone editor also supports explicit fixed starts.

## Remaining limitations

- Imported native layouts support furniture movement, wall movement and endpoints/thickness, adding/removing walls, sliding interior doors and changing their widths/parent walls, and adding/moving exterior exits. **Check layout** reports compiler issues; **Run** always recompiles the edited canonical geometry. The original pixel-only Berkeley sample retains furniture editing; import an image or backend layout JSON to use structural editing. Individual floor/furniture polygon vertices still require the standalone editor or JSON.
- The processed source image is available as a fixed, correctly projected overlay with adjustable opacity. Printed furniture and door swings remain part of that reference image; turning off the overlay hides them. Source PNGs and extraction/calibration records use private Blob when configured, or the local data directory otherwise. Exported JSON references an image ID; a different backend must share the same artifact store or receive a new upload.
- Automatic calibration prefers explicit lengths and units. With no printed references, a labeled object-size estimate can use at least three agreeing doors/chairs/desks across two types. Conflicting printed references (>8% difference from their median), or weak/conflicting object evidence, fall back to a manual measurement. Estimates retain assumptions and remain marked unconfirmed; simulation explicitly supports that labeled state. **Edit scale** accepts a known two-point length or full image width and retains geometry edits. It previews the resulting full image dimensions and rejects incomplete, out-of-bounds, or coincident measurements. Scaling changes physical distances while the drawing stays fitted to the canvas. PDF import and perspective correction are not implemented.
- Auth0 identity authorizes personal workspace and source requests through the Next.js server. Layouts, native drafts, scenarios, and uploaded sources persist in private Azure Blob Storage and reopen on other devices for the same account. Runs and baselines last for the current session.
- Vercel hosts the frontend; Azure Container Apps runs the Python 3.12 Docker image with one replica. Managed identity authorizes private Azure Blob Storage for workspaces and image artifacts. Local filesystem storage is available only when Azure is not configured.
- Native runs execute synchronously with one active simulation per Python process; locks do not coordinate different backend replicas. The frontend proxy has a 55-second run timeout and a 16 MiB playback-response budget; other JSON responses retain a 4 MiB budget. Interactive provider requests have a 75-second cap and share an 85-second extraction deadline, including the optional structural check, exterior detail review, and retries. The API starts its 90-second worker budget before image decoding/storage and rejects late results. The frontend proxy allows 105 seconds, its Vercel function allows 110 seconds, and the browser shares a 110-second limit across image preparation, upload, response reads and polling. Provider timeouts cancel and close the actual HTTP stream before releasing the slot. Jobs and provider locks are process-local and are lost on restart. With `VERCEL` set, asynchronous uploads finish synchronously within the same limits rather than creating a process-local job. Production extraction requires configured provider access. Returned geometry remains a draft for source-image review; compiler checks still gate simulation.

## Workspace sources and editing

The left sidebar has **Sources** and **Editing** tabs. Sources contains the floor-plan import and scale controls plus venue-image uploads with previews. Editing contains geometry tools and scenario settings. Selecting furniture or geometry opens Editing. Venue images are saved in account- and workspace-scoped private Azure blobs for personal workspaces; sample workspace uploads remain session-only. Existing account-scoped browser records and IndexedDB images migrate after sign-in, keeping unacknowledged originals for recovery.

Venue-image uploads call the independent Ultralytics YOLO service through `POST /api/crowd-estimates`, which forwards one prepared multipart image to `POST /v1/estimates`. Configure `CROWDY_CROWD_ESTIMATION_URL` and `CROWDY_CROWD_ESTIMATION_TOKEN` on Next.js; the token must match the separate service. See [service setup and contract](../services/crowd-estimation/README.md). Uploads estimate all current views and apply the largest individual count when every estimate succeeds and the result is between 1 and 200. Multiple views are never summed. Zero and larger counts remain visible for review; failures retain uploaded images and current occupancy. Saved images can be estimated again. Counts include detected visible people, so small or occluded people may be missed.

### iPhone live camera

Choose **Connect live camera** under Venue images, scan the QR code with the iPhone's camera, and open the link in Safari. Tap **Start camera** and allow camera access. The rear camera opens inline with no microphone. Keep Safari visible; switching apps or locking the phone pauses capture and releases the camera. **Resume camera** starts it again. **End feed** in the desktop workspace revokes the connection; the phone stops after its next request. A connection expires after 30 minutes or when the estimator restarts. No sign-in on the phone is needed; keep its private camera link private.

The frontend must have an **HTTPS address reachable by both devices**. A QR code containing desktop `localhost` points to the phone itself. For local development, start the estimator as described in its README, set the server-only frontend URL/token to match it, and expose the Next.js development server using an HTTPS tunnel. Open that same HTTPS frontend address on the desktop before creating the connection. Set `APP_BASE_URL` to that frontend address if using account sign-in and register the corresponding Auth0 callback/logout URLs. Ordinary HTTP LAN addresses cannot request the iPhone camera. A deployed HTTPS frontend avoids this local networking step; deploy both the new frontend and estimator image to enable the feature.

The phone sends JPEG frames with a maximum 1280-pixel edge and one request at a time. It waits two seconds after each response before sampling again, slowing down when inference or networking is busy. The desktop polls the independent service through `/api/live-crowd` every two seconds. The latest frame appears in a small preview. These are sampled camera updates, not continuous video playback or a saved recording; no audio is captured. The service retains only the latest bounded preview and estimate in memory. Sessions use separate viewer and camera capabilities; the service bearer token stays on the Next.js server. The camera capability stays in the URL fragment and request headers, not query strings.

Starting occupancy uses the median of the latest three received frames, or the available frames at startup. Counts are never summed across time or combined with venue photos. Automatic updates can be turned off. Fresh counts in the 1–200 range apply only in Layout while the workspace is idle and no baseline is pinned. Zero, above-limit, paused, failed, and stale estimates keep the previous occupancy. After 12 seconds without a fresh frame the UI marks the feed interrupted. Returning to Layout or clearing a baseline permits fresh updates again. Live sessions and frames are not saved with the workspace; the applied scenario occupancy follows the existing workspace saving behavior.

Run the estimator with **one process and one warm replica**. Terraform enforces minimum and maximum replicas of one; multiple replicas need shared session storage first. Current sessions are lost on restart/redeployment, so reconnect after either. There are at most 16 concurrent sessions. See [session API and lifecycle](../services/crowd-estimation/README.md#live-camera-sessions).

## Validation

From `backend/`: `python -m unittest discover -s tests`, plus the four `node tests/editor_*.test.cjs` scripts listed in the root README.

From `frontend/`: `npm run lint`, `npm run build`, `npm run test:simulation`, `npm run test:backend-simulation`, `npm run test:workspaces`, `npm run test:native-editor`, `npm run test:image-upload`, `npm run test:floorplan-import`, `npm run test:scale-calibration`, and `npm run test:workspace-sources`. With both services running, run `npm run test:backend-api` and `npm run test:auth`.

The backend entrance-review regressions replay recorded POFA observations through import, manual calibration, placement of 24 people, and real JuPedSim evacuation. Source-image endpoint rounding is clipped only within half a source pixel, 2 cm, and a quarter wall thickness; larger overshoots and interior boundary crossings still require correction.

The checks include real native evacuation through both geometry formats, edited polygon furniture, calibrated playback, stable seeds, mixed speeds, retained workspace geometry, invalid input recovery, upload request-size budgets, asynchronous import progress/failures, cloud workspace/source persistence, legacy migration, validated crowd-estimation responses and failure handling, and image extraction using a mocked provider. Run `npm run test:crowd-estimates`, `npm run test:live-crowd`, and `npm run test:live-camera` in `frontend/`, plus the service's separate Python test suite for still/live HTTP contracts, token separation, expiry, and pause/delete races. Storage tests cover private Blob round trips and filesystem fallback. Synthetic Auth0 sessions test the application's session handling; they do not verify the team's actual login/callback configuration. Real image-provider requests are not needed for the integration regression suite.

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
