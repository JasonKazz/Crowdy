import json
import unittest
from pathlib import Path

from shapely.geometry import LineString, Point, Polygon

from app.schemas.layout import ExitDoor, load_layout
from app.schemas.scenario import Occupant, Region
from app.services.floorplans.layout import compile_layout
from app.simulation.editor import validate_layout
from app.simulation.engine import run_simulation
from app.simulation.geometry import build_geometry
from app.simulation.routing import RoutePlanner, plan_routes
from test_exterior_exits import room


EXAMPLES = Path(__file__).resolve().parents[2] / 'examples'


def regression_layout():
    layout = load_layout(json.loads((EXAMPLES / 'narrow_table_regression.json').read_text()))
    # Image provenance is unnecessary for the geometry regression fixture.
    # Its recorded image exit observations become explicit boundary openings.
    from app.schemas.layout import exit_from_marker
    layout.exits = [exit_from_marker(marker, layout.walkable_areas) if isinstance(marker, Region) else marker for marker in layout.exits]
    return layout


class RoutingTests(unittest.TestCase):
    def test_exact_failed_layout_evacuates_all_40_original_people(self):
        layout = regression_layout()
        scenario = compile_layout(layout)
        original = [person.model_dump() for person in scenario.occupants]
        result = run_simulation(scenario)
        self.assertEqual(result['status'], 'completed')
        self.assertEqual(result['summary']['evacuated_count'], 40)
        self.assertEqual(result['summary']['remaining_count'], 0)
        self.assertEqual(result['scenario']['occupants'], json.loads(json.dumps(original)))
        self.assertEqual(len({event['agent_id'] for event in result['evacuations']}), 40)
        self.assertEqual(len(result['door_crossings']), 40)
        self.assertLess(result['summary']['building_clearance_time'], result['summary']['clearance_time'])

    def test_routes_give_a_full_body_clearance_around_tables(self):
        scenario = compile_layout(regression_layout())
        geometry = build_geometry(scenario)
        for route in plan_routes(scenario):
            self.assertTrue(geometry.buffer(1e-6).covers(LineString(route['path']).buffer(.2, quad_segs=8)))

    def test_long_table_detour_actually_walks_around_its_end(self):
        layout = room()
        layout.furniture = [Region(id='long-table', polygon=[(7, 1), (8, 1), (8, 7), (7, 7)])]
        layout.occupants = [Occupant(id='person', position=(5, 4))]
        result = run_simulation(compile_layout(layout))
        self.assertEqual(result['summary']['evacuated_count'], 1)
        points = [(agent['x'], agent['y']) for frame in result['frames'] for agent in frame['agents']]
        table = Polygon(layout.furniture[0].polygon)
        self.assertTrue(any(y < 1 or y > 7 for x, y in points if 6.8 < x < 8.2))
        self.assertTrue(all(not table.contains(Point(p)) for p in points))

    def test_point_sized_passage_is_rejected_before_simulation(self):
        layout = room()
        layout.furniture = [Region(id='barrier', polygon=[(9, .1), (9.75, .1), (9.75, 7.9), (9, 7.9)])]
        layout.occupants = [Occupant(id='person', position=(5, 4))]
        # Point geometry is connected; the only paths to the door are 10 cm
        # around the ends or a 25 cm gap behind this table. A 40 cm body cannot fit.
        self.assertTrue(build_geometry(compile_layout(layout)).is_valid)
        self.assertEqual(validate_layout(layout)['routes'][0]['status'], 'trapped')
        result = run_simulation(compile_layout(layout))
        self.assertEqual(result['summary']['trapped_count'], 1)
        self.assertEqual(result['status'], 'trapped')

    def test_displaced_agent_can_return_to_an_earlier_safe_corner(self):
        scenario = compile_layout(regression_layout())
        planner = RoutePlanner(build_geometry(scenario), .2)
        route = next(route for route in plan_routes(scenario, planner=planner)
                     if not planner.visible_body_space.covers(LineString([route['path'][0], route['path'][-1]])))
        start = route['path'][0]
        target, index = planner.next_target(start, route['path'], len(route['path']) - 1)
        self.assertTrue(planner.visible_body_space.covers(LineString([start, target])))
        self.assertLess(index, len(route['path']) - 1)

    def test_displaced_agent_reroutes_locally_around_door_jamb(self):
        scenario = compile_layout(room())
        scenario.occupants = [Occupant(id='person', position=(2, 7))]
        planner = RoutePlanner(build_geometry(scenario), .2)
        path = plan_routes(scenario, planner=planner)[0]['path']
        displaced = (9.75, 5.2)
        self.assertFalse(planner.visible_body_space.covers(LineString([displaced, path[-1]])))
        target, recovered, index = planner.update_route(displaced, path, len(path) - 1,
                                                       Polygon(scenario.exits[0].polygon))
        self.assertEqual(recovered[0], displaced)
        self.assertEqual(recovered[-1], path[-1])
        self.assertTrue(planner.visible_body_space.covers(LineString([displaced, target])))
        self.assertGreaterEqual(target[0], 9.5)
        self.assertLess(target[1], displaced[1])
        self.assertLess(LineString(recovered).length, 2)
        self.assertGreaterEqual(index, 1)

    def test_open_space_flares_but_corridor_keeps_door_width(self):
        open_layout = room()
        open_scenario = compile_layout(open_layout)
        open_apron = Polygon(open_scenario.walkable_areas[-1].polygon)
        corridor = room()
        corridor.exits[0].outside_space = 'corridor'
        corridor_scenario = compile_layout(corridor)
        corridor_apron = Polygon(corridor_scenario.walkable_areas[-1].polygon)
        self.assertGreater(open_apron.area, corridor_apron.area)
        self.assertTrue(open_apron.contains(Point(11.5, 5.5)))
        self.assertFalse(corridor_apron.contains(Point(11.5, 5.5)))

    def test_doorway_targets_are_repeatable_and_remain_near_the_boundary(self):
        layout = regression_layout()
        scenario = compile_layout(layout)
        first, second = plan_routes(scenario), plan_routes(scenario)
        self.assertEqual(first, second)
        targets = [route['path'][-1] for route in first if route['exit_id'] == 'exit_east']
        self.assertGreater(len(set(targets)), 3)
        self.assertGreater(max(p[1] for p in targets) - min(p[1] for p in targets), .3)
        boundary = next(b for b in scenario.exit_boundaries if b.id == 'exit_east')
        self.assertTrue(all(.2 <= sum((p[i] - boundary.start[i]) * boundary.outward[i] for i in range(2)) <= .4
                            for p in targets))

    def test_invalid_open_width_is_reported(self):
        layout = room()
        layout.exits[0].outside_width = .5
        with self.assertRaisesRegex(ValueError, 'cannot be narrower'):
            compile_layout(layout)


if __name__ == '__main__':
    unittest.main()
