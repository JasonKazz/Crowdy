"""Lossless layout bridge: metres stay authoritative, pixels are only a view."""
import hashlib
import math

from shapely.geometry import Polygon
from shapely.ops import unary_union

from app.schemas.layout import Layout, load_layout
from app.schemas.scenario import Population, Region
from app.services.floorplans.layout import compile_layout


def projection(layout):
    points = [p for floor in layout.walkable_areas for p in floor.polygon]
    left, right = min(p[0] for p in points), max(p[0] for p in points)
    bottom, top = min(p[1] for p in points), max(p[1] for p in points)
    if right <= left or top <= bottom:
        raise ValueError("The floor outline needs positive width and height")
    scale = min(760 / (right - left), 460 / (top - bottom))
    return {"pixels_per_metre": scale, "offset_x": 450 - (left + right) * scale / 2,
            "offset_y": 300 + (bottom + top) * scale / 2}


def pixel_point(point, transform):
    return {"x": point[0] * transform["pixels_per_metre"] + transform["offset_x"],
            "y": transform["offset_y"] - point[1] * transform["pixels_per_metre"]}


def world_point(x, y, transform):
    return ((x - transform["offset_x"]) / transform["pixels_per_metre"],
            (transform["offset_y"] - y) / transform["pixels_per_metre"])


def native_to_editor(data):
    layout = load_layout(data)
    if layout.population is None:
        layout.population = Population(count=len(layout.occupants), seed=42,
                                       spawn_area_ids=[area.id for area in layout.walkable_areas])
        layout.occupants = []
    compiled = compile_layout(layout)
    transform = projection(layout)
    pixels = lambda points: [pixel_point(point, transform) for point in points]
    items = []
    for region in layout.furniture:
        points = pixels(region.polygon)
        x, y = min(p["x"] for p in points), min(p["y"] for p in points)
        width, height = max(p["x"] for p in points) - x, max(p["y"] for p in points) - y
        if width <= 0 or height <= 0:
            raise ValueError(f"Furniture '{region.id}' has no area")
        items.append({"id": region.id, "label": region.id[:80],
                      "kind": "desk" if "desk" in region.id.lower() else "obstacle",
                      "x": x, "y": y, "width": width, "height": height,
                      "polygon": [{"x": (p["x"] - x) / width, "y": (p["y"] - y) / height} for p in points]})
    furniture_ids = {region.id for region in layout.furniture}
    exits = []
    zones = []
    for region in compiled.exits:
        centre = Polygon(region.polygon).centroid
        exits.append({"id": region.id, "label": region.id[:80], **pixel_point((centre.x, centre.y), transform)})
        zones.append({"id": region.id, "polygon": pixels(region.polygon)})
    return {"id": "layout-" + hashlib.sha256(layout.name.encode()).hexdigest()[:16],
            "name": layout.name[:80], "width": 900, "height": 600,
            "area": unary_union([Polygon(r.polygon) for r in layout.walkable_areas]).area,
            "items": items, "walls": [], "exits": exits,
            "native": {"layout": layout.model_dump(mode="json"), "transform": transform,
                       "floors": [pixels(r.polygon) for r in layout.walkable_areas],
                       "walls": [pixels(r.polygon) for r in compiled.obstacles if r.id not in furniture_ids],
                       "exit_zones": zones}}


def editor_native_layout(plan):
    if plan.get("walls"):
        raise ValueError("For imported layouts, edit walls and doors in the source layout using the detailed editor")
    layout = Layout.model_validate(plan["native"]["layout"])
    transform = projection(layout)
    supplied = plan["native"]["transform"]
    if any(not math.isclose(supplied[key], value, rel_tol=1e-9, abs_tol=1e-7)
           for key, value in transform.items()):
        raise ValueError("The canvas scale no longer matches its source layout. Import the layout again.")
    if {e["id"] for e in plan["exits"]} != {e.id for e in layout.exits}:
        raise ValueError("Exit definitions no longer match the source layout")
    furniture = []
    for item in plan["items"]:
        points = item.get("polygon") or [{"x": 0, "y": 0}, {"x": 1, "y": 0},
                                         {"x": 1, "y": 1}, {"x": 0, "y": 1}]
        furniture.append(Region(id=item["id"], polygon=[world_point(
            item["x"] + p["x"] * item["width"], item["y"] + p["y"] * item["height"], transform) for p in points]))
    layout.furniture = furniture
    layout.occupants = []
    layout.population = Population(count=1, seed=42, spawn_area_ids=[r.id for r in layout.walkable_areas])
    return layout, transform
