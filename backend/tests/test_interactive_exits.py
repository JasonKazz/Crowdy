"""Source-detail entrance verification without live model calls."""

import copy
import base64
import io
import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

from shapely.geometry import Polygon
from PIL import Image

from app.schemas.extraction import ExtractedDrawing, ExtractionRequest, ImageUpload, ScaleReference
from app.services.floorplans.entrance_review import EntranceSurvey
from app.services.floorplans.images import extract_image, finish_calibration, save_image
from app.services.floorplans.interactive_exits import entrance_windows, review_interactive_exits, uncertain_exits
from app.services.floorplans.providers import ProviderError, _EXTRACTION_DEADLINE, extraction_deadline
from app.services.floorplans.staged import to_pixels
from app.simulation.editor_adapter import editor_to_scenario
from app.simulation.engine import run_simulation
from app.simulation.workspace_layout import native_to_editor
from test_images import drawing_fixture, gemini_fixture, image_bytes


class InteractiveEntranceTests(unittest.TestCase):
    def survey(self, provider="claude", *, x=50):
        sy = 2 if provider == "gemini" else 1
        return EntranceSurvey.model_validate({
            "boundary_path": [{"x": x, "y": 50 * sy}, {"x": x, "y": 450 * sy}],
            "openings": [{"start": {"x": x, "y": 70 * sy}, "end": {"x": x, "y": 130 * sy}}],
            "warnings": [],
        })

    def test_clear_observed_exits_do_not_add_provider_calls(self):
        drawing = ExtractedDrawing.model_validate(drawing_fixture())
        with patch("app.services.floorplans.interactive_exits.extract_structured") as provider:
            observed, report = review_interactive_exits("claude", image_bytes(), 1000, 500, drawing)
        provider.assert_not_called()
        self.assertIsNone(report)
        self.assertEqual(observed, drawing)

    def test_partial_exit_warning_cannot_be_hidden_by_one_observed_door(self):
        drawing = ExtractedDrawing.model_validate(drawing_fixture())
        drawing.warnings = ["Some exterior door jambs are unreadable; only one opening was identified."]
        self.assertTrue(uncertain_exits(drawing))
        drawing.warnings = ["Some interior partitions were unclear."]
        self.assertFalse(uncertain_exits(drawing))

    def test_a_marker_missing_the_outline_needs_image_review_before_scale(self):
        drawing = ExtractedDrawing.model_validate(drawing_fixture())
        drawing.exits[0].polygon = [point.model_copy(update={"x": point.x + 35}) for point in drawing.exits[0].polygon]
        self.assertTrue(uncertain_exits(drawing))

    def test_marker_touching_a_curve_corner_still_needs_review_if_jambs_cross_edges(self):
        drawing = ExtractedDrawing.model_validate(drawing_fixture())
        data = drawing.model_dump()
        data["exits"] = [{**data["exits"][0], "polygon": [
            {"x": 48, "y": 40}, {"x": 52, "y": 40},
            {"x": 52, "y": 80}, {"x": 48, "y": 80},
        ]}]
        drawing = ExtractedDrawing.model_validate(data)
        self.assertTrue(uncertain_exits(drawing))

    def test_survey_recovers_observed_jambs_and_preserves_all_other_geometry(self):
        for provider, fixture in (("claude", drawing_fixture), ("gemini", gemini_fixture)):
            with self.subTest(provider=provider):
                data = fixture()
                data["exits"] = []
                drawing = ExtractedDrawing.model_validate(data)
                before = drawing.model_dump()
                with patch("app.services.floorplans.interactive_exits.entrance_windows", return_value=[
                        ((0, 0, 1000, 500), [(50, 50), (50, 450)])]), \
                        patch("app.services.floorplans.interactive_exits.extract_structured", return_value=(self.survey(provider), "fixture")):
                    observed, report = review_interactive_exits(provider, image_bytes(), 1000, 500, drawing)
                self.assertEqual(report["verified_openings"], 1)
                self.assertEqual(len(observed.exits), 1)
                for key in ("walls", "doors", "furniture", "rooms", "scale_references", "scale_objects"):
                    self.assertEqual(observed.model_dump()[key], before[key])
                self.assertEqual(drawing.model_dump(), before, "Review must not mutate the original observations")
                self.assertAlmostEqual(Polygon([(p.x, p.y) for p in observed.floor_outline]).area,
                                       Polygon([(p.x, p.y) for p in drawing.floor_outline]).area)
                self.assertAlmostEqual(max(p.y for p in observed.exits[0].polygon) - min(p.y for p in observed.exits[0].polygon),
                                       120 if provider == "gemini" else 60)

    def test_survey_on_an_unrelated_interior_wall_cannot_create_an_exterior_exit(self):
        data = drawing_fixture()
        data["exits"] = []
        drawing = ExtractedDrawing.model_validate(data)
        original = copy.deepcopy(drawing.floor_outline)
        with patch("app.services.floorplans.interactive_exits.entrance_windows", return_value=[
                ((0, 0, 1000, 500), [(50, 50), (50, 450)])]), \
                patch("app.services.floorplans.interactive_exits.extract_structured", return_value=(self.survey(x=500), "fixture")):
            observed, report = review_interactive_exits("claude", image_bytes(), 1000, 500, drawing)
        self.assertEqual(report["verified_openings"], 0)
        self.assertEqual(observed.exits, [])
        self.assertEqual(observed.floor_outline, original)

    def test_failed_survey_workers_keep_the_shared_deadline_and_never_add_exits(self):
        data = drawing_fixture()
        data["exits"] = []
        drawing = ExtractedDrawing.model_validate(data)
        before = drawing.model_dump()
        deadlines = []

        def unavailable(*_args):
            deadlines.append(_EXTRACTION_DEADLINE.get())
            raise ProviderError("Source entrance review unavailable")

        deadline = time.monotonic() + 60
        with extraction_deadline(deadline), \
                patch("app.services.floorplans.interactive_exits.extract_structured", side_effect=unavailable):
            observed, report = review_interactive_exits("claude", image_bytes(), 1000, 500, drawing)
        self.assertTrue(deadlines)
        self.assertLessEqual(len(deadlines), 6)
        self.assertTrue(all(value == deadline for value in deadlines))
        self.assertEqual(report["verified_openings"], 0)
        self.assertTrue(all("error" in region for region in report["regions"]))
        self.assertEqual(observed.exits, [])
        for key in ("floor_outline", "walls", "doors", "furniture", "rooms"):
            self.assertEqual(observed.model_dump()[key], before[key])

    def test_recorded_pofa_source_surveys_calibrate_place_and_evacuate_24_people(self):
        for filename in ("pofa-source-detail-observations.json", "pofa-gemini-source-detail-observations.json"):
            with self.subTest(fixture=filename):
                self.replay_pofa_fixture(filename)

    def replay_pofa_fixture(self, filename):
        fixture = json.loads((Path(__file__).parent / "fixtures" / filename).read_text())
        drawing = ExtractedDrawing.model_validate(fixture["initial_drawing"])
        cached = {}
        for entry in fixture["surveys"]:
            left, top, right, bottom = entry["bounds"]
            size = (right - left, bottom - top)
            factor = 1000 / max(size)
            frame = tuple(round(side * factor) for side in size)
            self.assertNotIn(frame, cached, "Recorded crops must be identifiable independently of thread completion order")
            cached[frame] = EntranceSurvey.model_validate(entry["survey"])

        def replay(_provider, encoded, _prompt, model_type):
            self.assertIs(model_type, EntranceSurvey)
            return cached[Image.open(io.BytesIO(encoded)).size], "recorded-pofa-source-detail"

        canonical = ExtractedDrawing.model_validate(to_pixels(drawing, fixture["provider"], fixture["image_size"]))
        self.assertLessEqual(len(entrance_windows(canonical, fixture["image_size"])), 6)
        with tempfile.TemporaryDirectory() as directory, \
                patch.dict("os.environ", {"AZURE_STORAGE_ACCOUNT_URL": "", "AZURE_STORAGE_CONNECTION_STRING": "",
                                          "BLOB_READ_WRITE_TOKEN": "", "CROWDY_FLOORPLAN_EXTRACTION_MODE": "interactive"}), \
                patch("app.services.floorplans.images.extract_drawing", return_value=(drawing, "recorded-pofa-structure")), \
                patch("app.services.floorplans.images.review_interactive_structure", return_value=(drawing, None)), \
                patch("app.services.floorplans.interactive_exits.extract_structured", side_effect=replay) as provider:
            root = Path(directory)
            source = save_image(ImageUpload(filename="recorded-pofa.png", image_base64=base64.b64encode(
                image_bytes(tuple(fixture["image_size"]))).decode()), root)
            pending = extract_image(ExtractionRequest(image_id=source.id, provider=fixture["provider"], people_count=24), root)["results"][0]
            self.assertTrue(pending["needs_scale"])
            self.assertEqual(provider.call_count, 6)
            # Calibration reuses the same observations; there is no model call.
            candidate = finish_calibration(pending["extraction_id"], ScaleReference.model_validate(fixture["manual_reference"]), root)
            self.assertEqual(provider.call_count, 6)
            self.assertEqual(candidate["issues"], [])
            self.assertEqual(candidate["counts"]["exits"], fixture["expected_exits"])
            self.assertEqual(candidate["counts"]["walls"], len(drawing.walls))
            self.assertEqual(candidate["counts"]["doors"], len(drawing.doors))
            self.assertEqual(candidate["counts"]["furniture"], len(drawing.furniture))
            scale = candidate["layout"]["source_image"]["meters_per_pixel"]
            for observed, original in zip(candidate["layout"]["walls"], canonical.walls):
                self.assertEqual(observed["id"], original.id)
                for key in ("start", "end"):
                    point = getattr(original, key)
                    self.assertAlmostEqual(observed[key][0], point.x * scale)
                    self.assertAlmostEqual(observed[key][1], (source.height_px - point.y) * scale)
            plan = native_to_editor(candidate["layout"], strict=False)
            scenario = editor_to_scenario(plan, {"occupancy": 24, "mobility": "standard", "distribution": "uniform", "seed": 42})
            self.assertEqual(len(scenario.occupants), 24)
            result = run_simulation(scenario)
            self.assertEqual(result["summary"]["evacuated_count"], 24)
            self.assertEqual(result["summary"]["trapped_count"], 0)


if __name__ == "__main__":
    unittest.main()
