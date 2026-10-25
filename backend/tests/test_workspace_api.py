"""Exercise the editor geometry bridge and real native HTTP response contract."""

import copy
import json
import math
import os
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient
from shapely.geometry import LineString, Point, Polygon

from app import api
from app.simulation.editor_adapter import editor_to_scenario, pixel_to_metres
from app.simulation.engine import run_simulation
from app.simulation.geometry import build_geometry


SAMPLE = json.loads((Path(__file__).parent / "fixtures/editor-sample.json").read_text())


def room_request(count=12):
    # A 10 x 8 metre room with two real, two-metre wall openings.
    return {
        "plan": {
            "id": "test-room", "name": "Test room", "width": 900, "height": 600,
            "area": 80, "items": [],
            "walls": [
                {"x1": 100, "y1": 120, "x2": 420, "y2": 120},
                {"x1": 100, "y1": 376, "x2": 420, "y2": 376},
                {"x1": 100, "y1": 120, "x2": 100, "y2": 216},
                {"x1": 100, "y1": 280, "x2": 100, "y2": 376},
                {"x1": 420, "y1": 120, "x2": 420, "y2": 216},
                {"x1": 420, "y1": 280, "x2": 420, "y2": 376},
            ],
            "exits": [
                {"id": "west", "label": "West", "x": 100, "y": 248},
                {"id": "east", "label": "East", "x": 420, "y": 248},
            ],
        },
        "scenario": {"occupancy": count, "mobility": "standard", "distribution": "uniform"},
    }


class EditorAdapterTests(unittest.TestCase):
    def test_exit_width_matches_the_wall_opening(self):
        payload = room_request()
        scenario = editor_to_scenario(payload['plan'], payload['scenario'])
        for boundary, exit in zip(scenario.exit_boundaries, scenario.exits):
            self.assertAlmostEqual(math.dist(boundary.start, boundary.end), 2)
            self.assertAlmostEqual(Polygon(exit.polygon).bounds[3] - Polygon(exit.polygon).bounds[1], 1.98)

    def test_86_person_queue_recovers_without_walking_to_back_of_line(self):
        # Keep the original wide-door queue fixture: the smaller Berkeley
        # sample has its own single-file passage and full-evacuation checks.
        payload = json.loads((Path(__file__).parent / "fixtures/editor-wide-queue.json").read_text())
        payload['scenario']['occupancy'] = 86
        result = run_simulation(editor_to_scenario(payload['plan'], payload['scenario']))
        self.assertEqual(result['summary']['evacuated_count'], 86)
        boundaries = {b['id']: LineString([b['start'], b['end']]) for b in result['scenario']['exit_boundaries']}
        exits = {a['agent_id']: a['exit_id'] for a in result['assignments']}
        closest = {}
        for frame in result['frames']:
            for person in frame['agents']:
                identifier = person['id']
                distance = boundaries[exits[identifier]].distance(Point(person['x'], person['y']))
                closest[identifier] = min(closest.get(identifier, math.inf), distance)
                if closest[identifier] < 2:
                    self.assertLess(distance - closest[identifier], .5,
                                    f'{identifier} retreated from the doorway at {frame["time"]} s')

    def test_units_walls_and_placement_clearance(self):
        payload = room_request()
        original = copy.deepcopy(payload)
        scenario = editor_to_scenario(payload["plan"], payload["scenario"])
        self.assertEqual(pixel_to_metres(320, 280), (10, 10))
        self.assertEqual(payload, original)
        self.assertEqual(scenario.settings.model_dump(), {"dt": .01, "sample_interval": .2, "max_time": 60, "blocked_exit_ids": [],
                                                       "behavior_mode": "idealized", "behavior_seed": 42})
        self.assertEqual(scenario.agent_defaults.radius, .23)
        self.assertEqual({exit.id for exit in scenario.exits}, {"west", "east"})
        self.assertTrue(any(region.id.startswith("editor-wall-") for region in scenario.obstacles))
        walkable = build_geometry(scenario)
        for occupant in scenario.occupants:
            point = Point(occupant.position)
            self.assertGreaterEqual(point.distance(walkable.boundary), .28 - 1e-9)
            self.assertGreaterEqual(occupant.position[0], 100 / 32)
            self.assertLessEqual(occupant.position[0], 420 / 32)

    def test_seed_repeatability_and_controls_change_population(self):
        payload = copy.deepcopy(SAMPLE)
        payload["scenario"]["occupancy"] = 20
        standard = editor_to_scenario(payload["plan"], payload["scenario"])
        repeated = editor_to_scenario(payload["plan"], payload["scenario"])
        self.assertEqual(standard.occupants, repeated.occupants)
        payload["scenario"]["mobility"] = "mixed"
        mixed = editor_to_scenario(payload["plan"], payload["scenario"])
        self.assertEqual([p.position for p in standard.occupants], [p.position for p in mixed.occupants])
        self.assertEqual(sum(p.desired_speed == .72 for p in mixed.occupants), 5)
        self.assertTrue(all(p.desired_speed == 1.2 for p in standard.occupants))
        payload["scenario"]["distribution"] = "workstations"
        clustered = editor_to_scenario(payload["plan"], payload["scenario"])
        self.assertNotEqual([p.position for p in standard.occupants], [p.position for p in clustered.occupants])
        self.assertEqual(clustered.occupants, editor_to_scenario(payload["plan"], payload["scenario"]).occupants)

    def test_workstations_without_desks_is_explicit_error(self):
        payload = room_request()
        payload["scenario"]["distribution"] = "workstations"
        with self.assertRaisesRegex(ValueError, "at least one desk"):
            editor_to_scenario(payload["plan"], payload["scenario"])

    def test_boundary_exit_does_not_cut_through_wall(self):
        payload = room_request()
        payload["plan"]["walls"].append({"x1": 100, "y1": 216, "x2": 100, "y2": 280})
        with self.assertRaisesRegex(ValueError, "connected|blocked"):
            editor_to_scenario(payload["plan"], payload["scenario"])

    def test_disconnected_rooms_are_rejected(self):
        payload = room_request()
        payload["plan"]["walls"].append({"x1": 260, "y1": 120, "x2": 260, "y2": 376})
        with self.assertRaisesRegex(ValueError, "connected"):
            editor_to_scenario(payload["plan"], payload["scenario"])

    def test_per_person_speed_reaches_native_model(self):
        payload = room_request(count=1)
        scenario = editor_to_scenario(payload["plan"], payload["scenario"])
        # Same person, geometry, route, and sampling; only the walking speed differs.
        scenario.occupants[0].position = (8.125, 11)
        fast = run_simulation(scenario)
        scenario.occupants[0].desired_speed = .72
        slow = run_simulation(scenario)
        self.assertEqual(fast["status"], "completed")
        self.assertEqual(slow["status"], "completed")
        self.assertGreater(slow["summary"]["clearance_time"], fast["summary"]["clearance_time"] * 1.3)


