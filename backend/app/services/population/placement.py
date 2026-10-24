"""Allocate a fixed total to rooms, then sample body-clear starting positions."""
import hashlib
import math
import random

from shapely.geometry import Point, Polygon
from shapely.ops import unary_union
from shapely.prepared import prep

from app.schemas.rooms import PopulationConfig
from app.services.population.rooms import allocate_counts, plan_room_zones, zone_polygons


def place_in_rooms(plan, settings, walkable, base_floor, exits, radius, metadata, layout=None):
    from app.simulation.editor_adapter import placement_access
    from app.simulation.workspace_layout import pixel_point
    config = PopulationConfig.model_validate(settings.get("population_config") or {})
    zones, warnings = plan_room_zones(plan, layout)
    clear = radius + .05
    spawn = walkable.intersection(base_floor).buffer(-clear)
    targets = unary_union([Polygon(exit.polygon) for exit in exits]).buffer(clear)
    spawn = spawn.difference(targets)
    # Match legacy automatic placement: require physical reachability to at
    # least one doorway, regardless of scenario closures. Blocking exits can
    # then legitimately trap occupants without changing their starting crowd.
    reachable, _ = placement_access(walkable, exits, radius)
    spawn = spawn.intersection(reachable)
    spaces = {zone.id: spawn.intersection(zone.shape) for zone in zones}
    counts, typed, building, activity = allocate_counts(zones, {key: shape.area for key, shape in spaces.items()},
        settings["occupancy"], config, layout.building_type if layout else "auto", plan["name"])
    positions, assignments, room_data = [], [], []
    if plan.get("native"):
        convert = lambda point: pixel_point(point, plan["native"]["transform"])
    else:
        convert = lambda point: {"x": point[0] * 32, "y": 600 - point[1] * 32}
    # Largest fixed allocations first reduce ordering failures in crowded zones.
    # Zones are disjoint, but enforce separation globally at shared boundaries.
    for zone in sorted(zones, key=lambda z: (-counts[z.id], z.id)):
        space, wanted = spaces[zone.id], counts[zone.id]
        seed = hashlib.sha256(f"rooms-v1:{settings.get('seed', 42)}:{zone.id}".encode()).digest()
        rng = random.Random(int.from_bytes(seed, "big"))
        placed = 0
        if wanted:
            prepared = prep(space)
            left, bottom, right, top = space.bounds
            for _ in range(max(8000, wanted * 1200)):
                candidate = (rng.uniform(left, right), rng.uniform(bottom, top))
                if not prepared.covers(Point(candidate)):
                    continue
                if any(math.dist(candidate, other) < 2 * radius + .05 for other in positions):
                    continue
                positions.append(candidate)
                assignments.append(zone.id)
                placed += 1
                if placed == wanted:
                    break
            if placed != wanted:
                raise ValueError(f"Could place only {placed} of {wanted} requested people in room '{zone.label}' with the selected body clearance. Reduce its room count or total occupancy, or review furniture and scale. No occupants were moved to another room.")
        if space.area < .1 and wanted == 0 and zone.shape.area > 1:
            warnings.append(f"'{zone.label}' has no usable body-clear spawn space connected to an exit; review room openings and furniture.")
        room_data.append({"id": zone.id, "label": zone.label, "room_type": typed[zone.id], "source": zone.source,
                          "area": round(zone.shape.area, 3), "usable_area": round(space.area, 3),
                          "count": wanted, "fixed": zone.id in config.room_counts,
                          "rings": zone_polygons(zone.shape, convert)})
    metadata.update(building_type=building, activity=activity,
                    rooms=sorted(room_data, key=lambda z: z["id"]), assignments=assignments, warnings=warnings)
    if any(zone.room_type == "unknown" for zone in zones):
        metadata["warnings"].append("Some room uses are inferred or unknown. Types and activity weights are editable assumptions, not measured occupancy.")
    return positions


def describe_existing(plan, settings, scenario, metadata, layout=None):
    """Describe pinned positions without regenerating or moving any person."""
    from app.services.population.rooms import resolve_context
    from app.simulation.workspace_layout import pixel_point
    zones, warnings = plan_room_zones(plan, layout)
    config = PopulationConfig.model_validate(settings.get("population_config") or {})
    typed, building, activity = resolve_context(zones, config, layout.building_type if layout else "auto", plan["name"])
    convert = (lambda point: pixel_point(point, plan["native"]["transform"])) if plan.get("native") else (lambda p: {"x":p[0]*32,"y":600-p[1]*32})
    counts = {z.id: 0 for z in zones}
    unassigned = 0
    for person in scenario.occupants:
        owner = next((z for z in zones if z.shape.covers(Point(person.position))), None)
        if owner is None:
            unassigned += 1
        else:
            counts[owner.id] += 1
    metadata.update(building_type=building,activity=activity,warnings=warnings,rooms=[{
        "id":z.id,"label":z.label,"room_type":typed[z.id],"source":z.source,"area":z.shape.area,
        "usable_area":0,"fixed":z.id in config.room_counts,"count":counts[z.id],
        "rings":zone_polygons(z.shape,convert)} for z in zones])
    if unassigned:
        metadata["rooms"].append({"id":"__pinned_unassigned__","label":"Pinned people outside current room zones",
            "room_type":"unknown","source":"baseline","area":0,"usable_area":0,"fixed":True,
            "count":unassigned,"rings":[]})
        metadata["warnings"].append("Some pinned positions fall outside the edited room zones (for example in a doorway). Their positions were retained.")
