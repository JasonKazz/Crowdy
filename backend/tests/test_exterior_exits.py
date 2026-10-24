import copy
import json
from pathlib import Path
import unittest

from shapely.geometry import Point, Polygon

from app.schemas.extraction import ExtractedDrawing
from app.schemas.layout import ExitDoor, Layout, load_layout, exit_from_marker
from app.schemas.scenario import Region
from app.services.floorplans.images import drawing_to_layout
from app.services.floorplans.exits import exit_geometry
from app.services.floorplans.layout import compile_layout
from app.services.population.generate import resolve_population
from app.simulation.engine import run_simulation
from app.simulation.geometry import build_geometry
from test_images import drawing_fixture, info, source


def room():
    return Layout.model_validate({
        "name": "Exterior doorway check", "walkable_areas": [{
            "id": "floor", "polygon": [[0, 0], [10, 0], [10, 8], [0, 8]],
        }],
        "exits": [{"id": "east", "floor_id": "floor", "edge_index": 1,
                   "offset": 4, "width": 1.2, "landing_depth": 2}],
        "occupants": [{"id": "person", "position": [8, 4]}],
        "agent_defaults": {"radius": .2, "desired_speed": 1.2},
        "settings": {"dt": .01, "sample_interval": .02, "max_time": 30},
    })


