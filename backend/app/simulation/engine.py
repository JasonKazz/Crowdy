import math

import jupedsim as jps

from app.schemas.scenario import Scenario
from app.simulation.geometry import build_geometry, region_to_polygon


def run_simulation(scenario: Scenario) -> dict:
    if len(scenario.exits) != 1:
        raise ValueError("This first runner requires exactly one exit")

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

    simulation = jps.Simulation(
        model=jps.CollisionFreeSpeedModel(),
        geometry=build_geometry(scenario),
        dt=settings.dt,
    )

    exit_region = scenario.exits[0]
    exit_stage = simulation.add_exit_stage(region_to_polygon(exit_region))
    journey = simulation.add_journey(jps.JourneyDescription([exit_stage]))

    agent_ids = {}
    for occupant in scenario.occupants:
        engine_id = simulation.add_agent(
            jps.CollisionFreeSpeedModelAgentParameters(
                position=occupant.position,
                radius=scenario.agent_defaults.radius,
                desired_speed=scenario.agent_defaults.desired_speed,
                journey_id=journey,
                stage_id=exit_stage,
            )
        )
        agent_ids[engine_id] = occupant.id

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
                "exit_id": exit_region.id,
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
        "frames": frames,
        "evacuations": evacuations,
        "summary": {
            "evacuated_count": len(evacuations),
            "remaining_count": simulation.agent_count(),
            "simulation_time": round(simulation.elapsed_time(), 8),
            "clearance_time": (
                round(simulation.elapsed_time(), 8) if completed else None
            ),
        },
    }
