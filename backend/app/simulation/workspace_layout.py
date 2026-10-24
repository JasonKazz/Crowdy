"""Lossless layout bridge: metres stay authoritative, pixels are only a view."""
import hashlib
import math

from shapely.geometry import Polygon
from shapely.ops import unary_union

from app.schemas.layout import ExitDoor, Layout, load_layout
from app.schemas.scenario import Population, Region
from app.services.floorplans.layout import compile_layout, wall_polygon
from app.services.floorplans.exits import exit_geometry


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


def native_to_editor(data, strict=True):
    layout = load_layout(data)
    if layout.population is None:
        layout.population = Population(count=len(layout.occupants), seed=42,
                                       spawn_area_ids=[area.id for area in layout.walkable_areas])
        layout.occupants = []
    issues = []
    try:
        compiled = compile_layout(layout)
        obstacles, exit_regions = compiled.obstacles, compiled.exits
    except ValueError as exc:
        if strict:
            raise
        issues.append(str(exc))
        # Rendering a draft does not authorize a run. Keep every original wall
        # and door in layout; simulation still uses the strict compiler.
        obstacles, exit_regions = list(layout.furniture), []
        for wall in layout.walls:
            length = math.dist(wall.start, wall.end)
            intervals = sorted((max(0, min(length, d.offset - d.width / 2)), max(0, min(length, d.offset + d.width / 2)))
                               for d in layout.doors if d.wall_id == wall.id)
            cursor = 0
            for start, end in [*intervals, (length, length)]:
                if start > cursor:
                    obstacles.append(Region(id=f"wall:{wall.id}:{cursor}", polygon=wall_polygon(wall, cursor, start)))
                cursor = max(cursor, end)
        floors = {floor.id: floor for floor in layout.walkable_areas}
        for door in layout.exits:
            if isinstance(door, ExitDoor):
                try:
                    exit_regions.append(exit_geometry(door, floors[door.floor_id], layout.agent_defaults.radius)[1])
                except (KeyError, ValueError, IndexError):
                    pass
            else:
                exit_regions.append(door)
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
    for region in exit_regions:
        centre = Polygon(region.polygon).centroid
        exits.append({"id": region.id, "label": region.id[:80], **pixel_point((centre.x, centre.y), transform)})
        zones.append({"id": region.id, "polygon": pixels(region.polygon)})
    # Invalid exterior doors must remain selectable in the editor even if a
    # valid outside removal strip cannot yet be generated.
    for door in layout.exits:
        if not any(item["id"] == door.id for item in exits) and isinstance(door, ExitDoor):
            floor = next((f for f in layout.walkable_areas if f.id == door.floor_id), None)
            point = floor.polygon[door.edge_index % len(floor.polygon)] if floor else (0, 0)
            exits.append({"id": door.id, "label": door.id[:80], **pixel_point(point, transform)})
    source = layout.source_image
    image = None
    if source:
        top_left = pixel_point((0, source.height_px * source.meters_per_pixel), transform)
        image = {"id": source.id, **top_left,
                 "width": source.width_px * source.meters_per_pixel * transform["pixels_per_metre"],
                 "height": source.height_px * source.meters_per_pixel * transform["pixels_per_metre"]}
    from app.services.population.rooms import native_room_zones, pieces, zone_polygons
    room_zones, room_warnings = native_room_zones(layout)
    room_views = [{"id": room.id, "label": room.label[:80], "room_type": room.room_type,
                   "source": room.source, "area": room.shape.area,
                   "polygon": pixels(list(max(pieces(room.shape), key=lambda p: p.area).exterior.coords)[:-1]),
                   "rings": zone_polygons(room.shape, lambda p: pixel_point(p, transform))}
                  for room in room_zones if not room.shape.is_empty]
    return {"id": "layout-" + hashlib.sha256(layout.name.encode()).hexdigest()[:16],
            "name": layout.name[:80], "width": 900, "height": 600,
            "area": unary_union([Polygon(r.polygon) for r in layout.walkable_areas]).area,
            "items": items, "walls": [], "exits": exits, "rooms": room_views,
            "native": {"layout": layout.model_dump(mode="json"), "transform": transform,
                       "floors": [pixels(r.polygon) for r in layout.walkable_areas],
                       "walls": [pixels(r.polygon) for r in obstacles if r.id not in furniture_ids],
                       "exit_zones": zones, "issues": issues, "image": image,
                       "room_warnings": room_warnings}}


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
