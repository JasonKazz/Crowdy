"""Native movement and HTTP regression tests for illustrative behavior modes."""
import copy
import json
import unittest
from pathlib import Path

from pydantic import ValidationError

from app import api
from app.schemas.scenario import Scenario
from app.simulation.behavior import agent_behaviors
from app.simulation.editor_adapter import editor_to_scenario
from app.simulation.engine import run_simulation
from app.simulation.workspace_layout import native_to_editor
from test_workspace_api import room_request


class BehaviorTests(unittest.TestCase):
    def scenario(self):
        payload = room_request(12)
        payload["scenario"].update(behavior_mode="behavioral", seed=7, mobility="mixed")
        return editor_to_scenario(payload["plan"], payload["scenario"])

    def test_behavior_is_identity_seeded_and_does_not_change_base_people(self):
        scenario = self.scenario()
        original = scenario.model_dump()
        first = agent_behaviors(scenario)
        self.assertEqual(first, agent_behaviors(scenario))
        reversed_scenario = scenario.model_copy(update={"occupants": list(reversed(scenario.occupants))})
        self.assertEqual(first, list(reversed(agent_behaviors(reversed_scenario))))
        for person, behavior in zip(scenario.occupants, first):
            self.assertEqual(behavior["response_delay"], 0)
            self.assertTrue(.85 <= behavior["speed_factor"] <= 1.15)
            self.assertAlmostEqual(behavior["desired_speed"], person.desired_speed * behavior["speed_factor"], places=6)
        self.assertGreater(len({b["desired_speed"] for b in first}), 3)
        self.assertEqual(scenario.model_dump(), original)
        scenario.settings.behavior_seed += 1
        self.assertNotEqual(first, agent_behaviors(scenario))

    def test_natural_starts_immediately_and_remains_deterministic(self):
        scenario = self.scenario()
        result = run_simulation(scenario)
        repeated = run_simulation(scenario)
        self.assertEqual(result["frames"], repeated["frames"])
        self.assertEqual(result["routing"], repeated["routing"])
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["behavior"]["version"], 2)
        self.assertTrue(all(p["response_delay"] == 0 for p in result["behavior"]["agents"]))
        self.assertNotEqual(result["frames"][0]["agents"], result["frames"][1]["agents"])
        self.assertEqual(result["scenario"]["occupants"], scenario.model_dump(mode="json")["occupants"])

    def test_short_run_keeps_remaining_people_without_artificial_waits(self):
        scenario = self.scenario()
        scenario.settings.max_time = .02
        result = run_simulation(scenario)
        self.assertEqual(result["status"], "timed_out")
        self.assertEqual(result["summary"]["remaining_count"], 12)
        self.assertEqual(result["summary"]["trapped_count"], 0)
        self.assertIsNone(result["summary"]["clearance_time"])
        self.assertNotEqual(result["frames"][0]["agents"],result["frames"][-1]["agents"])

    def test_all_closed_still_reports_trapped_without_waiting(self):
        scenario = self.scenario()
        scenario.settings.blocked_exit_ids = [e.id for e in scenario.exits]
        result = run_simulation(scenario)
        self.assertEqual(result["status"], "trapped")
        self.assertEqual(result["summary"]["trapped_count"], 12)
        self.assertEqual(result["summary"]["simulation_time"], 0)

    def test_idealized_uses_base_speed_without_delay(self):
        scenario = self.scenario()
        scenario.settings.behavior_mode = "idealized"
        for person, behavior in zip(scenario.occupants, agent_behaviors(scenario)):
            self.assertEqual(behavior["response_delay"], 0)
            self.assertEqual(behavior["speed_factor"], 1)
            self.assertEqual(behavior["desired_speed"], person.desired_speed)

    def test_both_editor_formats_compare_modes_without_compounding_speed(self):
        source = Path(__file__).resolve().parents[2] / "examples/narrow_table_regression.json"
        for plan in (room_request()["plan"], native_to_editor(json.loads(source.read_text()))):
            with self.subTest(native=bool(plan.get("native"))):
                settings = {"occupancy":12,"mobility":"mixed","distribution":"uniform","seed":7}
                before = api.run_editor_simulation(api.SimulationRequest(plan=plan,scenario=settings))
                reference = {"occupants":before["scenario"]["occupants"],"radius":before["scenario"]["agent_defaults"]["radius"],
                             "mobility":"mixed","distribution":"uniform","seed":7}
                request = api.SimulationRequest(plan=plan,scenario={**settings,"behavior_mode":"behavioral"},
                                               starting_population=reference)
                after = api.run_editor_simulation(request)
                repeated = api.run_editor_simulation(request)
                self.assertEqual(before["scenario"]["occupants"],after["scenario"]["occupants"])
                self.assertEqual(before["frames"][0],after["frames"][0])
                self.assertEqual(after["behavior"],repeated["behavior"])
                self.assertEqual(after["frames"],repeated["frames"])
                self.assertTrue(after["editor_metadata"]["reused_starting_population"])
                self.assertEqual(after["behavior"]["seed"],7)
                self.assertEqual(after["status"],"completed")

    def test_invalid_mode_or_seed_is_rejected(self):
        data = self.scenario().model_dump()
        for setting, value in (("behavior_mode","optimal"),("behavior_seed",-1)):
            invalid = copy.deepcopy(data)
            invalid["settings"][setting] = value
            with self.assertRaises(ValidationError):
                Scenario.model_validate(invalid)
