"""A local repair owns only an inconsistent wall and its supplied door relations."""

import unittest
from unittest.mock import patch

from app.schemas.extraction import ExtractedDrawing
from app.services.floorplans.interactive_doors import review_interactive_doors
from app.services.floorplans.providers import ProviderError
from app.services.floorplans.structure_pass import StructuralDrawing
from test_images import drawing_fixture, image_bytes


class InteriorSourceReviewTests(unittest.TestCase):
    def drawing(self):
        data = drawing_fixture()
        for key in ("start", "end"):
            data["doors"][0][key]["x"] = 510
        return ExtractedDrawing.model_validate(data)

    def survey(self, *, coverage="complete", neighbors=False, duplicate=False):
        paths = [{"id": "partition", "points": [{"x": 160, "y": 100}, {"x": 160, "y": 900}], "thickness": 20}]
        if neighbors:
            paths.append({"id": "unrelated", "points": [{"x": 260, "y": 100}, {"x": 260, "y": 900}], "thickness": 20})
        return StructuralDrawing.model_validate({
            "wall_paths": paths,
            "openings": [{"id": "door", "path_id": "unrelated" if duplicate else "partition", "segment_index": 0,
                          "start": {"x": 260 if duplicate else 160, "y": 400},
                          "end": {"x": 260 if duplicate else 160, "y": 520}}],
            "exits": [], "coverage": coverage, "warnings": [],
        })

    def test_valid_parent_and_unknown_reference_keep_normal_validation_without_calls(self):
        for data in (drawing_fixture(), {**drawing_fixture(), "walls": []}):
            drawing = ExtractedDrawing.model_validate(data)
            with patch("app.services.floorplans.interactive_doors.extract_structured") as provider:
                observed, report = review_interactive_doors("claude", image_bytes(), 1000, 500, drawing)
            provider.assert_not_called()
            self.assertEqual(observed, drawing)
            self.assertIsNone(report)

    def test_complete_correction_preserves_original_geometry_outside_its_ownership(self):
        drawing = self.drawing()
        before = drawing.model_dump()
        with patch("app.services.floorplans.interactive_doors.extract_structured", return_value=(self.survey(neighbors=True), "fixture")):
            observed, report = review_interactive_doors("claude", image_bytes(), 1000, 500, drawing)
        self.assertTrue(report["regions"][0]["accepted"])
        self.assertEqual(len(observed.walls), 1, "Unrelated local inventory must not be appended")
        self.assertAlmostEqual(observed.doors[0].start.x, 500)
        self.assertAlmostEqual(observed.walls[0].start.x, 500)
        for key in ("furniture", "rooms", "exits", "floor_outline"):
            self.assertEqual(observed.model_dump()[key], before[key])
        self.assertEqual(drawing.model_dump(), before)

    def test_partial_source_review_retains_the_original_blocking_relationship(self):
        drawing = self.drawing()
        with patch("app.services.floorplans.interactive_doors.extract_structured", return_value=(self.survey(coverage="partial"), "fixture")):
            observed, report = review_interactive_doors("claude", image_bytes(), 1000, 500, drawing)
        self.assertFalse(report["regions"][0]["accepted"])
        self.assertEqual(observed.walls, drawing.walls)
        self.assertEqual(observed.doors, drawing.doors)

    def test_nearby_intact_wall_cannot_be_duplicated_with_different_door_gaps(self):
        data = self.drawing().model_dump()
        data["walls"].append({"id": "intact", "start": {"x": 550, "y": 50}, "end": {"x": 550, "y": 450}, "thickness": 10})
        drawing = ExtractedDrawing.model_validate(data)
        with patch("app.services.floorplans.interactive_doors.extract_structured", return_value=(self.survey(neighbors=True, duplicate=True), "fixture")):
            observed, report = review_interactive_doors("claude", image_bytes(), 1000, 500, drawing)
        self.assertFalse(report["regions"][0]["accepted"])
        self.assertIn("overlaps", report["regions"][0]["error"])
        self.assertEqual(observed.walls, drawing.walls)
        self.assertEqual(observed.doors, drawing.doors)

    def test_failed_review_stays_within_the_warning_budget(self):
        data = self.drawing().model_dump()
        data["warnings"] = [f"Original source note {i}" for i in range(30)]
        drawing = ExtractedDrawing.model_validate(data)
        with patch("app.services.floorplans.interactive_doors.extract_structured", side_effect=ProviderError("Unavailable")):
            observed, report = review_interactive_doors("claude", image_bytes(), 1000, 500, drawing)
        self.assertFalse(report["regions"][0]["accepted"])
        self.assertEqual(len(observed.warnings), 30)
        self.assertEqual(observed.walls, drawing.walls)
        self.assertEqual(observed.doors, drawing.doors)


if __name__ == "__main__":
    unittest.main()
