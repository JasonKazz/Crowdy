"""Local image storage, coordinate conversion, and saved provider comparisons."""

import base64
import binascii
import io
import json
import math
import tempfile
import threading
import time
import uuid
import warnings
from pathlib import Path

from PIL import Image, ImageOps, UnidentifiedImageError
from shapely.geometry import Polygon
from shapely.ops import unary_union

from app.schemas.extraction import (
    CalibrationInfo, ExtractedDrawing, ExtractionInfo, ExtractionRequest, ImageUpload, ScaleReference, SourceImage,
)
from app.schemas.layout import Layout, exit_from_marker
from app.schemas.scenario import AgentDefaults, Population, Region, SimulationSettings
from app.services.floorplans.layout import compile_layout
from app.services.floorplans.providers import ProviderError, extract_drawing
from app.services.floorplans.interactive import (
    INTERACTIVE_REVIEW_WARNING, check_extraction_time, extraction_mode, extraction_scope,
    review_interactive_structure, validate_interactive_observations,
)
from app.services.floorplans.calibration import calibrate, calibrate_drawing
from app.services.floorplans.storage import read_artifact, write_artifact


MAX_IMAGE_BYTES = 10 * 1024 * 1024
MAX_IMAGE_PIXELS = 30_000_000
MAX_PREVIEW_BYTES = 3 * 1024 * 1024


def image_path(root: Path, image_id: str) -> Path:
    if len(image_id) != 32 or any(char not in "0123456789abcdef" for char in image_id):
        raise ValueError("Invalid image ID")
    return root / "images" / image_id / "source.png"


def save_image(upload: ImageUpload, root: Path) -> SourceImage:
    try:
        raw = base64.b64decode(upload.image_base64, validate=True)
    except (ValueError, binascii.Error):
        raise ValueError("The upload must contain a valid base64 image.") from None
    if not raw or len(raw) > MAX_IMAGE_BYTES:
        raise ValueError("Choose a PNG, JPEG, or WebP image up to 10 MiB.")
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(raw)) as original:
                if original.format not in {"PNG", "JPEG", "WEBP"}:
                    raise ValueError("This version accepts PNG, JPEG, and WebP images. Export PDF pages as images first.")
                if original.width * original.height > MAX_IMAGE_PIXELS:
                    raise ValueError("The image is too large. Resize it below 30 million pixels.")
                corrected = ImageOps.exif_transpose(original).convert("RGBA")
                # Preserve detail in the whole-plan provider input and overlay;
                # both use the exact same canonical image coordinates.
                corrected.thumbnail((3072, 3072), Image.Resampling.LANCZOS)
                # Small plans contain tiny repeated desks and door symbols.
                # Present them at a consistent readable size to both providers;
                # all observations and the overlay use this same stored frame.
                longest = max(corrected.size)
                if longest < 1000:
                    factor = 1000 / longest
                    corrected = corrected.resize(tuple(max(1, round(side * factor)) for side in corrected.size),
                                                 Image.Resampling.LANCZOS)
                image = Image.new("RGB", corrected.size, "white")
                image.paste(corrected, mask=corrected.getchannel("A"))
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError, Image.DecompressionBombWarning):
        raise ValueError("Could not decode this image. Choose a readable PNG, JPEG, or WebP.") from None
    source = SourceImage(id=uuid.uuid4().hex, width_px=image.width, height_px=image.height,
                         meters_per_pixel=0.02, scale_confirmed=False)
    path = image_path(root, source.id)
    encoded = io.BytesIO()
    image.save(encoded, "PNG")
    write_artifact(root, path, encoded.getvalue())
    write_artifact(root, path.parent / "metadata.json", source.model_dump_json(indent=2).encode())
    return source


def load_image(root: Path, image_id: str) -> tuple[SourceImage, bytes]:
    path = image_path(root, image_id)
    try:
        metadata = read_artifact(root, path.parent / "metadata.json")
        image = read_artifact(root, path)
    except FileNotFoundError:
        raise ValueError("Image not found. Upload it again in this editor.") from None
    return SourceImage.model_validate_json(metadata), image


def load_image_bytes(root: Path, image_id: str) -> bytes:
    return read_artifact(root, image_path(root, image_id))


