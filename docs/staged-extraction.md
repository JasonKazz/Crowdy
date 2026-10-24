# Staged floor-plan extraction

Large uploads now keep a canonical image up to 3072 pixels on its longest side. Images larger than 1092 pixels use the staged pipeline. Compact images retain the existing single-call path. No new packages or environment variables are required.

1. **Structure:** a common overview establishes the concave building boundary, room labels, major partitions, exterior openings and promising dimension regions.
2. **Scale:** enlarged crops include the complete dimension span and a generous surrounding margin. A reading must explicitly have legible units and two visible endpoints; crop-edge/partial spans are rejected. Existing agreement checks still decide calibration. If the overview misses dimension windows, one independent full-image scale reading is attempted.
3. **Walls and detail:** dedicated overlapping wall-only crops trace partition polylines and their parent-linked door openings independently of furniture. These structural observations replace coarse overview/furniture-pass wall guesses. Overlapping detail crops recover furniture and exterior openings. Dense table layouts get smaller, magnified crops. Straight rows of round tables use a compact observation that expands into individual circular polygons, preserving aisles. Access shading and annotation overlays are classified separately and excluded from physical furniture.
4. **Merge:** observations map back into the same source pixels, including independent Gemini x/y normalization, resizing, crop origins and isotropic wall thickness. Non-overlapping core regions own furniture; overlapping wall fragments and doors retain consistent parent IDs. Geometry omissions are recorded as warnings.
5. **Review:** one independent structure review checks displaced exits, clipped partitions and missing interior openings. Up to four uncertain exterior entrance banks receive local surveys of the perimeter and separate clear door groups. Boundary refinement replaces only a short arc, preserves orientation, and limits area change to 3%. Small wobbles within a verified doorway are straightened so its jambs bound one actual floor edge. Unusable exits are omitted from the editable draft with explicit notes, rather than moved to invented locations.
6. **Image support:** staged wall proposals must follow contrasting neutral linework. Small endpoint corrections are bounded to four source pixels; unsupported proposals are excluded with an explicit coverage warning and retained in raw stage artifacts. Colored annotations and uniform access shading cannot support a wall. Explicit door gaps are excluded from solid-wall pixel checks. When verified walls have no interior doors, a separate doorway-only pass checks their parent IDs and jamb alignment; it does not invent gaps to make rooms connect. This remains a heuristic and can reject faint/occluded real walls.
7. **Validation:** the existing layout compiler checks the converted metric geometry. Its issues remain visible in the editor. A candidate with compiler issues is a draft, not a simulation-ready result.

The website submits an asynchronous import and polls progress, avoiding the old long HTTP request timeout. One job per provider may run at a time; each job makes at most two simultaneous provider calls. There are at most 16 wall crops, 16 furniture crops, two scale crops (or one full-image scale scan), one overview, one structure review, four entrance surveys, and 16 doorway-only reviews. No new stage starts after ten minutes; an already-running provider request may take up to its existing 175-second limit to finish. Failed detail regions prevent a supposedly complete import. A failed scale pass can still lead to the existing measurement tool. Provider transport retry limits and credential/error sanitization remain unchanged.

Jobs are process-local and bounded to 32 results. A backend restart loses polling IDs, while images and stage observations persist on disk. Run one backend worker, as required by the existing process-local provider and simulator locks. This is not a durable distributed job queue.

Imported plans can now contain up to 1200 editable furniture items. Complex body-clear polygons use JuPedSim's navigation mesh instead of constructing an all-pairs visibility graph; small plans retain their existing planner.

## Inspect and reproduce

From `backend/`, using the project's activated Python environment:

```sh
python scripts/evaluate_extraction.py /path/to/floorplan.png --provider claude
```

Add `--env /path/to/.env` when credentials are stored elsewhere. This sends the image to the selected configured provider and incurs its normal usage. Artifacts stay in ignored `data/pipeline-evaluation/`:

- A named result JSON and a source-image overlay (blue boundary/scale, orange walls, cyan doors, pink furniture, green exit observations).
- `extractions/<id>/stages/`: each raw stage response and the image it saw, canonical merged observations and a report with crop transforms, counts, omissions, timing and review outcomes.
- `observations.json`, `context.json`, and the usual `candidate.json` or `error.json`.

