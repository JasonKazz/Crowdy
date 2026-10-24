"""Deterministic room zones and activity-weighted occupancy.

Room polygons are semantic spawn zones; they never create walls or routes.
Unknown space remains visible, and uncertain classification remains adjustable.
"""
import math
import re
from dataclasses import dataclass

from shapely.geometry import LineString, Polygon
from shapely.ops import unary_union

from app.schemas.rooms import PopulationConfig


@dataclass
class RoomZone:
    id: str
    label: str
    room_type: str
    shape: object
    source: str = "extracted"


LABELS = [
    ("restroom", r"\b(restroom|toilet|bathroom|wc|lavatory)\b"),
    ("classroom", r"\b(classrooms?|class|lecture|lab|laboratory)\b"),
    ("meeting", r"\b(meetings?|conference|boardroom|breakout)\b"),
    ("cafeteria", r"\b(cafeteria|dining|canteen|lunch|break|coffee)\b"),
    ("kitchen", r"\b(kitchen|catering|pantry|prep)\b"),
    ("lounge", r"\b(lounge|living|relax|recreation|lean back)\b"),
    ("corridor", r"\b(corridor|hallway|passage|circulation|broadway)\b"),
    ("lobby", r"\b(lobby|reception|welcome|foyer|atrium)\b"),
    ("auditorium", r"\b(auditorium|theat(?:er|re)|assembly|pavilion|pavillion|ballroom|gym|event|venue)\b"),
    ("bedroom", r"\b(bedroom|dorm|sleep|suite)\b"),
    ("storage", r"\b(storage|closet|utility|mechanical|electrical|no access)\b"),
    ("office", r"\b(offices?|workspaces?|workstations?|desks?|study|staff)\b"),
]


def infer_room_type(label):
    text = re.sub(r"[_-]+", " ", label.lower())
    return next((kind for kind, pattern in LABELS if re.search(pattern, text)), "unknown")


def infer_building_type(types, name=""):
    types = list(types)
    if re.search(r"\b(school|college|university)\b", name.lower()):
        return "school"
    if re.search(r"\boffice\b", name.lower()):
        return "office"
    if types.count("classroom") >= 2 or ("classroom" in types and "office" not in types):
        return "school"
    if "bedroom" in types:
        return "residential"
    if "auditorium" in types:
        return "venue"
    if "office" in types or "meeting" in types:
        return "office"
    return "other"


def pieces(shape):
    if shape.is_empty:
        return []
    if shape.geom_type == "Polygon":
        return [shape]
    return [part for child in getattr(shape, "geoms", []) for part in pieces(child)]


def native_room_zones(layout):
    floor = unary_union([Polygon(region.polygon) for region in layout.walkable_areas])
    # Close known door cuts only for identifying occupancy zones. Actual wall
    # geometry, door gaps and movement remain entirely owned by the compiler.
    barriers = unary_union([LineString([wall.start, wall.end]).buffer(wall.thickness / 2 + .02,
                           cap_style=3) for wall in layout.walls])
    cells = sorted(pieces(floor.difference(barriers)), key=lambda p: (-p.area, p.bounds))
    zones, warnings = [], []
    claimed = Polygon()
    observations = sorted(layout.rooms, key=lambda r: (Polygon(r.polygon).area, r.id))
    for room in observations:
        shape = Polygon(room.polygon)
        if not shape.is_valid or shape.area <= 1e-6:
            warnings.append(f"Room '{room.id}' has an invalid outline and was left for automatic zoning.")
            continue
        clipped = shape.intersection(floor)
        if cells and not clipped.is_empty:
            cell = max(cells, key=lambda p: p.intersection(clipped).area)
            # Keep a room from spanning a known full partition. This only trims
            # occupancy labels; it cannot repair a missing physical wall/door.
            aligned = clipped.intersection(cell)
            if aligned.area >= clipped.area * .5:
                clipped = aligned
        clipped = clipped.difference(claimed)
        if clipped.area < .1:
            warnings.append(f"Room '{room.id}' overlaps another room or lies outside the floor; review its outline.")
            continue
        label = layout.room_labels.get(room.id) or room.id.replace("_", " ")
        kind = layout.room_types.get(room.id, "unknown")
        if kind == "unknown":
            kind = infer_room_type(label)
        zones.append(RoomZone(room.id, label, kind, clipped))
        claimed = claimed.union(clipped)
    # Recover genuinely enclosed spaces omitted by vision without adding any
    # invented walls. All remaining space is an explicit unassigned zone.
    reserved = {room.id for room in zones} | {room.id for room in layout.rooms}
    for index, cell in enumerate(cells):
        remaining = cell.difference(claimed)
        if remaining.area < 1 or remaining.area < .65 * cell.area or len(cells) < 2:
            continue
        identifier = f"__room_{index + 1}__"
        while identifier in reserved:
            identifier += "_"
        reserved.add(identifier)
        kind = "unknown"
        desk_count = sum(1 for item in layout.furniture if "desk" in item.id.lower()
                         and remaining.covers(Polygon(item.polygon).representative_point()))
        if desk_count:
            kind = "office"
        zones.append(RoomZone(identifier, f"Detected space {index + 1}", kind, remaining, "geometry"))
        claimed = claimed.union(remaining)
    remaining = floor.difference(barriers).difference(claimed)
    if remaining.area > .1 or not zones:
        identifier = "__other__"
        while identifier in reserved:
            identifier += "_"
        zones.append(RoomZone(identifier, "Other / circulation" if zones else "Open floor", "unknown", remaining,
                              "unassigned"))
    # Canonical room collection has a 100-room budget. Avoid accidental growth
    # from fragmented wall linework while retaining every leftover floor area.
    if len(zones) > 100:
        retained = zones[:99]
        retained.append(RoomZone("__overflow__", "Other space", "unknown",
                                 unary_union([room.shape for room in zones[99:]]), "unassigned"))
        zones = retained
        warnings.append("Small fragmented room zones were combined into Other space.")
    return zones, warnings


