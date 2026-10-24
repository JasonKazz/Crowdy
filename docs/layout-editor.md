# Local layout editor

This development page connects manual layout changes to the Python evacuation model. The main frontend can later reuse the layout compiler without adopting this HTML interface. It does not require AI API keys.

## Try it

1. From `backend/`, activate `.venv` and run `python -m app.simulation.editor`.
2. Open `http://127.0.0.1:8765` in a browser. Leave the terminal running.
3. Select the meeting table and drag it, or change its center coordinates in the inspector.
4. Select `connecting-door`. Drag it along the partition, or change its center distance from the wall start and its opening width.
5. Select `partition`. Drag the wall, or edit its endpoints. Attached doors follow it.
6. Choose **Check layout**. The backend compiles the geometry, checks it, and previews the starting people.
7. Choose **Run simulation**, then **Open animation**. Results come from the existing Python/JuPedSim engine.
8. Export editable JSON before closing if you want to keep unfinished edits. The original example file is never changed.

**Undo** and **Redo** apply to object edits, settings changes, and imports. Furniture and exit polygons can be resized and rotated in 15-degree steps. The Add menu creates furniture, walls, door openings, or exit zones. New objects start near the middle of the first floor polygon; move them into the desired location before validating.

## Editable format

`examples/editable_office.json` is the complete working example. Distances are meters; x increases right and y increases up. `schema_version` is currently `1`.

- `walkable_areas`: floor polygons. Their outlines are imported from JSON and are read-only in this editor.
- `furniture`: polygon obstacles, with stable IDs.
- `walls`: a start point, end point, and thickness in meters.
- `doors`: a parent `wall_id`, center distance `offset` measured along that wall, and clear opening `width`, all in meters.
- `exits`: polygon destination zones inside the floor where people leave the simulation. Interior doors are openings, not evacuation destinations.
- `occupants` or `population`: explicit starting people or seeded placement settings, as in the existing scenarios.
- `agent_defaults` and `settings`: the existing movement defaults and time/exit settings.

The editable document carries both layout and run settings for this development workflow. The compiler converts it to the existing `Scenario` format: furniture and solid wall segments become obstacles, and door intervals are omitted from their parent wall. Simulation code continues to consume scenarios, so the old JSON inputs and command-line examples work unchanged.

Old scenario imports preserve their simulation inputs exactly. Existing obstacles become furniture. Existing doorway and landing floor polygons stay floor pieces; their role cannot be reliably inferred from those polygons alone. To make a new sliding door, add a wall and attach a door to it.

## Validation and results

Checks reject invalid polygons, walls or furniture outside the floor, missing parent walls, overlapping door intervals, doors beyond wall ends, obstructed door openings, disconnected walking geometry, invalid exit settings, and invalid starting people. Generated populations are checked for capacity and clearance. Errors describe the object or geometry that needs correction.

Doors are always open gaps in this version. Closing an exit makes that destination unavailable but does not insert a barricade. There is no timed door closure, door-swing simulation, image import, or automatic annotation yet. The editor inherits the simulator's requirement for one connected walkable polygon and the population generator's requirement for one connected spawn polygon.

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

POST bodies are JSON documents up to 2 MiB. Validation failures return status 422 and an `error` message. Concurrent simulation requests return 409 while a run is active. No new Python dependencies are required.