The canonical overlay shows all retained image observations. A converted draft can have fewer exits because unusable or duplicate markers are rejected during metric conversion; inspect the candidate warnings as well.

## Supplied venue images: evaluation

Real Claude calls were run against the supplied 2016×1322 `PFA_first_floor.png` and 1500×766 `fine_arts.png`. Both final saved observations were converted again after improving draft exit rejection; that conversion reused the saved responses and made no additional API requests.

| Input | Final converted draft | Calibration | Compiler result |
| --- | --- | --- | --- |
| PFA first floor | 18 wall segments, 0 interior doors, 1 furniture item, 2 exterior openings | Printed dimensions, about 0.11066 m/source pixel | Exit landing crosses another part of the approximate boundary; correction required |
| Fine Arts event layout | 7 wall segments, 0 interior doors, 251 furniture items, 1 exterior opening | Printed 54 ft/28 ft spans, about 0.14085 m/source pixel | Passes geometric checks |

The prior saved one-pass outputs contained zero furniture and zero interior doors for these images, and required manual scale. An intermediate staged Fine Arts run found 281 furniture footprints; the final run above used the stricter classification of access zones versus physical furniture. These counts measure recovered observations, **not recall or accuracy against ground truth**.

Visual review found much better individual round-table recovery, but remaining table-position/count errors, approximate curved outlines, missed openings and missing interior doors. Some observations of gray access areas also need review. Fine Arts passing geometry checks does not make its evacuation output reliable: the missing doors/exits materially affect paths and clearance times. Purple/gray overlays hide source detail that cannot be recovered confidently from that image alone. A base architectural plan registered to the event plan would be useful future work; automatic registration is not implemented here.

A ten-person, 30-second simulation smoke test on the converted Fine Arts draft exercised the dense-plan route/simulation path. It ran in about 0.7 seconds of wall time, evacuated 4 people and retained 6 at the configured simulated horizon; this is not evidence of a complete evacuation or physical accuracy.

A Gemini PFA attempt encountered provider timeouts in two detail regions. It correctly returned an incomplete-import error, so there is no Gemini accuracy comparison for these inputs.

## Entrance and wall regression, October 24

Exterior dispersal polygons are now clipped against the complete building footprint while retaining only the doorway's interior seam. Adjacent doors may share outside space; duplicate threshold openings remain invalid. Removal strips stay immediately outside and must clear nearby walls by a full body radius. Nanometre overlay precision avoids cracks where angled wall seams meet. Door lane selection uses the threshold orientation and remains stable if fitting reorders the target polygon vertices.

The exact saved concave entrance that previously failed now compiles without changing its footprint. Tests also cover a real six-opening surveyed bank, adjacent doors sharing outside space, blocked outside destinations, observed-jamb rounding, and stable routing after target vertex reordering.

A fresh Claude run on the supplied Fine Arts image and a replay of its saved observations with the final deterministic checks produced **26 retained wall segments, 269 furniture items and six exterior openings**. The fresh call did not recover a legible scale; for the geometry/run regression, the already detected printed scale was reused only after verifying that both stored source images were identical. A new import can still require a known measurement. Replay made four additional doorway-only requests, then subsequent geometry checks reused all saved observations without provider calls.

The 118-person, 300-second idealized run evacuated **104**, with **14 still moving at the time limit** and no geometrically trapped people. Interior door verification still returned zero confidently identified jamb pairs. Visual inspection still finds missing/obscured partitions and approximate outlines; these results must not be interpreted as complete architectural recognition or validated evacuation times. The importer exposes its uncertainty rather than inventing doors or deleting disconnected rooms to force a pass.

A fresh compact import of the original office image recovered four walls, three interior doors, 33 furniture items and the left Welcome exit, with no compiler issues. Its automatic object-scale estimate allowed a full **80/80 evacuation in 58.64 simulated seconds**. Compact images keep their existing extraction path; the staged pixel-support heuristic is not applied to them.

The Next.js proxy permits simulation responses up to 16 MiB (other JSON responses retain their 4 MiB limit). This fixes the supplied venue run being rejected after successful backend execution without discarding trajectory samples or changing physical results. Larger recorded runs can still exceed this bounded transfer limit.