def plan_room_zones(plan, layout=None):
    if layout is not None:
        return native_room_zones(layout)
    from app.simulation.editor_adapter import pixel_to_metres
    zones = []
    for room in plan.get("rooms", []):
        shape = Polygon([pixel_to_metres(point["x"], point["y"]) for point in room["polygon"]])
        if not shape.is_valid or shape.area <= 0:
            raise ValueError(f"Room '{room['label']}' has an invalid outline")
        zones.append(RoomZone(room["id"], room["label"], room["room_type"], shape, "sample"))
    if not zones:
        walls = plan["walls"]
        xs = [w[k] for w in walls for k in ("x1", "x2")] or [0, 900]
        ys = [w[k] for w in walls for k in ("y1", "y2")] or [0, 600]
        from shapely.geometry import box
        a, b = pixel_to_metres(min(xs), max(ys)), pixel_to_metres(max(xs), min(ys))
        zones = [RoomZone("__other__", "Open floor", "unknown", box(*a, *b), "unassigned")]
    # Pixel plans can supply semantic zones. Give overlaps one deterministic
    # owner and retain uncovered floor so people are never duplicated/lost.
    from shapely.geometry import box
    walls = plan["walls"]
    xs = [w[k] for w in walls for k in ("x1", "x2")] or [0, 900]
    ys = [w[k] for w in walls for k in ("y1", "y2")] or [0, 600]
    a, b = pixel_to_metres(min(xs), max(ys)), pixel_to_metres(max(xs), min(ys))
    floor, claimed = box(*a, *b), Polygon()
    for zone in zones:
        zone.shape = zone.shape.intersection(floor).difference(claimed)
        claimed = claimed.union(zone.shape)
    rest = floor.difference(claimed)
    if rest.area > .1:
        zones.append(RoomZone("__other__", "Other / circulation", "unknown", rest, "unassigned"))
    return zones, []


PREFERENCES = {
    "workday": {"office": 8, "meeting": 1.5, "lounge": .5, "cafeteria": .3},
    "meeting": {"meeting": 12, "office": 1, "auditorium": 4},
    "lunch": {"cafeteria": 12, "lounge": 4, "kitchen": 1, "office": .5, "classroom": .4},
    "class_time": {"classroom": 12, "office": 1, "auditorium": .5},
    "passing_period": {"corridor": 12, "lobby": 8, "classroom": .6},
    "assembly": {"auditorium": 14, "lobby": 1, "classroom": .3},
    "event": {"auditorium": 12, "meeting": 4, "lobby": 2, "cafeteria": 1.5},
    "residential_day": {"lounge": 7, "kitchen": 3, "bedroom": 1},
    "residential_evening": {"bedroom": 8, "lounge": 3, "kitchen": 1},
}
DEFAULT_ACTIVITY = {"office": "workday", "school": "class_time", "venue": "event",
                    "residential": "residential_evening", "other": "workday"}


def resolve_context(zones, config, detected="auto", name=""):
    typed = {zone.id: config.room_types.get(zone.id, zone.room_type) for zone in zones}
    building = config.building_type if config.building_type != "auto" else detected
    if building == "auto":
        building = infer_building_type(typed.values(), name)
    activity = config.activity if config.activity != "auto" else DEFAULT_ACTIVITY[building]
    return typed, building, activity


def allocate_counts(zones, areas, total, config, detected="auto", name=""):
    known = {zone.id for zone in zones}
    unknown = (set(config.room_counts) | set(config.room_types)) - known
    if unknown:
        raise ValueError("Room settings reference missing rooms: " + ", ".join(sorted(unknown)) + ". Reset room overrides.")
    fixed = config.room_counts
    if sum(fixed.values()) > total:
        raise ValueError(f"Fixed room counts total {sum(fixed.values())}, exceeding the {total}-person crowd. Increase occupancy or reduce room counts.")
    typed, building, activity = resolve_context(zones, config, detected, name)
    weights = PREFERENCES[activity]
    counts = {zone.id: fixed.get(zone.id, 0) for zone in zones}
    for zone in zones:
        if counts[zone.id] and areas.get(zone.id, 0) < 1e-8:
            raise ValueError(f"Room '{zone.label}' has no body-clear space for {counts[zone.id]} people. Review walls, furniture or its outline.")
    eligible = [z for z in zones if z.id not in fixed and areas.get(z.id, 0) > 1e-8]
    remaining = total - sum(counts.values())
    if remaining and not eligible:
        raise ValueError(f"{remaining} people are unassigned. Unlock a room with Auto or make fixed room counts equal total occupancy.")
    scores = {}
    for zone in eligible:
        kind = typed[zone.id]
        preference = weights.get(kind, .05 if kind == "storage" else .15 if kind in ("corridor", "restroom") else 1)
        scores[zone.id] = areas[zone.id] * preference
    denominator = sum(scores.values())
    fractions = {identifier: remaining * score / denominator for identifier, score in scores.items()} if denominator else {}
    for identifier, value in fractions.items():
        counts[identifier] = math.floor(value)
    for identifier in sorted(fractions, key=lambda key: (-(fractions[key] - math.floor(fractions[key])), key))[:remaining - sum(counts[z.id] for z in eligible)]:
        counts[identifier] += 1
    return counts, typed, building, activity


def zone_polygons(shape, convert):
    # SVG evenodd rings retain holes, such as an open zone around a smaller room.
    return [[convert(tuple(p)) for p in ring.coords[:-1]] for part in pieces(shape)
            for ring in (part.exterior, *part.interiors)]
