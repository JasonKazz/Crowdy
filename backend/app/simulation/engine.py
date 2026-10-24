import math

import jupedsim as jps
from shapely.geometry import Point

from app.schemas.scenario import Scenario
from app.services.population.generate import resolve_population
from app.simulation.geometry import build_geometry, region_to_polygon
from app.simulation.routing import RoutePlanner, plan_routes


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

    planner = RoutePlanner(geometry, scenario.agent_defaults.radius)
    assignments = plan_routes(scenario, planner=planner, allow_trapped=True)
    trapped = {assignment["agent_id"] for assignment in assignments if assignment["exit_id"] is None}
    steering_stage = simulation.add_direct_steering_stage()
    steering_journey = simulation.add_journey(jps.JourneyDescription([steering_stage]))
    exit_shapes = {}
    exit_polygons = []
    blocked_exits = set(settings.blocked_exit_ids)
    for exit_region in sorted(scenario.exits, key=lambda region: region.id):
        polygon = region_to_polygon(exit_region)
        if any(polygon.intersects(other) for other in exit_polygons):
            raise ValueError("Exit regions must not overlap or touch")
        exit_polygons.append(polygon)
        if exit_region.id in blocked_exits:
            continue
        exit_shapes[exit_region.id] = polygon

    agent_ids = {}
    agent_exits = {}
    agent_paths = {}
    cursors = {}
    for occupant, assignment in zip(scenario.occupants, assignments):
        exit_id = assignment["exit_id"]
        speed = occupant.desired_speed if occupant.desired_speed is not None else scenario.agent_defaults.desired_speed
        if occupant.id in trapped:
            speed = 0
        engine_id = simulation.add_agent(
            jps.CollisionFreeSpeedModelAgentParameters(
                position=occupant.position,
                radius=scenario.agent_defaults.radius,
                desired_speed=speed,
                journey_id=steering_journey,
                stage_id=steering_stage,
            )
        )
        agent_ids[engine_id] = occupant.id
        agent_exits[engine_id] = exit_id
        agent_paths[engine_id] = assignment["path"]
        cursors[engine_id] = 1
        if occupant.id in trapped:
            simulation.agent(engine_id).target = occupant.position

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
    door_crossings = []
    crossed = set()
    boundaries = {boundary.id: boundary for boundary in scenario.exit_boundaries}
    steering_interval = max(1, round(.1 / settings.dt))

    steps_to_run = 0 if len(trapped) == len(ids) else max_steps
    for step in range(1, steps_to_run + 1):
        for agent in simulation.agents():
            if agent_ids[agent.id] in trapped:
                continue
            if step == 1 or step % steering_interval == 0:
                target, agent_paths[agent.id], cursors[agent.id] = planner.update_route(
                    agent.position, agent_paths[agent.id], cursors[agent.id], exit_shapes[agent_exits[agent.id]])
                agent.target = target
        simulation.iterate()

        for agent in list(simulation.agents()):
            if agent_ids[agent.id] in trapped:
                continue
            boundary = boundaries.get(agent_exits[agent.id])
            position = agent.position
            if boundary is not None and agent.id not in crossed:
                outside_distance = sum((position[i] - boundary.start[i]) * boundary.outward[i] for i in range(2))
                if outside_distance >= scenario.agent_defaults.radius:
                    crossed.add(agent.id)
                    door_crossings.append({"agent_id": agent_ids[agent.id], "exit_id": boundary.id,
                                           "time": round(simulation.elapsed_time(), 8)})
            if exit_shapes[agent_exits[agent.id]].covers(Point(position)):
                evacuations.append({"agent_id": agent_ids[agent.id], "exit_id": agent_exits[agent.id],
                                    "time": round(simulation.elapsed_time(), 8)})
                simulation.mark_agent_for_removal(agent.id)

        finished = simulation.agent_count() == len(trapped)
        if step % sample_steps == 0 or finished or step == max_steps:
            frames.append(capture_frame())

        if finished:
            break

    completed = simulation.agent_count() == 0
    moving_remaining = simulation.agent_count() - len(trapped)
    return {
        "status": "completed" if completed else "trapped" if moving_remaining == 0 else "timed_out",
        "scenario": scenario.model_dump(mode="json"),
        "population_generation": (
            population_config.model_dump(mode="json") if population_config else None
        ),
        "assignments": assignments,
        "trapped": [{"agent_id": identifier, "reason": "No body-clear route to an available exit"}
                    for identifier in sorted(trapped)],
        "frames": frames,
        "evacuations": evacuations,
        "door_crossings": door_crossings,
        "summary": {
            "evacuated_count": len(evacuations),
            "remaining_count": simulation.agent_count(),
            "trapped_count": len(trapped),
            "moving_remaining_count": moving_remaining,
            "simulation_time": round(simulation.elapsed_time(), 8),
            "clearance_time": (
                round(simulation.elapsed_time(), 8) if completed else None
            ),
            "building_clearance_time": max((event["time"] for event in door_crossings), default=None)
            if len(door_crossings) == len(ids) else None,
            "per_exit_counts": {
                exit_region.id: sum(
                    event["exit_id"] == exit_region.id for event in evacuations
                )
                for exit_region in scenario.exits
            },
        },
    }
