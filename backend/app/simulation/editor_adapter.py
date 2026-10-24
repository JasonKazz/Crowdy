"""Translate the editor's pixel geometry into an explicit JuPedSim scenario.

This adapter does not run an approximate browser solver. All trajectories and
clearance outcomes are produced by the native engine after this conversion.
"""

import math
import random
from dataclasses import dataclass

from shapely.geometry import LineString, Point, Polygon, box
from shapely.ops import unary_union
from shapely.prepared import prep

from app.schemas.scenario import ExitBoundary, Occupant, Region, Scenario
from app.simulation.geometry import build_geometry

PIXELS_PER_METRE = 32.0
CANVAS_HEIGHT = 600.0
AGENT_RADIUS = 0.2
SPAWN_CLEARANCE = 0.25
AGENT_SEPARATION = 0.45
WALL_HALF_WIDTH = 3.5 / PIXELS_PER_METRE
POPULATION_SEED = 42


def pixel_to_metres(x: float, y: float) -> tuple[float, float]:
    return x / PIXELS_PER_METRE, (CANVAS_HEIGHT - y) / PIXELS_PER_METRE


def _region(identifier: str, polygon: Polygon) -> Region:
    if polygon.is_empty or not polygon.is_valid or polygon.area <= 1e-10:
        raise ValueError(f"Geometry '{identifier}' has no valid area")
    if polygon.interiors:
        raise ValueError(f"Geometry '{identifier}' contains unsupported holes")
    return Region(id=identifier, polygon=list(polygon.exterior.coords)[:-1])


def _polygons(geometry):
    if geometry.is_empty:
        return []
    if isinstance(geometry, Polygon):
        return [geometry]
    if hasattr(geometry, "geoms"):
        return [piece for member in geometry.geoms for piece in _polygons(member)]
    return []


def _along(origin, normal, start, end, half_width):
    tangent = (-normal[1], normal[0])
    return Polygon([
        (origin[0] + normal[0] * offset + tangent[0] * side,
         origin[1] + normal[1] * offset + tangent[1] * side)
        for offset, side in [
            (start, -half_width), (end, -half_width),
            (end, half_width), (start, half_width),
        ]
    ])


@dataclass(frozen=True)
class BoundaryExit:
    identifier: str
    label: str
    origin: tuple[float, float]
    normal: tuple[float, float]
    width: float


def _boundary_opening(plan, floor, origin, normal):
    """Measure the actual gap between wall segments along this floor edge."""
    tangent = (-normal[1], normal[0])
    edge_points = [p for p in list(floor.exterior.coords)[:-1]
                   if abs(sum((p[i] - origin[i]) * normal[i] for i in range(2))) < 1e-7]
    collinear_walls = []
    for wall in plan["walls"]:
        points = [pixel_to_metres(wall["x1"], wall["y1"]), pixel_to_metres(wall["x2"], wall["y2"])]
        if all(abs(sum((p[i] - origin[i]) * normal[i] for i in range(2))) < 1e-7 for p in points):
            collinear_walls.append(LineString(points).buffer(WALL_HALF_WIDTH, cap_style=2))
    # A bare boundary with only a point marker has no measured door width.
    if len(edge_points) != 2 or not collinear_walls:
        return origin, 1.4
    edge_points.sort(key=lambda p: sum(p[i] * tangent[i] for i in range(2)))
    opening = LineString(edge_points).difference(unary_union(collinear_walls))
    pieces = [opening] if opening.geom_type == "LineString" else list(getattr(opening, "geoms", []))
    for piece in pieces:
        if piece.geom_type == "LineString" and piece.length > 0 and piece.distance(Point(origin)) < 1e-7:
            centre = piece.interpolate(.5, normalized=True)
            return (centre.x, centre.y), piece.length
    # Keep the normal obstruction check's actionable error for a blocked marker.
    return origin, 1.4


