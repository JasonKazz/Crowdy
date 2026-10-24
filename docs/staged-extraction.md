# Staged floor-plan extraction

Large uploads now keep a canonical image up to 3072 pixels on its longest side. Images larger than 1092 pixels use the staged pipeline. Compact images retain the existing single-call path. No new packages or environment variables are required.

1. **Structure:** a common overview establishes the concave building boundary, room labels, major partitions, exterior openings and promising dimension regions.
2. **Scale:** enlarged crops include the complete dimension span and a generous surrounding margin. A reading must explicitly have legible units and two visible endpoints; crop-edge/partial spans are rejected. Existing agreement checks still decide calibration.
3. **Detail:** overlapping native-resolution crops recover furniture, partitions and openings. Dense table layouts get smaller, magnified crops. Straight rows of round tables use a compact observation that expands into individual circular polygons, preserving aisles. Access shading and annotation overlays are classified separately and excluded from physical furniture.
4. **Merge:** observations map back into the same source pixels, including independent Gemini x/y normalization, resizing, crop origins and isotropic wall thickness. Non-overlapping core regions own furniture; overlapping wall fragments and doors retain consistent parent IDs. Geometry omissions are recorded as warnings.
5. **Review:** one independent structure review checks displaced exits, clipped partitions and missing interior openings. Up to four uncertain exterior openings receive a local image pass. Boundary refinement requires observed door jambs and a small, valid polygon change. Unusable exits are omitted from the editable draft with explicit notes, rather than moved to invented locations.
6. **Validation:** the existing layout compiler checks the converted metric geometry. Its issues remain visible in the editor. A candidate with compiler issues is a draft, not a simulation-ready result.

The website submits an asynchronous import and polls progress, avoiding the old long HTTP request timeout. One job per provider may run at a time; each job makes at most two simultaneous provider calls. There are at most 16 detail crops, two scale crops, one overview, one structure review and four exit reviews. No new stage starts after ten minutes; an already-running provider request may take up to its existing 175-second limit to finish. Failed detail regions prevent a supposedly complete import. A failed scale pass can still lead to the existing measurement tool. Provider transport retry limits and credential/error sanitization remain unchanged.

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
