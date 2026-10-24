"""Local image storage, coordinate conversion, and saved provider comparisons."""

import base64
import binascii
import io
import json
import math
import time
import uuid
import warnings
from pathlib import Path

from PIL import Image, ImageOps, UnidentifiedImageError

from app.schemas.extraction import (
    ExtractedDrawing, ExtractionInfo, ExtractionRequest, ImageUpload, SourceImage,
)
from app.schemas.layout import Layout
from app.schemas.scenario import AgentDefaults, Population, Region, SimulationSettings
from app.services.floorplans.layout import compile_layout
from app.services.floorplans.providers import ProviderError, extract_drawing


MAX_IMAGE_BYTES = 10 * 1024 * 1024
MAX_IMAGE_PIXELS = 30_000_000


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
                # Both providers see the identical image, within Claude's standard-tier
                # native pixel budget: at most 39 x 39 patches of 28 pixels.
                corrected.thumbnail((1092, 1092), Image.Resampling.LANCZOS)
                image = Image.new("RGB", corrected.size, "white")
                image.paste(corrected, mask=corrected.getchannel("A"))
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError, Image.DecompressionBombWarning):
        raise ValueError("Could not decode this image. Choose a readable PNG, JPEG, or WebP.") from None
    source = SourceImage(id=uuid.uuid4().hex, width_px=image.width, height_px=image.height,
                         meters_per_pixel=0.02, scale_confirmed=False)
    path = image_path(root, source.id)
    path.parent.mkdir(parents=True)
    image.save(path, "PNG")
    (path.parent / "metadata.json").write_text(source.model_dump_json(indent=2))
    return source


def load_image(root: Path, image_id: str) -> tuple[SourceImage, bytes]:
    path = image_path(root, image_id)
    if not path.is_file():
        raise ValueError("Image not found. Upload it again in this editor.")
    return SourceImage.model_validate_json((path.parent / "metadata.json").read_text()), path.read_bytes()


def draft_layout(source: SourceImage) -> Layout:
    width, height = source.width_px * source.meters_per_pixel, source.height_px * source.meters_per_pixel
    return Layout(
        name="Uploaded floor plan — awaiting extraction",
        walkable_areas=[Region(id="floor", polygon=[(0, 0), (width, 0), (width, height), (0, height)])],
        source_image=source,
        population=Population(count=40, spawn_area_ids=["floor"]),
        agent_defaults=AgentDefaults(radius=0.2, desired_speed=1.2),
        settings=SimulationSettings(dt=0.01, sample_interval=0.1, max_time=120),
    )


def drawing_to_layout(drawing: ExtractedDrawing, source: SourceImage, provider: str,
                      info: ExtractionInfo, people_count: int) -> Layout:
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
    return Layout(
        name=drawing.name or "Extracted floor plan", source_image=source, extraction=info,
        walkable_areas=[Region(id="floor", polygon=[position(point) for point in drawing.floor_outline])],
        furniture=[region(item) for item in drawing.furniture], walls=walls, doors=doors,
        exits=[region(item) for item in drawing.exits],
        rooms=[region(item) for item in drawing.rooms],
        room_labels={item.id: item.label for item in drawing.rooms},
        population=Population(count=people_count, spawn_area_ids=["floor"]),
        agent_defaults=AgentDefaults(radius=0.2, desired_speed=1.2),
        settings=SimulationSettings(dt=0.01, sample_interval=0.1, max_time=120),
    )


def extract_image(request: ExtractionRequest, root: Path) -> dict:
    original, image = load_image(root, request.image_id)
    source = original.model_copy(update={"meters_per_pixel": request.meters_per_pixel,
                                        "scale_confirmed": request.scale_confirmed})
    results = []
    providers = ("gemini", "claude") if request.provider == "both" else (request.provider,)
    for provider in providers:
        started = time.perf_counter()
        directory = None
        try:
            drawing, model = extract_drawing(provider, image, source.width_px, source.height_px)
            info = ExtractionInfo(id=uuid.uuid4().hex, provider=provider, model=model,
                                  elapsed_seconds=round(time.perf_counter() - started, 3),
                                  warnings=drawing.warnings)
            directory = root / "extractions" / info.id
            directory.mkdir(parents=True)
            (directory / "observations.json").write_text(drawing.model_dump_json(indent=2))
            layout = drawing_to_layout(drawing, source, provider, info, request.people_count)
            issues = []
            try:
                compile_layout(layout)
            except ValueError as exc:
                issues.append(str(exc))
            result = {"provider": provider, "model": model, "layout": layout.model_dump(mode="json"),
                      "warnings": layout.extraction.warnings, "issues": issues,
                      "elapsed_seconds": info.elapsed_seconds,
                      "counts": {name: len(getattr(layout, name)) for name in ("rooms", "walls", "doors", "furniture", "exits")}}
            (directory / "candidate.json").write_text(json.dumps(result, indent=2, allow_nan=False))
            results.append(result)
        except (ProviderError, ValueError) as exc:
            error = {"provider": provider, "error": str(exc)}
            if directory is not None:
                (directory / "error.json").write_text(json.dumps(error, indent=2))
            results.append(error)
    return {"results": results}
