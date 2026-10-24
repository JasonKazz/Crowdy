"""Compare exit availability with exactly the same people and model settings."""

from app.schemas.scenario import Scenario
from app.services.population.generate import resolve_population
from app.simulation.engine import run_simulation


def compare_exit_availability(scenario: Scenario, blocked_exit_ids: list[str]) -> dict:
    scenario = Scenario.model_validate(scenario.model_dump())
    if scenario.settings.blocked_exit_ids:
        raise ValueError("The baseline scenario must have all exits available")
    if not blocked_exit_ids:
        raise ValueError("Select at least one exit to block")

    # Validate the proposed closures before doing population or simulation work.
    variant = scenario.model_dump()
    variant["settings"]["blocked_exit_ids"] = list(blocked_exit_ids)
    Scenario.model_validate(variant)

    generation = scenario.population.model_dump(mode="json") if scenario.population else None
    frozen = resolve_population(scenario)
    variant = frozen.model_dump()
    variant["settings"]["blocked_exit_ids"] = list(blocked_exit_ids)
    variant["name"] += " (blocked-exit scenario)"

    baseline = run_simulation(frozen)
    blocked = run_simulation(Scenario.model_validate(variant))
    for result in (baseline, blocked):
        result["population_generation"] = generation

    same_starts = baseline["frames"][0]["agents"] == blocked["frames"][0]["agents"]
    if not same_starts:
        raise RuntimeError("Comparison failed: starting positions differ")

    a, b = baseline["summary"], blocked["summary"]
    both_completed = baseline["status"] == blocked["status"] == "completed"
    delta = round(b["clearance_time"] - a["clearance_time"], 8) if both_completed else None
    comparison = {
        "blocked_exit_ids": sorted(blocked_exit_ids),
        "people_count": len(frozen.occupants),
        "same_starting_positions": same_starts,
        "baseline": {"status": baseline["status"], **a},
        "blocked": {"status": blocked["status"], **b},
        "clearance_time_change_s": delta,
        "per_exit_count_changes": {
            exit_id: b["per_exit_counts"][exit_id] - count
            for exit_id, count in a["per_exit_counts"].items()
        },
    }
    return {"baseline": baseline, "blocked": blocked, "comparison": comparison}
