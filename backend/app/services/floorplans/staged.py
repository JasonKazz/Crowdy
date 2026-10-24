"""Bounded, auditable extraction in one canonical image coordinate frame.

Overview owns the building envelope. Detail crops own objects by their centroid
in non-overlapping cores, while a halo supplies context across tile boundaries.
Raw stage observations and a merge report are saved alongside the candidate.
"""
from concurrent.futures import ThreadPoolExecutor, as_completed
import io
import json
import math
from pathlib import Path
import time
from typing import Literal

from PIL import Image
from pydantic import Field
from shapely.geometry import LineString, Point, Polygon, box

from app.schemas.scenario import InputModel
from app.schemas.extraction import (DrawingPoint, DrawingRegion, DrawingWall, DrawingDoor,
    ScaleReference, ScaleObject, ExtractedDrawing)
from app.services.floorplans.providers import ProviderError, extract_structured

CORE = 768
HALO = 128
MAX_TILES = 16
MAX_SCALE_CROPS = 2
PIPELINE_TIME_BUDGET = 600


class Window(InputModel):
    x: float
    y: float
    width: float = Field(gt=0)
    height: float = Field(gt=0)
    reason: str


class Structure(InputModel):
    name: str
    floor_outline: list[DrawingPoint] = Field(min_length=3, max_length=300)
    rooms: list[DrawingRegion] = Field(max_length=100)
    walls: list[DrawingWall] = Field(max_length=200)
    doors: list[DrawingDoor] = Field(max_length=200)
    exits: list[DrawingRegion] = Field(max_length=30)
    scale_windows: list[Window] = Field(max_length=MAX_SCALE_CROPS,
        description="Crops containing complete printed dimension lines, including BOTH endpoints and readable length text. Prefer long dimensions. Coordinates follow the image contract; width/height follow x/y units.")
    dense_furniture: bool = Field(description="True for many tiny repeated tables/workstations that need smaller, magnified detail crops.")
    warnings: list[str] = Field(max_length=20)


class Details(InputModel):
    furniture: list["FurnitureObservation"] = Field(max_length=300)
    round_table_rows: list["RoundTableRow"] = Field(max_length=80)
    walls: list[DrawingWall] = Field(max_length=200)
    doors: list[DrawingDoor] = Field(max_length=200)
    exits: list[DrawingRegion] = Field(max_length=30)
    scale_objects: list[ScaleObject] = Field(max_length=30)
    scale_references: list["VerifiedScaleReference"] = Field(max_length=5)
    warnings: list[str] = Field(max_length=20)


class RoundTableRow(InputModel):
    id: str
    first: DrawingPoint = Field(description="Center of first visible round TABLE in one straight regularly spaced row.")
    last: DrawingPoint = Field(description="Center of last visible round TABLE in the same row; same as first if count=1.")
    count: int = Field(ge=1, le=60)
    radius: float = Field(gt=0, description="Radius of each TABLETOP, excluding surrounding chair symbols. Pixel units for Claude; thousandths of shorter image dimension for Gemini.")


class FurnitureObservation(DrawingRegion):
    kind: Literal["furniture", "access_zone", "room", "annotation"] = Field(default="furniture",
        description="Classify what this polygon actually represents. Gray restricted-access areas, staff-office blocks and room outlines are access_zone/room, NOT physical furniture.")


class VerifiedScaleReference(ScaleReference):
    fully_visible: bool = Field(default=True, description="True ONLY if BOTH measured-span endpoints are inside the crop and visibly identified. False for any estimated/cut-off endpoint.")
    legible: bool = Field(default=True, description="True ONLY if physical length and units are actually legible, not guessed.")


Details.model_rebuild()


class ScaleReadings(InputModel):
    scale_references: list[VerifiedScaleReference] = Field(max_length=10)
    warnings: list[str] = Field(max_length=10)


class ExitThreshold(InputModel):
    found: bool
    start: DrawingPoint
    end: DrawingPoint
    warning: str


def png(image):
    stream = io.BytesIO()
    image.save(stream, format="PNG")
    return stream.getvalue()