class ExteriorExitTests(unittest.TestCase):
    def test_exit_is_outside_and_only_the_doorway_opens_the_boundary(self):
        scenario = compile_layout(room())
        target = Polygon(scenario.exits[0].polygon)
        geometry = build_geometry(scenario)
        self.assertAlmostEqual(target.bounds[0], 10.22)
        self.assertAlmostEqual(target.bounds[2], 10.4)
        self.assertTrue(geometry.contains(Point(10.5, 4)))
        self.assertFalse(geometry.contains(Point(10.01, 2)))
        self.assertFalse(target.intersects(Polygon(room().walkable_areas[0].polygon)))

    def test_agent_crosses_outside_before_being_counted_as_evacuated(self):
        result = run_simulation(compile_layout(room()))
        self.assertEqual(result["summary"]["evacuated_count"], 1)
        positions = [a for f in result["frames"] for a in f["agents"]]
        self.assertGreater(positions[-1]["x"], 10.19)
        self.assertLess(positions[-1]["x"], 10.23)
        self.assertTrue(any(p["x"] > 10.19 for p in positions))
        self.assertTrue(all(3.4 <= p["y"] <= 4.6 for p in positions if 9.95 <= p["x"] <= 10.05))
        self.assertLess(result["summary"]["building_clearance_time"], result["summary"]["clearance_time"])

    def test_zone_distance_uses_body_radius_not_landing_depth(self):
        short, deep = room(), room()
        deep.exits[0].landing_depth = 6
        self.assertEqual(compile_layout(short).exits, compile_layout(deep).exits)
        short.agent_defaults.radius = .35
        target = Polygon(compile_layout(short).exits[0].polygon)
        self.assertAlmostEqual(target.bounds[0], 10.37)

    def test_playback_draws_building_and_near_exit_without_fake_exterior_hall(self):
        import json
        from app.simulation.animate import render_html
        scenario = compile_layout(room())
        page = render_html({"scenario": scenario.model_dump(mode="json"), "frames": [{"time": 0, "agents": []}]})
        data = json.loads(page.split('<script id="simulation-data" type="application/json">')[1].split('</script>')[0])
        self.assertAlmostEqual(max(p[0] for p in data['geometry']['boundary']), 10)
        self.assertGreater(min(p[0] for p in data['scenario']['exits'][0]['polygon']), 10)

    def test_sliding_exit_closes_old_opening_and_moves_outside_destination(self):
        layout = room()
        layout.exits[0].offset = 6
        scenario = compile_layout(layout)
        geometry = build_geometry(scenario)
        self.assertFalse(geometry.contains(Point(10.1, 4)))
        self.assertTrue(geometry.contains(Point(10.1, 6)))
        self.assertAlmostEqual(Polygon(scenario.exits[0].polygon).centroid.y, 6)

    def test_clockwise_and_counterclockwise_outlines_have_the_same_outside(self):
        layout = room()
        expected = build_geometry(compile_layout(layout))
        layout.walkable_areas[0].polygon.reverse()
        # Reversing this 4-corner outline keeps the east edge at index 1,
        # but reverses the direction of distances measured along that edge.
        observed = build_geometry(compile_layout(layout))
        self.assertAlmostEqual(expected.symmetric_difference(observed).area, 0)

    def test_real_surveyed_door_bank_preserves_all_six_openings(self):
        layout=Layout.model_validate_json((Path(__file__).parent/'fixtures/venue-surveyed-door-bank.json').read_text())
        before=copy.deepcopy(layout.walkable_areas)
        scenario=compile_layout(layout)
        self.assertEqual(len(scenario.exits),6)
        self.assertEqual(layout.walkable_areas,before)
        floor=Polygon(before[0].polygon)
        for region in scenario.exits:
            self.assertGreaterEqual(Polygon(region.polygon).distance(floor),layout.agent_defaults.radius)

    def test_surveyed_jamb_projection_accepts_roundoff_at_edge_ends(self):
        layout=Layout.model_validate_json((Path(__file__).parent/'fixtures/venue-surveyed-door-bank.json').read_text())
        for door in layout.exits:
            _,_,marker=exit_geometry(door,layout.walkable_areas[0],layout.agent_defaults.radius)
            observed=exit_from_marker(marker,layout.walkable_areas)
            self.assertEqual(observed.edge_index,door.edge_index)
            self.assertAlmostEqual(observed.width,door.width)

    def test_angled_boundary_uses_outward_normal(self):
        layout = room()
        layout.walkable_areas[0].polygon = [(0, 0), (10, 0), (12, 8), (2, 8)]
        scenario = compile_layout(layout)
        interior = Polygon(layout.walkable_areas[0].polygon)
        self.assertFalse(Polygon(scenario.exits[0].polygon).intersects(interior))
        self.assertTrue(build_geometry(scenario).is_valid)

    def test_invalid_openings_cannot_silently_change_the_floor(self):
        for field, value, message in (
            ("width", .4, "too narrow"), ("offset", .1, "past its floor edge"),
            ("landing_depth", .2, "deeper outside"), ("edge_index", 10, "missing floor edge"),
            ("floor_id", "missing", "unknown floor"),
        ):
            with self.subTest(field=field):
                layout = room()
                setattr(layout.exits[0], field, value)
                with self.assertRaisesRegex(ValueError, message):
                    compile_layout(layout)

    def test_seam_between_floors_is_not_an_exterior_door(self):
        layout = room()
        layout.walkable_areas.append(Region(id="wing", polygon=[(10, 0), (14, 0), (14, 8), (10, 8)]))
        with self.assertRaisesRegex(ValueError, "exterior floor edge"):
            compile_layout(layout)

    def test_duplicate_openings_and_obstructed_openings_are_rejected(self):
        layout = room()
        layout.exits.append(layout.exits[0].model_copy(update={"id": "second"}))
        with self.assertRaisesRegex(ValueError, "openings must not overlap"):
            compile_layout(layout)
        layout = room()
        layout.furniture.append(Region(id="blocked-door", polygon=[(9, 3.5), (10, 3.5), (10, 4.5), (9, 4.5)]))
        with self.assertRaisesRegex(ValueError, "opening is obstructed"):
            compile_layout(layout)

    def test_adjacent_doors_can_share_outside_dispersal_space(self):
        layout=room()
        layout.exits[0].offset=3.5
        layout.exits.append(layout.exits[0].model_copy(update={'id':'second','offset':5.0}))
        scenario=compile_layout(layout)
        self.assertEqual(len(scenario.exits),2)
        first,second=[Polygon(area.polygon) for area in scenario.walkable_areas[1:]]
        self.assertGreater(first.intersection(second).area,0)
        self.assertTrue(build_geometry(scenario).is_valid)

    def test_concave_venue_entrance_landing_stays_outside_and_preserves_floor(self):
        layout=Layout.model_validate_json((Path(__file__).parent/'fixtures/venue-concave-entrance.json').read_text())
        before=layout.model_dump()
        floor=Polygon(layout.walkable_areas[0].polygon)
        scenario=compile_layout(layout)
        self.assertEqual(layout.model_dump(),before)
        apron=Polygon(scenario.walkable_areas[-1].polygon)
        _,target,threshold=exit_geometry(layout.exits[0],layout.walkable_areas[0],layout.agent_defaults.radius)
        self.assertLess(apron.intersection(floor).difference(Polygon(threshold.polygon)).area,1e-8)
        self.assertGreaterEqual(Polygon(target.polygon).distance(floor),layout.agent_defaults.radius)
        self.assertTrue(build_geometry(scenario).is_valid)

    def test_another_wing_blocking_all_body_clear_space_is_rejected(self):
        layout=room()
        layout.walkable_areas.append(Region(id='wing',polygon=[(10.1,0),(14,0),(14,8),(10.1,8)]))
        with self.assertRaisesRegex(ValueError,'body-clear outside'):
            compile_layout(layout)

    def test_new_and_previously_saved_image_exits_become_boundary_doors(self):
        layout = drawing_to_layout(ExtractedDrawing.model_validate(drawing_fixture()), source(), "claude", info(), 12)
        self.assertTrue(all(isinstance(exit, ExitDoor) for exit in layout.exits))
        self.assertAlmostEqual(layout.exits[0].width, 1.2)
        old = layout.model_dump(mode="json")
        old["exits"] = [{"id": item["id"], "polygon": [
            [point["x"] * .02, (500 - point["y"]) * .02] for point in item["polygon"]
        ]} for item in drawing_fixture()["exits"]]
        snapshot = copy.deepcopy(old)
        migrated = load_layout(old)
        self.assertEqual(migrated.exits, layout.exits)
        self.assertEqual(old, snapshot)
        self.assertEqual(load_layout(migrated.model_dump()).exits, migrated.exits)

    def test_population_starts_inside_building_not_on_new_landings(self):
        layout = drawing_to_layout(ExtractedDrawing.model_validate(drawing_fixture()), source(), "claude", info(), 40)
        resolved = resolve_population(compile_layout(layout))
        interior = Polygon(layout.walkable_areas[0].polygon)
        self.assertTrue(all(interior.contains(Point(p.position)) for p in resolved.occupants))


if __name__ == "__main__":
    unittest.main()