def image_preview(image: bytes) -> tuple[bytes, str]:
    """Bound the HTTP overlay without altering extraction pixels or coordinates."""
    if len(image) <= MAX_PREVIEW_BYTES:
        return image, "image/png"
    with Image.open(io.BytesIO(image)) as original:
        preview = original.convert("RGB")
    while True:
        # Prefer the original dimensions: the SVG overlay and measurement tool
        # retain the canonical source extent regardless of its preview encoding.
        for quality in (92, 82, 72, 60, 45, 30):
            encoded = io.BytesIO()
            preview.save(encoded, "JPEG", quality=quality, optimize=True)
            if encoded.tell() <= MAX_PREVIEW_BYTES:
                return encoded.getvalue(), "image/jpeg"
        preview = preview.resize((max(1, round(preview.width * .75)),
                                  max(1, round(preview.height * .75))), Image.Resampling.LANCZOS)


def draft_layout(source: SourceImage) -> Layout:
    width, height = source.width_px * source.meters_per_pixel, source.height_px * source.meters_per_pixel
    return Layout(
        name="Uploaded floor plan — awaiting extraction",
        walkable_areas=[Region(id="floor", polygon=[(0, 0), (width, 0), (width, height), (0, height)])],
        source_image=source,
        population=Population(count=40, spawn_area_ids=["floor"]),
        agent_defaults=AgentDefaults(radius=0.23, desired_speed=1.2),
        settings=SimulationSettings(dt=0.01, sample_interval=0.1, max_time=120),
    )


def remove_redundant_boundary_vertices(points):
    """Keep the same perimeter, without artificial edge breaks at a doorway.

    Apply only to new image observations, before assigning exterior edge IDs.
    Never renumber edges of an existing editable layout. Preserve real corners,
    concavities and backtracking/invalid geometry for normal validation.
    """
    tolerance = 1e-8  # metres; numerical cleanup, not architectural snapping
    boundary = []
    for point in points:
        if not boundary or math.dist(point, boundary[-1]) > tolerance:
            boundary.append(point)
    if len(boundary) > 1 and math.dist(boundary[0], boundary[-1]) <= tolerance:
        boundary.pop()
    changed = True
    while changed and len(boundary) > 3:
        changed = False
        for index, current in enumerate(boundary):
            before, after = boundary[index-1], boundary[(index+1) % len(boundary)]
            dx, dy = after[0]-before[0], after[1]-before[1]
            length = math.hypot(dx, dy)
            if length <= tolerance:
                continue
            along = ((current[0]-before[0])*dx + (current[1]-before[1])*dy) / length
            perpendicular = abs((current[0]-before[0])*dy - (current[1]-before[1])*dx) / length
            if perpendicular <= tolerance and 0 <= along <= length:
                boundary.pop(index)
                changed = True
                break
    return boundary


def refine_jamb_roundoff(walls, doors, tolerance, notes):
    """Narrow an opening by at most two source pixels at an adjacent wall face.

    Solid geometry is never removed. Interior, large and furniture obstructions
    remain validation errors; this only handles small roundoff at jamb endpoints.
    """
    from app.services.floorplans.layout import wall_polygon
    from app.schemas.layout import Wall
    wall_models = {item['id']: Wall.model_validate(item) for item in walls}
    for door in doors:
        parent = wall_models[door['wall_id']]
        length = math.dist(parent.start, parent.end)
        direction = [(parent.end[i] - parent.start[i]) / length for i in range(2)]
        lower, upper = door['offset'] - door['width']/2, door['offset'] + door['width']/2
        opening = Polygon(wall_polygon(parent, lower, upper))
        start, end = lower, upper
        limit = min(tolerance, door['width'] * .05)
        for wall in wall_models.values():
            if wall.id == parent.id:
                continue
            hit = opening.intersection(Polygon(wall_polygon(wall, 0, math.dist(wall.start, wall.end))))
            if hit.area < 1e-10:
                continue
            spans = [sum((point[i] - parent.start[i]) * direction[i] for i in range(2))
                     for part in ([hit] if hit.geom_type == 'Polygon' else getattr(hit, 'geoms', []))
                     if part.geom_type == 'Polygon' for point in part.exterior.coords]
            if not spans:
                continue
            a, b = min(spans), max(spans)
            if a <= lower + 1e-8 and 0 < b - lower <= limit + 1e-8:
                start = max(start, b + 1e-9)
            elif b >= upper - 1e-8 and 0 < upper - a <= limit + 1e-8:
                end = min(end, a - 1e-9)
        if (start > lower or end < upper) and end-start > .46 and upper-lower-(end-start) <= 2*limit+1e-8:
            door['offset'], door['width'] = (start+end)/2, end-start
            notes.append(f"Narrowed door '{door['id']}' at an adjacent wall face to correct at most two source pixels of jamb roundoff; no wall removed. Review over the source image.")


