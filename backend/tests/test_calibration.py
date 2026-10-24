import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from app import api
from app.schemas.extraction import ExtractedDrawing, ScaleReference
from app.services.floorplans.calibration import calibrate
from test_images import drawing_fixture, source, upload_fixture


def reference(start=(50, 50), end=(950, 50), distance=18, unit="m"):
    return ScaleReference(kind="dimension", label=f"{distance} {unit}",
                          start={"x": start[0], "y": start[1]}, end={"x": end[0], "y": end[1]},
                          distance=distance, unit=unit)


class CalibrationTests(unittest.TestCase):
    def test_pixel_and_normalized_references_produce_identical_scale(self):
        claude, _ = calibrate(source(), [reference()], "claude")
        gemini, _ = calibrate(source(), [reference(start=(50, 100), end=(950, 100))], "gemini")
        self.assertAlmostEqual(claude.meters_per_pixel, .02)
        self.assertEqual(claude.calibration, gemini.calibration)
        self.assertTrue(claude.scale_confirmed)

    def test_units_and_manual_reference(self):
        for unit, distance in (("m", 18), ("cm", 1800), ("mm", 18000), ("ft", 18 / .3048), ("in", 18 / .0254)):
            with self.subTest(unit=unit):
                result, _ = calibrate(source(), [reference(distance=distance, unit=unit)], "claude", manual=True)
                self.assertAlmostEqual(result.meters_per_pixel, .02)
                self.assertEqual(result.calibration.method, "manual")

    def test_missing_short_outside_and_conflicting_measurements_need_manual_scale(self):
        for references in ([], [reference(end=(51, 50))], [reference(start=(-1, 50))],
                           [reference(), reference(start=(50, 100), end=(950, 100), distance=30)]):
            with self.subTest(references=references):
                result, reason = calibrate(source(), references, "claude")
                self.assertIsNone(result)
                self.assertTrue(reason)

    def test_independent_agreeing_dimensions_choose_the_longest(self):
        result, _ = calibrate(source(), [reference(), reference(start=(50, 50), end=(50, 450), distance=8)], "claude")
        self.assertAlmostEqual(result.meters_per_pixel, .02)
        self.assertEqual(len(result.calibration.references), 2)


