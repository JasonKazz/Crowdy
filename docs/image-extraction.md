# Image-to-layout workflow

This feature starts from a PNG, JPEG, or WebP floor-plan image and produces the same editable geometry consumed by the Python simulator. It supports one selected provider or a comparison of Gemini and Claude. JSON imports and existing simulation commands continue to work.

## Setup

From `backend/`, activate `.venv` and install `requirements.txt`. The additions are Pillow for decoding/resizing images and python-dotenv for local configuration. HTTP calls use Python's standard library.

Keep real credentials in the repository root `.env`, which Git ignores:

```dotenv
GEMINI_API_KEY=replace_locally
ANTHROPIC_API_KEY=replace_locally
GEMINI_MODEL=gemini-3.8-flash
ANTHROPIC_MODEL=claude-sonnet-5-5
```

Model names are configurable because availability varies by account and changes over time. `CLAUDE_API_KEY` is accepted as an alias when `ANTHROPIC_API_KEY` is absent. One provider key is enough for its individual extraction button; comparison requires both. `.env.example` must contain placeholders only. Existing environment variables take precedence. Restart after changing keys or model names. Keys stay in request headers on the server and are not sent to the browser, saved in artifacts, or included in upstream error messages.

Run `python -m app.simulation.editor` and open its printed `http://127.0.0.1:...` address. `--env-file /absolute/path/to/.env` selects another local configuration file. Opening `editor.html` directly cannot use these endpoints.

## Use it

1. Upload an image up to 10 MiB. PDF input is not supported yet; export one page as PNG or JPEG first. Images above 30 million pixels are rejected.
2. Enter a known real-world length, select **Mark two points to set scale**, and click its endpoints. Use a printed dimension or a distance you know; the model does not invent a building scale.
3. Choose Gemini or Claude and **Extract layout**. **Compare both models** extracts sequentially with both providers against exactly the same processed image. Transient HTTP failures (408, 429, 500, 502, 503, 504, 529) get up to two retries with exponential backoff and jitter, within a shared 175-second request budget. Numeric `Retry-After` headers are honored when they fit in the budget. Invalid-key, access, and malformed-request errors are not retried. Network timeouts are not retried because the POST might already have been processed. There is no hidden fallback to the other provider. For a first test, `examples/sample_floorplan.png` has an 18-meter dimension marked along its top edge.
4. For a comparison, choose **Use Gemini layout** or **Use Claude layout** to inspect that candidate. The cards show model names, wall/door/furniture counts, time, model notes, and geometry issues. These are observations and checks, not an accuracy score.
5. Edit the clean geometry view. **Compare with original image (fixed reference)** shows the source pixels for alignment checks; printed tables, door swings, and walls cannot move with the editable objects. The reference hides when you edit to avoid leaving apparent duplicates behind. Correct furniture, wall endpoints, door offsets/widths, exterior exits, or polygon corners. Unrecognized exits remain empty; add exterior exit doors manually.
6. Check the layout, set population/settings, and run. Image-derived layouts cannot simulate until scale is confirmed and an extraction has been selected. Normal geometry and population checks still apply.

Uploading only displays an image-frame rectangle. This is not an inferred room, and cannot be simulated as if extraction had succeeded. Model observations may also produce a draft with disconnected rooms or a misplaced door; the draft stays editable and the check explains the problem. No general-purpose snapping or connection repair silently changes its topology.

## Coordinates and geometry

Both models receive an EXIF-corrected, white-backed PNG resized to at most 1092 pixels per side. This fits within Claude's standard-tier native patch budget, so its returned pixel coordinates can be mapped without another server-side resize. This limit favors a quick prototype; dense plans can lose small details and need a clearer crop.

The provider-neutral observation schema records the interior floor outline, labeled room polygons, furniture polygons, wall centerlines with thickness, interior door endpoints and parent wall IDs, exterior exit zones, and ambiguity notes. Gemini is prompted for independently normalized 0–1000 axes and thickness in thousandths of the shorter image dimension. Claude is prompted for absolute pixels and thickness in pixels. The converter then scales to meters and flips image y-down into simulation y-up. Door endpoints are projected onto their parent centerline to compute an editable offset and opening width; doors far from that line are rejected. If a model returns wall fragments ending at an observed door, the virtual parent centerline may be extended only through that door's own interval. The compiler cuts that full interval out, so this normalization adds no solid wall; it is recorded in the candidate notes.

