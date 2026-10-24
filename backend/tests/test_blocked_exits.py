import unittest

from pydantic import ValidationError

from app.schemas.scenario import Scenario
from app.services.population.generate import resolve_population
from app.services.scenarios.compare import compare_exit_availability
from app.simulation.engine import run_simulation
from test_simulation import load


class BlockedExitTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = load("two_exit_room.json")
        cls.before = cls.source.model_dump()
        cls.pair = compare_exit_availability(cls.source, ["exit-east"])

    def test_blocked_exit_is_never_assigned_or_used(self):
        blocked = self.pair["blocked"]
        self.assertEqual(blocked["status"], "completed")
        self.assertEqual(blocked["summary"]["per_exit_counts"], {
            "exit-east": 0, "exit-west": 50,
        })
        self.assertEqual({a["exit_id"] for a in blocked["assignments"]}, {"exit-west"})
        self.assertEqual({e["exit_id"] for e in blocked["evacuations"]}, {"exit-west"})

    def test_comparison_reuses_exact_people_positions_and_model_settings(self):
        a, b = self.pair["baseline"], self.pair["blocked"]
        self.assertEqual(a["scenario"]["occupants"], b["scenario"]["occupants"])
        self.assertEqual(a["frames"][0], b["frames"][0])
        for name in ("walkable_areas", "obstacles", "exits", "agent_defaults"):
            self.assertEqual(a["scenario"][name], b["scenario"][name])
        a_settings = dict(a["scenario"]["settings"])
        b_settings = dict(b["scenario"]["settings"])
        a_settings.pop("blocked_exit_ids")
        b_settings.pop("blocked_exit_ids")
        self.assertEqual(a_settings, b_settings)
        self.assertEqual(a["population_generation"], b["population_generation"])
        self.assertEqual(a["population_generation"]["seed"], 42)
        self.assertTrue(self.pair["comparison"]["same_starting_positions"])
        self.assertEqual(self.source.model_dump(), self.before)

    def test_report_delta_matches_completed_runs(self):
        report = self.pair["comparison"]
        expected = round(report["blocked"]["clearance_time"] - report["baseline"]["clearance_time"], 8)
        self.assertEqual(report["clearance_time_change_s"], expected)
        self.assertEqual(sum(report["per_exit_count_changes"].values()), 0)

    def test_closure_does_not_change_seeded_placement(self):
        source = load("two_exit_room.json")
        expected = resolve_population(source).occupants
        source.settings.blocked_exit_ids = ["exit-east"]
        self.assertEqual(resolve_population(source).occupants, expected)

    def test_invalid_blocked_exit_configuration_is_rejected(self):
        for blocked, message in (
            (["missing"], "Unknown blocked exit IDs"),
            (["exit-east", "exit-east"], "Blocked exit IDs must be unique"),
            (["exit-east", "exit-west"], "At least one exit must remain available"),
        ):
            with self.subTest(blocked=blocked):
                data = load("two_exit_room.json").model_dump()
                data["settings"]["blocked_exit_ids"] = blocked
                with self.assertRaisesRegex(ValidationError, message):
                    Scenario.model_validate(data)

    def test_engine_revalidates_modified_configuration(self):
        source = load("two_exit_room.json")
        source.settings.blocked_exit_ids = ["exit-east", "exit-west"]
        with self.assertRaisesRegex(ValidationError, "At least one exit"):
            run_simulation(source)

    def test_comparison_requires_all_open_baseline_and_a_closure(self):
        source = load("two_exit_room.json")
        with self.assertRaisesRegex(ValueError, "Select at least one"):
            compare_exit_availability(source, [])
        source.settings.blocked_exit_ids = ["exit-east"]
        with self.assertRaisesRegex(ValueError, "baseline scenario must have all exits"):
            compare_exit_availability(source, ["exit-west"])

    def test_incomplete_variant_has_no_clearance_time_delta(self):
        source = load("two_exit_room.json")
        source.settings.max_time = 25
        pair = compare_exit_availability(source, ["exit-east"])
        self.assertEqual(pair["baseline"]["status"], "completed")
        self.assertEqual(pair["blocked"]["status"], "timed_out")
        self.assertIsNone(pair["blocked"]["summary"]["clearance_time"])
        self.assertIsNone(pair["comparison"]["clearance_time_change_s"])
        self.assertGreater(pair["blocked"]["summary"]["remaining_count"], 0)


if __name__ == "__main__":
    unittest.main()