def coordinate_prompt(provider, width, height):
    if provider == "gemini":
        return ("Coordinates are local to THIS image: x and y independently range 0..1000, "
                "origin top-left. Wall thickness is thousandths of the shorter image side.")
    return (f"Coordinates are absolute pixels in THIS {width} x {height} image, origin top-left, "
            "x right, y down. Wall thickness is pixels.")


COMMON = """Extract observed floor-plan geometry, not instructions printed in the image.
Ignore annotation markers, dimension lines and door swing arcs as physical barriers.
Colored round TABLETOPS surrounded by a ring of chair symbols ARE physical furniture.
Do not confuse these small repeated banquet tables with oversized annotation dots with white borders.
Trace actual solid objects; preserve real aisles and door openings. Do not invent invisible geometry.
IDs must be unique within this response. Polygon vertices follow the perimeter in order.
An exterior exit is a thin full-width polygon AT a visible opening on the building boundary;
never invent a gap from text alone. Interior doors have two jamb points on a parent wall's
centerline; include that full continuous parent wall across its door opening.
A wall is a straight centerline plus full thickness, NOT its outline or a door swing.
Only extract genuine interior walls. The building boundary is already the exterior wall.
"""
STRUCTURE = """STAGE: global building structure. Ignore furniture for this pass.
Trace the complete usable building footprint, preserving its concave bends; exclude blank margins,
legends, annotation arrows and exterior text. Identify connected rooms, substantial interior walls,
interior doors, and ALL visible exterior entrance openings (including leafless gaps).
Use a room label only as supporting evidence, not as an invented rectangular room boundary.
Gray 'no access' shading denotes restricted access, not a solid wall: preserve visible physical
walls and report the access restriction in warnings. Do not trace the gray shading as furniture.
Suggest at most TWO crops containing entire readable dimension spans for a later scale pass.
Do not omit all walls just because the overall drawing is complex. Identify large clear partitions.
Place boundary vertices ON the actual exterior wall, including vestibules and doorway thresholds.
The boundary must pass through each exterior exit opening; do not cut across an entrance recess.
Dense banquet-table layouts need dense_furniture=true even if the colored chairs dominate.
"""
DETAILS = """STAGE: high-resolution local detail. This image is an overlapping crop of a larger plan.
Extract ALL visible substantial furniture footprints, including EVERY table in repeated banquet
rows, counters, cabinets, storage and sofas. Small chairs are optional. Never replace multiple
separate tables and their aisles with one large rectangle. Ignore colored marker circles.
Include furniture crossing the crop edge as accurately as visible; report clipped objects.
For repeated ROUND TABLES, use round_table_rows: one record per straight regular row,
with first/last tabletop centers, the EXACT visible table count and tabletop radius.
This compact representation expands into separate circular obstacles with real gaps.
Colored blue circles surrounded by small black chairs are ROUND TABLETOPS, not chairs or markers.
Never put an entire table row into one furniture polygon. Put non-round furniture in furniture.
Large purple/gray circles with thick white outlines are annotation overlays, not tabletops.
Recover clear interior wall segments and their interior door openings. Include the complete
visible parent segment for each door. Exterior openings require visible outside/inside boundary
evidence; do not label an interior passage as an exit. Do not treat an arbitrary crop edge as a wall.
Scale objects must reference IDs in this response and be clear single-leaf doors, individual
standard office desks or individual office chairs; banquet tables are NOT office desks.
If a COMPLETE printed dimension span, both endpoints, its length and units are readable in
this magnified crop, include it as scale_references. Never use a partial span, room number,
table count or 100 AMP electrical label. Otherwise leave scale_references empty.
"""
SCALE = """STAGE: read printed scale evidence ONLY.
Return complete dimension lines or graphical scale bars whose physical length and both endpoints
are actually readable. Read the text carefully: feet/inches use ft (e.g. 12'-6\" = 12.5 ft).
Endpoints are the measured span's extension-line intersections, not the text's bounding box.
Labels such as 100 AMP, room IDs, table counts, angles and a paper ratio without a scale bar
are NOT measurements. Prefer long unambiguous spans. If unreadable, return no references.
"""


