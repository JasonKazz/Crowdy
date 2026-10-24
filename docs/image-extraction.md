# Image-to-layout workflow

This feature starts from a PNG, JPEG, or WebP floor-plan image and produces the same editable geometry consumed by the Python simulator. It supports one selected provider or a comparison of Gemini and Claude. JSON imports and existing simulation commands continue to work.

## Setup

From `backend/`, activate `.venv` and install `requirements.txt`. Pillow decodes/resizes images, python-dotenv loads local configuration, and HTTPX handles provider requests. Vercel uses the locked API environment in `pyproject.toml` and `uv.lock`; see [deployment setup](deployment.md).

Keep real credentials in the repository root `.env`, which Git ignores:

```dotenv
AI_GATEWAY_API_KEY=replace_locally
# Optional Gateway model overrides; these are the service defaults.
AI_GATEWAY_GEMINI_MODEL=google/gemini-3.8-flash
AI_GATEWAY_ANTHROPIC_MODEL=anthropic/claude-sonnet-5.5
```

One Vercel AI Gateway key enables both extraction buttons and comparison. When
`AI_GATEWAY_API_KEY` is configured, it takes precedence over native provider keys
and uses the fixed OpenAI-compatible
`https://ai-gateway.vercel.sh/v1/chat/completions` endpoint. No endpoint override is
supported. Choose models with image and structured-output support available to
your Gateway account.

For direct access instead, omit the Gateway key and set `GEMINI_API_KEY` and/or
`ANTHROPIC_API_KEY`. `CLAUDE_API_KEY` remains an alias when `ANTHROPIC_API_KEY` is
absent. One native key enables its extraction button; direct comparison requires
both native keys. Native `GEMINI_MODEL` / `ANTHROPIC_MODEL` settings are independent
of the Gateway model overrides above.

`.env.example` must contain placeholders only. Existing environment variables
take precedence. Restart locally after changing keys or model names. In Azure,
pass the Gateway key through Terraform's sensitive `ai_gateway_api_key` variable
and redeploy the backend. Keys stay in server request headers and are not sent to
the browser, saved in artifacts, or included in upstream error messages. The
frontend never needs a provider key.

Run `python -m app.simulation.editor` and open its printed `http://127.0.0.1:...` address. `--env-file /absolute/path/to/.env` selects another local configuration file. Opening `editor.html` directly cannot use these endpoints.

## Use it

### Main website

Choose **Upload floor plan**, pick a provider, and upload the image. There is no up-front scale field. The model returns explicit dimension/scale-bar observations (endpoints, value, units, visible label); Python validates bounds, converts units, checks agreement, and uses the longest agreeing reference. When no printed references are returned, the backend tries an object-size estimate. Short/unreadable or conflicting printed evidence still opens the measurement tool; it is never silently overridden by an object guess. Insufficient or conflicting objects also open that tool. Mark two endpoints and enter the distance in metres, centimetres, millimetres, feet, or inches. The saved extraction is reused, without another model request.

Source files may be PNG/JPEG/WebP up to 10 MiB and 30 million pixels. Before sending, the browser corrects orientation, adds a white background, and resizes to at most 3072 pixels per side. It uses PNG when possible, then JPEG if needed, within a 3 MiB encoded-image budget so the base64 JSON fits Vercel's 4.5 MB request limit. A file that cannot fit is rejected before upload. The backend stores the resulting processed image as PNG.

Interactive extraction sends the full canonical image once, using low reasoning effort on the supported default Gemini 3.8 Flash and Claude Sonnet 5.5 models. If exits are absent or rooms have no partitions, one additional whole-frame structural check is allowed within the same deadline. The importer does not launch wall/furniture tile batches based on image size. Provider calls have a 75-second cap and share an 85-second extraction budget; the API checks a 90-second import budget and the browser limits preparation, upload and polling to 110 seconds. Timeouts leave the current layout unchanged. Model IDs are visible in the provider selector. All returned geometry still needs visual review; observations are never invented to satisfy a structural count.