def drawing_to_layout(drawing: ExtractedDrawing, source: SourceImage, provider: str,
                      info: ExtractionInfo, people_count: int, allow_review=False) -> Layout:
    info = info.model_copy(deep=True)
    def pixel(point):
        x, y = point.x, point.y
        if provider == "gemini":
            x, y = x * source.width_px / 1000, y * source.height_px / 1000
        if not (0 <= x <= source.width_px and 0 <= y <= source.height_px):
            raise ValueError("An extracted coordinate is outside the image. Retry extraction or use a clearer plan.")
        return x, y

    def position(point):
        x, y = pixel(point)
        return x * source.meters_per_pixel, (source.height_px - y) * source.meters_per_pixel

    def region(item):
        return Region(id=item.id, polygon=[position(point) for point in item.polygon])

    thickness_scale = source.meters_per_pixel * (
        min(source.width_px, source.height_px) / 1000 if provider == "gemini" else 1
    )
    walls = [{"id": wall.id, "start": position(wall.start), "end": position(wall.end),
              "thickness": wall.thickness * thickness_scale} for wall in drawing.walls]
    wall_by_id = {wall["id"]: wall for wall in walls}
    door_points = []
    for door in drawing.doors:
        if door.wall_id not in wall_by_id:
            raise ValueError(f"Extracted door '{door.id}' has no matching wall. Retry extraction.")
        wall = wall_by_id[door.wall_id]
        start, end = position(door.start), position(door.end)
        length = math.dist(wall["start"], wall["end"])
        if length <= 1e-6:
            raise ValueError("An extracted wall has no length. Retry extraction.")
        direction = [(wall["end"][i] - wall["start"][i]) / length for i in range(2)]
        for point in (start, end):
            perpendicular = abs((point[0] - wall["start"][0]) * direction[1] -
                                (point[1] - wall["start"][1]) * direction[0])
            if perpendicular > wall["thickness"] / 2 + 2 * source.meters_per_pixel:
                raise ValueError(f"Door '{door.id}' does not align with its parent wall. Retry extraction.")
        # Door endpoints are projected onto their parent centerline; no global
        # snapping or invented connections are applied to the rest of the plan.
        offsets = [sum((point[i] - wall["start"][i]) * direction[i] for i in range(2))
                   for point in (start, end)]
        lower, upper = sorted(offsets)
        if (lower < 0 or upper > length) and lower <= length + 1e-9 and upper >= -1e-9:
            # Some models return solid wall fragments ending at an observed door.
            # Extending the virtual parent ONLY through that same opening adds
            # no solid geometry: the compiler subtracts the entire extension.
            origin = wall["start"]
            wall["start"] = tuple(origin[i] + direction[i] * min(0, lower) for i in range(2))
            wall["end"] = tuple(origin[i] + direction[i] * max(length, upper) for i in range(2))
            info.warnings.append(f"Extended wall '{wall['id']}' centerline through detected door '{door.id}'; no solid wall was added.")
        door_points.append((door, start, end))
    doors = []
    for door, start, end in door_points:
        wall = wall_by_id[door.wall_id]
        length = math.dist(wall["start"], wall["end"])
        direction = [(wall["end"][i] - wall["start"][i]) / length for i in range(2)]
        offsets = [sum((point[i] - wall["start"][i]) * direction[i] for i in range(2))
                   for point in (start, end)]
        doors.append({"id": door.id, "wall_id": door.wall_id,
                      "offset": sum(offsets) / 2, "width": abs(offsets[1] - offsets[0])})
    refine_jamb_roundoff(walls, doors, 2 * source.meters_per_pixel, info.warnings)
    furniture = [region(item) for item in drawing.furniture]
    # Adjacent counters can enclose sink/appliance cavities. Merge only such
    # closed furniture clusters and fill their inaccessible interiors. Open U
    # shapes and rooms bounded by walls remain untouched. One merged item also
    # moves as a whole in the editor, with no stale filler left behind.
    shapes = [Polygon(item.polygon) for item in furniture]
    if shapes and all(shape.is_valid for shape in shapes):
        solids = unary_union(shapes)
        pieces = [solids] if isinstance(solids, Polygon) else list(solids.geoms)
        for piece in pieces:
            if not piece.interiors:
                continue
            exterior = Polygon(piece.exterior)
            members = [item for item in furniture if exterior.covers(Polygon(item.polygon))]
            if not members:  # Already absorbed by an enclosing furniture cluster.
                continue
            member_ids = {item.id for item in members}
            furniture = [item for item in furniture if item.id not in member_ids]
            furniture.append(Region(id=members[0].id, polygon=list(piece.exterior.coords)[:-1]))
            info.warnings.append("Joined touching furniture around an enclosed cavity into one solid editable barrier; open aisles were preserved.")
    floors = [Region(id="floor", polygon=remove_redundant_boundary_vertices(
        [position(point) for point in drawing.floor_outline]))]
    exits = []
    for item in drawing.exits:
        marker = region(item)
        if not allow_review:
            exits.append(marker)
            continue
        try:
            opening = exit_from_marker(marker, floors)
        except ValueError:
            info.warnings.insert(0,f"Review required: exit '{item.id}' does not align with a usable exterior edge; omitted from the draft. Add/correct it over the image.")
            continue
        if any(other.floor_id==opening.floor_id and other.edge_index==opening.edge_index
               and min(other.offset+other.width/2,opening.offset+opening.width/2)
                   -max(other.offset-other.width/2,opening.offset-opening.width/2) > .5*min(other.width,opening.width)
               for other in exits):
            info.warnings.append(f"Merged duplicate exterior opening observation '{item.id}'.")
            continue
        exits.append(opening)
    from app.services.population.rooms import infer_room_type, infer_building_type
    classifications = {item.room_id: item.room_type for item in drawing.room_classifications}
    room_types = {room.id: classifications.get(room.id, infer_room_type(room.label)) for room in drawing.rooms}
    building_type = drawing.building_type if drawing.building_type != "auto" else infer_building_type(room_types.values(), drawing.name)
    return Layout(
        name=drawing.name or "Extracted floor plan", source_image=source, extraction=info,
        walkable_areas=floors,
        furniture=furniture, walls=walls, doors=doors,
        furniture_labels={item.id:item.label for item in drawing.furniture},
        exits=exits,
        rooms=[region(item) for item in drawing.rooms],
        room_labels={item.id: item.label for item in drawing.rooms},
        room_types=room_types, building_type=building_type,
        population=Population(count=people_count, spawn_area_ids=["floor"]),
        agent_defaults=AgentDefaults(radius=0.23, desired_speed=1.2),
        settings=SimulationSettings(dt=0.01, sample_interval=0.1, max_time=120),
    )


