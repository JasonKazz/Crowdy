import json
import tempfile
import unittest
from pathlib import Path

from pydantic import ValidationError
from shapely.geometry import LineString, Point, Polygon
from shapely.ops import unary_union

from app.schemas.layout import Layout, load_layout
from app.schemas.scenario import Occupant, Region, Scenario
from app.services.floorplans.layout import compile_layout, wall_polygon
from app.simulation.animate import render_html
from app.simulation.editor import save_run, validate_layout
from app.simulation.geometry import build_geometry


EXAMPLES = Path(__file__).resolve().parents[2] / "examples"


def office():
    return Layout.model_validate_json((EXAMPLES / "editable_office.json").read_text())


def angled_boundary_office():
    layout = office()
    layout.walkable_areas[0].polygon = [(0, 0), (16, 0), (16, 6), (12, 10), (0, 10)]
    layout.furniture = []
    layout.walls[0].start, layout.walls[0].end = (6, 0), (14, 8)
    layout.exits[0].edge_index = 4
    layout.exits[1].offset = 1.25
    return layout


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

    def test_diagonal_boundary_endcaps_clip_only_outside_solids_without_mutation(self):
        layout = angled_boundary_office()
        original = layout.model_dump()
        floor = Polygon(layout.walkable_areas[0].polygon)
        wall, door = layout.walls[0], layout.doors[0]
        length = LineString([wall.start, wall.end]).length
        full_wall = Polygon(wall_polygon(wall, 0, length))
        self.assertGreater(full_wall.difference(floor).area, .001)
        opening = Polygon(wall_polygon(wall, door.offset - door.width / 2, door.offset + door.width / 2))
        expected = full_wall.difference(opening).intersection(floor)

        scenario = compile_layout(layout)
        solids = unary_union([Polygon(obstacle.polygon) for obstacle in scenario.obstacles])
        self.assertLess(solids.symmetric_difference(expected).area, 1e-12)
        self.assertEqual([obstacle.id for obstacle in scenario.obstacles], ["wall:partition:0", "wall:partition:1"])
        self.assertEqual(scenario.walkable_areas[0].polygon, layout.walkable_areas[0].polygon)
        geometry = build_geometry(scenario)
        self.assertAlmostEqual(opening.intersection(floor).intersection(geometry).area, opening.intersection(floor).area)
        self.assertEqual(layout.model_dump(), original)

    def test_door_at_a_clipped_endcap_preserves_all_interior_opening_area(self):
        layout = angled_boundary_office()
        door = layout.doors[0]
        door.offset = door.width / 2
        floor = Polygon(layout.walkable_areas[0].polygon)
        opening = Polygon(wall_polygon(layout.walls[0], 0, door.width))
        self.assertGreater(opening.difference(floor).area, 0)
        before = layout.model_dump()
        geometry = build_geometry(compile_layout(layout))
        interior_opening = opening.intersection(floor)
        self.assertAlmostEqual(interior_opening.intersection(geometry).area, interior_opening.area)
        self.assertEqual(layout.model_dump(), before)

    def test_pofa_interior_endpoint_overhang_clips_but_outside_centerline_still_needs_review(self):
        # Actual extracted floor and two observed walls, without the source image.
        # The exterior exit below is solely a test fixture, not an inferred POFA door.
        layout = Layout.model_validate({
            "name": "POFA wall-endcap regression", "units": "meters",
            "walkable_areas": [{"id": "floor", "polygon": [
                [6.566166214854077, 52.41207675071021], [24.036858465090816, 58.97824296556429],
                [39.27974432100206, 62.378579041113724], [50.418776292629516, 63.25797630203168],
                [64.48913246731682, 62.20269958893013], [76.21442927955624, 60.15077264678823],
                [85.0084018887358, 57.51258086403436], [96.14743386036326, 52.822462139138594],
                [105.5276713101548, 47.25294615332487], [114.90790875994634, 40.21776806598122],
                [123.11561652851393, 32.59632513802559], [134.84091334075336, 18.232836543032303],
                [138.2412494163028, 13.249585397830547], [133.08211881891745, 10.611393615076677],
                [120.77055716606604, 3.8693479480390094], [116.66670328178225, 1.113903197162745],
                [114.32164391933436, 1.113903197162745], [110.80405487566253, 7.386936991710836],
                [99.66502290403508, 19.69849864456223], [87.93972609179566, 28.492471253741794],
                [76.21442927955624, 33.76885481924953], [58.62648406119711, 36.99331144261538],
                [50.418776292629516, 37.28644386292136], [35.17589043671826, 35.82078176139144],
                [22.278063943254903, 31.130663036495665], [18.2914630270935, 29.195989062476162],
            ]}],
            "walls": [{"id": "structure_review:w1:0", "start": [86.18093156995975, 56.926316023422395],
                       "end": [92.04357997607946, 54.28812424066852], "thickness": .17587945218359133}],
            "exits": [{"id": "fixture-exit", "floor_id": "floor", "edge_index": 2,
                       "offset": 5, "width": 1.5, "landing_depth": 2}],
            "population": {"count": 1, "spawn_area_ids": ["floor"]},
            "agent_defaults": {"radius": .23, "desired_speed": 1.2},
            "settings": {"dt": .01, "sample_interval": .1, "max_time": 120},
        })
        floor = Polygon(layout.walkable_areas[0].polygon)
        wall = layout.walls[0]
        centerline = LineString([wall.start, wall.end])
        self.assertTrue(floor.covers(centerline))
        distance = Point(wall.start).distance(floor.boundary)
        self.assertGreater(distance, .08, "The endpoint is inside, not numerically on the boundary")
        self.assertLess(distance, wall.thickness / 2)
        full_wall = Polygon(wall_polygon(wall, 0, centerline.length))
        self.assertGreater(full_wall.difference(floor).area, 0)
        before = layout.model_dump()
        scenario = compile_layout(layout)
        solid = unary_union([Polygon(obstacle.polygon) for obstacle in scenario.obstacles])
        self.assertLess(solid.symmetric_difference(full_wall.intersection(floor)).area, 1e-12)
        self.assertEqual(layout.model_dump(), before)

        layout.walls.append(wall.model_copy(update={
            "id": "structure_review:w2:0", "start": (58.9196164815031, 36.93468495855418),
            "end": (67.42045667037668, 35.82078176139144),
        }))
        before = layout.model_dump()
        with self.assertRaisesRegex(ValueError, r"Wall 'structure_review:w2:0'.*outside.*Move or remove this wall in Walls & doors"):
            compile_layout(layout)
        self.assertEqual(layout.model_dump(), before)

    def test_endcap_clipping_still_rejects_centerlines_outside_and_crossing_a_notch(self):
        layout = angled_boundary_office()
        layout.walls[0].end = (14.2, 8.2)
        with self.assertRaisesRegex(ValueError, "Wall.*outside"):
            compile_layout(layout)
        layout = office()
        layout.furniture = []
        layout.walkable_areas[0].polygon = [(0, 0), (16, 0), (16, 10), (10, 10), (10, 6), (8, 6), (8, 10), (0, 10)]
        layout.exits[0].edge_index = 7
        layout.walls[0].start, layout.walls[0].end = (6, 8), (12, 8)
        floor = Polygon(layout.walkable_areas[0].polygon)
        self.assertTrue(floor.covers(Point(layout.walls[0].start)) and floor.covers(Point(layout.walls[0].end)))
        with self.assertRaisesRegex(ValueError, "Wall.*outside"):
            compile_layout(layout)

    def test_wall_parallel_to_nearby_boundary_cannot_clip_a_long_strip(self):
        for start in ((0, .01), (1, .01)):
            with self.subTest(start=start):
                layout = office()
                layout.furniture = []
                layout.walls[0].start, layout.walls[0].end = start, (15, .02)
                with self.assertRaisesRegex(ValueError, "Wall.*outside"):
                    compile_layout(layout)

    def test_clipping_cannot_silently_fill_a_hole_in_a_wall_solid(self):
        layout = office()
        layout.furniture = []
        layout.walkable_areas = [
            Region(id="floor", polygon=[(0, 0), (.2, 0), (.2, 10), (0, 10)]),
            Region(id="right", polygon=[(.3, 0), (16, 0), (16, 10), (.3, 10)]),
            Region(id="below", polygon=[(.2, 0), (.3, 0), (.3, .7), (.2, .7)]),
            Region(id="above", polygon=[(.2, .8), (.3, .8), (.3, 10), (.2, 10)]),
        ]
        layout.exits = [Region(id="exit", polygon=[(15, 1), (15.8, 1), (15.8, 1.5), (15, 1.5)])]
        layout.walls[0].start, layout.walls[0].end, layout.walls[0].thickness = (0, .5), (10, .5), 1
        with self.assertRaisesRegex(ValueError, "Wall.*clipping needs review.*holes"):
            compile_layout(layout)

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

    def test_numerical_obstacle_overshoot_is_clipped_without_mutating_input(self):
        layout = office()
        layout.furniture.append(Region(id="roundoff", polygon=[
            (-1e-10, 6), (.2, 6), (.2, 7), (-1e-10, 7),
        ]))
        before = layout.model_dump()
        geometry = build_geometry(compile_layout(layout))
        self.assertFalse(geometry.contains(Point(.1, 6.5)))
        self.assertEqual(layout.model_dump(), before)

    def test_real_obstacle_and_wall_overshoots_still_fail(self):
        layout = office()
        layout.furniture.append(Region(id="outside", polygon=[
            (-1e-6, 6), (.2, 6), (.2, 6.001), (-1e-6, 6.001),
        ]))
        # Small outside AREA is insufficient: distance outside must be numerical.
        with self.assertRaisesRegex(ValueError, "Obstacle 'outside'.*outside"):
            compile_layout(layout)
        layout = office()
        layout.walls[0].start = (8, -1e-6)
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

    def test_generated_people_are_replaced_after_furniture_covers_old_start(self):
        layout = office()
        first = validate_layout(layout)
        geometry = build_geometry(compile_layout(layout))
        position = next(person["position"] for person in first["occupants"]
                        if Point(person["position"]).distance(geometry.boundary) > 0.8)
        x, y = position
        layout.furniture.append(Region(id="moved-table", polygon=[
            (x - .3, y - .3), (x + .3, y - .3), (x + .3, y + .3), (x - .3, y + .3),
        ]))
        second = validate_layout(layout)
        self.assertEqual(len(second["occupants"]), 40)
        self.assertNotEqual(first["occupants"], second["occupants"])
        self.assertEqual(second["occupants"], validate_layout(layout)["occupants"])
        changed = build_geometry(compile_layout(layout))
        for person in second["occupants"]:
            point = Point(person["position"])
            self.assertTrue(changed.contains(point))
            self.assertGreaterEqual(point.distance(changed.boundary), layout.agent_defaults.radius)

    def test_fixed_person_inside_furniture_has_actionable_error(self):
        layout = office()
        layout.population = None
        layout.occupants = [Occupant(id="fixed-person", position=(3, 4))]
        with self.assertRaisesRegex(ValueError, "fixed-person.*inside obstacle 'meeting-table'.*automatic placement"):
            validate_layout(layout)

    def test_fixed_person_outside_floor_has_distinct_error(self):
        layout = office()
        layout.population = None
        layout.occupants = [Occupant(id="fixed-person", position=(-1, 4))]
        with self.assertRaisesRegex(ValueError, "fixed-person.*outside the floor.*regenerate people"):
            validate_layout(layout)

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
