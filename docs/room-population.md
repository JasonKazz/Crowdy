# Room-aware population placement

Import a floor plan, keep **Rooms & activity · automatic**, and run. Building type and activity default to Auto. The extraction keeps readable room labels and semantic room polygons. Small/compact plans infer room use locally from those labels; their geometry response deliberately stays within Claude's structured-output grammar budget. The staged global structure pass can also return `building_type` and `room_classifications` (`room_type:room_id` strings on the provider wire). Unknown uses stay editable.

The backend clips room observations to the floor, gives overlapping polygons deterministic ownership, and limits room zones to known physical partitions. Complete wall centerlines, with their known door cuts temporarily closed for zoning only, can recover enclosed spaces omitted by vision. Remaining floor is shown as Other/open space. This does not add walls, invent doors, or establish that extraction matches the image. The compact and staged prompts now explicitly inventory all room labels and inspect each room for visible interior door openings. Missing door geometry still needs correction. A detected interior opening can be narrowed at a known adjacent wall face by at most two processed-image pixels per jamb (and 5% of its width per jamb). This only corrects endpoint roundoff; it never removes walls or clears furniture/middle-of-opening obstructions. The correction is recorded for review.

## Controls

**Building type** is an optional override: automatic, office, school, venue, residential, or other. **Time / activity** supports automatic selection, workday, meeting time, lunch/break, during class, between classes, assembly, event, residential daytime and residential evening. These are illustrative activity weights, not clock-based schedules or measured occupancies. The detected building picks a default activity. Selecting another activity weights usable room area by room use; it does not infer total building occupancy.

Set total occupancy (1–200), then optionally edit each room's type or people count. A changed room count is fixed; the remaining people are apportioned among automatic rooms. Zero is a valid fixed count. Auto beside a fixed room releases that override. Reset rooms clears count and type overrides. If fixed counts exceed the current total, the UI raises the total, up to the 200-person limit. Direct API requests with counts above total are rejected. If every usable room is fixed, fixed counts must equal total. No person is silently moved from a full fixed room into another room.

Unknown room types and room-use guesses remain visible. Rooms with no body-clear route to any physical exit receive no automatically placed occupants and produce a review warning. Blocking exits for a scenario does not affect this initial physical reachability check or reshuffle the crowd. An all-blocked scenario can therefore trap the same starting people. A room count on unusable space fails with a room-specific error.

## One placement path

`POST /api/populations` forwards to `POST /api/populations/preview`. It accepts the same plan/scenario as Run and returns explicit occupants, radius, and room summaries/rings/counts. The same `editor_to_scenario` placement path supplies Run. Seed, geometry, body width, room configuration and total occupancy therefore produce identical preview and initial run positions. Furniture and wall edits are included. The browser debounces changes and cancels obsolete preview requests; stale positions are hidden rather than displayed on changed geometry.

The Python API's scenario adds `distribution: "rooms"` and optional `population_config`:

```json
{
  "building_type": "auto",
  "activity": "lunch",
  "room_counts": {"meeting-room": 12},
  "room_types": {"meeting-room": "meeting"}
}
```

The frontend stores equivalent camelCase `scenario.population` fields. Semantic rooms and placement settings persist in account-scoped browser workspaces and JSON exports. Existing workspaces without these fields retain their original uniform/workstation setting. New imports and new workspaces default to rooms. Matched comparisons freeze room configuration along with the starting people; changing activity/counts requires clearing the baseline.

## Real-time limits

Placement previews update without running an evacuation. At Run, the backend computes a complete trajectory and returns it for playback. Changes to walls, furniture or exits during playback are not injected into that recorded run. Streaming simulation would need a persistent session, timed commands, route updates when an exit changes, safe handling of an obstacle moved onto a person, and a WebSocket/SSE connection. This change does not implement that session lifecycle or larger-population scaling.

## Checks

- Backend: `python -m unittest discover -s tests -v`.
- Frontend contracts: `npm run test:room-population` and `npm run test:workspaces`.
- Both local services: `ROOM_POPULATION_HTTP=1 npm run test:room-population` checks real JSON import, workday/lunch redistribution, count overrides, closure stability and exact preview/run starting positions.
- Import `examples/room_aware_office.json` for a measured two-room example. Compare Workday and Lunch, set a fixed room count, then run.

The live Claude office-image smoke check recovered eight labeled activity regions. Its scale evidence conflicted, so it correctly requested a measurement rather than silently accepting an estimate. A separate geometry/placement smoke check used an explicitly assumed 20 m image width; this is not a verified measurement or extraction-accuracy benchmark.