The plan shows the calibration evidence beside its scale. **Estimated scale** marks object-based estimates, with a note beside simulation results as well. **Edit scale** accepts either a two-point known measurement or the full source-image width in meters (including image margins), without another provider request or loss of furniture/structural edits. Entering a manual value replaces the estimate and removes its badge. Agent size and walking speed remain physical simulation settings when the drawing scale changes.

#### Object-size fallback

The model classifies existing object IDs into `single_door`, `office_chair`, or `office_desk` in `scale_objects`; it does not invent real-world dimensions. Provider responses use compact `kind:object_id` strings to stay within Claude’s grammar-compilation budget. The adapter restores `{kind, object_id}` records and validates their types before saving observations; malformed categories are rejected. Python measures door openings and the longest side of each furniture footprint’s minimum rotated rectangle in processed image pixels. It uses these **prototype assumptions**, not universal standards:

| Object | Nominal size | Assumed size range |
| --- | --- | --- |
| Single-leaf door clear opening | 0.90 m | 0.75–1.05 m |
| Individual office chair, longest full-footprint dimension | 0.60 m | 0.45–0.75 m |
| Individual rectangular office desk, longest side | 1.40 m | 1.00–1.80 m |

At least three distinct objects across two types are required. When the model already selects at least two usable furniture references, generic furniture labels do not add extra scale anchors; an unusually sized desk can remain a barrier without overriding those selected references. If the model omits classifier entries, a second local pass can recover unambiguous individual desk/task-chair labels from the furniture it already extracted. With at least two agreeing furniture anchors (within 20% of their median), interior openings can supply a missing door type when adding them passes the same category-balanced consensus and overlapping-range checks as the final estimate. There is no separate doorway-versus-furniture cutoff. Wide double openings are excluded by that size-consistency check; an inferred single-door type remains an assumption, not a verified leaf count. Existing contradictory model classifications are retained rather than discarded. The saved per-object `origin` distinguishes `model` classifications from `geometry` inference. This pass reuses the same observations without another provider request. Unknown IDs, duplicate IDs/geometry, out-of-image/tiny spans, invalid polygons, and implausibly elongated furniture are ignored. Each category receives equal weight through its median implied scale, preventing repeated chairs from outvoting doors. All implied scales must be within 25% of the category-balanced estimate, and their assumed scale ranges must overlap. The estimate is clamped to that overlap and checked again. Otherwise, a known measurement is required. These are heuristic consistency checks, not calibrated confidence probabilities: repeated symbols can agree and still be drawn at the wrong size. Double doors, conference tables, counters, and grouped workstations are excluded by the extraction instructions.

The saved source records `calibration.method="estimated"`, each object ID, observed pixel span, assumed length, and the intersected `meters_per_pixel_range`. That range describes compatible size assumptions, **not an accuracy guarantee or confidence interval**. `scale_confirmed` stays false; the compiler explicitly allows an estimated calibration with its recorded evidence. Uncalibrated image frames still cannot run. JSON exports preserve this provenance, including the plan attached to a completed run. Existing saved observations without `scale_objects` remain compatible and require a manual measurement when no printed scale exists.

For imported layouts, **Walls & doors** provides Select, Draw wall, Add door, and Add exit tools. Draw a wall with two clicks (Shift constrains it to an axis); nearby existing endpoints snap together. Drag a wall, its endpoint handles, an interior door along its parent, or an exterior exit onto a boundary edge. Selection exposes metric coordinates, thickness, door width/offset/parent, and exit width/offset. Removing a wall also removes its attached doors. Undo restores the previous layout.

The **Source image overlay** is the original processed image at the exact image-to-world-to-canvas transform. It never moves with edited furniture or doors. Reduce opacity or switch it off to inspect clean geometry. **Check layout** reports issues without destroying the draft; invalid layouts cannot simulate. The standalone editor still supports individual polygon vertex editing.

### Standalone backend editor