def _editor_geometry(plan: dict):
    walls = plan["walls"]
    xs = [wall[key] for wall in walls for key in ("x1", "x2")]
    ys = [wall[key] for wall in walls for key in ("y1", "y2")]
    min_x, max_x = (min(xs), max(xs)) if xs else (0.0, plan["width"])
    min_y, max_y = (min(ys), max(ys)) if ys else (0.0, plan["height"])
    if max_x - min_x < 16 or max_y - min_y < 16:
        raise ValueError("The wall envelope is too small for a person; review the floor boundary")
    left, bottom = pixel_to_metres(min_x, max_y)
    right, top = pixel_to_metres(max_x, min_y)
    base_floor = box(left, bottom, right, top)
    areas = [_region("editor-floor", base_floor)]
    floor_parts = [base_floor]
    exits = []
    boundary_exits = []

    for index, exit in enumerate(plan["exits"]):
        px, py = exit["x"], exit["y"]
        centre = pixel_to_metres(px, py)
        candidates = [
            (abs(px - min_x), (-1.0, 0.0), (left, centre[1])),
            (abs(px - max_x), (1.0, 0.0), (right, centre[1])),
            (abs(py - min_y), (0.0, 1.0), (centre[0], top)),
            (abs(py - max_y), (0.0, -1.0), (centre[0], bottom)),
        ]
        distance, normal, origin = min(candidates, key=lambda candidate: candidate[0])
        if distance <= 4.0:
            origin, door_width = _boundary_opening(plan, base_floor, origin, normal)
            # Extend only the floor. Existing wall segments remain obstacles;
            # this never cuts a new opening through a solid wall.
            landing = _along(origin, normal, -0.15, 1.5, door_width / 2)
            floor_parts.append(landing)
            areas.append(_region(f"editor-landing-{index}", landing))
            stage = _along(origin, normal, AGENT_RADIUS + .02, AGENT_RADIUS + .20, door_width / 2 - .01)
            # RoutePlanner reads the first edge as the cross-door threshold.
            # Keep that edge tangent to the doorway, as the layout compiler does.
            corners = list(stage.exterior.coords)[:-1]
            stage = Polygon([corners[i] for i in (0, 3, 2, 1)])
            boundary_exits.append(BoundaryExit(exit["id"], exit["label"], origin, normal, door_width))
        else:
            if not base_floor.contains(Point(centre)):
                raise ValueError(f"Exit '{exit['label']}' lies outside the floor boundary")
            stage = box(centre[0] - 0.25, centre[1] - 0.25, centre[0] + 0.25, centre[1] + 0.25)
        exits.append(_region(exit["id"], stage))

    floor = unary_union(floor_parts)
    obstacles = []
    for index, wall in enumerate(walls):
        first = pixel_to_metres(wall["x1"], wall["y1"])
        second = pixel_to_metres(wall["x2"], wall["y2"])
        if first == second:
            raise ValueError(f"Wall {index + 1} needs two distinct endpoints")
        clipped = LineString([first, second]).buffer(WALL_HALF_WIDTH, cap_style=2).intersection(floor)
        for part, polygon in enumerate(_polygons(clipped)):
            obstacles.append(_region(f"editor-wall-{index}-{part}", polygon))

    for index, item in enumerate(plan["items"]):
        lower = pixel_to_metres(item["x"], item["y"] + item["height"])
        upper = pixel_to_metres(item["x"] + item["width"], item["y"])
        obstacle = box(lower[0], lower[1], upper[0], upper[1])
        if not base_floor.covers(obstacle):
            raise ValueError(f"Object '{item['label']}' extends outside the floor boundary")
        obstacles.append(_region(f"editor-item-{index}", obstacle))

    return base_floor, areas, obstacles, exits, boundary_exits


