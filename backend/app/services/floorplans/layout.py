"""Compile walls with door openings into the existing simulation format."""

import math

from shapely.geometry import LineString
from shapely.ops import unary_union

from app.schemas.layout import ExitDoor, Layout, Wall
from app.schemas.scenario import Region, Scenario
from app.services.floorplans.exits import exit_boundary, exit_geometry
from app.simulation.geometry import build_geometry, region_to_polygon


def wall_polygon(wall: Wall, start: float, end: float) -> list[tuple[float, float]]:
    length = math.dist(wall.start, wall.end)
    ux = (wall.end[0] - wall.start[0]) / length
    uy = (wall.end[1] - wall.start[1]) / length
    nx, ny = -uy * wall.thickness / 2, ux * wall.thickness / 2
    a = (wall.start[0] + ux * start, wall.start[1] + uy * start)
    b = (wall.start[0] + ux * end, wall.start[1] + uy * end)
    return [(a[0] + nx, a[1] + ny), (b[0] + nx, b[1] + ny),
            (b[0] - nx, b[1] - ny), (a[0] - nx, a[1] - ny)]


def compile_layout(layout: Layout) -> Scenario:
    # Revalidate interactive callers and leave their editable document untouched.
    layout = Layout.model_validate(layout.model_dump())
    if layout.source_image:
        if not layout.source_image.scale_confirmed:
            raise ValueError("Set the image scale using two points and a known distance before simulation.")
        if layout.extraction is None:
            raise ValueError("Extract a layout from the uploaded image before simulation.")
    if not layout.exits:
        raise ValueError("Add at least one exterior exit door before simulation.")
    floor = unary_union([region_to_polygon(r) for r in layout.walkable_areas])
    floors = {region.id: region for region in layout.walkable_areas}
    walkable_areas, exits, exit_openings = list(layout.walkable_areas), [], []
    exit_boundaries = list(layout.exit_boundaries)
    for door in layout.exits:
        if not isinstance(door, ExitDoor):
            exits.append(door)
            continue
        if door.floor_id not in floors:
            raise ValueError(f"Exit '{door.id}' references unknown floor '{door.floor_id}'")
        if door.width <= 2 * layout.agent_defaults.radius:
            raise ValueError(f"Exit '{door.id}' is too narrow for the configured people")
        if door.landing_depth <= 2 * layout.agent_defaults.radius + .22:
            raise ValueError(f"Exit '{door.id}' needs a deeper outside landing")
        apron, target, threshold = exit_geometry(door, floors[door.floor_id], layout.agent_defaults.radius)
        # Check the entire edge: a seam between overlapping floor regions is
        # not an exterior wall. Also reject aprons that enter another wing.
        points = floors[door.floor_id].polygon
        edge = LineString([points[door.edge_index], points[(door.edge_index + 1) % len(points)]])
        if not floor.boundary.buffer(1e-8).covers(edge):
            raise ValueError(f"Exit '{door.id}' must attach to an exterior floor edge")
        shape = region_to_polygon(apron)
        expected_overlap = door.width * 0.05
        if abs(shape.intersection(floor).area - expected_overlap) > 1e-7:
            raise ValueError(f"Exit '{door.id}' landing must lead outside without crossing another part of the building")
        if any(shape.intersection(previous).area > 1e-9 for _, previous in exit_openings):
            raise ValueError("Exterior exit landings must not overlap")
        if apron.id in floors:
            raise ValueError(f"Reserved floor ID '{apron.id}' conflicts with an exterior exit")
        walkable_areas.append(apron)
        exits.append(target)
        exit_boundaries.append(exit_boundary(door, floors[door.floor_id]))
        exit_openings.append((door.id, shape))
    walls = {wall.id: wall for wall in layout.walls}
    intervals = {wall.id: [] for wall in layout.walls}
    door_shapes = []
    for door in layout.doors:
        if door.wall_id not in walls:
            raise ValueError(f"Door '{door.id}' references unknown wall '{door.wall_id}'")
        wall = walls[door.wall_id]
        start, end = door.offset - door.width / 2, door.offset + door.width / 2
        length = math.dist(wall.start, wall.end)
        if start < 0 or end > length:
            raise ValueError(f"Door '{door.id}' extends past the ends of wall '{wall.id}'")
        intervals[wall.id].append((start, end, door.id))
        door_shapes.append((door.id, region_to_polygon(Region(
            id=door.id, polygon=wall_polygon(wall, start, end),
        ))))

    obstacles = list(layout.furniture)
    used_ids = {item.id for item in obstacles}
    for wall in layout.walls:
        full_wall = region_to_polygon(Region(
            id=wall.id, polygon=wall_polygon(wall, 0, math.dist(wall.start, wall.end)),
        ))
        if not floor.covers(full_wall):
            raise ValueError(f"Wall '{wall.id}' extends outside the floor")
        cursor = 0.0
        segments = []
        for start, end, door_id in sorted(intervals[wall.id]):
            if start < cursor:
                raise ValueError(f"Door '{door_id}' overlaps another door on wall '{wall.id}'")
            if start > cursor:
                segments.append((cursor, start))
            cursor = end
        length = math.dist(wall.start, wall.end)
        if cursor < length:
            segments.append((cursor, length))
        for index, (start, end) in enumerate(segments):
            identifier = f"wall:{wall.id}:{index}"
            while identifier in used_ids:
                identifier = "_" + identifier
            used_ids.add(identifier)
            obstacles.append(Region(id=identifier, polygon=wall_polygon(wall, start, end)))

    scenario = Scenario.model_validate({
        "name": layout.name, "units": layout.units,
        "walkable_areas": [r.model_dump() for r in walkable_areas],
        "obstacles": [r.model_dump() for r in obstacles],
        "exits": [r.model_dump() for r in exits],
        "exit_boundaries": [boundary.model_dump() for boundary in exit_boundaries],
        "occupants": [p.model_dump() for p in layout.occupants],
        "population": layout.population.model_dump() if layout.population else None,
        "agent_defaults": layout.agent_defaults.model_dump(),
        "settings": layout.settings.model_dump(),
    })
    walkable = build_geometry(scenario)
    for exit_id, shape in exit_openings:
        if shape.intersection(walkable).area < shape.area - 1e-8:
            raise ValueError(f"Exit '{exit_id}' opening is obstructed by furniture or a wall")
    for door_id, shape in door_shapes:
        # A piece of furniture or a crossing wall must not silently fill a door.
        if shape.intersection(walkable).area < shape.area - 1e-9:
            raise ValueError(f"Door '{door_id}' is obstructed by furniture or another wall")
    for index, exit_region in enumerate(scenario.exits):
        shape = region_to_polygon(exit_region)
        if any(shape.intersects(region_to_polygon(other)) for other in scenario.exits[:index]):
            raise ValueError("Exit regions must not overlap or touch")
    return scenario
