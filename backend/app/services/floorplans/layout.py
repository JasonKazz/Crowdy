"""Compile walls with door openings into the existing simulation format."""

import math

from shapely.ops import unary_union

from app.schemas.layout import Layout, Wall
from app.schemas.scenario import Region, Scenario
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
    floor = unary_union([region_to_polygon(r) for r in layout.walkable_areas])
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
        "walkable_areas": [r.model_dump() for r in layout.walkable_areas],
        "obstacles": [r.model_dump() for r in obstacles],
        "exits": [r.model_dump() for r in layout.exits],
        "occupants": [p.model_dump() for p in layout.occupants],
        "population": layout.population.model_dump() if layout.population else None,
        "agent_defaults": layout.agent_defaults.model_dump(),
        "settings": layout.settings.model_dump(),
    })
    walkable = build_geometry(scenario)
    for door_id, shape in door_shapes:
        # A piece of furniture or a crossing wall must not silently fill a door.
        if shape.intersection(walkable).area < shape.area - 1e-9:
            raise ValueError(f"Door '{door_id}' is obstructed by furniture or another wall")
    for index, exit_region in enumerate(scenario.exits):
        shape = region_to_polygon(exit_region)
        if any(shape.intersects(region_to_polygon(other)) for other in scenario.exits[:index]):
            raise ValueError("Exit regions must not overlap or touch")
    return scenario
