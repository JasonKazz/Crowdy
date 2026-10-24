import copy
import json
import tempfile
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from app import api
from app.schemas.extraction import CalibrationInfo, ExtractedDrawing
from app.services.floorplans.calibration import calibrate_drawing, estimate_scale
from app.services.floorplans.providers import ProviderError, extract_drawing, output_schema
from test_calibration import reference
from test_images import drawing_fixture, region, source, upload_fixture


def estimated_drawing():
    drawing = drawing_fixture()
    drawing["doors"][0]["end"]["y"] = 245  # 45 px opening -> .90 m at .02 m/px
    drawing["furniture"] = [region("desk", 150, 150, 220, 185), region("chair", 300, 150, 330, 180)]
    drawing["scale_objects"] = [{"object_id": name, "kind": kind} for name, kind in
        (("door", "single_door"), ("desk", "office_desk"), ("chair", "office_chair"))]
    return drawing


def normalized(drawing):
    drawing = copy.deepcopy(drawing)
    def visit(value):
        if isinstance(value, dict):
            if set(value) == {"x", "y"}:
                value["y"] *= 2  # 1000 x 500 input, independently normalized axes
            else:
                for child in value.values():
                    visit(child)
        elif isinstance(value, list):
            for child in value:
                visit(child)
    visit(drawing)
    drawing["walls"][0]["thickness"] *= 2
    return drawing


def omitted_door_drawing():
    """A fresh-upload regression: 33/36px desks and a 30px opening."""
    drawing = estimated_drawing()
    drawing["furniture"] = [region(f"desk_{i}", 100+i*100, 150, 100+i*100+width, 170)
                            for i, width in enumerate((33, 36, 33))]
    for item in drawing["furniture"]:
        item["label"] = "Desk"
    drawing["scale_objects"] = [{"object_id": item["id"], "kind": "office_desk"} for item in drawing["furniture"]]
    drawing["doors"][0]["end"]["y"] = 230
    return drawing


def estimate(drawing, provider="claude"):
    return calibrate_drawing(source(), ExtractedDrawing.model_validate(drawing), provider)


