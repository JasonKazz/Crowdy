"""Counting capacity and source-coordinate stitching, independent of recall."""

from dataclasses import replace
import unittest
from unittest.mock import Mock, patch

from PIL import Image

from app.config import Settings
from app.estimator import CrowdEstimator, Detection
from app.tiling import EstimationLimit, merge_detections, plan_tiles
from test_service import model_returning


class TilingTests(unittest.TestCase):
    def test_overlapping_tiles_cover_every_source_point_with_exactly_one_owner(self):
        tiles = plan_tiles(2048, 1536, 640, .2, 128)
        self.assertEqual(len(tiles), 12)
        for x in range(0, 2048, 19):
            for y in range(0, 1536, 17):
                owned = [t for t in tiles if t.owns((x, y, x + .1, y + .1))]
                self.assertEqual(len(owned), 1)
                self.assertTrue(owned[0].box[0] <= x < owned[0].box[2])
                self.assertTrue(owned[0].box[1] <= y < owned[0].box[3])

    def test_excessive_tiles_are_rejected_before_inference(self):
        detector = CrowdEstimator(Settings(token="test", max_tiles=1))
        detector._model = model_returning()
        with Image.new("RGB", (1500, 500)) as frame:
            with self.assertRaisesRegex(EstimationLimit, "too many"):
                detector.estimate(frame)
        detector._model.predict.assert_not_called()

    def test_cross_tile_duplicates_merge_but_same_tile_overlapping_people_remain(self):
        a = Detection(confidence=.9, bbox=(20, 20, 40, 80))
        b = Detection(confidence=.8, bbox=(21, 20, 41, 80))
        c = Detection(confidence=.7, bbox=(22, 20, 42, 80))
        result, capped, complete = merge_detections([(a, 0), (b, 1), (c, 0)], 10000)
        self.assertEqual(result, [a, c])
        self.assertFalse(capped)
        self.assertTrue(complete)

    def test_duplicate_merge_checks_cpu_budget(self):
        candidates = [(Detection(confidence=.9, bbox=(20, 20, 40, 80)), 0)] * 1000
        result, capped, complete = merge_detections(candidates, 10000, within_budget=lambda: False)
        self.assertLess(len(result), len(candidates))
        self.assertFalse(complete)
        self.assertFalse(capped)

    def test_original_coordinates_and_unique_seam_ownership(self):
        settings = Settings(token="test", tile_size=640)
        tiles = plan_tiles(1000, 500, 640, .2, 128)
        # The same actual person is visible in both crops. It belongs to the
        # second tile's core and must appear once at its original coordinates.
        responses = [model_returning().predict.return_value,
                     model_returning([[530, 100, 570, 200]], [.9], [0]).predict.return_value,
                     model_returning([[170, 100, 210, 200]], [.85], [0]).predict.return_value]
        detector = CrowdEstimator(settings)
        detector._model = Mock(predict=Mock(side_effect=responses))
        with Image.new("RGB", (1000, 500)) as frame:
            result = detector.estimate(frame)
        self.assertEqual(result.count, 1)
        self.assertEqual(result.detections[0].bbox, (530, 100, 570, 200))
        self.assertEqual(result.inference.tiles_processed, len(tiles) + 1)
        self.assertTrue(result.inference.complete)
        self.assertTrue(detector._model.predict.call_args.kwargs["nms"])

    def test_time_budget_returns_explicit_partial_count_and_releases_lock(self):
        detector = CrowdEstimator(Settings(token="test"))
        detector._model = model_returning([[20, 20, 900, 400]], [.9], [0])
        with Image.new("RGB", (1000, 500)) as frame, \
                patch("app.estimator.perf_counter", side_effect=[0, 26, 27]):
            result = detector.estimate(frame)
        self.assertEqual(result.count, 1)
        self.assertFalse(result.inference.complete)
        self.assertEqual(result.inference.tiles_processed, 1)
        self.assertEqual(result.inference.tiles_planned, 3)
        self.assertTrue(any("partial count" in warning for warning in result.warnings))
        self.assertFalse(detector._lock.locked())

    def test_overview_preserves_a_person_larger_than_the_source_tile(self):
        detector = CrowdEstimator(Settings(token="test"))
        detector._model = Mock(predict=Mock(side_effect=[
            model_returning([[20, 20, 980, 450]], [.9], [0]).predict.return_value,
            model_returning().predict.return_value, model_returning().predict.return_value,
        ]))
        with Image.new("RGB", (1000, 500)) as frame:
            result = detector.estimate(frame)
        self.assertEqual(result.count, 1)
        self.assertEqual(result.detections[0].bbox, (20, 20, 980, 450))
        self.assertTrue(result.inference.complete)

    def test_invalid_dense_inference_settings_are_rejected(self):
        for options in ({"max_detections": 10001}, {"tile_size": 1}, {"tile_overlap": float("nan")},
                        {"tile_overlap": .9}, {"max_tiles": 257}, {"inference_seconds": float("inf")}):
            with self.subTest(options=options), self.assertRaises(ValueError):
                Settings(token="test", **options)

    def test_5000_and_10000_capacity_without_tile_duplicates_or_large_responses(self):
        # Synthetic DETECTOR OUTPUTS exercise transport/stitching capacity only;
        # they are deliberately not presented as a model-accuracy benchmark.
        points = [(25 + x * 50, 25 + y * 50) for y in range(100) for x in range(100)]
        settings = Settings(token="test", inference_seconds=120)
        tiles = plan_tiles(5000, 5000, settings.tile_size, settings.tile_overlap, settings.max_tiles)
        responses = [model_returning().predict.return_value]
        for tile in tiles:
            boxes = [[x - 5 - tile.box[0], y - 10 - tile.box[1], x + 5 - tile.box[0], y + 10 - tile.box[1]]
                     for x, y in points if tile.box[0] + 5 <= x < tile.box[2] - 5 and tile.box[1] + 10 <= y < tile.box[3] - 10]
            responses.append(model_returning(boxes, [.9] * len(boxes), [0] * len(boxes)).predict.return_value)
        with Image.new("RGB", (5000, 5000)) as frame:
            for limit in (5000, 10000):
                detector = CrowdEstimator(replace(settings, max_detections=limit))
                detector._model = Mock(predict=Mock(side_effect=responses))
                result = detector.estimate(frame)
                self.assertEqual(result.count, limit)
                self.assertEqual(len({d.bbox for d in result.detections}), limit)
                self.assertLess(len(result.model_dump_json().encode()), 3.5 * 1024 * 1024)
                self.assertEqual(result.inference.truncated, limit < 10000)
                self.assertEqual(result.inference.complete, limit == 10000)


if __name__ == "__main__":
    unittest.main()