def _positions(plan: dict, settings: dict, walkable, base_floor, exits, convert=pixel_to_metres):
    spawn = walkable.intersection(base_floor)
    exit_buffer = unary_union([Polygon(exit.polygon) for exit in exits]).buffer(SPAWN_CLEARANCE)
    spawn = spawn.difference(exit_buffer)
    usable = spawn.buffer(-SPAWN_CLEARANCE)
    if usable.is_empty or usable.area <= 0:
        raise ValueError("The layout has no clear space for people; move obstacles away from walls and exits")
    prepared = prep(spawn)
    boundary = spawn.boundary
    count = settings["occupancy"]
    desks = [
        convert(item["x"] + item["width"] / 2, item["y"] + item["height"] / 2)
        for item in sorted(plan["items"], key=lambda item: item["id"])
        if item["kind"] == "desk"
    ]
    clustered = settings["distribution"] == "workstations"
    if clustered and not desks:
        raise ValueError("Around workstations needs at least one desk; add a desk or choose Across the floor plan")
    rng = random.Random(settings.get("seed", POPULATION_SEED))
    min_x, min_y, max_x, max_y = base_floor.bounds
    positions = []
    for _ in range(max(5000, count * 400)):
        if clustered:
            centre = desks[rng.randrange(len(desks))]
            candidate = (rng.gauss(centre[0], 1.8), rng.gauss(centre[1], 1.8))
        else:
            candidate = (rng.uniform(min_x, max_x), rng.uniform(min_y, max_y))
        point = Point(candidate)
        if not prepared.contains(point) or point.distance(boundary) < SPAWN_CLEARANCE:
            continue
        if any(math.dist(candidate, other) < AGENT_SEPARATION for other in positions):
            continue
        positions.append(candidate)
        if len(positions) == count:
            return positions
    raise ValueError(
        f"Could not place {count} people with body clearance. Reduce occupancy, move furniture, "
        "or choose Across the floor plan."
    )


def editor_to_scenario(plan: dict, settings: dict) -> Scenario:
    if plan.get("native"):
        from app.services.floorplans.layout import compile_layout
        from app.simulation.workspace_layout import editor_native_layout, world_point
        layout, transform = editor_native_layout(plan)
        scenario = compile_layout(layout)
        base_floor = unary_union([Polygon(r.polygon) for r in layout.walkable_areas])
        starts = _positions(plan, settings, build_geometry(scenario), base_floor, scenario.exits,
                            convert=lambda x, y: world_point(x, y, transform))
        return _with_people(scenario, starts, settings)
    base_floor, areas, obstacles, exits, boundary_exits = _editor_geometry(plan)
    # Population is a temporary schema-valid placeholder. Explicit starts below
    # let mixed walking profiles keep per-person model parameters.
    scenario = Scenario.model_validate({
        "name": plan["name"],
        "units": "meters",
        "walkable_areas": [region.model_dump() for region in areas],
        "obstacles": [region.model_dump() for region in obstacles],
        "exits": [region.model_dump() for region in exits],
        "exit_boundaries": [ExitBoundary(id=exit.identifier,
            start=(exit.origin[0] - exit.normal[1] * exit.width / 2, exit.origin[1] + exit.normal[0] * exit.width / 2),
            end=(exit.origin[0] + exit.normal[1] * exit.width / 2, exit.origin[1] - exit.normal[0] * exit.width / 2),
            outward=exit.normal, outside_space="open").model_dump() for exit in boundary_exits],
        "population": {"count": settings["occupancy"], "seed": POPULATION_SEED, "spawn_area_ids": ["editor-floor"]},
        "agent_defaults": {"radius": AGENT_RADIUS, "desired_speed": 1.2},
        "settings": {"dt": 0.01, "sample_interval": 0.2, "max_time": 60.0},
    })
    try:
        walkable = build_geometry(scenario)
    except ValueError as exc:
        raise ValueError(f"Review the layout geometry: {exc}") from exc

    for exit in boundary_exits:
        corridor = _along(exit.origin, exit.normal, -0.5, 0.85, SPAWN_CLEARANCE)
        if not walkable.covers(corridor):
            raise ValueError(
                f"Exit '{exit.label}' is blocked or has less than 0.5 m clear width. "
                "Place it in a real wall opening and move nearby obstacles."
            )
    body_space = walkable.buffer(-AGENT_RADIUS)
    if body_space.is_empty or body_space.geom_type != "Polygon":
        raise ValueError("Walls or furniture leave disconnected areas or passages too narrow for people")
    starts = _positions(plan, settings, walkable, base_floor, exits)
    return _with_people(scenario, starts, settings)


def _with_people(scenario, starts, settings):
    slower = set()
    if settings["mobility"] == "mixed":
        slower = set(random.Random(settings.get("seed", POPULATION_SEED) + 1).sample(range(len(starts)), math.ceil(len(starts) / 4)))
    occupants = [
        Occupant(id=f"p{index + 1:04d}", position=position, desired_speed=0.72 if index in slower else 1.2)
        for index, position in enumerate(starts)
    ]
    resolved = scenario.model_copy(update={"occupants": occupants, "population": None})
    build_geometry(resolved)
    return resolved