class EstimatedScaleTests(unittest.TestCase):
    def test_unclassified_unusual_desk_does_not_override_selected_scale_anchors(self):
        drawing = omitted_door_drawing()
        # A useful barrier need not be a standard-sized scale reference.
        drawing["furniture"].append(region("small_desk", 700, 150, 720, 170))
        drawing["furniture"][-1]["label"] = "Desk"
        result, reason = estimate(drawing)
        self.assertIsNotNone(result, reason)
        self.assertNotIn("small_desk", [obj.object_id for obj in result.calibration.estimated_objects])
        # An explicit conflicting classification still requires review.
        drawing["scale_objects"].append({"object_id": "small_desk", "kind": "office_desk"})
        self.assertIsNone(estimate(drawing)[0])

    def test_door_inference_uses_the_final_consensus_in_both_coordinate_systems(self):
        drawing = omitted_door_drawing()
        claude, reason = estimate(drawing)
        gemini, _ = estimate(normalized(drawing), "gemini")
        self.assertIsNotNone(claude, reason)
        self.assertEqual(claude.calibration, gemini.calibration)
        self.assertGreaterEqual(claude.meters_per_pixel, 1 / 33)
        self.assertLessEqual(claude.meters_per_pixel, 1.05 / 30)
        self.assertIn("door", [obj.object_id for obj in claude.calibration.estimated_objects])
    def test_missing_door_classification_is_recovered_from_existing_geometry(self):
        drawing = estimated_drawing()
        drawing["furniture"] = [region(f"desk_{i}", 100+i*100, 150, 138+i*100, 170) for i in range(3)]
        for item in drawing["furniture"]:
            item["label"] = "Desk"
        drawing["scale_objects"] = [{"object_id": item["id"], "kind": "office_desk"} for item in drawing["furniture"]]
        door = drawing["doors"][0]
        door["end"]["y"] = 225  # 25px single opening, omitted by model classifier
        for i, width in enumerate((53, 60)):
            wide = copy.deepcopy(door)
            wide["id"] = f"double_{i}"
            wide["end"]["y"] = 200+width
            drawing["doors"].append(wide)
        result, reason = estimate(drawing)
        self.assertIsNotNone(result, reason)
        objects = {item.object_id:item for item in result.calibration.estimated_objects}
        self.assertEqual(objects["door"].origin, "geometry")
        self.assertNotIn("double_0", objects)
        self.assertNotIn("double_1", objects)
        self.assertEqual(result.calibration.method, "estimated")
        self.assertFalse(result.scale_confirmed)

    def test_empty_classifier_can_use_clear_furniture_labels(self):
        drawing = estimated_drawing()
        drawing["scale_objects"] = []
        result, reason = estimate(drawing)
        self.assertIsNotNone(result, reason)
        self.assertTrue(all(obj.origin == "geometry" for obj in result.calibration.estimated_objects))
        self.assertAlmostEqual(result.meters_per_pixel, .02)

    def test_geometry_inference_does_not_relabel_tables_or_mismatched_doorways(self):
        drawing = estimated_drawing()
        drawing["scale_objects"] = []
        drawing["furniture"][0]["label"] = "Desk bank"
        self.assertIsNone(estimate(drawing)[0])
        drawing["furniture"][0]["label"] = "Office desk"
        drawing["doors"][0]["end"]["y"] = 290  # wide double opening disagrees with furniture
        self.assertIsNone(estimate(drawing)[0])

    def test_inference_keeps_existing_conflicting_classifications_for_review(self):
        drawing = estimated_drawing()
        drawing["furniture"][1] = region("chair", 300, 150, 360, 210)
        drawing["furniture"][1]["label"] = "Chair"
        self.assertIsNone(estimate(drawing)[0])

    def test_compact_provider_classifications_restore_typed_objects_and_reject_invalid_types(self):
        self.assertEqual(output_schema()["properties"]["scale_objects"]["items"], {"type": "string"})
        for provider in ("claude", "gemini"):
            for valid in (True, False):
                drawing = estimated_drawing()
                drawing["scale_objects"] = ["single_door:door", "office_desk:desk", "office_chair:chair" if valid else "conference_table:chair"]
                response = {"content": [{"type": "text", "text": json.dumps(drawing)}]} if provider == "claude" else {
                    "candidates": [{"content": {"parts": [{"text": json.dumps(drawing)}]}}]}
                with patch.dict("os.environ", {"ANTHROPIC_API_KEY": "fake", "GEMINI_API_KEY": "fake"}), \
                        patch("app.services.floorplans.providers.request_json", return_value=response):
                    if valid:
                        observed, _ = extract_drawing(provider, b"test-only", 1000, 500)
                        self.assertEqual(observed.scale_objects[0].object_id, "door")
                        self.assertEqual(observed.scale_objects[2].kind, "office_chair")
                    else:
                        with self.assertRaises(ProviderError):
                            extract_drawing(provider, b"test-only", 1000, 500)

    def test_claude_and_gemini_get_same_scale_with_auditable_assumptions(self):
        drawing = estimated_drawing()
        claude, reason = estimate(drawing)
        gemini, _ = estimate(normalized(drawing), "gemini")
        self.assertEqual(reason, "")
        self.assertAlmostEqual(claude.meters_per_pixel, .02)
        self.assertEqual(claude.calibration, gemini.calibration)
        self.assertEqual(claude.calibration.method, "estimated")
        self.assertFalse(claude.scale_confirmed)
        self.assertEqual(len(claude.calibration.estimated_objects), 3)
        self.assertEqual(claude.calibration.references, [])  # No fabricated dimension evidence
        self.assertLess(claude.calibration.meters_per_pixel_range[0], .02)
        self.assertGreater(claude.calibration.meters_per_pixel_range[1], .02)

    def test_readable_printed_dimensions_take_priority(self):
        drawing = estimated_drawing()
        drawing["scale_references"] = [reference(distance=36).model_dump()]
        result, _ = estimate(drawing)
        self.assertEqual(result.calibration.method, "automatic")
        self.assertAlmostEqual(result.meters_per_pixel, .04)

    def test_conflicting_or_invalid_printed_evidence_does_not_silently_guess(self):
        for references in ([reference(), reference(distance=36)], [reference(start=(-10, 0))]):
            drawing = estimated_drawing()
            drawing["scale_references"] = [item.model_dump() for item in references]
            self.assertIsNone(estimate(drawing)[0])

    def test_insufficient_duplicate_unknown_and_wrong_category_objects_need_measurement(self):
        for modification in ("few", "duplicate", "unknown", "wrong", "same_shape", "same_type", "tiny", "outside", "invalid_polygon", "ambiguous_id"):
            with self.subTest(modification=modification):
                drawing = estimated_drawing()
                if modification == "few":
                    drawing["scale_objects"].pop()
                elif modification == "duplicate":
                    drawing["scale_objects"][2] = drawing["scale_objects"][1]
                elif modification == "unknown":
                    drawing["scale_objects"][2]["object_id"] = "missing"
                elif modification == "wrong":
                    drawing["scale_objects"][2]["object_id"] = "partition"
                elif modification == "same_shape":
                    drawing["furniture"][1]["polygon"] = drawing["furniture"][0]["polygon"]
                elif modification == "same_type":
                    drawing["scale_objects"] = [{"object_id": "chair", "kind": "office_chair"}] * 5
                elif modification == "tiny":
                    drawing["furniture"][1] = region("chair", 300, 150, 303, 153)
                elif modification == "outside":
                    drawing["furniture"][1] = region("chair", -30, 150, 0, 180)
                elif modification == "invalid_polygon":
                    drawing["furniture"][1]["polygon"] = [{"x": 0, "y": 0}] * 3
                elif modification == "ambiguous_id":
                    drawing["furniture"][1]["id"] = "door"
                self.assertIsNone(estimate_scale(source(), ExtractedDrawing.model_validate(drawing), "claude")[0])

    def test_conflicting_object_sizes_need_measurement(self):
        drawing = estimated_drawing()
        drawing["furniture"][1] = region("chair", 300, 150, 360, 210)
        result, reason = estimate(drawing)
        self.assertIsNone(result)
        self.assertIn("conflicting", reason)

    def test_rotated_furniture_uses_its_own_axes(self):
        drawing = estimated_drawing()
        # Rotate the 70 x 35 desk 45 degrees, preserving its true longest side.
        from math import cos, sin, pi
        for p in drawing["furniture"][0]["polygon"]:
            x, y = p["x"] - 150, p["y"] - 150
            p["x"], p["y"] = 150 + x*cos(pi/4)-y*sin(pi/4), 150+x*sin(pi/4)+y*cos(pi/4)
        result, _ = estimate(drawing)
        self.assertAlmostEqual(result.meters_per_pixel, .02)

    def test_repeated_furniture_does_not_outvote_door_scale(self):
        drawing = estimated_drawing()
        for i in range(8):
            drawing["furniture"].append(region(f"chair-{i}", 100+i*40, 300, 125+i*40, 325))
            drawing["scale_objects"].append({"object_id": f"chair-{i}", "kind": "office_chair"})
        result, _ = estimate(drawing)
        self.assertAlmostEqual(result.meters_per_pixel, .02)  # Equal category weight

    def test_estimated_metadata_requires_actual_evidence(self):
        with self.assertRaisesRegex(ValueError, "three distinct"):
            CalibrationInfo(method="estimated", label="guess")


