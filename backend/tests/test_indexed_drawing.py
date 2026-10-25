"""Initial provider geometry shares observed jamb vertices with its parent."""

import copy
import json
import math
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from app.schemas.extraction import ExtractedDrawing, ExtractionRequest, ImageUpload
from app.services.floorplans.images import extract_image, save_image
from app.services.floorplans.indexed_drawing import IndexedDrawing
from app.services.floorplans.interactive_doors import inconsistent_parents, validate_source_door_relationships
from app.services.floorplans.providers import extract_drawing
from app.services.floorplans.layout import compile_layout
from app.schemas.layout import Door, Wall
from test_images import drawing_fixture, upload_fixture
from test_exterior_exits import room


def indexed_fixture():
    data = {key: value for key, value in drawing_fixture().items() if key not in {"walls", "doors"}}
    data["wall_runs"] = [{
        "id": "stepped-front", "thickness": 4,
        "points": [{"x": x, "y": y} for x, y in (
            (100, 100), (180, 100), (240, 100), (300, 100),
            (300, 200), (350, 200), (410, 200), (500, 200))],
        "openings": [{"id": "door-a", "segment_index": 1}, {"id": "door-b", "segment_index": 5}],
    }]
    return data


class IndexedDrawingTests(unittest.TestCase):
    def test_stepped_front_preserves_corners_and_attaches_doors_to_observed_jamb_segments(self):
        observed = IndexedDrawing.model_validate(indexed_fixture()).to_drawing()
        self.assertEqual(len(observed.walls), 3)
        self.assertEqual({door.id for door in observed.doors}, {"door-a", "door-b"})
        self.assertEqual(inconsistent_parents(observed), [])
        for door in observed.doors:
            parent = next(wall for wall in observed.walls if wall.id == door.wall_id)
            self.assertEqual(door.start.y, parent.start.y)
            self.assertEqual(door.end.y, parent.end.y)
        self.assertNotEqual(observed.doors[0].wall_id, observed.doors[1].wall_id)
        self.assertEqual(observed.furniture, ExtractedDrawing.model_validate(drawing_fixture()).furniture)

    def test_indexed_geometry_does_not_snap_a_source_vertex_onto_an_approximate_line(self):
        data = indexed_fixture()
        data["wall_runs"][0]["points"][2]["y"] = 100.1
        observed = IndexedDrawing.model_validate(data).to_drawing()
        door = next(door for door in observed.doors if door.id == "door-a")
        self.assertEqual(door.end.y, 100.1)
        self.assertEqual(inconsistent_parents(observed), [])

    def test_invalid_or_duplicate_gap_references_are_rejected(self):
        for mutate in (
            lambda run: run["openings"][0].update(segment_index=90),
            lambda run: run["openings"][1].update(id="door-a"),
            lambda run: run["openings"][1].update(segment_index=1),
            lambda run: run["points"].__setitem__(1, run["points"][0]),
        ):
            data = indexed_fixture()
            mutate(data["wall_runs"][0])
            with self.assertRaises(ValueError):
                IndexedDrawing.model_validate(data)

    def test_recorded_legacy_observations_are_preserved_without_reparenting(self):
        data = drawing_fixture()
        data["doors"][0]["end"]["x"] += 25
        snapshot = copy.deepcopy(data)
        observed = IndexedDrawing.model_validate(data).to_drawing()
        self.assertEqual(observed, ExtractedDrawing.model_validate(data))
        self.assertEqual(data, snapshot)
        with self.assertRaisesRegex(ValueError, "before setting scale"):
            validate_source_door_relationships(observed, "claude", (1000, 500))

    def test_exact_production_misparent_is_rejected_before_calibration(self):
        fixture = json.loads((Path(__file__).parent / "fixtures/pofa-production-misparented-doors.json").read_text())
        data = drawing_fixture()
        data.update(walls=fixture["walls"], doors=fixture["doors"])
        observed = IndexedDrawing.model_validate(data).to_drawing()
        self.assertFalse(fixture["review_resolved"])
        with self.assertRaisesRegex(ValueError, "Door 'door_1'.*before setting scale"):
            validate_source_door_relationships(observed, fixture["provider"], fixture["source_size"])

    def test_full_span_angled_opening_cannot_leave_a_floating_point_wall_sliver(self):
        for residual in (-1e-10, 0, 1e-10):
            with self.subTest(residual=residual):
                layout = room()
                wall = Wall(id="virtual-parent", start=(2.1234, 2.456), end=(7.98765, 5.4321), thickness=.2)
                length = math.dist(wall.start, wall.end)
                layout.walls = [wall]
                layout.doors = [Door(id="whole-parent", wall_id=wall.id, offset=length / 2, width=length + residual)]
                original = layout.model_dump()
                scenario = compile_layout(layout)
                self.assertEqual(scenario.obstacles, [])
                self.assertEqual(layout.model_dump(), original)

    def test_real_small_wall_intervals_are_preserved_and_real_door_overhang_is_rejected(self):
        layout = room()
        wall = Wall(id="parent", start=(2.1234, 2.456), end=(7.98765, 5.4321), thickness=.2)
        length = math.dist(wall.start, wall.end)
        layout.walls = [wall]
        layout.doors = [Door(id="door", wall_id=wall.id, offset=length / 2, width=length - .01)]
        self.assertEqual(len(compile_layout(layout).obstacles), 2)
        layout.doors[0].width = length + .0001
        with self.assertRaisesRegex(ValueError, "past the ends"):
            compile_layout(layout)

    def test_real_provider_request_uses_indexed_wire_schema_and_returns_public_canonical_model(self):
        response = {"choices": [{"finish_reason": "stop", "message": {
            "role": "assistant", "content": json.dumps(indexed_fixture()),
        }}]}
        with patch.dict(os.environ, {"AI_GATEWAY_API_KEY": "fake-key"}, clear=True), \
                patch("app.services.floorplans.providers.request_json", return_value=response) as transport:
            observed, _ = extract_drawing("gemini", b"synthetic-source", 1000, 500)
        self.assertIsInstance(observed, ExtractedDrawing)
        self.assertNotIn("wall_runs", observed.model_dump())
        payload = transport.call_args.args[2]
        properties = payload["response_format"]["json_schema"]["schema"]["properties"]
        self.assertIn("wall_runs", properties)
        self.assertNotIn("walls", properties)
        self.assertNotIn("doors", properties)
        self.assertEqual(payload["reasoning_effort"], "low")
        self.assertEqual(inconsistent_parents(observed), [])

    def test_unresolved_legacy_door_is_reported_before_requesting_manual_scale(self):
        data = drawing_fixture()
        data["doors"][0]["end"]["x"] += 25
        drawing = ExtractedDrawing.model_validate(data)
        with tempfile.TemporaryDirectory() as directory, \
                patch.dict(os.environ, {"AZURE_STORAGE_ACCOUNT_URL": "", "AZURE_STORAGE_CONNECTION_STRING": "",
                                          "BLOB_READ_WRITE_TOKEN": "", "CROWDY_FLOORPLAN_EXTRACTION_MODE": "interactive"}), \
                patch("app.services.floorplans.images.extract_drawing", return_value=(drawing, "recorded-model")), \
                patch("app.services.floorplans.images.review_interactive_structure", return_value=(drawing, None)), \
                patch("app.services.floorplans.images.review_interactive_doors", return_value=(drawing, {"regions": []})), \
                patch("app.services.floorplans.images.review_interactive_exits", return_value=(drawing, None)):
            root = Path(directory)
            source = save_image(ImageUpload.model_validate(upload_fixture().model_dump()), root)
            result = extract_image(ExtractionRequest(image_id=source.id, provider="claude"), root)["results"][0]
            self.assertIn("before setting scale", result["error"])
            self.assertNotIn("needs_scale", result)
            self.assertTrue((root / "extractions" / result["extraction_id"] / "observations.json").exists())


if __name__ == "__main__":
    unittest.main()
