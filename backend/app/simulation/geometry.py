from shapely.geometry import Point, Polygon
from shapely.ops import unary_union
from shapely.validation import explain_validity

from app.schemas.scenario import Region, Scenario


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

    for region, obstacle in zip(scenario.obstacles, obstacles):
        if not floor.covers(obstacle):
            raise ValueError(
                f"Obstacle '{region.id}' extends outside the floor"
            )

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
    positions = []

    for occupant in scenario.occupants:
        point = Point(occupant.position)

        if not walkable.contains(point):
            raise ValueError(
                f"Occupant '{occupant.id}' is outside walkable space"
            )

        if point.distance(walkable.boundary) < radius:
            raise ValueError(
                f"Occupant '{occupant.id}' is too close to a wall "
                "or obstacle"
            )

        for other_id, other_point in positions:
            if point.distance(other_point) < 2 * radius:
                raise ValueError(
                    f"Occupants '{occupant.id}' and '{other_id}' overlap"
                )

        positions.append((occupant.id, point))

    return walkable