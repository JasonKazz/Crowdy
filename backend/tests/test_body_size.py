"""Physical doorway and placement regressions, not just person glyph sizes."""
import copy
import json
import math
import unittest
from pathlib import Path

from pydantic import ValidationError
from shapely.geometry import Point

from app import api
from app.schemas.layout import Layout
from app.services.floorplans.layout import compile_layout
from app.simulation.editor_adapter import editor_to_scenario
from app.simulation.engine import run_simulation
from app.simulation.geometry import build_geometry
from app.simulation.workspace_layout import native_to_editor
from test_workspace_api import room_request, SAMPLE


def doorway_layout(width):
    return Layout.model_validate({
        "name": "Doorway width regression", "units":"meters",
        "walkable_areas": [{"id":"room","polygon":[[0,0],[8,0],[8,6],[0,6]]}],
        "exits": [{"id":"east","floor_id":"room","edge_index":1,"offset":3,"width":width}],
        "occupants": [{"id":"a","position":[5.5,2.65]}, {"id":"b","position":[5.5,3.35]}],
        "agent_defaults":{"radius":.25,"desired_speed":1.2},
        "settings":{"dt":.01,"sample_interval":.01,"max_time":20},
    })


class BodySizeTests(unittest.TestCase):
    def test_90cm_door_is_single_file_but_wide_opening_allows_abreast(self):
        for width, expected in ((.9,1),(1.4,2)):
            with self.subTest(width=width):
                result = run_simulation(compile_layout(doorway_layout(width)))
                self.assertEqual(result["status"],"completed")
                # A 20 cm-deep strip centered on the doorway: two 50 cm bodies
                # cannot occupy this side by side in a 90 cm aperture.
                simultaneous = max(sum(abs(p["x"]-8)<.1 for p in frame["agents"]) for frame in result["frames"])
                self.assertEqual(simultaneous,expected)
                for frame in result["frames"]:
                    if len(frame["agents"]) == 2:
                        a,b=frame["agents"]
                        self.assertGreaterEqual(math.hypot(a["x"]-b["x"],a["y"]-b["y"]),.5-1e-6)

    def test_width_controls_native_and_pixel_placement_clearance_and_exit_strip(self):
        source = Path(__file__).resolve().parents[2] / "examples/narrow_table_regression.json"
        for plan in (room_request()["plan"],native_to_editor(json.loads(source.read_text()))):
            for width in (.5,.6):
                with self.subTest(native=bool(plan.get("native")),width=width):
                    original=copy.deepcopy(plan)
                    settings={"occupancy":12,"mobility":"standard","distribution":"uniform","body_width":width}
                    scenario=editor_to_scenario(plan,settings)
                    self.assertEqual(plan,original,"Interactive body settings must not rewrite imported geometry")
                    self.assertEqual(scenario.agent_defaults.radius,width/2)
                    geometry=build_geometry(scenario)
                    for i,person in enumerate(scenario.occupants):
                        self.assertGreaterEqual(Point(person.position).distance(geometry.boundary),width/2+.05-1e-8)
                        for other in scenario.occupants[:i]:
                            self.assertGreaterEqual(math.dist(person.position,other.position),width+.05-1e-8)
                    boundaries={b.id:b for b in scenario.exit_boundaries}
                    for exit in scenario.exits:
                        if exit.id in boundaries:
                            b=boundaries[exit.id]
                            distance=min(sum((p[i]-b.start[i])*b.outward[i] for i in range(2)) for p in exit.polygon)
                            self.assertAlmostEqual(distance,width/2+.02)

    def test_sample_doorways_are_wide_not_standard_single_doors(self):
        scenario=editor_to_scenario(SAMPLE["plan"],SAMPLE["scenario"])
        self.assertEqual(scenario.agent_defaults.radius,.25)
        self.assertEqual([math.dist(b.start,b.end) for b in scenario.exit_boundaries],[1.75,1.75])

    def test_comparisons_reject_a_change_in_physical_body_size(self):
        payload=room_request()
        before=api.run_editor_simulation(api.SimulationRequest.model_validate(payload))
        payload["starting_population"]={"occupants":before["scenario"]["occupants"],"radius":.25,
                                        "mobility":"standard","distribution":"uniform","seed":42}
        payload["scenario"]["body_width"]=.6
        with self.assertRaisesRegex(ValueError,"body width unchanged"):
            api.run_editor_simulation(api.SimulationRequest.model_validate(payload))

    def test_invalid_body_widths_are_rejected(self):
        for width in (.39,.71,float("nan"),float("inf")):
            with self.subTest(width=width),self.assertRaises(ValidationError):
                api.EditorSettings(occupancy=12,mobility="standard",distribution="uniform",body_width=width)