1. Upload an image up to 10 MiB. PDF input is not supported yet; export one page as PNG or JPEG first. Images above 30 million pixels are rejected.
2. Enter a known real-world length, select **Mark two points to set scale**, and click its endpoints. Use a printed dimension or a distance you know; the model does not invent a building scale.
3. Choose Gemini or Claude and **Extract layout**. **Compare both models** extracts sequentially with both providers against exactly the same processed image. Transient HTTP failures (408, 429, 500, 502, 503, 504, 529) get up to two retries with exponential backoff and jitter, within a 75-second provider cap and the shared extraction deadline. Numeric `Retry-After` headers are honored when they fit in the budget. Invalid-key, access, and malformed-request errors are not retried. Network timeouts are not retried because the POST might already have been processed. There is no hidden fallback to the other provider. For a first test, `examples/sample_floorplan.png` has an 18-meter dimension marked along its top edge.
4. For a comparison, choose **Use Gemini layout** or **Use Claude layout** to inspect that candidate. The cards show model names, wall/door/furniture counts, time, model notes, and geometry issues. These are observations and checks, not an accuracy score.
5. Edit the clean geometry view. **Compare with original image (fixed reference)** shows the source pixels for alignment checks; printed tables, door swings, and walls cannot move with the editable objects. The reference hides when you edit to avoid leaving apparent duplicates behind. Correct furniture, wall endpoints, door offsets/widths, exterior exits, or polygon corners. Unrecognized exits remain empty; add exterior exit doors manually.
6. Check the layout, set population/settings, and run. Image-derived layouts require a confirmed scale or an explicit estimated calibration, and a selected extraction, before simulation. Normal geometry and population checks still apply.

Uploading only displays an image-frame rectangle. This is not an inferred room, and cannot be simulated as if extraction had succeeded. Model observations may also produce a draft with disconnected rooms or a misplaced door; the draft stays editable and the check explains the problem. No general-purpose snapping or connection repair silently changes its topology.

## Coordinates and geometry

Uploads are EXIF-corrected and composited onto white. Compact images use one provider frame; large images retain a canonical frame up to 3072 pixels and use overview/detail crops capped at 1092 pixels per side. Crop observations are mapped back into the canonical source frame.

The provider-neutral observation schema records the interior floor outline, labeled room polygons, furniture polygons, wall centerlines with thickness, interior door endpoints and parent wall IDs, exterior exit zones, and ambiguity notes. Gemini is prompted for independently normalized 0–1000 axes and thickness in thousandths of the shorter image dimension. Claude is prompted for absolute pixels and thickness in pixels. The converter then scales to meters and flips image y-down into simulation y-up. Door endpoints are projected onto their parent centerline to compute an editable offset and opening width; doors far from that line are rejected. If a model returns wall fragments ending at an observed door, the virtual parent centerline may be extended only through that door's own interval. The compiler cuts that full interval out, so this normalization adds no solid wall; it is recorded in the candidate notes.

The floor outline supplies the exterior boundary; wall records describe interior partitions. Before attaching exits on a newly extracted image, repeated closing/consecutive points and redundant collinear boundary vertices are removed. This preserves the physical perimeter while allowing an entrance to span artificial subdivisions of the same straight exterior wall. Real corners and existing editable floor edge indices are preserved. Each observed exit marker is projected onto the nearest boundary edge, using its width along that edge as the clear door width. The editable exit stays attached to that edge. Its thin green removal strip sits immediately outside the doorway, one body radius plus 2 cm beyond the wall. Outside dispersal space is fitted around nearby building wings; removal strips are also clipped to ensure body clearance from adjacent walls. Separate doorways may share outside space, but overlapping threshold openings are rejected. People leave the simulation when their full body clears the building; they do not have to walk to a far outside destination. Review the selected edge and width: automatic attachment is a geometric estimate, not evidence that a door is an approved emergency exit. Markers far from a boundary are rejected. Previously saved image layouts upgrade their markers on import without another model call.