class EstimatedScaleAPITests(unittest.TestCase):
    def test_fresh_upload_does_not_ask_for_scale_when_omitted_door_geometry_agrees(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict("os.environ", {"CROWDY_STORAGE_DIR": directory, "CROWDY_BACKEND_TOKEN": ""}), TestClient(api.app) as client:
            drawing = ExtractedDrawing.model_validate(omitted_door_drawing())
            with patch("app.services.floorplans.images.extract_drawing", return_value=(drawing, "fake-model")):
                response = client.post("/api/floorplans", json={**upload_fixture().model_dump(), "provider": "claude"})
            self.assertEqual(response.status_code, 200, response.text)
            self.assertNotIn("needs_scale", response.json())
            calibration = response.json()["plan"]["native"]["layout"]["source_image"]["calibration"]
            self.assertEqual(calibration["method"], "estimated")
            self.assertTrue(any(obj["object_id"] == "door" and obj["origin"] == "geometry" for obj in calibration["estimated_objects"]))

    def test_estimated_import_runs_and_manual_adjustment_preserves_edits_without_model_call(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict("os.environ", {"CROWDY_STORAGE_DIR": directory, "CROWDY_BACKEND_TOKEN": ""}), TestClient(api.app) as client:
            drawing = ExtractedDrawing.model_validate(estimated_drawing())
            with patch("app.services.floorplans.images.extract_drawing", return_value=(drawing, "fake-model")) as call:
                response = client.post("/api/floorplans", json={**upload_fixture().model_dump(), "provider": "claude"})
            self.assertEqual(response.status_code, 200, response.text)
            call.assert_called_once()
            data = response.json()
            self.assertNotIn("needs_scale", data)
            plan = data["plan"]
            native = plan["native"]["layout"]
            self.assertEqual(native["source_image"]["calibration"]["method"], "estimated")
            self.assertFalse(native["source_image"]["scale_confirmed"])
            self.assertTrue(any("estimated" in note for note in data["warnings"]))
            scenario = {"occupancy": 20, "mobility": "standard", "distribution": "uniform", "seed": 7}
            run = client.post("/api/simulations", json={"plan": plan, "scenario": scenario})
            self.assertEqual(run.status_code, 200, run.text)
            self.assertEqual(run.json()["summary"]["evacuated_count"], 20)
            plan["items"][0]["x"] += 10
            native["doors"][0]["offset"] = 3.5
            with patch("app.services.floorplans.images.extract_drawing", side_effect=AssertionError("No second model call")):
                corrected = client.post("/api/floorplans", json={"editor_plan": plan, "manual_scale": reference(distance=36).model_dump()})
            self.assertEqual(corrected.status_code, 200, corrected.text)
            next_plan = corrected.json()["plan"]
            self.assertAlmostEqual(next_plan["items"][0]["x"], plan["items"][0]["x"])
            source_image = next_plan["native"]["layout"]["source_image"]
            self.assertEqual(source_image["calibration"]["method"], "manual")
            self.assertEqual(source_image["calibration"]["estimated_objects"], [])
            self.assertTrue(source_image["scale_confirmed"])
            self.assertEqual(next_plan["native"]["layout"]["doors"][0]["offset"], 7)
            self.assertEqual(next_plan["native"]["layout"]["agent_defaults"]["radius"], .2)
            # Import/export and checks retain estimation provenance until explicitly changed.
            checked = client.post("/api/floorplans", json={"layout": native})
            self.assertEqual(checked.json()["plan"]["native"]["layout"]["source_image"]["calibration"]["method"], "estimated")
