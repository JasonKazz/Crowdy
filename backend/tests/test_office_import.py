"""Replay real Claude observations; live model recognition remains a manual check."""
from pathlib import Path
import unittest

from shapely.geometry import Point, Polygon
from shapely.ops import unary_union

from app.schemas.extraction import ExtractedDrawing, SourceImage
from app.services.floorplans.calibration import calibrate_drawing
from app.services.floorplans.images import drawing_to_layout
from app.services.floorplans.layout import compile_layout
from app.simulation.engine import run_simulation
from test_images import info


class OfficeImportTests(unittest.TestCase):
    def test_welcome_entrance_and_major_barriers_run_without_manual_changes(self):
        drawing = ExtractedDrawing.model_validate_json((Path(__file__).parent /
            "fixtures/claude-office-observations.json").read_text())
        source, reason = calibrate_drawing(SourceImage(id="a" * 32, width_px=1000,
            height_px=750, meters_per_pixel=.02), drawing, "claude")
        self.assertIsNotNone(source, reason)
        layout = drawing_to_layout(drawing, source, "claude", info(), 80)
        solids = unary_union([Polygon(item.polygon) for item in layout.furniture])
        # Image landmarks checked against the original 500 x 375 plan, not IDs
        # or counts: all desk clusters, reception pair, tables, counters, sofas.
        def position(x, y):
            return Point(2*x*source.meters_per_pixel, (750-2*y)*source.meters_per_pixel)
        for x,y in ((328,50),(348,85),(417,50),(428,85),(335,163),(329,190),
                    (350,190),(410,174),(428,210),(65,300),(95,323),(236,70),
                    (70,170),(162,290),(180,345),(210,310),(242,325),(300,345),
                    (380,310),(380,345)):
            with self.subTest(barrier=(x,y)):
                self.assertTrue(solids.covers(position(x,y)))
        for x,y in ((290,140),(370,145),(120,260),(120,320),(335,270)):
            with self.subTest(aisle=(x,y)):
                self.assertFalse(solids.covers(position(x,y)))
        scenario = compile_layout(layout)
        boundary = scenario.exit_boundaries[0]
        self.assertLess(boundary.outward[0], -.99)  # Left Welcome entrance
        result = run_simulation(scenario)
        self.assertEqual(result["summary"]["evacuated_count"], 80)
        self.assertEqual(result["summary"]["remaining_count"], 0)
        self.assertEqual(len(result["door_crossings"]), 80)
        for frame in result["frames"]:
            for person in frame["agents"]:
                self.assertFalse(solids.contains(Point(person["x"], person["y"])))