class CalibrationAPITests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        env = patch.dict("os.environ", {"CROWDY_STORAGE_DIR": self.directory.name, "CROWDY_BACKEND_TOKEN": ""})
        env.start(); self.addCleanup(env.stop)
        self.client = TestClient(api.app); self.addCleanup(self.client.close)

    def import_drawing(self, drawing, provider="claude"):
        with patch("app.services.floorplans.images.extract_drawing", return_value=(ExtractedDrawing.model_validate(drawing), "test-model")) as call:
            response = self.client.post("/api/floorplans", json={**upload_fixture().model_dump(), "provider": provider})
        self.assertEqual(response.status_code, 200, response.text)
        call.assert_called_once()
        return response.json()

    def test_automatic_import_records_evidence_and_source_image_alignment(self):
        drawing = drawing_fixture(); drawing["scale_references"] = [reference().model_dump()]
        imported = self.import_drawing(drawing)
        native = imported["plan"]["native"]
        image, source_image = native["image"], native["layout"]["source_image"]
        self.assertEqual(source_image["calibration"]["method"], "automatic")
        self.assertAlmostEqual(source_image["meters_per_pixel"], .02)
        self.assertAlmostEqual(image["width"], 20 * native["transform"]["pixels_per_metre"])
        self.assertAlmostEqual(image["y"], native["transform"]["offset_y"] - 10 * native["transform"]["pixels_per_metre"])
        response = self.client.get(f'/api/floorplans/images/{image["id"]}')
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.content.startswith(b"\x89PNG"))

    def test_manual_fallback_uses_saved_extraction_without_another_provider_call(self):
        pending = self.import_drawing(drawing_fixture())
        self.assertTrue(pending["needs_scale"])
        self.assertNotIn("plan", pending)
        with patch("app.services.floorplans.images.extract_drawing", side_effect=AssertionError("Must reuse observations")):
            response = self.client.post("/api/floorplans", json={"extraction_id": pending["extraction_id"],
                "manual_scale": reference().model_dump()})
        self.assertEqual(response.status_code, 200, response.text)
        plan = response.json()["plan"]
        self.assertEqual(plan["native"]["layout"]["source_image"]["calibration"]["method"], "manual")
        run = self.client.post("/api/simulations", json={"plan": plan,
            "scenario": {"occupancy": 20, "mobility": "standard", "distribution": "uniform", "seed": 7}})
        self.assertEqual(run.status_code, 200, run.text)
        self.assertEqual(run.json()["summary"]["evacuated_count"], 20)

    def test_invalid_draft_can_be_corrected_but_cannot_be_simulated(self):
        drawing = drawing_fixture(); drawing["scale_references"] = [reference().model_dump()]
        drawing["walls"][0]["start"]["y"] = 40  # actually outside the floor, not roundoff
        plan = self.import_drawing(drawing)["plan"]
        self.assertIn("outside", plan["native"]["issues"][0])
        settings = {"occupancy": 10, "mobility": "standard", "distribution": "uniform"}
        self.assertEqual(self.client.post("/api/simulations", json={"plan": plan, "scenario": settings}).status_code, 422)
        plan["native"]["layout"]["walls"][0]["start"][1] = 9
        response = self.client.post("/api/floorplans", json={"editor_plan": plan})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["plan"]["native"]["issues"], [])

    def test_recalibration_preserves_edits_and_physical_agent_size(self):
        drawing = drawing_fixture(); drawing["scale_references"] = [reference().model_dump()]
        plan = self.import_drawing(drawing)["plan"]
        plan["items"][0]["x"] += 10
        plan["native"]["layout"]["doors"][0]["offset"] = 3.5
        response = self.client.post("/api/floorplans", json={"editor_plan": plan, "manual_scale": reference(distance=36).model_dump()})
        self.assertEqual(response.status_code, 200, response.text)
        corrected = response.json()["plan"]
        self.assertAlmostEqual(corrected["items"][0]["x"], plan["items"][0]["x"])
        self.assertEqual(corrected["native"]["layout"]["doors"][0]["offset"], 7)
        self.assertEqual(corrected["native"]["layout"]["agent_defaults"]["radius"], .2)

    def test_invalid_door_offset_remains_editable_without_extending_preview_wall(self):
        drawing = drawing_fixture(); drawing["scale_references"] = [reference().model_dump()]
        plan = self.import_drawing(drawing)["plan"]
        plan["native"]["layout"]["doors"][0]["offset"] = 100
        response = self.client.post("/api/floorplans", json={"editor_plan": plan})
        self.assertEqual(response.status_code, 200, response.text)
        native = response.json()["plan"]["native"]
        self.assertIn("past the ends", native["issues"][0])
        self.assertEqual(native["layout"]["doors"][0]["offset"], 100)
        floor_y = [p["y"] for polygon in native["floors"] for p in polygon]
        for polygon in native["walls"]:
            for point in polygon:
                self.assertGreaterEqual(point["y"], min(floor_y) - 1e-8)
                self.assertLessEqual(point["y"], max(floor_y) + 1e-8)

    def test_source_images_and_saved_extractions_validate_ids_and_auth(self):
        self.assertEqual(self.client.get("/api/floorplans/images/not-an-id").status_code, 400)
        self.assertEqual(self.client.get("/api/floorplans/images/" + "a" * 32).status_code, 404)
        with patch.dict("os.environ", {"CROWDY_BACKEND_TOKEN": "test-token"}):
            self.assertEqual(self.client.get("/api/floorplans/images/" + "a" * 32).status_code, 401)
        self.assertEqual(self.client.post("/api/floorplans", json={"extraction_id": "../invalid", "manual_scale": reference().model_dump()}).status_code, 422)