def extract_image(request: ExtractionRequest, root: Path, progress=None, *,
                  deadline: float | None = None, cancelled: threading.Event | None = None) -> dict:
    mode = extraction_mode()
    with extraction_scope(mode, deadline=deadline, cancelled=cancelled) as expires:
        return _extract_image(request, root, progress, mode=mode, deadline=expires, cancelled=cancelled)


def _extract_image(request: ExtractionRequest, root: Path, progress, *, mode: str,
                   deadline: float, cancelled: threading.Event | None) -> dict:
    original, image = load_image(root, request.image_id)
    check_extraction_time(deadline, cancelled)
    results = []
    providers = ("gemini", "claude") if request.provider == "both" else (request.provider,)
    for provider in providers:
        started = time.perf_counter()
        extraction_id = uuid.uuid4().hex
        directory = root / "extractions" / extraction_id
        try:
            check_extraction_time(deadline, cancelled)
            if mode == "diagnostic_staged":
                from app.services.floorplans.staged import extract_staged
                # Stages need scratch files while extracting. Persist them via
                # the configured store, including failed-stage diagnostics, so
                # neither Blob imports nor later calibration depend on this worker.
                with tempfile.TemporaryDirectory(prefix="crowdy-stages-") as scratch:
                    stage_directory = Path(scratch)
                    try:
                        drawing, model = extract_staged(provider, image, original.width_px, original.height_px,
                                                        stage_directory, progress)
                    finally:
                        for artifact in sorted(stage_directory.rglob("*")):
                            if artifact.is_file():
                                write_artifact(root, directory / "stages" / artifact.relative_to(stage_directory),
                                               artifact.read_bytes())
            else:
                if progress:
                    progress("Reading the whole floor plan")
                drawing, model = extract_drawing(provider, image, original.width_px, original.height_px)
                # Keep the original observation even if the one bounded quality
                # follow-up cannot finish. Never hide failed geometry behind a
                # successful-looking empty outline or a background crop queue.
                write_artifact(root, directory / "whole-plan.json", drawing.model_dump_json(indent=2).encode())
                check_extraction_time(deadline, cancelled)
                drawing, review = review_interactive_structure(provider, image, original.width_px, original.height_px,
                                                               drawing, progress)
                if review is not None:
                    write_artifact(root, directory / "structure-review.json", json.dumps(review, indent=2).encode())
            check_extraction_time(deadline, cancelled)
            if progress:
                progress("Checking extracted geometry and scale")
            info = ExtractionInfo(id=extraction_id, provider=provider, model=model,
                                  elapsed_seconds=round(time.perf_counter() - started, 3),
                                  warnings=([INTERACTIVE_REVIEW_WARNING] if mode == "interactive" else []) + drawing.warnings)
            write_artifact(root, directory / "observations.json", drawing.model_dump_json(indent=2).encode())
            write_artifact(root, directory / "context.json", json.dumps({"source": original.model_dump(mode="json"),
                "info": info.model_dump(mode="json"), "people_count": request.people_count,
                "extraction_mode": mode}).encode())
            check_extraction_time(deadline, cancelled)
            if mode == "interactive":
                validate_interactive_observations(drawing)
            if request.meters_per_pixel is None:
                source, reason = calibrate_drawing(original, drawing, provider)
                if source is None:
                    results.append({"provider": provider, "needs_scale": True, "extraction_id": info.id,
                        "image_id": original.id, "width_px": original.width_px, "height_px": original.height_px,
                        "reason": reason, "warnings": info.warnings})
                    continue
            else:
                source = original.model_copy(update={"meters_per_pixel": request.meters_per_pixel,
                    "scale_confirmed": request.scale_confirmed,
                    "calibration": CalibrationInfo(method="manual", label="Entered image scale")})
            check_extraction_time(deadline, cancelled)
            if progress:
                progress("Validating the floor plan")
            result = save_candidate(drawing, source, info, request.people_count, directory, root)
            check_extraction_time(deadline, cancelled)
            results.append(result)
        except (ProviderError, ValueError) as exc:
            error = {"provider": provider, "error": str(exc), "extraction_id": extraction_id}
            write_artifact(root, directory / "error.json", json.dumps(error, indent=2).encode())
            results.append(error)
    return {"results": results}