Room labels do not change population placement, which remains uniform in the selected interior spawn region. Each converted candidate goes through the existing layout compiler; JSON/schema validity alone does not establish geometric accuracy.

Calibration rescales geometric coordinates, wall thicknesses, door openings, and explicit occupant positions. Physical outside-landing settings are retained. It leaves agent radius, walking speed, and simulation time settings unchanged. Recalibrating after extraction uses the same image alignment.

Small images are presented at a longest side of 1000 pixels. Larger uploads preserve a canonical frame up to 3072 pixels; the whole-plan request and optional structural check use that same full frame. Upscaling does not recover missing source detail. The slower tiled path is an explicit diagnostic opt-in; see [diagnostic extraction and historical evaluations](staged-extraction.md).

Extraction includes clear outer-wall entrances without drawn door leaves, using wall endpoints as evidence and labels only as corroboration. Repeated desk units and substantial tables, counters, cabinets, and sofas take priority over small chairs. A closed cavity bounded entirely by touching furniture is joined into one solid editable furniture item, with a warning; this avoids treating a sink or inaccessible cabinet interior as a separate spawn room. Open U-shaped counter work areas and wall-bounded rooms are not filled. Automatic editor placement uses the same body-clear connected regions as routing, and places occupants only in regions connected to an exit. Results report the excluded region area and display a review note when any area was excluded. A fully enclosed room or a pocket behind a gap narrower than a person therefore receives no automatic starting occupants; this is a placement assumption, not proof that the room is safe. Explicitly supplied trapped occupants are retained, reported as trapped, and kept visible; they are never silently moved.

## Improving extraction instructions

Edit `backend/app/services/floorplans/floorplan_extraction.txt` for compact-image instructions, or the task prompts and observation schemas in `backend/app/services/floorplans/staged.py` for staged imports. `{coordinates}` is filled with the provider-specific coordinate contract; leave that placeholder intact. Instructions cover the full-image frame, shared junction coordinates, wall thickness, continuous parent walls, aligned door jambs, exterior-only exits, polygon validity, and explicit ambiguity warnings. Field descriptions in `backend/app/schemas/extraction.py` also go into the structured-output schema. The prompt file is read for every extraction, so text-only changes do not require a server restart. Python/schema changes do.

The API already requests schema-constrained JSON. That controls its structure, not whether the geometry matches the source. Continue validating in Python and reviewing the image overlay. The compiler tolerates at most `1e-8` meters of numerical boundary overshoot, clipping it only in the local simulation geometry; it does not move stored walls, enlarge the floor, or repair genuinely misplaced objects.

To evaluate a prompt change, keep the model, processed image, and calibration fixed. Compare extracted outlines, missing/extra walls and furniture, doorway alignment/width, and exterior exits against a manually checked layout. Record geometry failures and corrections needed. A layout that imports successfully is not automatically a more accurate reading. A labeled example image with its verified JSON is a useful future addition, but text describing example coordinates alone is not visual ground truth.

