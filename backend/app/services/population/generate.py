"""Reproducible uniform placement inside explicitly selected floor areas."""

import jupedsim as jps
from shapely.geometry import Polygon
from shapely.ops import unary_union

from app.schemas.scenario import Occupant, Scenario
from app.simulation.geometry import build_geometry, region_to_polygon


def resolve_population(scenario: Scenario) -> Scenario:
    config = scenario.population
    if config is None:
        return scenario

    areas = {area.id: area for area in scenario.walkable_areas}
    missing = sorted(set(config.spawn_area_ids) - areas.keys())
    if missing:
        raise ValueError(f"Unknown spawn area IDs: {', '.join(missing)}")

    # Intersect with compiled geometry to keep people out of furniture.
    selected = unary_union([
        region_to_polygon(areas[area_id])
        for area_id in sorted(set(config.spawn_area_ids))
    ])
    walkable = build_geometry(scenario)
    spawn = selected.intersection(walkable)

    # Keep starts out of exit zones, including a body-radius clearance.
    radius = scenario.agent_defaults.radius
    exits = unary_union([
        region_to_polygon(exit_region).buffer(radius + 0.05)
        for exit_region in scenario.exits
    ])
    spawn = spawn.difference(exits)
    if not isinstance(spawn, Polygon) or spawn.is_empty or not spawn.is_valid:
        raise ValueError("Spawn areas must form one connected polygon")

    try:
        positions = jps.distribute_by_number(
            polygon=spawn,
            number_of_agents=config.count,
            distance_to_agents=2 * radius + 0.05,
            distance_to_polygon=radius + 0.05,
            seed=config.seed,
        )
    except jps.AgentNumberError as exc:
        raise ValueError(
            f"Could not fit {config.count} people with the requested clearance; "
            "reduce the count or enlarge the spawn area"
        ) from exc

    people = [
        Occupant(id=f"p{i:04d}", position=(float(x), float(y)))
        for i, (x, y) in enumerate(positions, start=1)
    ]
    resolved = scenario.model_copy(update={"occupants": people, "population": None})
    build_geometry(resolved)  # Apply the same placement checks as manual starts.
    return resolved
