"""The exact bundled demo must remain runnable through the real native engine."""

import json
from pathlib import Path
import unittest

from shapely.geometry import LineString, Polygon
from shapely.ops import unary_union

from app.services.floorplans.layout import compile_layout
from app.simulation.editor_adapter import editor_to_scenario
from app.simulation.engine import run_simulation
from app.simulation.workspace_layout import editor_native_layout


DEMO_ASSET = Path(__file__).resolve().parents[2] / "frontend/src/lib/demos/pofa-verified.json"
DEMO_SETTINGS = {"occupancy": 24, "mobility": "standard", "distribution": "normal", "seed": 42,
                 "body_width": .46, "behavior_mode": "idealized", "population_config": {}}


class PofaDemoTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.asset = json.loads(DEMO_ASSET.read_text())
        cls.plan = cls.asset["plan"]
        cls.layout, _ = editor_native_layout(cls.plan)
        cls.compiled = compile_layout(cls.layout)
        cls.placement = {}
        cls.scenario = editor_to_scenario(cls.plan, DEMO_SETTINGS, placement_metadata=cls.placement)
        cls.result = run_simulation(cls.scenario)

    def test_bundled_asset_strictly_compiles_its_fifteen_visible_exits(self):
        self.assertEqual(self.asset["version"], 1)
        self.assertEqual(self.plan["native"]["issues"], [])
        expected = {door.id for door in self.layout.exits}
        self.assertEqual(len(expected), 15)
        self.assertEqual({exit["id"] for exit in self.plan["exits"]}, expected)
        self.assertEqual({zone["id"] for zone in self.plan["native"]["exit_zones"]}, expected)
        self.assertEqual({region.id for region in self.compiled.exits}, expected)
        self.assertEqual({boundary.id for boundary in self.compiled.exit_boundaries}, expected)

    def test_demo_default_population_really_leaves_through_measured_doorways(self):
        self.assertEqual(self.placement["activity"], "normal")
        self.assertEqual(len(self.placement["normal_placements"]), 24)
        self.assertEqual(len(self.scenario.occupants), 24)
        repeated = editor_to_scenario(self.plan, DEMO_SETTINGS)
        self.assertEqual(self.scenario.occupants, repeated.occupants)
        result = self.result
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["summary"]["evacuated_count"], 24)
        self.assertEqual(result["summary"]["remaining_count"], 0)
        self.assertEqual(result["summary"]["trapped_count"], 0)
        self.assertEqual(result["frames"][-1]["agents"], [])
        people = {person.id for person in self.scenario.occupants}
        crossings = {event["agent_id"]: event for event in result["door_crossings"]}
        evacuations = {event["agent_id"]: event for event in result["evacuations"]}
        self.assertEqual(len(result["door_crossings"]), 24)
        self.assertEqual(len(result["evacuations"]), 24)
        self.assertEqual(set(crossings), people)
        self.assertEqual(set(evacuations), people)
        boundaries = {boundary.id: boundary for boundary in self.scenario.exit_boundaries}
        trajectories = {identifier: [] for identifier in people}
        for frame in result["frames"]:
            for agent in frame["agents"]:
                trajectories[agent["id"]].append((agent["x"], agent["y"]))
        for identifier in people:
            with self.subTest(person=identifier):
                event = crossings[identifier]
                self.assertEqual(event["exit_id"], evacuations[identifier]["exit_id"])
                self.assertLessEqual(event["time"], evacuations[identifier]["time"])
                boundary = boundaries[event["exit_id"]]
                portal = LineString([boundary.start, boundary.end])
                # Independently inspect sampled motion: an outward half-plane
                # alone cannot establish passage through this finite doorway.
                passages = []
                for start, end in zip(trajectories[identifier], trajectories[identifier][1:]):
                    before = sum((start[i] - boundary.start[i]) * boundary.outward[i] for i in range(2))
                    after = sum((end[i] - boundary.start[i]) * boundary.outward[i] for i in range(2))
                    if before <= 0 <= after and after > before:
                        passages.append(LineString([start, end]).intersects(portal))
                self.assertIn(True, passages, "The demo trajectory must cross its recorded doorway's actual jamb span.")
        self.assertLess(result["summary"]["building_clearance_time"], result["summary"]["clearance_time"])

    def test_demo_aprons_cannot_open_unmeasured_recess_sidewalls(self):
        building = unary_union([Polygon(floor.polygon) for floor in self.layout.walkable_areas])
        boundaries = {boundary.id: boundary for boundary in self.compiled.exit_boundaries}
        aprons = [area for area in self.compiled.walkable_areas if area.id.startswith("exit-apron:")]
        self.assertEqual(len(aprons), 15)
        portals = []
        for apron in aprons:
            identifier = apron.id.removeprefix("exit-apron:")
            boundary = boundaries[identifier]
            portal = LineString([boundary.start, boundary.end])
            portals.append(portal)
            with self.subTest(exit=identifier):
                contacts = Polygon(apron.polygon).intersection(building.boundary)
                self.assertLess(contacts.difference(portal.buffer(1e-7)).length, 1e-8)
        outside = unary_union([Polygon(apron.polygon) for apron in aprons])
        contacts = outside.intersection(building.boundary)
        self.assertLess(contacts.difference(unary_union(portals).buffer(1e-7)).length, 1e-8)


if __name__ == "__main__":
    unittest.main()
