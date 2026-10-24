# Local layout editor

This development page connects manual layout changes to the Python evacuation model. The main frontend can later reuse the layout compiler without adopting this HTML interface. It does not require AI API keys.

Open the `http://127.0.0.1:...` address printed by the Python server. Opening `editor.html` directly as a `file://` URL cannot load layouts or import JSON, because those operations use backend endpoints. Unlike the exported playback HTML, this editor requires its server to stay running. When opened directly, it shows startup instructions and disables the unavailable controls.

## Try it

1. From `backend/`, activate `.venv` and run `python -m app.simulation.editor`.
2. Open `http://127.0.0.1:8765` in a browser. Leave the terminal running.
3. Select the meeting table and drag it, or change its center coordinates in the inspector.
4. Select `connecting-door`. Drag it along the partition, or change its center distance from the wall start and its opening width.
5. Select `partition`. Drag the wall, or edit its endpoints. Attached doors follow it.
6. Choose **Check layout**. The backend compiles the geometry, checks it, and previews the starting people.
7. Choose **Run simulation**, then **Open animation**. Results come from the existing Python/JuPedSim engine.
8. Export editable JSON before closing if you want to keep unfinished edits. The original example file is never changed.

**Undo** and **Redo** apply to object edits, settings changes, and imports. Use the toolbar to draw furniture rectangles and wall segments directly on the canvas, or click to place a door on the nearest wall or an exit on the nearest boundary. The Add menu selects the corresponding placement tool.

| Tool | Interaction |
| --- | --- |
| Select / Move (`V`) | Drag whole objects. Doors attach to the nearest appropriate wall or boundary edge. |
| Resize (`S`) | Drag a square handle; the opposite corner stays fixed and every vertex scales. Hold Shift to keep proportions. Door handles adjust opening width. |
| Rotate (`R`) | Drag the round handle; Shift snaps to 15-degree steps. Walls rotate with their attached doors. |
| Vertices (`E`) | Edit individual polygon corners or wall endpoints deliberately. |
| Pan (`H`) | Drag the canvas, or hold Space from another tool. Wheel zooms about the pointer. Fit view resets the viewport. |
| Draw furniture (`F`), wall (`W`) | Drag the new shape on the canvas. Escape cancels. |
| Place door (`D`), exit (`X`) | Click near the desired wall or exterior boundary. |

The object list selects small objects without needing a precise canvas click. Layers can be hidden or locked; floors start locked to prevent accidental building edits. Arrow keys nudge by 0.1 m, or 1 m with Shift. Delete/Backspace removes a selected unlocked object. Cmd/Ctrl+D duplicates furniture or a wall and its doors. Cmd/Ctrl+Z undoes, and Shift+Cmd/Ctrl+Z redoes. Viewport pan/zoom does not change geometry or add undo entries. Resize is distinct from vertex editing, so dragging a resize handle cannot accidentally warp only one corner of a table.

## Editable format

`examples/editable_office.json` is the complete working example. Distances are meters; x increases right and y increases up. `schema_version` is currently `1`.

- `walkable_areas`: floor polygons. Select one to resize it or drag its corner handles.
- `furniture`: polygon obstacles, with stable IDs.
- `walls`: a start point, end point, and thickness in meters.
- `doors`: a parent `wall_id`, center distance `offset` measured along that wall, and clear opening `width`, all in meters.
- `exits`: exterior door records with `id`, `floor_id`, zero-based `edge_index`, center distance `offset`, and opening `width`. The compiler places a thin green evacuation strip from `radius + 0.02` to `radius + 0.20` meters beyond the wall. It has the doorway's width with a 1 cm edge inset. Saved `landing_depth`, `outside_space`, and `outside_width` values remain supported for routing-clearance geometry; changing them does not move this strip. Legacy scenario imports retain their explicit polygon destinations.
- `occupants` or `population`: explicit starting people or seeded placement settings, as in the existing scenarios.
- `agent_defaults` and `settings`: the existing movement defaults and time/exit settings.

