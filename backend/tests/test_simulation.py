"""Run from backend/: python -m unittest discover -s tests -v"""

import unittest
from pathlib import Path

from pydantic import ValidationError
from shapely.geometry import Point, Polygon

from app.schemas.scenario import Scenario
from app.services.population.generate import resolve_population
from app.simulation.engine import run_simulation


EXAMPLES = Path(__file__).resolve().parents[2] / "examples"


def load(name):
    return Scenario.model_validate_json((EXAMPLES / name).read_text())


class SimulationTests(unittest.TestCase):
    def test_original_manual_example_still_evacuates(self):
        result = run_simulation(load("simple_room.json"))
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["summary"]["evacuated_count"], 6)
        self.assertEqual(result["summary"]["per_exit_counts"], {"exit-east": 6})
        self.assertEqual(result["frames"][-1]["agents"], [])

    def test_generated_population_uses_both_exits(self):
        result = run_simulation(load("two_exit_room.json"))
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["summary"]["evacuated_count"], 50)
        self.assertEqual(result["summary"]["remaining_count"], 0)
        counts = result["summary"]["per_exit_counts"]
        self.assertEqual(sum(counts.values()), 50)
        self.assertTrue(all(count > 0 for count in counts.values()))
        self.assertEqual(len(result["assignments"]), 50)
        self.assertEqual(len(result["scenario"]["occupants"]), 50)
        self.assertIsNone(result["scenario"]["population"])
        self.assertEqual(result["population_generation"]["seed"], 42)
        self.assertEqual(result["frames"][-1]["agents"], [])

    def test_generation_is_repeatable_without_mutating_input(self):
        scenario = load("two_exit_room.json")
        first = resolve_population(scenario)
        second = resolve_population(scenario)
        self.assertEqual(first.occupants, second.occupants)
        self.assertEqual(scenario.occupants, [])
        self.assertIsNotNone(scenario.population)
        scenario.population.seed += 1
        different = resolve_population(scenario)
        self.assertNotEqual(first.occupants, different.occupants)

    def test_generated_people_stay_in_room_and_out_of_table(self):
        scenario = resolve_population(load("two_exit_room.json"))
        room = Polygon(scenario.walkable_areas[0].polygon)
        table = Polygon(scenario.obstacles[0].polygon)
        radius = scenario.agent_defaults.radius
        for i, person in enumerate(scenario.occupants):
            point = Point(person.position)
            self.assertTrue(room.contains(point))
            self.assertGreaterEqual(point.distance(table), radius)
            for other in scenario.occupants[:i]:
                self.assertGreaterEqual(point.distance(Point(other.position)), 2 * radius)

    def test_unknown_spawn_area_is_rejected(self):
        scenario = load("two_exit_room.json")
        scenario.population.spawn_area_ids = ["missing"]
        with self.assertRaisesRegex(ValueError, "Unknown spawn area"):
            resolve_population(scenario)

    def test_too_small_spawn_area_reports_capacity_problem(self):
        scenario = load("two_exit_room.json")
        tiny = scenario.walkable_areas[0].model_copy(update={
            "id": "tiny", "polygon": [(2, 2), (2.3, 2), (2.3, 2.3), (2, 2.3)],
        })
        scenario.walkable_areas.append(tiny)
        scenario.population.spawn_area_ids = ["tiny"]
        scenario.population.count = 2
        with self.assertRaisesRegex(ValueError, "Could not fit"):
            resolve_population(scenario)

    def test_duplicate_exit_ids_are_rejected(self):
        data = load("simple_room.json").model_dump()
        data["exits"].append(data["exits"][0].copy())
        with self.assertRaisesRegex(ValidationError, "exits IDs must be unique"):
            Scenario.model_validate(data)

    def test_overlapping_exits_are_rejected(self):
        scenario = load("simple_room.json")
        scenario.exits.append(scenario.exits[0].model_copy(update={"id": "overlap"}))
        with self.assertRaisesRegex(ValueError, "must not overlap"):
            run_simulation(scenario)

    def test_exit_choice_accounts_for_obstacle_detour(self):
        scenario = Scenario.model_validate({
            "name": "Detour", "units": "meters",
            "walkable_areas": [{"id": "room", "polygon": [[0, 0], [10, 0], [10, 10], [0, 10]]}],
            "obstacles": [{"id": "barrier", "polygon": [[1.5, 0], [2, 0], [2, 8], [1.5, 8]]}],
            "exits": [
                {"id": "west", "polygon": [[0.2, 0.5], [0.8, 0.5], [0.8, 1.5], [0.2, 1.5]]},
                {"id": "east", "polygon": [[8, 0.5], [9, 0.5], [9, 1.5], [8, 1.5]]},
            ],
            "occupants": [{"id": "p1", "position": [4, 1]}],
            "agent_defaults": {"radius": 0.2, "desired_speed": 1.2},
            "settings": {"dt": 0.01, "sample_interval": 0.1, "max_time": 30},
        })
        result = run_simulation(scenario)
        # West is nearer in a straight line, but a long barrier blocks that route.
        self.assertEqual(result["assignments"][0]["exit_id"], "east")
        self.assertEqual(result["evacuations"][0]["exit_id"], "east")

    def test_timeout_preserves_remaining_people_and_null_clearance(self):
        scenario = load("two_exit_room.json")
        scenario.settings.max_time = 0.02
        result = run_simulation(scenario)
        self.assertEqual(result["status"], "timed_out")
        self.assertEqual(result["summary"]["remaining_count"], 50)
        self.assertIsNone(result["summary"]["clearance_time"])
        self.assertEqual(len(result["frames"][-1]["agents"]), 50)

    def test_ambiguous_population_source_is_rejected(self):
        data = load("two_exit_room.json").model_dump()
        data["occupants"] = [{"id": "manual", "position": [2, 2]}]
        with self.assertRaisesRegex(ValidationError, "not both"):
            Scenario.model_validate(data)

    def test_empty_population_without_generation_is_rejected(self):
        data = load("simple_room.json").model_dump()
        data["occupants"] = []
        with self.assertRaisesRegex(ValidationError, "Provide occupants"):
            Scenario.model_validate(data)


if __name__ == "__main__":
    unittest.main()
