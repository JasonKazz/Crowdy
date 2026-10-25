"""Local repair owns one inconsistent parent and its supplied door relationships."""

import unittest
from unittest.mock import patch
import time
from PIL import Image

from app.schemas.extraction import DrawingPoint, ExtractedDrawing
from app.services.floorplans.interactive_doors import DoorRelationshipReview, _panel_point, review_interactive_doors, review_panels
from app.services.floorplans.providers import ProviderError
from test_images import drawing_fixture, image_bytes


class InteriorSourceReviewTests(unittest.TestCase):
    def drawing(self):
        data = drawing_fixture()
        for key in ("start", "end"):
            data["doors"][0][key]["x"] = 510
        return ExtractedDrawing.model_validate(data)

    def survey(self, *, resolved=True, duplicate=False, extra=False, gap=1, door_id="door"):
        points = lambda x: [{"x": x, "y": y} for y in (100, 400, 520, 900)]
        runs = [{"id": "original", "role": "supplied_parent", "points": points(160), "thickness": 20,
                 "openings": [] if duplicate else [{"door_id": door_id, "segment_index": gap}]}]
        if duplicate:
            runs.append({"id": "doorwall", "panel_id": door_id, "role": "door_parent", "points": points(260), "thickness": 20,
                         "openings": [{"door_id": door_id, "segment_index": gap}]})
        if extra:
            runs.append({"id": "unrelated", "role": "door_parent", "points": points(240), "thickness": 20, "openings": []})
        return DoorRelationshipReview.model_validate({"resolved": resolved, "wall_runs": runs, "warnings": []})

    def review(self, drawing, survey):
        # The model fixture and its synthetic source evidence are explicit test
        # doubles. Independent wall_evidence tests exercise real source pixels.
        with patch("app.services.floorplans.interactive_doors.extract_structured", return_value=(survey, "fixture")), \
                patch("app.services.floorplans.interactive_doors.review_panels", side_effect=self.panels), \
                patch("app.services.floorplans.interactive_doors.wall_evidence", return_value={"accepted": True, "support": 1}):
            return review_interactive_doors("claude", image_bytes(), 1000, 500, drawing)

    def panels(self, _source, doors, bounds):
        frame = {"bounds": bounds, "scale": 2, "size": (340, 1000), "offset": (0, 0)}
        return Image.new("RGB", (340, 1000), "white"), {"parent": frame, **{door.id: frame for door in doors}}

    def test_contact_sheet_panel_points_roundtrip_in_both_provider_contracts(self):
        drawing = self.drawing()
        sheet, panels = review_panels(Image.new("RGB", (1000, 500)), drawing.doors, (420, 0, 590, 500))
        self.assertLessEqual(max(sheet.size), 1500)
        for panel in panels.values():
            x = (panel["bounds"][0] + panel["bounds"][2]) / 2
            y = (panel["bounds"][1] + panel["bounds"][3]) / 2
            px = (x - panel["bounds"][0]) * panel["scale"] + panel["offset"][0]
            py = (y - panel["bounds"][1]) * panel["scale"] + panel["offset"][1]
            for provider in ("claude", "gemini"):
                point = DrawingPoint(x=px if provider == "claude" else px * 1000 / panel["size"][0],
                                     y=py if provider == "claude" else py * 1000 / panel["size"][1])
                observed = _panel_point(point, panel, provider)
                self.assertAlmostEqual(observed["x"], x)
                self.assertAlmostEqual(observed["y"], y)

    def test_valid_parent_and_unknown_reference_keep_normal_validation_without_calls(self):
        for data in (drawing_fixture(), {**drawing_fixture(), "walls": []}):
            drawing = ExtractedDrawing.model_validate(data)
            with patch("app.services.floorplans.interactive_doors.extract_structured") as provider:
                observed, report = review_interactive_doors("claude", image_bytes(), 1000, 500, drawing)
            provider.assert_not_called()
            self.assertEqual(observed, drawing)
            self.assertIsNone(report)

    def test_observed_jamb_segment_defines_parent_exactly_and_preserves_unrelated_geometry(self):
        drawing = self.drawing()
        before = drawing.model_dump()
        observed, report = self.review(drawing, self.survey())
        self.assertTrue(report["regions"][0]["accepted"])
        self.assertEqual(len(observed.walls), 3)
        door = observed.doors[0]
        wall = next(w for w in observed.walls if w.id == door.wall_id)
        self.assertEqual(door.start, wall.start)
        self.assertEqual(door.end, wall.end)
        self.assertAlmostEqual(door.start.x, 500)
        for key in ("furniture", "rooms", "exits", "floor_outline"):
            self.assertEqual(observed.model_dump()[key], before[key])
        self.assertEqual(drawing.model_dump(), before)

    def test_partial_source_review_retains_original_blocking_relationship(self):
        drawing = self.drawing()
        observed, report = self.review(drawing, self.survey(resolved=False))
        self.assertFalse(report["regions"][0]["accepted"])
        self.assertEqual(observed.walls, drawing.walls)
        self.assertEqual(observed.doors, drawing.doors)

    def test_unrelated_local_wall_inventory_is_rejected(self):
        drawing = self.drawing()
        observed, report = self.review(drawing, self.survey(extra=True))
        self.assertFalse(report["regions"][0]["accepted"])
        self.assertIn("unrelated", report["regions"][0]["error"])
        self.assertEqual(observed.walls, drawing.walls)
        self.assertEqual(observed.doors, drawing.doors)

    def test_extra_wall_cannot_claim_to_be_a_second_supplied_parent(self):
        data = self.survey(extra=True).model_dump()
        data["wall_runs"][-1]["role"] = "supplied_parent"
        drawing = self.drawing()
        observed, report = self.review(drawing, DoorRelationshipReview.model_validate(data))
        self.assertFalse(report["regions"][0]["accepted"])
        self.assertIn("exactly one", report["regions"][0]["error"])
        self.assertEqual(observed.walls, drawing.walls)
        self.assertEqual(observed.doors, drawing.doors)

    def test_parent_run_cannot_branch_into_an_unrelated_partition(self):
        data = self.survey().model_dump()
        data["wall_runs"][0]["points"][-1] = {"x": 300, "y": 520}
        drawing = self.drawing()
        observed, report = self.review(drawing, DoorRelationshipReview.model_validate(data))
        self.assertFalse(report["regions"][0]["accepted"])
        self.assertEqual(observed.walls, drawing.walls)
        self.assertEqual(observed.doors, drawing.doors)

    def test_large_review_is_rejected_before_source_scanning(self):
        data = self.survey().model_dump()
        run = data["wall_runs"][0]
        run["points"] = [{"x": 160, "y": y * 20 + 100} for y in range(35)]
        data["wall_runs"].append({**run, "id": "extra", "role": "door_parent"})
        drawing = self.drawing()
        with patch("app.services.floorplans.interactive_doors.extract_structured", return_value=(DoorRelationshipReview.model_validate(data), "fixture")), \
                patch("app.services.floorplans.interactive_doors.review_panels", side_effect=self.panels), \
                patch("app.services.floorplans.interactive_doors.wall_evidence") as evidence:
            observed, report = review_interactive_doors("claude", image_bytes(), 1000, 500, drawing)
        evidence.assert_not_called()
        self.assertFalse(report["regions"][0]["accepted"])
        self.assertIn("budget", report["regions"][0]["error"])
        self.assertEqual(observed.walls, drawing.walls)

    def test_configured_secondary_provider_keeps_primary_coordinates_and_provenance(self):
        data = self.drawing().model_dump()
        from app.services.floorplans.staged import for_provider
        drawing = for_provider(ExtractedDrawing.model_validate(data), "gemini", (1000, 500))
        started = time.monotonic()
        with patch("app.services.floorplans.interactive_doors.provider_status", return_value={"claude": {"configured": True}}), \
                patch("app.services.floorplans.interactive_doors.extract_structured", return_value=(self.survey(), "claude-fixture")) as provider, \
                patch("app.services.floorplans.interactive_doors.review_panels", side_effect=self.panels), \
                patch("app.services.floorplans.interactive_doors.wall_evidence", return_value={"accepted": True, "support": 1}):
            observed, report = review_interactive_doors("gemini", image_bytes(), 1000, 500, drawing)
        self.assertEqual(provider.call_args.args[0], "claude")
        self.assertLessEqual(provider.call_args.kwargs["deadline"] - started, 20.1)
        self.assertEqual(report["regions"][0]["primary_provider"], "gemini")
        self.assertEqual(report["regions"][0]["repair_provider"], "claude")
        self.assertEqual(report["regions"][0]["model"], "claude-fixture")
        self.assertAlmostEqual(observed.doors[0].start.y, 400)
        self.assertTrue(any("primary extraction provider remains Gemini" in note for note in observed.warnings))

    def test_intact_wall_cannot_be_duplicated_with_different_door_gaps(self):
        data = self.drawing().model_dump()
        data["walls"].append({"id": "intact", "start": {"x": 550, "y": 50}, "end": {"x": 550, "y": 450}, "thickness": 10})
        drawing = ExtractedDrawing.model_validate(data)
        observed, report = self.review(drawing, self.survey(duplicate=True))
        self.assertFalse(report["regions"][0]["accepted"])
        self.assertIn("overlaps", report["regions"][0]["error"])
        self.assertEqual(observed.walls, drawing.walls)
        self.assertEqual(observed.doors, drawing.doors)

    def test_invalid_gap_index_or_unknown_door_id_cannot_create_an_opening(self):
        for survey in (self.survey(gap=5), self.survey(door_id="unrelated")):
            with self.subTest(survey=survey):
                drawing = self.drawing()
                observed, report = self.review(drawing, survey)
                self.assertFalse(report["regions"][0]["accepted"])
                self.assertEqual(observed.walls, drawing.walls)
                self.assertEqual(observed.doors, drawing.doors)

    def test_unsupported_solid_fragments_reject_the_whole_repair(self):
        drawing = self.drawing()
        with patch("app.services.floorplans.interactive_doors.extract_structured", return_value=(self.survey(), "fixture")), \
                patch("app.services.floorplans.interactive_doors.review_panels", side_effect=self.panels), \
                patch("app.services.floorplans.interactive_doors.wall_evidence", return_value={"accepted": False, "support": .2}):
            observed, report = review_interactive_doors("claude", image_bytes(), 1000, 500, drawing)
        self.assertFalse(report["regions"][0]["accepted"])
        self.assertIn("source linework", report["regions"][0]["error"])
        self.assertEqual(observed.walls, drawing.walls)
        self.assertEqual(observed.doors, drawing.doors)

    def test_failed_review_stays_within_warning_budget(self):
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
