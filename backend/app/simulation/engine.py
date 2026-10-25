import math

import jupedsim as jps
from shapely.geometry import Point

from app.schemas.scenario import Scenario
from app.services.population.generate import resolve_population
from app.simulation.behavior import agent_behaviors
from app.simulation.geometry import build_geometry, region_to_polygon
from app.simulation.routing import RoutePlanner, plan_routes


def crossed_exit_threshold(previous, current, boundary):
    """A real outward passage through this finite doorway, not its half-plane."""
    before = sum((previous[i] - boundary.start[i]) * boundary.outward[i] for i in range(2))
    after = sum((current[i] - boundary.start[i]) * boundary.outward[i] for i in range(2))
    if not before <= 0 <= after or after <= before:
        return False
    fraction = -before / (after - before)
    crossing = tuple(previous[i] + fraction * (current[i] - previous[i]) for i in range(2))
    edge = tuple(boundary.end[i] - boundary.start[i] for i in range(2))
    along = sum((crossing[i] - boundary.start[i]) * edge[i] for i in range(2))
    return -1e-9 <= along <= sum(value * value for value in edge) + 1e-9


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
    behaviors = agent_behaviors(scenario)
    behavior_by_id = {person["agent_id"]: person for person in behaviors}
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
    waiting = set()
    for occupant, assignment in zip(scenario.occupants, assignments):
        exit_id = assignment["exit_id"]
        behavior = behavior_by_id[occupant.id]
        speed = behavior["desired_speed"]
        if occupant.id in trapped or behavior["response_delay"] > 0:
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
        if occupant.id in trapped or behavior["response_delay"] > 0:
            simulation.agent(engine_id).target = occupant.position
        if occupant.id not in trapped and behavior["response_delay"] > 0:
            waiting.add(engine_id)

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
    passed_threshold = set()
    boundaries = {boundary.id: boundary for boundary in scenario.exit_boundaries}
    steering_interval = max(1, round(.1 / settings.dt))
    from app.simulation.adaptive import AdaptiveExitChoices
    adaptive = AdaptiveExitChoices(scenario,planner,exit_shapes,behavior_by_id) if settings.behavior_mode == "behavioral" else None
    decision_interval = max(1,round(1 / settings.dt))

    steps_to_run = 0 if len(trapped) == len(ids) else max_steps
    for step in range(1, steps_to_run + 1):
        any_released = False
        if adaptive is not None and (step == 1 or step % decision_interval == 0):
            adaptive.reconsider(list(simulation.agents()),agent_ids,agent_exits,agent_paths,cursors,
                                simulation.elapsed_time(),passed_threshold | crossed | waiting)
        for agent in simulation.agents():
            if agent_ids[agent.id] in trapped:
                continue
            released = False
            if agent.id in waiting:
                behavior = behavior_by_id[agent_ids[agent.id]]
                if simulation.elapsed_time() + 1e-9 < behavior["response_delay"]:
                    continue
                agent.model.desired_speed = behavior["desired_speed"]
                waiting.remove(agent.id)
                released = True
                any_released = True
            if released or step == 1 or step % steering_interval == 0:
                target, agent_paths[agent.id], cursors[agent.id] = planner.update_route(
                    agent.position, agent_paths[agent.id], cursors[agent.id], exit_shapes[agent_exits[agent.id]])
                agent.target = target
        # Preserve the stationary endpoint exactly. Otherwise interpolating a
        # regular 0.2 s sample interval can make a person walk before responding.
        if any_released and frames[-1]["time"] < round(simulation.elapsed_time(), 8):
            frames.append(capture_frame())
        previous_positions = {agent.id: agent.position for agent in simulation.agents()}
        simulation.iterate()

        for agent in list(simulation.agents()):
            if agent_ids[agent.id] in trapped or agent.id in waiting:
                continue
            boundary = boundaries.get(agent_exits[agent.id])
            position = agent.position
            if boundary is not None and agent.id not in crossed:
                outside_distance = sum((position[i] - boundary.start[i]) * boundary.outward[i] for i in range(2))
                if outside_distance < 0:
                    passed_threshold.discard(agent.id)
                elif crossed_exit_threshold(previous_positions[agent.id], position, boundary):
                    passed_threshold.add(agent.id)
                if agent.id in passed_threshold and outside_distance >= scenario.agent_defaults.radius:
                    crossed.add(agent.id)
                    door_crossings.append({"agent_id": agent_ids[agent.id], "exit_id": boundary.id,
                                           "time": round(simulation.elapsed_time(), 8)})
            if (boundary is None or agent.id in crossed) and exit_shapes[agent_exits[agent.id]].covers(Point(position)):
                evacuations.append({"agent_id": agent_ids[agent.id], "exit_id": agent_exits[agent.id],
                                    "time": round(simulation.elapsed_time(), 8)})
                simulation.mark_agent_for_removal(agent.id)

        finished = simulation.agent_count() == len(trapped)
        if step % sample_steps == 0 or finished or step == max_steps:
            frames.append(capture_frame())

        if finished:
            break

    for assignment in assignments:
        engine_id=next(key for key,value in agent_ids.items() if value==assignment["agent_id"])
        assignment["final_exit_id"] = agent_exits[engine_id]
    completed = simulation.agent_count() == 0
    moving_remaining = simulation.agent_count() - len(trapped)
    return {
        "status": "completed" if completed else "trapped" if moving_remaining == 0 else "timed_out",
        "scenario": scenario.model_dump(mode="json"),
        "population_generation": (
            population_config.model_dump(mode="json") if population_config else None
        ),
        "assignments": assignments,
        "behavior": {"version": 2, "mode": settings.behavior_mode, "seed": settings.behavior_seed,
                     "agents": behaviors},
        "routing": {"version":1,"mode":"adaptive" if adaptive else "fixed",
                    "exit_changes":adaptive.events if adaptive else []},
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
