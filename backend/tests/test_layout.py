import json
import tempfile
import unittest
from pathlib import Path

from pydantic import ValidationError
from shapely.geometry import Point, Polygon

from app.schemas.layout import Layout, load_layout
from app.schemas.scenario import Region, Scenario
from app.services.floorplans.layout import compile_layout, wall_polygon
from app.simulation.animate import render_html
from app.simulation.editor import save_run, validate_layout
from app.simulation.geometry import build_geometry


EXAMPLES = Path(__file__).resolve().parents[2] / "examples"


def office():
    return Layout.model_validate_json((EXAMPLES / "editable_office.json").read_text())


class LayoutTests(unittest.TestCase):
    def test_original_scenario_import_preserves_simulation_inputs(self):
        for name in ("simple_room.json", "two_exit_room.json"):
            original = Scenario.model_validate_json((EXAMPLES / name).read_text())
            compiled = compile_layout(load_layout(original.model_dump(mode="json")))
            self.assertEqual(compiled.model_dump(), original.model_dump())

    def test_wall_blocks_routes_except_at_door(self):
        geometry = build_geometry(compile_layout(office()))
        self.assertTrue(geometry.contains(Point(8, 4)))
        self.assertFalse(geometry.contains(Point(8, 2)))
        self.assertAlmostEqual(geometry.area, 167.24)

    def test_sliding_door_moves_actual_gap_without_changing_input(self):
        layout = office()
        layout.doors[0].offset = 6
        original = layout.model_dump()
        geometry = build_geometry(compile_layout(layout))
        self.assertFalse(geometry.contains(Point(8, 4)))
        self.assertTrue(geometry.contains(Point(8, 6)))
        self.assertEqual(layout.model_dump(), original)

    def test_moving_wall_keeps_door_attached(self):
        layout = office()
        layout.walls[0].start = (7, 0)
        layout.walls[0].end = (7, 10)
        geometry = build_geometry(compile_layout(layout))
        self.assertTrue(geometry.contains(Point(7, 4)))
        self.assertFalse(geometry.contains(Point(7, 2)))
        self.assertTrue(geometry.contains(Point(8, 2)))

    def test_angled_wall_opens_full_thickness(self):
        layout = office()
        wall = layout.walls[0]
        wall.start, wall.end = (6, 1), (10, 9)
        geometry = build_geometry(compile_layout(layout))
        gap = Polygon(wall_polygon(wall, 3.4, 4.6))
        self.assertAlmostEqual(gap.intersection(geometry).area, gap.area)

    def test_furniture_movement_changes_real_geometry(self):
        layout = office()
        layout.furniture[0].polygon = [(x, y + 2) for x, y in layout.furniture[0].polygon]
        geometry = build_geometry(compile_layout(layout))
        self.assertTrue(geometry.contains(Point(3, 4)))
        self.assertFalse(geometry.contains(Point(3, 6)))

    def test_door_without_wall_and_overlapping_doors_rejected(self):
        layout = office()
        layout.doors[0].wall_id = "missing"
        with self.assertRaisesRegex(ValueError, "unknown wall"):
            compile_layout(layout)
        layout = office()
        layout.doors.append(layout.doors[0].model_copy(update={"id": "duplicate-opening"}))
        with self.assertRaisesRegex(ValueError, "overlaps another door"):
            compile_layout(layout)

    def test_door_cannot_extend_beyond_wall(self):
        layout = office()
        layout.doors[0].offset = 0.2
        with self.assertRaisesRegex(ValueError, "past the ends"):
            compile_layout(layout)

    def test_deleting_only_door_reports_disconnected_floor(self):
        layout = office()
        layout.doors = []
        with self.assertRaisesRegex(ValueError, "one connected"):
            compile_layout(layout)

    def test_furniture_cannot_silently_fill_door_opening(self):
        layout = office()
        layout.furniture.append(Region(id="door-obstruction", polygon=[
            (7.8, 3.4), (8.2, 3.4), (8.2, 3.7), (7.8, 3.7),
        ]))
        with self.assertRaisesRegex(ValueError, "Door.*obstructed"):
            compile_layout(layout)

    def test_wall_outside_floor_rejected_even_where_door_cuts_it(self):
        layout = office()
        layout.walls[0].start = (0, 0)
        layout.walls[0].end = (0, 10)
        with self.assertRaisesRegex(ValueError, "Wall.*outside"):
            compile_layout(layout)

    def test_duplicate_ids_and_nonfinite_coordinates_rejected(self):
        layout = office()
        layout.walls.append(layout.walls[0])
        with self.assertRaisesRegex(ValueError, "walls IDs"):
            compile_layout(layout)
        data = office().model_dump()
        data["walls"][0]["start"] = [float("nan"), 0]
        with self.assertRaises(ValidationError):
            Layout.model_validate(data)

    def test_preview_repeats_population_and_validates_capacity(self):
        first = validate_layout(office())
        second = validate_layout(office())
        self.assertEqual(first["occupants"], second["occupants"])
        self.assertEqual(len(first["occupants"]), 40)

    def test_separate_runs_save_exact_inputs_and_existing_playback(self):
        layout = office()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            first_id, first = save_run(layout, root)
            layout.doors[0].offset = 6
            second_id, second = save_run(layout, root)
            self.assertNotEqual(first_id, second_id)
            for run_id, offset, outcome in ((first_id, 4, first), (second_id, 6, second)):
                saved = json.loads((root / run_id / "layout.json").read_text())
                self.assertEqual(saved["doors"][0]["offset"], offset)
                result = json.loads((root / run_id / "result.json").read_text())
                self.assertEqual(outcome["status"], "completed")
                self.assertEqual(result["summary"]["evacuated_count"], 40)
                self.assertTrue((root / run_id / "scenario.json").is_file())
                page = (root / run_id / "playback.html").read_text()
                self.assertIn("simulation-data", page)
                self.assertNotIn("__DATA__", page)

    def test_html_renderer_escapes_layout_name_and_does_not_mutate(self):
        layout = office()
        layout.name = "</script><script>alert(1)</script>"
        scenario = compile_layout(layout)
        result = {"scenario": scenario.model_dump(mode="json"), "frames": [{"time": 0, "agents": []}]}
        page = render_html(result)
        self.assertNotIn(layout.name, page)
        self.assertIn("\\u003c/script>", page)
        self.assertNotIn("geometry", result)


if __name__ == "__main__":
    unittest.main()