def save_candidate(drawing, source, info, people_count, directory, root):
    try:
        read_artifact(root, directory / "stages" / "report.json")
        staged = True
    except FileNotFoundError:
        staged = False
    layout = drawing_to_layout(drawing, source, info.provider, info, people_count,
                               allow_review=staged)
    notes = list(layout.extraction.warnings)
    if source.calibration and source.calibration.method == "estimated":
        notes.append("Scale estimated from assumed object sizes. Use Edit scale to replace it with a known measurement.")
    issues = []
    try:
        compile_layout(layout)
    except ValueError as exc:
        issues.append(str(exc))
    result = {"provider": info.provider, "model": info.model, "extraction_id": info.id, "layout": layout.model_dump(mode="json"),
              "warnings": notes, "issues": issues,
              "elapsed_seconds": info.elapsed_seconds,
              "counts": {name: len(getattr(layout, name)) for name in ("rooms", "walls", "doors", "furniture", "exits")}}
    write_artifact(root, directory / "candidate.json", json.dumps(result, indent=2, allow_nan=False).encode())
    return result


def finish_calibration(extraction_id: str, reference: ScaleReference, root: Path):
    if len(extraction_id) != 32 or any(c not in "0123456789abcdef" for c in extraction_id):
        raise ValueError("Invalid extraction ID")
    directory = root / "extractions" / extraction_id
    try:
        context = json.loads(read_artifact(root, directory / "context.json"))
        observations = read_artifact(root, directory / "observations.json")
    except FileNotFoundError:
        raise ValueError("The saved extraction was not found. Upload the image again.") from None
    source, reason = calibrate(SourceImage.model_validate(context["source"]), [reference], "claude", manual=True)
    if source is None:
        raise ValueError(reason)
    return save_candidate(ExtractedDrawing.model_validate_json(observations),
                          source, ExtractionInfo.model_validate(context["info"]), context["people_count"], directory, root)
