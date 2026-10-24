"""Replay real Claude observations; live model recognition remains a manual check."""
from pathlib import Path
import unittest

from shapely.geometry import Point, Polygon
from shapely.ops import unary_union

from app.schemas.extraction import ExtractedDrawing, SourceImage
from app.schemas.layout import Layout
from app.services.floorplans.calibration import calibrate_drawing
from app.services.floorplans.images import drawing_to_layout, remove_redundant_boundary_vertices
from app.services.floorplans.layout import compile_layout
from app.simulation.engine import run_simulation
from test_images import info


class OfficeImportTests(unittest.TestCase):
    def test_fragmented_welcome_boundary_preserves_exit_and_evacuates(self):
        # Actual failed compact-image output: a 58 px exit on a 55 px segment
        # of a much longer straight wall, with a repeated closing vertex.
        drawing = ExtractedDrawing.model_validate_json((Path(__file__).parent /
            "fixtures/claude-office-fragmented-boundary.json").read_text())
        source, reason = calibrate_drawing(SourceImage(id="a"*32, width_px=1000,
            height_px=750, meters_per_pixel=.02), drawing, "claude")
        self.assertIsNotNone(source, reason)
        original = Polygon([(p.x*source.meters_per_pixel,
            (750-p.y)*source.meters_per_pixel) for p in drawing.floor_outline])
        for review in (False, True):
            with self.subTest(staged_draft=review):
                layout = drawing_to_layout(drawing, source, "claude", info(), 40, allow_review=review)
                self.assertEqual(len(layout.exits), 1)
                self.assertEqual(len(layout.walkable_areas[0].polygon), 4)
                self.assertTrue(original.equals(Polygon(layout.walkable_areas[0].polygon)))
                self.assertAlmostEqual(layout.exits[0].width, 58*source.meters_per_pixel)
                scenario = compile_layout(layout)
        result = run_simulation(scenario)
        self.assertEqual(result['summary']['evacuated_count'], 40)
        self.assertEqual(result['summary']['remaining_count'], 0)

    def test_boundary_cleanup_keeps_real_corners_and_backtracking(self):
        corners = [(0,0),(10,0),(10,8),(5,8.00001),(0,8)]
        self.assertEqual(remove_redundant_boundary_vertices(corners), corners)
        backtracking = [(0,0),(10,0),(8,0),(10,8),(0,8)]
        self.assertEqual(remove_redundant_boundary_vertices(backtracking), backtracking)
        redundant = [(0,0),(5,0),(10,0),(10,8),(10,8),(0,8),(0,0)]
        self.assertEqual(remove_redundant_boundary_vertices(redundant), [(0,0),(10,0),(10,8),(0,8)])

    def test_existing_editable_layout_keeps_its_edge_indices(self):
        from test_exterior_exits import room
        layout = room()
        layout.walkable_areas[0].polygon.insert(1, (5,0))
        layout.exits[0].edge_index = 2
        imported = Layout.model_validate(layout.model_dump())
        self.assertEqual(imported.walkable_areas, layout.walkable_areas)
        self.assertEqual(imported.exits[0].edge_index, 2)
        compile_layout(imported)


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