Useful references: [Claude coordinates](https://platform.claude.com/docs/en/build-with-claude/vision-coordinates), [structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs), and [Gemini transient-error retries](https://ai.google.dev/gemini-api/docs/troubleshooting).

## Stored artifacts

Locally, image artifacts use the ignored `backend/data/editor/` directory by default. `CROWDY_STORAGE_DIR` can change that root. With `BLOB_READ_WRITE_TOKEN` configured, the image/extraction records below use private Vercel Blob under `crowdy/editor/` instead, so manual calibration and image overlays work across backend instances:

- `images/<image_id>/source.png`: the canonical processed image underlying both providers’ crops.
- `images/<image_id>/metadata.json`: image ID, pixel dimensions, and initial unconfirmed scale.
- `extractions/<extraction_id>/observations.json`: validated provider observations in that provider's coordinate units.
- `extractions/<extraction_id>/context.json`: source image, extraction metadata, and population settings needed to finish manual calibration without another provider call.
- `extractions/<extraction_id>/candidate.json`: converted editable layout, model/time metadata, warnings, and geometry issues.
- `extractions/<extraction_id>/error.json`: extraction or conversion error.
- `extractions/<extraction_id>/stages/`: stage observations, input crops, canonical merged drawing, and merge/validation report. Temporary stage files are copied to the configured artifact store even when extraction fails.

Standalone simulation runs still write `<run_id>/layout.json`, `scenario.json`, `result.json`, and `playback.html` to the local run directory. The main website returns playback data directly and keeps runs/baselines in the editor session.

Images persist in the configured Blob store or local data directory. Vercel's `/tmp/crowdy/editor/` fallback is temporary and instance-local; production needs the linked private Blob store. Exported layout JSON references the image ID; a different backend must share the store or receive the image again. No base64 image or API key is embedded in the editable JSON.

## Endpoints

The main Next.js workspace uses `POST /api/floorplans` on the Python service:

- New image: `{filename, image_base64, provider}`. The website adds `async_import: true`, receiving HTTP 202 with `job_id`. Poll `GET /api/floorplans/jobs/<job_id>` on Python, or `GET /api/floorplans?job_id=<job_id>` through Next.js, for `running`/`complete`/`failed`, progress and the final `result`. Synchronous callers omit that flag. Jobs and provider slots are process-local: run the asynchronous image-import service as one persistent Python process. A backend restart or another worker cannot resume job polling, although persisted image/extraction artifacts remain available for calibration and overlays. Request-scoped serverless execution must use synchronous imports within its host duration limits. A measured or estimated calibration returns `{plan, warnings}`; estimates include the provenance and assumptions in `plan.native.layout.source_image.calibration`. Otherwise the response has `needs_scale`, `extraction_id`, `image_id`, `width_px`, `height_px`, and `reason`.
- Complete a pending extraction: `{extraction_id, manual_scale: {kind: "dimension", label, start: {x,y}, end: {x,y}, distance, unit}}`. Manual endpoints are pixels in the processed source image for both providers.
- Check the current editable plan: `{editor_plan}`. It reconstructs edited furniture polygons and retains canonical wall/door changes; issues are in `plan.native.issues`.
- Recalibrate without losing edits: `{editor_plan, manual_scale}`.
- `GET /api/floorplans/images/<image_id>` serves a PNG or JPEG preview bounded to 3 MiB with the same backend token protection. The canonical PNG remains unchanged for extraction and calibration, and previews retain its coordinate extent. Next.js proxies the preview through `/api/floorplans?image_id=<image_id>`; credentials remain server-side.

Explicit `image_width_m` remains accepted for existing clients. It is no longer supplied by the website. Automatic detection never uses a default 20 m width.

The standalone editor endpoints remain:

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/providers` | Configured/missing flags and model names, with no credentials. |
| POST | `/api/images` | Base64 image plus filename; returns an editable image frame and source metadata. |
| GET | `/images/<image_id>` | Read the processed PNG from the configured artifact store. |
| POST | `/api/extract` | Image ID, provider (`gemini`, `claude`, `both`), meters-per-pixel, scale-confirmed flag, and population count. |

The local standalone editor accepts image-upload JSON up to 14 MiB for source files up to 10 MiB; other standalone JSON endpoints retain their 2 MiB limit. A second standalone extraction returns 409 while one is active. The main API has a 1 MiB simulation limit and reserves one extraction slot per provider, returning 429 when that provider is busy. Vercel's 4.5 MB transport limit applies before these application limits, so the website preprocesses images as described above. Individual provider failures in a standalone comparison leave the other provider's successful candidate usable. No comparison declares a winner without reference geometry or human review.

Floor area has no fixed upper limit. Import, simulation requests and saved workspaces accept any finite positive area in square metres. The 900 × 600 editor canvas is independent of the building’s physical dimensions. Validation reports the failing name, canvas, area or collection field rather than a combined template error.
