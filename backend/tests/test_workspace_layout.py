"""Real HTTP runs through both layout formats; no paid provider requests."""
import copy
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient
from shapely.geometry import Polygon

from app import api
from app.schemas.extraction import ExtractedDrawing
from app.simulation.editor_adapter import editor_to_scenario
from app.simulation.workspace_layout import native_to_editor, editor_native_layout
from test_images import gemini_fixture, upload_fixture

EXAMPLES = Path(__file__).resolve().parents[2] / "examples"


class WorkspaceLayoutTests(unittest.TestCase):
    def test_automatic_placement_excludes_and_reports_body_inaccessible_pocket(self):
        from test_exterior_exits import room
        from app.schemas.scenario import Region
        from app.services.floorplans.layout import compile_layout
        from app.simulation.engine import run_simulation
        layout = room()
        layout.furniture = [Region(id=name, polygon=points) for name,points in (
            ("left", [(2,2),(2.2,2),(2.2,4),(2,4)]),
            ("top", [(2.2,3.8),(4,3.8),(4,4),(2.2,4)]),
            ("bottom", [(2.2,2),(4,2),(4,2.2),(2.2,2.2)]),
            ("right_lower", [(3.8,2.2),(4,2.2),(4,2.85),(3.8,2.85)]),
            ("right_upper", [(3.8,3.15),(4,3.15),(4,3.8),(3.8,3.8)]))]
        plan = native_to_editor(layout.model_dump(mode="json"))
        response = self.client.post("/api/simulations", json={"plan": plan, "scenario": self.settings})
        self.assertEqual(response.status_code, 200, response.text)
        result = response.json()
        self.assertGreater(result["editor_metadata"]["excluded_spawn_area_m2"], .5)
        self.assertEqual(result["summary"]["evacuated_count"], self.settings["occupancy"])
        self.assertFalse(any(2.2 < p["position"][0] < 3.8 and 2.2 < p["position"][1] < 3.8
                             for p in result["scenario"]["occupants"]))
        # Explicitly trapped people remain an error, not silently relocated.
        layout.occupants[0].position = (3,3)
        with self.assertRaisesRegex(ValueError, "No body-clear route"):
            run_simulation(compile_layout(layout))

    def setUp(self):
        self.source = json.loads((EXAMPLES / "narrow_table_regression.json").read_text())
        self.plan = native_to_editor(self.source)
        self.settings = {"occupancy": 20, "mobility": "standard", "distribution": "uniform", "seed": 7}
        self.client = TestClient(api.app)
        self.addCleanup(self.client.close)
        self.environment = patch.dict("os.environ", {"CROWDY_BACKEND_TOKEN": ""})
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def test_import_retains_polygons_doors_and_real_world_scale(self):
        response = self.client.post("/api/floorplans", json={"layout": self.source})
        self.assertEqual(response.status_code, 200, response.text)
        plan = response.json()["plan"]
        layout, _ = editor_native_layout(plan)
        self.assertEqual(layout.walkable_areas[0].polygon, [tuple(p) for p in self.source["walkable_areas"][0]["polygon"]])
        self.assertEqual(layout.doors[0].model_dump(mode="json"), self.source["doors"][0])
        for old, new in zip(self.source["furniture"], layout.furniture):
            self.assertLess(Polygon(old["polygon"]).symmetric_difference(Polygon(new.polygon)).area, 1e-10)
        self.assertTrue(plan["native"]["walls"])
        self.assertEqual(len(plan["native"]["exit_zones"]), 2)
        self.assertEqual(len(self.source["occupants"]), 40)

    def test_moved_polygon_is_the_exact_obstacle_used_by_simulation(self):
        plan = copy.deepcopy(self.plan)
        plan["items"][1]["x"] += 12
        source_shape = Polygon(self.source["furniture"][1]["polygon"])
        layout, transform = editor_native_layout(plan)
        expected_shift = 12 / transform["pixels_per_metre"]
        self.assertAlmostEqual(Polygon(layout.furniture[1].polygon).centroid.x - source_shape.centroid.x, expected_shift)
        response = self.client.post("/api/simulations", json={"plan": plan, "scenario": self.settings})
        self.assertEqual(response.status_code, 200, response.text)
        result = response.json()
        self.assertEqual(result["engine"], "jupedsim")
        self.assertEqual(result["summary"]["evacuated_count"], 20)
        self.assertEqual(result["summary"]["remaining_count"], 0)
        self.assertEqual(len(result["door_crossings"]), 20)
        self.assertEqual(result["editor_metadata"]["seed"], 7)

    def test_seed_and_mixed_profile_survive_native_bridge(self):
        first = editor_to_scenario(self.plan, self.settings)
        repeat = editor_to_scenario(self.plan, self.settings)
        self.assertEqual(first.occupants, repeat.occupants)
        second = editor_to_scenario(self.plan, {**self.settings, "seed": 8, "mobility": "mixed"})
        self.assertNotEqual([p.position for p in first.occupants], [p.position for p in second.occupants])
        self.assertEqual(sum(p.desired_speed == .72 for p in second.occupants), 5)

    def test_invalid_scale_and_polygon_are_rejected_before_simulation(self):
        plan = copy.deepcopy(self.plan)
        plan["native"]["transform"]["pixels_per_metre"] *= 2
        response = self.client.post("/api/simulations", json={"plan": plan, "scenario": self.settings})
        self.assertEqual(response.status_code, 422)
        self.assertIn("scale", response.json()["detail"])
        plan = copy.deepcopy(self.plan)
        plan["items"][0]["polygon"][0]["x"] = -1
        self.assertEqual(self.client.post("/api/simulations", json={"plan": plan, "scenario": self.settings}).status_code, 422)

    def test_image_extraction_uses_existing_pipeline_and_confirmed_scale(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict("os.environ", {"CROWDY_STORAGE_DIR": directory}), \
                patch("app.services.floorplans.images.extract_drawing", return_value=(ExtractedDrawing.model_validate(gemini_fixture()), "test-model")) as provider:
            upload = upload_fixture().model_dump()
            response = self.client.post("/api/floorplans", json={**upload, "provider": "gemini", "image_width_m": 20})
            self.assertEqual(response.status_code, 200, response.text)
            provider.assert_called_once()
            plan = response.json()["plan"]
            source = plan["native"]["layout"]["source_image"]
            self.assertTrue(source["scale_confirmed"])
            self.assertAlmostEqual(source["meters_per_pixel"] * source["width_px"], 20)
            self.assertTrue(plan["native"]["layout"]["extraction"])

    def test_reported_claude_wall_roundoff_imports_and_simulates(self):
        # Actual saved observations from sample_floorplan.png; no paid model call.
        drawing = ExtractedDrawing.model_validate_json(
            (Path(__file__).parent / "fixtures" / "claude-boundary-observations.json").read_text())
        with tempfile.TemporaryDirectory() as directory, patch.dict("os.environ", {"CROWDY_STORAGE_DIR": directory}), \
                patch("app.services.floorplans.images.extract_drawing", return_value=(drawing, "saved-claude-output")):
            response = self.client.post("/api/floorplans", json={
                **upload_fixture().model_dump(), "provider": "claude", "image_width_m": 20})
        self.assertEqual(response.status_code, 200, response.text)
        plan = response.json()["plan"]
        wall = plan["native"]["layout"]["walls"][0]
        self.assertEqual(wall["start"], [10, 9.040000000000001])
        self.assertEqual(wall["end"], [10, .92])
        run = self.client.post("/api/simulations", json={"plan": plan, "scenario": self.settings})
        self.assertEqual(run.status_code, 200, run.text)
        self.assertEqual(run.json()["summary"]["evacuated_count"], 20)
        self.assertEqual(run.json()["summary"]["remaining_count"], 0)

    def test_import_uses_same_backend_token_as_simulation(self):
        with patch.dict("os.environ", {"CROWDY_BACKEND_TOKEN": "local-test-token"}):
            self.assertEqual(self.client.post("/api/floorplans", json={"layout": self.source}).status_code, 401)
            response = self.client.post("/api/floorplans", json={"layout": self.source}, headers={"Authorization": "Bearer local-test-token"})
            self.assertEqual(response.status_code, 200)