def to_pixels(observation, provider, size, offset=(0, 0), factor=1):
    """Local pixels/normalized -> canonical pixels, including thickness and crop origin."""
    data = observation.model_dump()
    if "furniture" in data:
        physical = []
        for item in data["furniture"]:
            kind = item.pop("kind", "furniture")
            if kind == "furniture":
                physical.append(item)
            else:
                data["warnings"].append(f"{item['id']}: {kind} retained in stage observations, excluded from physical furniture.")
        data["furniture"] = physical
    if "scale_references" in data:
        verified = []
        margin = 2 if provider != "gemini" else 2*1000/min(size)
        limitx,limity = (1000,1000) if provider=="gemini" else size
        for ref in data["scale_references"]:
            visible = ref.pop("fully_visible",True)
            legible = ref.pop("legible",True)
            interior = all(margin < ref[key]["x"] < limitx-margin and margin < ref[key]["y"] < limity-margin
                           for key in ("start","end"))
            if visible and legible and interior:
                verified.append(ref)
            else:
                data["warnings"].append(f"Rejected incomplete/unreadable scale span: {ref['label']}.")
        data["scale_references"] = verified
    for row in data.pop("round_table_rows", []):
        # Compact observations expand before the affine transform. Radius uses
        # the same isotropic convention as thickness, not independent x/y units.
        rx, ry = ((row["radius"] * min(size) / size[0], row["radius"] * min(size) / size[1])
                  if provider == "gemini" else (row["radius"], row["radius"]))
        for index in range(row["count"]):
            t = index / max(1, row["count"]-1)
            cx = row["first"]["x"] * (1-t) + row["last"]["x"] * t
            cy = row["first"]["y"] * (1-t) + row["last"]["y"] * t
            data["furniture"].append({"id": f"{row['id']}_{index+1}", "label": "Round banquet table",
                "polygon": [{"x":cx+rx*math.cos(i*math.pi/6), "y":cy+ry*math.sin(i*math.pi/6)} for i in range(12)]})
    sx, sy = (size[0] / 1000, size[1] / 1000) if provider == "gemini" else (1, 1)
    def point(p):
        return {"x": p["x"] * sx * factor + offset[0], "y": p["y"] * sy * factor + offset[1]}
    if "floor_outline" in data:
        data["floor_outline"] = [point(p) for p in data["floor_outline"]]
    for name in ("rooms", "furniture", "exits"):
        for item in data.get(name, []):
            item["polygon"] = [point(p) for p in item["polygon"]]
    for name in ("walls", "doors", "scale_references"):
        for item in data.get(name, []):
            item["start"], item["end"] = point(item["start"]), point(item["end"])
            if name == "walls":
                item["thickness"] *= (min(size) / 1000 if provider == "gemini" else 1) * factor
    for item in data.get("scale_windows", []):
        origin = point(item)
        item.update(origin, width=item["width"] * sx * factor, height=item["height"] * sy * factor)
    return data


def for_provider(drawing, provider, size):
    if provider != "gemini":
        return drawing
    # Reuse the inverse affine transform, including the normalized thickness convention.
    data = drawing.model_dump()
    def point(p):
        return {"x": p["x"] * 1000 / size[0], "y": p["y"] * 1000 / size[1]}
    data["floor_outline"] = [point(p) for p in data["floor_outline"]]
    for name in ("rooms", "furniture", "exits"):
        for item in data[name]:
            item["polygon"] = [point(p) for p in item["polygon"]]
    for name in ("walls", "doors", "scale_references"):
        for item in data[name]:
            item["start"], item["end"] = point(item["start"]), point(item["end"])
            if name == "walls":
                item["thickness"] *= 1000 / min(size)
    return ExtractedDrawing.model_validate(data)