The editable document carries both layout and run settings for this development workflow. The compiler converts it to the existing `Scenario` format: furniture and solid wall segments become obstacles, and door intervals are omitted from their parent wall. Simulation code continues to consume scenarios, so the old JSON inputs and command-line examples work unchanged.

An exterior door stays attached when its floor edge moves. Its evacuation strip follows the edge's outward normal, including diagonal edges and either outline winding direction. People are generated in their configured original spawn regions, not the added outside landings. Image-derived polygon exit markers from older exports are upgraded on import; no new model request is needed. Older non-image scenario destinations keep their original meaning.

Old scenario imports preserve their simulation inputs exactly. Existing obstacles become furniture. Existing doorway and landing floor polygons stay floor pieces; their role cannot be reliably inferred from those polygons alone. To make a new sliding door, add a wall and attach a door to it.

## Validation and results

Checks reject invalid polygons, walls or furniture outside the floor, missing parent walls, overlapping door intervals, doors beyond wall ends, obstructed door openings, disconnected walking geometry, invalid exit settings, and invalid starting people. Exterior exits must attach to actual exterior edges, fit the configured people's diameter, and have unobstructed landings outside the building that do not overlap other landings. Generated populations are checked for capacity and clearance. Errors describe the object or geometry that needs correction.

Checks also plan a body-clear route for every starting person. Round offsets model the space a circular body needs at wall corners; a visibility graph routes around furniture and excludes gaps too narrow for that body. Runs use look-ahead steering along those routes while retaining JuPedSim's local collision-free speed model. Steering can return to an earlier corner when a neighbor pushes someone away from a previously visible route. **Show planned routes** overlays the checked paths. These routes do not dynamically choose a different exit or model behavioral knowledge/panic.

`door_crossings` records each person's full body leaving the building. `summary.building_clearance_time` is the last crossing when everyone has crossed; it is null for legacy scenarios without boundary metadata or incomplete building evacuation. `summary.clearance_time` is arrival in the immediately adjacent evacuation strip, a small tolerance beyond that body crossing. The run no longer includes walking to a far exterior destination. The editor and playback show the building and doorway strip; internal clearance geometry is not drawn as another hallway. This mode ends the pedestrian simulation at the doorway and does not simulate subsequent outdoor dispersal or downstream crowd buildup.

Doors are always open gaps in this version. Closing an exit makes that destination unavailable but does not insert a barricade. There is no timed door closure or door-swing simulation. Image import and Gemini/Claude extraction are described in [the image guide](image-extraction.md). The editor inherits the simulator's requirement for one connected walkable polygon and the population generator's requirement for one connected spawn polygon.

Changing furniture or walls can change where generated people fit. The same seed repeats placement for unchanged geometry; it does not promise identical positions across edited layouts. Explicit occupants remain fixed and edits that cover them are rejected.

Each run stores four separate files under `backend/data/editor/<run_id>/`:

- `layout.json`: editable input, including the run settings.
- `scenario.json`: compiled simulation input.
- `result.json`: resolved starting positions, frames, departures, and summary metrics.
- `playback.html`: self-contained animation.

The page exposes links to these files for runs created during its current server session. Restarting keeps the files on disk but clears the page's run-link registry. Exported layouts can be imported again. Refreshing the page discards unfinished edits, so export first.

## Local development endpoints

These endpoints belong to the standalone local development server, which binds to `127.0.0.1`. They are not a deployed multi-user API.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/layout` | Load the initial or last successfully simulated layout. |
| POST | `/api/import` | Normalize an editable layout or legacy scenario JSON. |
| POST | `/api/validate` | Compile geometry and preview generated people. |
| POST | `/api/simulate` | Run the simulation and save a new set of snapshots. |
| GET | `/runs/<run_id>/playback` | Open that run's animation. |
| GET | `/runs/<run_id>/layout`, `/scenario`, `/result` | Read a saved input or result. |

Layout POST bodies are JSON documents up to 2 MiB. Validation failures return status 422 and an `error` message. Concurrent simulation requests return 409 while a run is active. Image extraction adds the dependencies and endpoints described in the image guide.
