import math

import jupedsim as jps

from app.schemas.scenario import Scenario
from app.services.population.generate import resolve_population
from app.simulation.geometry import build_geometry, region_to_polygon


def run_simulation(scenario: Scenario) -> dict:
    # Revalidate in case an interactive caller changed a model in place.
    scenario = Scenario.model_validate(scenario.model_dump())
    population_config = scenario.population
    scenario = resolve_population(scenario)

    ids = [occupant.id for occupant in scenario.occupants]
    if len(ids) != len(set(ids)):
        raise ValueError("Occupant IDs must be unique")

    settings = scenario.settings
    sample_steps = round(settings.sample_interval / settings.dt)
    if sample_steps < 1 or not math.isclose(
        sample_steps * settings.dt,
        settings.sample_interval,
        rel_tol=1e-9,
    ):
        raise ValueError("sample_interval must be a positive multiple of dt")

    max_steps = math.floor(settings.max_time / settings.dt + 1e-9)
    if max_steps < 1:
        raise ValueError("max_time must be at least dt")

    geometry = build_geometry(scenario)
    simulation = jps.Simulation(
        model=jps.CollisionFreeSpeedModel(),
        geometry=geometry,
        dt=settings.dt,
    )

    router = jps.RoutingEngine(geometry)
    exit_options = []
    exit_polygons = []
    blocked_exits = set(settings.blocked_exit_ids)
    for exit_region in sorted(scenario.exits, key=lambda region: region.id):
        polygon = region_to_polygon(exit_region)
        if any(polygon.intersects(other) for other in exit_polygons):
            raise ValueError("Exit regions must not overlap or touch")
        exit_polygons.append(polygon)
        if exit_region.id in blocked_exits:
            continue
        stage = simulation.add_exit_stage(polygon)
        journey = simulation.add_journey(jps.JourneyDescription([stage]))
        target = polygon.representative_point()
        exit_options.append((exit_region.id, stage, journey, (target.x, target.y)))

    agent_ids = {}
    agent_exits = {}
    assignments = []
    for occupant in scenario.occupants:
        routes = []
        for exit_id, stage, journey, target in exit_options:
            try:
                path = router.compute_waypoints(occupant.position, target)
            except RuntimeError:
                continue
            distance = sum(math.dist(a, b) for a, b in zip(path, path[1:]))
            if math.isfinite(distance):
                routes.append((distance, exit_id, stage, journey))
        if not routes:
            raise ValueError(f"No reachable exit for occupant '{occupant.id}'")
        distance, exit_id, stage, journey = min(routes)
        engine_id = simulation.add_agent(
            jps.CollisionFreeSpeedModelAgentParameters(
                position=occupant.position,
                radius=scenario.agent_defaults.radius,
                desired_speed=scenario.agent_defaults.desired_speed,
                journey_id=journey,
                stage_id=stage,
            )
        )
        agent_ids[engine_id] = occupant.id
        agent_exits[engine_id] = exit_id
        assignments.append({
            "agent_id": occupant.id,
            "exit_id": exit_id,
            "route_length": distance,
        })

    def capture_frame():
        return {
            "time": round(simulation.elapsed_time(), 8),
            "agents": [
                {
                    "id": agent_ids[agent.id],
                    "x": agent.position[0],
                    "y": agent.position[1],
                }
                for agent in simulation.agents()
            ],
        }

    frames = [capture_frame()]
    evacuations = []

    for step in range(1, max_steps + 1):
        simulation.iterate()

        for engine_id in simulation.removed_agents():
            evacuations.append({
                "agent_id": agent_ids[engine_id],
                "exit_id": agent_exits[engine_id],
                "time": round(simulation.elapsed_time(), 8),
            })

        finished = simulation.agent_count() == 0
        if step % sample_steps == 0 or finished or step == max_steps:
            frames.append(capture_frame())

        if finished:
            break

    completed = simulation.agent_count() == 0
    return {
        "status": "completed" if completed else "timed_out",
        "scenario": scenario.model_dump(mode="json"),
        "population_generation": (
            population_config.model_dump(mode="json") if population_config else None
        ),
        "assignments": assignments,
        "frames": frames,
        "evacuations": evacuations,
        "summary": {
            "evacuated_count": len(evacuations),
            "remaining_count": simulation.agent_count(),
            "simulation_time": round(simulation.elapsed_time(), 8),
            "clearance_time": (
                round(simulation.elapsed_time(), 8) if completed else None
            ),
            "per_exit_counts": {
                exit_region.id: sum(
                    event["exit_id"] == exit_region.id for event in evacuations
                )
                for exit_region in scenario.exits
            },
        },
    }