def tiles(size, floor, core_size=CORE):
    width, height = size
    result = []
    halo = min(HALO, core_size // 6)
    for y in range(0, height, core_size):
        for x in range(0, width, core_size):
            core = (x, y, min(width, x + core_size), min(height, y + core_size))
            if floor.intersection(box(*core)).area < 100:
                continue
            crop = (max(0, x-halo), max(0, y-halo), min(width, x+core_size+halo), min(height, y+core_size+halo))
            result.append((core, crop))
    if len(result) > MAX_TILES:
        raise ProviderError("This drawing needs too many detailed regions. Upload a single floor or a smaller image.")
    return result


def _point(p):
    return (p["x"], p["y"])


def _region(item):
    return Polygon([_point(p) for p in item["polygon"]])


def _line(item):
    return LineString([_point(item["start"]), _point(item["end"])])


def same_wall(a, b):
    """Overlapping collinear observations, excluding adjacent parallel walls."""
    first, second = _line(a), _line(b)
    av = [a["end"][k] - a["start"][k] for k in ("x", "y")]
    bv = [b["end"][k] - b["start"][k] for k in ("x", "y")]
    cosine = abs(sum(x*y for x,y in zip(av,bv)) / (first.length*second.length))
    if cosine < math.cos(math.radians(3)):
        return False
    tolerance = max(1.5, min(a["thickness"], b["thickness"]) * .4)
    # Infinite-line distance, not distance to an endpoint of a shorter fragment.
    distances = [abs(av[0]*(p["y"]-a["start"]["y"])-av[1]*(p["x"]-a["start"]["x"])) / first.length
                 for p in (b["start"], b["end"])]
    if max(distances) > tolerance:
        return False
    spans = [sum((p[k]-a["start"][k])*v for k,v in zip(("x","y"),av))/first.length
             for p in (b["start"],b["end"])]
    overlap = min(first.length,max(spans)) - max(0,min(spans))
    return overlap >= min(first.length,second.length) * .3


def extend_wall(existing, observation):
    line = _line(existing)
    origin = _point(existing["start"])
    direction = [(existing["end"][k]-existing["start"][k])/line.length for k in ("x","y")]
    spans = [0, line.length, *[sum((p[k]-origin[i])*direction[i] for i,k in enumerate(("x","y")))
        for p in (observation["start"],observation["end"])]]
    existing["start"] = {k: origin[i] + min(spans)*direction[i] for i,k in enumerate(("x","y"))}
    existing["end"] = {k: origin[i] + max(spans)*direction[i] for i,k in enumerate(("x","y"))}


def merge(structure, details, references, size):
    """Deterministic overlap/ID reconciliation; never fill an aisle to join objects."""
    notes = list(structure["warnings"])
    floor = Polygon([_point(p) for p in structure["floor_outline"]])
    if not floor.is_valid or floor.area < 100:
        raise ProviderError("The structure pass produced an invalid building boundary. Try the other provider.")
    if not box(0, 0, *size).buffer(.5).covers(floor):
        raise ProviderError("The structure pass placed the building outside the image.")
    data = {key: structure[key] for key in ("name", "floor_outline", "rooms", "walls", "doors", "exits")}
    data.update(furniture=[], scale_references=references, scale_objects=[], warnings=[])
    # Namespace IDs; every detail door retains its actual parent through wall deduplication.
    batches = [("overview", structure, None)] + [(f"tile_{i}", d, core) for i, (d, core) in enumerate(details)]
    data["walls"], data["doors"], data["exits"] = [], [], []
    furniture_shapes, exit_shapes = [], []
    removed = {"duplicate_furniture": 0, "duplicate_walls": 0, "invalid_geometry": 0, "clipped_walls": 0}
    for prefix, batch, core in batches:
        wall_ids, object_ids = {}, {}
        for item in batch.get("walls", []):
            line = _line(item)
            if line.length < 2 or item["thickness"] > min(size) * .03:
                removed["invalid_geometry"] += 1
                continue
            # A wall footprint must lie inside the building. Trim only the part
            # outside its usable inner envelope, keeping every long connected part.
            safe = floor.buffer(-item["thickness"] / 2 - .05)
            clipped = line.intersection(safe)
            if clipped.geom_type != "LineString" or clipped.length < 2:
                notes.append(f"Review {prefix}:{item['id']}: wall crosses the extracted boundary and could not be retained as one segment.")
                removed["invalid_geometry"] += 1
                continue
            if clipped.length < .98 * line.length:
                removed["clipped_walls"] += 1
            coords = list(clipped.coords)
            item = {**item, "start": {"x": coords[0][0], "y": coords[0][1]},
                    "end": {"x": coords[-1][0], "y": coords[-1][1]}}
            match = next((w for w in data["walls"] if same_wall(w, item)), None)
            if match:
                extended = dict(match)
                extend_wall(extended, item)
                if floor.buffer(-match["thickness"]/2-.05).covers(_line(extended)):
                    match.update(extended)
                wall_ids[item["id"]] = match["id"]
                removed["duplicate_walls"] += 1
            else:
                identifier = f"{prefix}_{item['id']}"
                wall_ids[item["id"]] = identifier
                data["walls"].append({**item, "id": identifier})
        for item in batch.get("doors", []):
            parent = wall_ids.get(item["wall_id"])
            if not parent:
                notes.append(f"Review {prefix}:{item['id']}: no usable parent wall for the observed door.")
                continue
            wall = next(w for w in data["walls"] if w["id"] == parent)
            line = _line(wall)
            if max(Point(_point(item[k])).distance(line) for k in ("start", "end")) > max(3, wall["thickness"]):
                notes.append(f"Review {prefix}:{item['id']}: door jambs do not match their wall.")
                continue
            projected = [line.interpolate(line.project(Point(_point(item[k])))) for k in ("start", "end")]
            if projected[0].distance(projected[1]) < 2:
                continue
            candidate = {**item, "id": f"{prefix}_{item['id']}", "wall_id": parent,
                "start": {"x": projected[0].x, "y": projected[0].y}, "end": {"x": projected[1].x, "y": projected[1].y}}
            existing = next((d for d in data["doors"] if _line(d).hausdorff_distance(_line(candidate)) < 3), None)
            if existing:
                object_ids[item["id"]] = existing["id"]
            else:
                data["doors"].append(candidate)
                object_ids[item["id"]] = candidate["id"]
        for name, shapes in (("furniture", furniture_shapes), ("exits", exit_shapes)):
            for item in batch.get(name, []):
                shape = _region(item)
                if not shape.is_valid or shape.area < 1 or not box(0, 0, *size).buffer(.5).covers(shape):
                    removed["invalid_geometry"] += 1
                    continue
                if name == "furniture":
                    if not floor.covers(shape):
                        removed["invalid_geometry"] += 1
                        continue
                    if core:
                        cx, cy = shape.centroid.coords[0]
                        # Half-open ownership makes exactly one crop responsible.
                        if not (core[0] <= cx < core[2] and core[1] <= cy < core[3]):
                            continue
                elif shape.distance(floor.boundary) > max(6, math.sqrt(shape.area)):
                    notes.append(f"Review {prefix}:{item['id']}: interior exit marker omitted.")
                    continue
                match = next((i for i, other in enumerate(shapes)
                    if shape.intersection(other).area / min(shape.area, other.area) > (.4 if name == "exits" else .75)
                    and min(shape.area, other.area) / max(shape.area, other.area) > .5), None)
                if match is not None:
                    object_ids[item["id"]] = data[name][match]["id"]
                    if name == "furniture":
                        removed["duplicate_furniture"] += 1
                    continue
                identifier = f"{prefix}_{item['id']}"
                data[name].append({**item, "id": identifier})
                shapes.append(shape)
                object_ids[item["id"]] = identifier
        for obj in batch.get("scale_objects", []):
            if obj["object_id"] in object_ids and len(data["scale_objects"]) < 30:
                data["scale_objects"].append({**obj, "object_id": object_ids[obj["object_id"]]})
        if prefix != "overview":
            notes.extend(f"{prefix}: {note}" for note in batch.get("warnings", []))
    if removed["invalid_geometry"]:
        notes.insert(0, f"Review required: {removed['invalid_geometry']} invalid/out-of-bound observations were omitted; inspect the overlay before simulation.")
    if removed["clipped_walls"]:
        notes.insert(0, f"{removed['clipped_walls']} wall segments were trimmed to the extracted building boundary; review their endpoints.")
    if not data["exits"]:
        notes.insert(0, "No reliable exterior exit opening was recovered. Add or correct exits before running.")
    data["warnings"] = list(dict.fromkeys(notes))[:30]
    return ExtractedDrawing.model_validate(data), removed


def anchor_exit(drawing, identifier, start, end):
    """Refine a short boundary section using independently observed door jambs.

    This moves the approximate outline to image evidence, rather than moving a
    door to a guessed position on that outline. Reject large or invalid edits.
    """
    data = drawing.model_dump()
    vertices = [_point(p) for p in data["floor_outline"]]
    opening = LineString([start, end])
    if opening.length < 2:
        return False
    middle = opening.interpolate(.5, normalized=True)
    index = min(range(len(vertices)), key=lambda i: LineString([vertices[i],vertices[(i+1)%len(vertices)]]).distance(middle))
    edge = LineString([vertices[index],vertices[(index+1)%len(vertices)]])
    if opening.distance(edge) > max(12, opening.length * .5):
        return False
    spans = sorted((edge.project(Point(p)), p) for p in (start,end))
    if spans[1][0]-spans[0][0] < opening.length * .8:
        return False
    margin = min(15, opening.length/2)
    before = edge.interpolate(max(0,spans[0][0]-margin)).coords[0]
    after = edge.interpolate(min(edge.length,spans[1][0]+margin)).coords[0]
    replacement = [before,spans[0][1],spans[1][1],after]
    candidate = vertices[:index+1]+replacement+vertices[index+1:]
    candidate = [p for i,p in enumerate(candidate) if i==0 or math.dist(p,candidate[i-1])>1e-5]
    if len(candidate)>300:
        return False
    shape, old = Polygon(candidate), Polygon(vertices)
    if not shape.is_valid or abs(shape.area-old.area) > old.area*.02:
        return False
    drawing.floor_outline = [DrawingPoint(x=x,y=y) for x,y in candidate]
    nx,ny = -(end[1]-start[1])/opening.length, (end[0]-start[0])/opening.length
    marker = next(item for item in drawing.exits if item.id==identifier)
    marker.polygon = [DrawingPoint(x=p[0]+sign*nx,y=p[1]+sign*ny)
        for p,sign in ((start,1),(end,1),(end,-1),(start,-1))]
    return True


def extract_staged(provider, image_bytes, width, height, directory: Path, progress=None):
    started = time.monotonic()
    directory.mkdir(parents=True, exist_ok=True)
    source = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    calls = []
    if source.size != (width, height):
        raise ValueError("Stored image dimensions do not match its metadata")
    def report(message):
        if progress:
            progress(message)
    def call(name, image, task, schema):
        if time.monotonic()-started >= PIPELINE_TIME_BUDGET:
            raise ProviderError("The staged import exceeded its processing budget. Try the other provider or a smaller floor plan.")
        calls.append(name)
        report(name.replace("_", " "))
        observed, model = extract_structured(provider, png(image), COMMON + coordinate_prompt(provider, *image.size) + "\n" + task, schema)
        (directory / f"{name}.json").write_text(observed.model_dump_json(indent=2))
        image.save(directory / f"{name}.png")
        return observed, model
    overview = source.copy()
    overview.thumbnail((1092, 1092), Image.Resampling.LANCZOS)
    observed, model = call("structure", overview, STRUCTURE, Structure)
    # Aspect ratio rounding is accounted for separately on each axis.
    structure = to_pixels(observed, provider, overview.size)
    xfactor, yfactor = width / overview.width, height / overview.height
    # Exact inverse resize, not one guessed common factor.
    def resize_structure(data):
        for p in data["floor_outline"]:
            p["x"] *= xfactor; p["y"] *= yfactor
        for name in ("rooms", "exits"):
            for r in data[name]:
                for p in r["polygon"]:
                    p["x"] *= xfactor; p["y"] *= yfactor
        for name in ("walls", "doors"):
            for item in data[name]:
                for key in ("start", "end"):
                    item[key]["x"] *= xfactor; item[key]["y"] *= yfactor
                if name == "walls": item["thickness"] *= min(xfactor, yfactor)
        for window in data["scale_windows"]:
            window["x"] *= xfactor; window["width"] *= xfactor
            window["y"] *= yfactor; window["height"] *= yfactor
    resize_structure(structure)
    floor = Polygon([_point(p) for p in structure["floor_outline"]])
    if not floor.is_valid:
        raise ProviderError("The structure pass produced a self-intersecting boundary. Try the other provider.")
    regions = tiles(source.size, floor, 384 if structure["dense_furniture"] else CORE)
    work = []
    for i, window in enumerate(structure["scale_windows"]):
        # Overview suggestions often locate the text rather than the entire
        # measured span. Include a generous halo to recover both extension lines.
        padx,pady = max(100,window["width"]*.4),max(60,window["height"]*.5)
        bounds = (max(0, math.floor(window["x"]-padx)), max(0, math.floor(window["y"]-pady)),
            min(width, math.ceil(window["x"]+window["width"]+padx)), min(height, math.ceil(window["y"]+window["height"]+pady)))
        if bounds[2] <= bounds[0] or bounds[3] <= bounds[1]: continue
        work.append((f"scale_{i+1}", bounds, None, SCALE, ScaleReadings))
    if not work:
        structure["warnings"].append("The overview found no readable printed dimension span; object-scale estimation will be attempted.")
    for i, (core, bounds) in enumerate(regions):
        work.append((f"detail_{i+1}", bounds, core, DETAILS, Details))
    details, references, failures = {}, [], []
    def run(task):
        name, bounds, core, prompt, schema = task
        crop = source.crop(bounds)
        # Stage inputs stay inside both providers' native small-image budget.
        original_size = crop.size
        crop.thumbnail((1092, 1092), Image.Resampling.LANCZOS)
        if max(crop.size) < 1000:
            magnification = 1000 / max(crop.size)
            crop = crop.resize(tuple(round(side*magnification) for side in crop.size), Image.Resampling.LANCZOS)
        obs, _ = call(name, crop, prompt, schema)
        converted = to_pixels(obs, provider, crop.size)
        # Re-express local results in exact source pixels, then translate.
        sx, sy = original_size[0] / crop.width, original_size[1] / crop.height
        def convert(p):
            p["x"] = p["x"] * sx + bounds[0]; p["y"] = p["y"] * sy + bounds[1]
        for key in ("furniture", "exits"):
            for item in converted.get(key, []):
                for p in item["polygon"]: convert(p)
        for key in ("walls", "doors", "scale_references"):
            for item in converted.get(key, []):
                convert(item["start"]); convert(item["end"])
                if key == "walls": item["thickness"] *= min(sx, sy)
        return name, converted, core
    # Two requests at a time; total calls <= 1 + 2 scale + 16 detail.
    report(f"Reading {len(regions)} detail regions and {len(work)-len(regions)} scale regions")
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = {pool.submit(run, task): task[0] for task in work}
        for future in as_completed(futures):
            name = futures[future]
            try:
                _, converted, core = future.result()
                if core is None:
                    references.extend(converted["scale_references"])
                    structure["warnings"].extend(converted["warnings"])
                else:
                    details[name] = (converted, core)
                    references.extend(converted["scale_references"])
            except (ProviderError, ValueError) as exc:
                failures.append({"stage": name, "error": str(exc)})
            report(f"Read {len(details)+len([f for f in futures if f.done() and futures[f].startswith('scale')])}/{len(work)} regions")
    # Missing detail regions may conceal obstacles or exits: do not silently
    # return an apparently complete, runnable layout.
    failed_detail = [failure for failure in failures if failure["stage"].startswith("detail")]
    report_data = {"pipeline_version": 1, "size": source.size, "overview_size": overview.size,
        "tile_count": len(regions), "calls": 1+len(work), "failures": failures,
        "tiles": [{"core": core, "crop": bounds} for core, bounds in regions]}
    (directory / "report.json").write_text(json.dumps(report_data, indent=2))
    if failed_detail:
        raise ProviderError(f"{len(failed_detail)} detail regions could not be read. No complete layout was imported. " + failed_detail[0]["error"])
    structure["warnings"].extend(f"Scale pass unavailable: {f['error']}" for f in failures)
    report("Merging geometry and checking overlaps")
    drawing, removed = merge(structure, [details[name] for name in sorted(details)], references[:20], source.size)
    # One independent structure review, bounded rather than recursive retries.
    # The reviewer sees the actual overview and localized consistency failures.
    boundary = Polygon([_point(p) for p in drawing.model_dump()["floor_outline"]]).boundary
    misplaced = [item.id for item in drawing.exits if _region(item.model_dump()).centroid.distance(boundary) > 4]
    if misplaced or removed["clipped_walls"] or (len(drawing.walls) > 5 and not drawing.doors):
        report("Reviewing boundary, exits and missing door openings")
        feedback = ("STAGE: independent STRUCTURE correction. The first pass had these consistency problems: "
            + json.dumps({"exit_markers_far_from_boundary": misplaced,
                "trimmed_walls": removed["clipped_walls"], "interior_doors_found": len(drawing.doors)})
            + ". Reinspect the actual drawing. Trace the real exterior wall accurately including entrance vestibules, "
            "put exits ON their actual threshold, and recover clear interior door openings. "
            "Do not add guessed doors merely to satisfy a count. Do not treat dimension lines, room label "
            "leaders, or diagonals inside rooms as walls. Return the corrected COMPLETE structure.\n" + STRUCTURE)
        try:
            review, _ = call("structure_review", overview, feedback, Structure)
            revised = to_pixels(review, provider, overview.size)
            resize_structure(revised)
            drawing, removed = merge(revised, [details[name] for name in sorted(details)], references[:20], source.size)
            report_data["structure_review"] = True
        except (ProviderError, ValueError) as exc:
            report_data["structure_review_error"] = str(exc)
            drawing.warnings = (["Structure review was unavailable; inspect boundary and door openings."] + drawing.warnings)[:30]
    # A global outline can be a few pixels off a real entrance on a curved plan.
    # Reinspect at native detail before changing that outline. Bounded to four
    # uncertain exits; unresolved observations remain explicit review warnings.
    exit_reviews = []
    for marker in drawing.exits:
        boundary = Polygon([(p.x,p.y) for p in drawing.floor_outline]).boundary
        shape = _region(marker.model_dump())
        if shape.centroid.distance(boundary) <= 4 or len(exit_reviews) >= 4:
            continue
        minx,miny,maxx,maxy = shape.bounds
        margin = max(60, max(maxx-minx,maxy-miny))
        bounds = (max(0,math.floor(minx-margin)),max(0,math.floor(miny-margin)),
            min(width,math.ceil(maxx+margin)),min(height,math.ceil(maxy+margin)))
        crop = source.crop(bounds)
        native_size = crop.size
        magnification = 1000 / max(crop.size)
        crop = crop.resize(tuple(round(side*magnification) for side in crop.size),Image.Resampling.LANCZOS)
        task = ("STAGE: verify ONE exterior doorway in this crop. The tentative opening is near the center. "
            "Find the two jambs on its actual exterior-wall threshold, excluding door swing arcs. "
            "Return found=false if there is no clearly visible exterior opening; never invent a gap from text. "
            "For a contiguous exterior bank of doors, return the full clear bank's jambs. "
            "Do not use crop edges or interior passages as exterior doors.")
        record = {"id":marker.id}
        try:
            reviewed,_ = call(f"exit_review_{len(exit_reviews)+1}",crop,task,ExitThreshold)
            if reviewed.found:
                sx,sy = ((native_size[0]/1000,native_size[1]/1000) if provider=="gemini"
                         else (native_size[0]/crop.width,native_size[1]/crop.height))
                start=(reviewed.start.x*sx+bounds[0],reviewed.start.y*sy+bounds[1])
                end=(reviewed.end.x*sx+bounds[0],reviewed.end.y*sy+bounds[1])
                in_frame = all(0<=p[0]<=width and 0<=p[1]<=height for p in (start,end))
                record["anchored"] = in_frame and anchor_exit(drawing,marker.id,start,end)
            else:
                record["anchored"] = False
            if not record["anchored"]:
                drawing.warnings.insert(0,f"Review exterior exit {marker.id}: local image evidence could not safely refine its threshold.")
            if reviewed.warning:
                drawing.warnings.append(f"{marker.id}: {reviewed.warning}")
        except (ProviderError, ValueError) as exc:
            record["error"] = str(exc)
            drawing.warnings.insert(0,f"Local verification unavailable for exterior exit {marker.id}.")
        exit_reviews.append(record)
    drawing.warnings = drawing.warnings[:30]
    report_data["exit_reviews"] = exit_reviews
    report_data.update(merge=removed, counts={name: len(getattr(drawing, name)) for name in
        ("rooms", "walls", "doors", "exits", "furniture", "scale_references")},
        calls=len(calls), stages=calls, elapsed_seconds=round(time.monotonic()-started, 2))
    (directory / "report.json").write_text(json.dumps(report_data, indent=2))
    (directory / "canonical.json").write_text(drawing.model_dump_json(indent=2))
    return for_provider(drawing, provider, source.size), model
