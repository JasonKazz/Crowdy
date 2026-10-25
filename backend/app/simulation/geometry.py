from shapely.geometry import Point, Polygon
from shapely.ops import unary_union
from shapely.validation import explain_validity

from app.schemas.scenario import Region, Scenario
from app.simulation.spatial import SpatialIndex
from app.simulation.budget import check_simulation_budget

# Metre coordinates can acquire tiny overshoots when wall endpoints are expanded
# into polygons. This tolerance is numerical, not an image-snapping allowance.
GEOMETRY_TOLERANCE = 1e-8


def region_to_polygon(region: Region) -> Polygon:
    polygon = Polygon(region.polygon)

    if not polygon.is_valid:
        raise ValueError(
            f"Invalid polygon '{region.id}': "
            f"{explain_validity(polygon)}"
        )

    if polygon.is_empty or polygon.area <= 0:
        raise ValueError(
            f"Polygon '{region.id}' must have positive area"
        )

    return polygon


def build_geometry(scenario: Scenario) -> Polygon:
    # Join the room, doorway, and landing.
    floor = unary_union([
        region_to_polygon(region)
        for region in scenario.walkable_areas
    ])

    obstacles = [
        region_to_polygon(region)
        for region in scenario.obstacles
    ]

    for index, (region, obstacle) in enumerate(zip(scenario.obstacles, obstacles)):
        if not floor.covers(obstacle):
            if not floor.buffer(GEOMETRY_TOLERANCE).covers(obstacle):
                raise ValueError(f"Obstacle '{region.id}' extends outside the floor")
            obstacles[index] = obstacle.intersection(floor)

    # Remove furniture from the space people can walk through.
    walkable = (
        floor.difference(unary_union(obstacles))
        if obstacles
        else floor
    )

    if walkable.is_empty or not walkable.is_valid:
        raise ValueError("The resulting walkable geometry is invalid")

    if not isinstance(walkable, Polygon):
        raise ValueError(
            "This first version requires one connected walkable area"
        )

    for region in scenario.exits:
        exit_polygon = region_to_polygon(region)

        if not walkable.covers(exit_polygon):
            raise ValueError(
                f"Exit '{region.id}' must be inside walkable space"
            )

    radius = scenario.agent_defaults.radius
    positions = SpatialIndex(2 * radius)
    boundary = walkable.boundary

    for index, occupant in enumerate(scenario.occupants):
        if index % 128 == 0:
            check_simulation_budget()
        point = Point(occupant.position)

        if not walkable.contains(point):
            obstacle_id = next((region.id for region, polygon in zip(scenario.obstacles, obstacles)
                                if polygon.covers(point)), None)
            reason = (f"inside obstacle '{obstacle_id}'" if obstacle_id is not None
                      else "outside the floor or on its boundary")
            raise ValueError(
                f"Occupant '{occupant.id}' is {reason}. "
                "Enable automatic placement or regenerate people in the editor, "
                "or correct this fixed starting position."
            )

        if point.distance(boundary) < radius:
            raise ValueError(
                f"Occupant '{occupant.id}' is too close to a wall "
                "or obstacle. Enable automatic placement or regenerate people "
                "in the editor, or correct this fixed starting position."
            )

        for other_point, other_id in positions.nearby(occupant.position):
            if point.distance(Point(other_point)) < 2 * radius:
                raise ValueError(
                    f"Occupants '{occupant.id}' and '{other_id}' overlap"
                )

        positions.add(occupant.position, occupant.id)

    return walkable