class EditorApiTests(unittest.TestCase):
    def setUp(self):
        self.environment = patch.dict(os.environ, {}, clear=False)
        self.environment.start()
        self.addCleanup(self.environment.stop)
        os.environ.pop("CROWDY_BACKEND_TOKEN", None)
        self.client = TestClient(api.app)
        self.addCleanup(self.client.close)

    def test_health(self):
        response = self.client.get("/health")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["engine"], "jupedsim")
        self.assertEqual(response.json()["version"], "1.4.2")
        self.assertEqual(response.json()["application_version"], "0.1.0")
        self.assertEqual(response.json()["limits"]["max_population"], 10000)
        self.assertEqual(response.json()["status"], "ready")
        self.assertEqual(response.headers["cache-control"], "no-store")

    def test_native_multiple_exit_run_preserves_frames_and_summary(self):
        response = self.client.post("/api/simulations", json=room_request())
        self.assertEqual(response.status_code, 200, response.text)
        result = response.json()
        self.assertEqual(result["engine"], "jupedsim")
        self.assertEqual(result["engine_version"], "1.4.2")
        self.assertEqual(result["editor_metadata"]["seed"], 42)
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["summary"]["evacuated_count"], 12)
        self.assertEqual(result["summary"]["remaining_count"], 0)
        self.assertEqual(set(result["summary"]["per_exit_counts"]), {"west", "east"})
        self.assertTrue(all(count > 0 for count in result["summary"]["per_exit_counts"].values()))
        self.assertEqual(len(result["frames"][0]["agents"]), 12)
        self.assertEqual(result["frames"][0]["time"], 0)
        self.assertEqual(result["frames"][-1]["time"], result["summary"]["simulation_time"])
        self.assertEqual(result["frames"][-1]["agents"], [])
        self.assertEqual(len(result["evacuations"]), 12)
        self.assertEqual(response.headers["cache-control"], "private, no-store")
        for frame in result["frames"]:
            for person in frame["agents"]:
                self.assertEqual(person["x"], round(person["x"], 6))
                self.assertEqual(person["y"], round(person["y"], 6))

    def test_real_berkeley_sample_evacuates_with_body_clear_routing(self):
        response = self.client.post("/api/simulations", json=SAMPLE)
        self.assertEqual(response.status_code, 200, response.text)
        result = response.json()
        self.assertEqual(result["status"], "completed")
        self.assertLess(result["summary"]["simulation_time"], 60)
        self.assertGreater(result["summary"]["clearance_time"], 0)
        self.assertEqual(result["summary"]["remaining_count"], 0)
        self.assertEqual(result["summary"]["remaining_count"] + result["summary"]["evacuated_count"], 80)
        self.assertEqual(len(result["frames"][-1]["agents"]), result["summary"]["remaining_count"])
        self.assertTrue(all(count > 0 for count in result["summary"]["per_exit_counts"].values()))
        self.assertLess(len(response.content), 4_000_000)

    def test_large_floor_area_does_not_block_simulation(self):
        payload = room_request(count=1)
        payload["plan"]["area"] = 14813.587936797483
        response = self.client.post("/api/simulations", json=payload)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["summary"]["evacuated_count"], 1)

    def test_invalid_area_error_identifies_the_field_without_reflecting_input(self):
        payload = room_request()
        payload["plan"].update(area=0, name="private floor plan name")
        with patch("app.api.run_editor_simulation") as run:
            response = self.client.post("/api/simulations", json=payload)
            self.assertEqual(response.status_code, 422)
            self.assertIn("plan.area", response.json()["detail"])
            self.assertIn("greater than 0", response.json()["detail"])
            self.assertNotIn("private floor plan name", response.text)
            run.assert_not_called()

    def test_invalid_parameters_are_422_without_engine_run(self):
        mutations = [
            lambda p: p["scenario"].update(occupancy=10001),
            lambda p: p["scenario"].update(mobility="flying"),
            lambda p: p["scenario"].update(behavior_mode="optimal"),
            lambda p: p["scenario"].update(body_width=.39),
            lambda p: p["plan"].update(width=901),
            lambda p: p["plan"]["walls"][0].update(x1=-1),
            lambda p: p["plan"]["exits"].append(p["plan"]["exits"][0]),
            lambda p: p["plan"].update(items=[{"id": "bad", "label": "Too far", "kind": "desk", "x": 899, "y": 0, "width": 20, "height": 20}]),
        ]
        with patch("app.api.run_editor_simulation") as run:
            for mutate in mutations:
                payload = room_request()
                mutate(payload)
                with self.subTest(payload=payload):
                    response = self.client.post("/api/simulations", json=payload)
                    self.assertEqual(response.status_code, 422)
                    self.assertIn("errors", response.json())
            run.assert_not_called()

    def test_geometry_error_is_actionable_422_and_unlocks(self):
        payload = room_request()
        payload["plan"]["walls"].append({"x1": 260, "y1": 120, "x2": 260, "y2": 376})
        response = self.client.post("/api/simulations", json=payload)
        self.assertEqual(response.status_code, 422)
        self.assertIn("connected", response.json()["detail"])
        self.assertEqual(self.client.get("/health").json()["status"], "ready")

    def test_body_limit_for_declared_and_streamed_requests(self):
        for content in (b"x" * (api.MAX_BODY_BYTES + 1), iter([b"x" * 600_000, b"y" * 600_000])):
            response = self.client.post("/api/simulations", content=content)
            self.assertEqual(response.status_code, 413)
            self.assertIn("1 MB", response.json()["detail"])

    def test_optional_bearer_auth(self):
        os.environ["CROWDY_BACKEND_TOKEN"] = "test-token"
        for headers in ({}, {"Authorization": "Bearer wrong"}, {"Authorization": "Basic test-token"}):
            self.assertEqual(self.client.post("/api/simulations", json=room_request(), headers=headers).status_code, 401)
        with patch("app.api.run_editor_simulation", return_value={"ok": True}):
            response = self.client.post("/api/simulations", json=room_request(), headers={"Authorization": "Bearer test-token"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.client.get("/health").status_code, 200)

    def test_one_concurrent_simulation_and_releases_after_error(self):
        started, release = threading.Event(), threading.Event()

        def running(_payload):
            started.set()
            if not release.wait(timeout=5):
                raise AssertionError("Test failed to release native simulation")
            raise ValueError("Test layout could not be routed")

        with patch("app.api.run_editor_simulation", side_effect=running), ThreadPoolExecutor(max_workers=1) as pool:
            first = pool.submit(self.client.post, "/api/simulations", json=room_request())
            try:
                self.assertTrue(started.wait(timeout=5))
                self.assertEqual(self.client.get("/health").json()["status"], "busy")
                second = self.client.post("/api/simulations", json=room_request())
                self.assertEqual(second.status_code, 429)
                self.assertEqual(second.headers["retry-after"], "2")
            finally:
                release.set()
            self.assertEqual(first.result(timeout=5).status_code, 422)
        self.assertEqual(self.client.get("/health").json()["status"], "ready")


if __name__ == "__main__":
    unittest.main()
