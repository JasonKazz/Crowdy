# Starting placement and evacuation choices

Choose **Normal** for people at chairs, desks, meeting tables and couches, with a small circulating group. Choose **Random** to scatter people across clear, reachable floor space. Total occupancy and seed remain adjustable. Building/activity menus are no longer required. Legacy `rooms` and `workstations` API distributions remain supported, but the UI migrates those saved choices to Normal.

## Normal placement

Visible individual chairs supply observed seat anchors. Desks, tables and couches supply inferred seating positions when chairs are absent; these assumptions are disclosed in the UI. The built-in sample uses the chair locations drawn by its renderer and the fronts of its couches. Usable desk positions are prioritized before additional furniture seats. Seat candidates must have a clear standing position connected to a physical exit, maintain the configured body clearance and respect optional room counts.

The default target is 90% seated/at desks and 10% circulating for crowds of at least five. This is an editable scene assumption, not a measured occupancy estimate. If there are too few usable seats, remaining occupants circulate and a warning reports the shortage. The algorithm does not invent more chairs to fill the crowd. Reduce occupancy or correct missing furniture for a mostly seated scene. Individual small chairs are treated as movable seating rather than fixed obstacles; tables, couches, grouped seating blocks and other large barriers remain solid. This simplification applies to both evacuation modes.

**The layout preview shows pre-alarm seated poses. Run begins at adjacent clear standing positions. Sit-to-stand motion is not simulated.** The preview API returns these physical standing starts as `occupants`, plus separate `normal_placements` display poses. The same plan/settings give exactly the same preview occupants and initial native run occupants.

Room labels/types and automatic room zoning remain available. Expand **Adjust room counts (optional)** to change a room count or type. Fixed counts reserve that room's share of total occupancy; automatic placements use the remaining share. A physically full/unreachable fixed room produces a specific error rather than moving its people into another room. Room type changes label metadata in Normal mode; they do not impose activity weighting.

`POST /api/populations` proxies to `POST /api/populations/preview`. Use `scenario.distribution: "normal"` or `"uniform"` (Random). Optional `population_config.room_counts` and `room_types` use room IDs. The old activity settings remain accepted only for legacy room-weighted requests. Both current UI modes use the backend for placement previews, with debounce, cancellation and stale-response guards. Saved baselines retain their exact physical starting people.

## Evacuation modes

**Direct · nearest exit** starts immediately at base walking speeds and retains each person's initially nearest reachable exit. It is not a globally optimal evacuation solver.

**Natural · avoids crowded exits** starts immediately, varies intrinsic walking speeds by an illustrative ±15%, and reconsiders exits once per simulation second. It estimates route travel time plus doorway queue service time. People consider switching when at least three other assigned occupants are near their doorway; an alternative must save at least 1.5 estimated seconds and 20% of estimated remaining time. People within one metre of their chosen exit or already outside its threshold keep that exit. A five-second cooldown and three-switch limit reduce back-and-forth choices. Alternatives must have a body-clear route and cannot be blocked exits. Native JuPedSim still determines every movement and collision.

The native response records initial route assignments, final exit IDs and timestamped congestion switches. Frontend validation checks the switch chain, closures and cooldown; playback preserves the measured native frames. The results show how many people changed exits. These queue estimates are illustrative, not calibrated predictions of human decision-making, and need not improve every run.

**Sideways squeezing is not implemented.** Directional ellipses are a visual representation. JuPedSim's current collision-free-speed model and Crowdy's route clearance still use a circular body with a default 46 cm diameter. A physically narrower sideways posture requires independently oriented body geometry, collision checks and routing through narrow gaps; shrinking a radius or rotating only the drawing would not implement it.

## Extraction and scale

Image observations retain furniture labels so desks, tables, sofas and clear individual chairs can be classified for seating. Native geometry stays authoritative in metres. Chairs omitted or merged by vision cannot be treated as verified observed seats. Furniture-edge seats and room-use labels remain reviewable assumptions; this change does not establish an image extraction accuracy benchmark. Scale still follows the existing detected/estimated/manual calibration flow.

The earlier bounded door-jamb correction remains: an interior opening may narrow at a known neighboring wall face by at most two processed-image pixels and 5% of width per jamb. It does not remove walls or clear furniture obstructions.

## Live interaction limits

Editing furniture, walls, counts or seed updates the initial placement preview. Run computes a full native trajectory for playback. Edits during playback do not enter that recorded simulation. True live edits still require a persistent simulation session and command stream.

## Validation

Run `python -m unittest discover -s tests -v` from `backend/`. The Normal placement tests check renderer seat anchors, observed chair labels, solid major furniture, body-clear standing starts, exact preview/run occupants, count reservations, repeatability and overflow warnings. The congestion fixture uses a 0.8 m west doorway and a second east exit; tests verify actual exit switches, event consistency, cooldown, closure handling, bounded displacement, body separation and geometry clearance.

Frontend checks include `npm run test:room-population`, `test:backend-simulation`, `test:workspaces`, TypeScript, ESLint and real HTTP proxy checks. The browser sample uses 24 people so Normal placement can be mostly seated. Import `examples/room_aware_office.json` to test a separate two-room native layout.
