"""Compile walls with door openings into the existing simulation format."""

import math

from shapely.geometry import LineString, Point, Polygon
from shapely.ops import unary_union

from app.schemas.layout import ExitDoor, Layout, Wall
from app.schemas.scenario import Region, Scenario
from app.services.floorplans.exits import exit_boundary, exit_geometry
from app.simulation.geometry import GEOMETRY_TOLERANCE, build_geometry, region_to_polygon


def wall_polygon(wall: Wall, start: float, end: float) -> list[tuple[float, float]]:
    length = math.dist(wall.start, wall.end)
    ux = (wall.end[0] - wall.start[0]) / length
    uy = (wall.end[1] - wall.start[1]) / length
    nx, ny = -uy * wall.thickness / 2, ux * wall.thickness / 2
    a = (wall.start[0] + ux * start, wall.start[1] + uy * start)
    b = (wall.start[0] + ux * end, wall.start[1] + uy * end)
    return [(a[0] + nx, a[1] + ny), (b[0] + nx, b[1] + ny),
            (b[0] - nx, b[1] - ny), (a[0] - nx, a[1] - ny)]


def _only_boundary_endcaps_protrude(wall: Wall, footprint, floor, endpoint_tolerance=GEOMETRY_TOLERANCE) -> bool:
    """Allow a local thickness overhang where an interior wall meets an edge."""
    centerline = LineString([wall.start, wall.end])
    if not floor.buffer(endpoint_tolerance).covers(centerline):
        return False
    endpoints = [Point(wall.start), Point(wall.end)]
    contacts = [point for point in endpoints
                if point.distance(floor.boundary) <= wall.thickness / 2 + endpoint_tolerance]
    if not contacts:
        return False
    # A centerline on the exterior edge is still an invalid interior wall.
    # Intermediate boundary contacts (including a concave notch) need review.
    endpoint_regions = unary_union([point.buffer(endpoint_tolerance) for point in endpoints])
    if not centerline.intersection(floor.boundary).difference(endpoint_regions).is_empty:
        return False
    if not centerline.difference(floor.buffer(GEOMETRY_TOLERANCE)).difference(endpoint_regions).is_empty:
        return False
    # Reject long strips along a nearby boundary. Clipping is limited to one
    # physical wall thickness around an endpoint whose thickness reaches an edge.
    caps = unary_union([point.buffer(wall.thickness + endpoint_tolerance) for point in contacts])
    return caps.covers(footprint.difference(floor.buffer(GEOMETRY_TOLERANCE)))


def compile_layout(layout: Layout) -> Scenario:
    # Revalidate interactive callers and leave their editable document untouched.
    layout = Layout.model_validate(layout.model_dump())
    if layout.source_image:
        estimated = layout.source_image.calibration and layout.source_image.calibration.method == "estimated"
        if not layout.source_image.scale_confirmed and not estimated:
            raise ValueError("Set the image scale using two points and a known distance before simulation.")
        if layout.extraction is None:
            raise ValueError("Extract a layout from the uploaded image before simulation.")
    if not layout.exits:
        raise ValueError("Add at least one exterior exit door before simulation.")
    floor = unary_union([region_to_polygon(r) for r in layout.walkable_areas])
    floors = {region.id: region for region in layout.walkable_areas}
    walkable_areas, exits, exit_openings, thresholds = list(layout.walkable_areas), [], [], []
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
        # Check the entire edge: a seam between overlapping floor regions is
        # not an exterior wall. Fitted outside space must respect ALL wings.
        points = floors[door.floor_id].polygon
        if door.edge_index >= len(points):
            raise ValueError(f"Exit '{door.id}' references a missing floor edge")
        edge = LineString([points[door.edge_index], points[(door.edge_index + 1) % len(points)]])
        if not floor.boundary.buffer(1e-8).covers(edge):
            raise ValueError(f"Exit '{door.id}' must attach to an exterior floor edge")
        apron, target, threshold = exit_geometry(door, floors[door.floor_id], layout.agent_defaults.radius, building=floor)
        shape = region_to_polygon(apron)
        allowed_seam = region_to_polygon(threshold).intersection(floor)
        if shape.intersection(floor).difference(allowed_seam).area > 1e-7:
            raise ValueError(f"Exit '{door.id}' outside landing crosses the building beyond its doorway")
        opening = region_to_polygon(threshold)
        if any(opening.intersection(previous).area > 1e-9 for previous in thresholds):
            raise ValueError("Exterior exit openings must not overlap; remove duplicate doors or split the entrance bank")
        thresholds.append(opening)
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

    from app.services.population.furniture import is_minor_chair
    obstacles = [item for item in layout.furniture if not is_minor_chair(item,layout.furniture_labels)]
    used_ids = {item.id for item in obstacles}
    for wall in layout.walls:
        full_wall = region_to_polygon(Region(
            id=wall.id, polygon=wall_polygon(wall, 0, math.dist(wall.start, wall.end)),
        ))
        clip_endcaps = not floor.covers(full_wall) and not floor.buffer(GEOMETRY_TOLERANCE).covers(full_wall)
        # Independently observed image coordinates can differ by a fraction of
        # one source pixel at a shared junction. Permit that rounding only at
        # the wall endpoints, capped at 2 cm and a quarter of its thickness.
        # Keep the floor and editable centerlines intact; only outside solids
        # are clipped. Interior crossings and longer boundary strips still fail.
        endpoint_tolerance = GEOMETRY_TOLERANCE
        if layout.source_image and layout.extraction:
            endpoint_tolerance = max(endpoint_tolerance, min(
                .5 * layout.source_image.meters_per_pixel, wall.thickness / 4, .02))
        if clip_endcaps and not _only_boundary_endcaps_protrude(wall, full_wall, floor, endpoint_tolerance):
            raise ValueError(f"Wall '{wall.id}' extends outside the floor. "
                             "Move or remove this wall in Walls & doors, or correct the floor outline.")
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
            polygon = wall_polygon(wall, start, end)
            if clip_endcaps:
                solid = Polygon(polygon).intersection(floor)
                # Region cannot represent holes or disconnected pieces. Keep
                # those cases explicit instead of silently filling/dropping area.
                if not isinstance(solid, Polygon) or solid.is_empty or solid.interiors:
                    raise ValueError(f"Wall '{wall.id}' boundary clipping needs review: wall solids must remain single polygons without holes")
                polygon = list(solid.exterior.coords)[:-1]
            identifier = f"wall:{wall.id}:{index}"
            while identifier in used_ids:
                identifier = "_" + identifier
            used_ids.add(identifier)
            obstacles.append(Region(id=identifier, polygon=polygon))

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
        # A clipped boundary endcap has no doorway area outside the original floor.
        shape = shape.intersection(floor)
        if shape.intersection(walkable).area < shape.area - 1e-9:
            raise ValueError(f"Door '{door_id}' is obstructed by furniture or another wall")
    for index, exit_region in enumerate(scenario.exits):
        shape = region_to_polygon(exit_region)
        if any(shape.intersects(region_to_polygon(other)) for other in scenario.exits[:index]):
            raise ValueError("Exit regions must not overlap or touch")
    return scenario