The floor outline supplies the exterior boundary; wall records describe interior partitions. Each observed exit marker is projected onto the nearest boundary edge, using its width along that edge as the clear door width. The editable exit stays attached to that edge. Its thin green removal strip sits immediately outside the doorway, one body radius plus 2 cm beyond the wall. People leave the simulation when their full body clears the building; they do not have to walk to a far outside destination. Review the selected edge and width: automatic attachment is a geometric estimate, not evidence that a door is an approved emergency exit. Markers far from a boundary are rejected. Previously saved image layouts upgrade their markers on import without another model call.

Room labels do not change population placement, which remains uniform in the selected interior spawn region. Each converted candidate goes through the existing layout compiler; JSON/schema validity alone does not establish geometric accuracy.

Calibration rescales geometric coordinates, wall thicknesses, door openings, outside landings, and explicit occupant positions. It leaves agent radius, walking speed, and simulation time settings unchanged. Recalibrating after extraction uses the same image alignment.

## Improving extraction instructions

Edit `backend/app/services/floorplans/floorplan_extraction.txt` to change the instructions sent to both providers. `{coordinates}` is filled with the provider-specific coordinate contract; leave that placeholder intact. Instructions cover the full-image frame, shared junction coordinates, wall thickness, continuous parent walls, aligned door jambs, exterior-only exits, polygon validity, and explicit ambiguity warnings. Field descriptions in `backend/app/schemas/extraction.py` also go into the structured-output schema. The prompt file is read for every extraction, so text-only changes do not require a server restart. Python/schema changes do.

The API already requests schema-constrained JSON. That controls its structure, not whether the geometry matches the source. Continue validating in Python and reviewing the image overlay. The compiler tolerates at most `1e-8` meters of numerical boundary overshoot, clipping it only in the local simulation geometry; it does not move stored walls, enlarge the floor, or repair genuinely misplaced objects.

To evaluate a prompt change, keep the model, processed image, and calibration fixed. Compare extracted outlines, missing/extra walls and furniture, doorway alignment/width, and exterior exits against a manually checked layout. Record geometry failures and corrections needed. A layout that imports successfully is not automatically a more accurate reading. A labeled example image with its verified JSON is a useful future addition, but text describing example coordinates alone is not visual ground truth.

Useful references: [Claude coordinates](https://platform.claude.com/docs/en/build-with-claude/vision-coordinates), [structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs), and [Gemini transient-error retries](https://ai.google.dev/gemini-api/docs/troubleshooting).

## Stored artifacts

All artifacts live in the ignored `backend/data/editor/` directory:

- `images/<image_id>/source.png`: the processed image both providers see.
- `images/<image_id>/metadata.json`: image ID, pixel dimensions, and initial unconfirmed scale.
- `extractions/<extraction_id>/observations.json`: validated provider observations in that provider's coordinate units.
- `extractions/<extraction_id>/candidate.json`: converted editable layout, model/time metadata, warnings, and geometry issues.
- `extractions/<extraction_id>/error.json`: conversion error, when valid observations could not be converted into an editable candidate.
- `<run_id>/layout.json`: the chosen and manually corrected layout, including confirmed scale, source-image ID, room labels, and extraction provenance.
- `<run_id>/scenario.json`, `result.json`, `playback.html`: the existing compiled input, simulation output, and animation.

Images persist across server restarts in the same data directory. Exported layout JSON references that local image ID; moving JSON to another machine requires transferring its corresponding image storage too. No base64 image or API key is embedded in the editable JSON.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/providers` | Configured/missing flags and model names, with no credentials. |
| POST | `/api/images` | Base64 image plus filename; returns an editable image frame and source metadata. |
| GET | `/images/<image_id>` | Read the processed PNG from local storage. |
| POST | `/api/extract` | Image ID, provider (`gemini`, `claude`, `both`), meters-per-pixel, scale-confirmed flag, and population count. |

Image-upload JSON has a 14 MiB request limit to accommodate base64; individual source files are limited to 10 MiB. Other JSON endpoints retain their 2 MiB limit. A second extraction returns 409 while one is active. Individual provider failures are returned in the comparison results so the other provider's successful candidate remains usable. No comparison declares a winner without reference geometry or human review.
