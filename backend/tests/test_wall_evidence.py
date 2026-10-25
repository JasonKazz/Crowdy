import math
from statistics import median
from threading import Event
import unittest
from unittest import mock

from PIL import Image, ImageDraw

from app.services.floorplans.wall_evidence import wall_evidence
from app.services.floorplans.providers import ProviderError, extraction_deadline


class WallEvidenceTests(unittest.TestCase):
    def test_dark_line_on_gray_fill_is_supported_without_changing_source(self):
        image = Image.new("RGB", (240, 180), (160, 160, 160))
        ImageDraw.Draw(image).line((20, 70, 220, 70), fill=(65, 65, 65), width=3)
        original = image.tobytes()
        report = wall_evidence((20, 70), (220, 70), 3, image)
        self.assertTrue(report["accepted"], report)
        self.assertGreaterEqual(report["support"], 0.99)
        self.assertEqual(report["count"], report["supported_count"])
        self.assertEqual(image.tobytes(), original)

    def test_faint_angled_wall_allows_one_pixel_coordinate_rounding(self):
        image = Image.new("RGB", (240, 180), "white")
        ImageDraw.Draw(image).line((20, 30, 220, 130), fill=(226, 226, 226), width=1)
        report = wall_evidence((20, 31), (220, 131), 1, image)
        self.assertTrue(report["accepted"], report)
        self.assertGreaterEqual(report["support"], 0.95)
        self.assertGreater(report["median_contrast"], 20)

    def test_one_pixel_rounding_in_both_normal_directions_at_varied_angles(self):
        for degrees in (5, 30, 45, 85, 110, 135, 175):
            angle = math.radians(degrees)
            dx, dy = math.cos(angle), math.sin(angle)
            start = (round(150 - 100 * dx), round(150 - 100 * dy))
            end = (round(150 + 100 * dx), round(150 + 100 * dy))
            image = Image.new("RGB", (300, 300), (230, 230, 230))
            ImageDraw.Draw(image).line((*start, *end), fill=(205, 205, 205), width=1)
            for shift in (-1, 1):
                with self.subTest(degrees=degrees, shift=shift):
                    report = wall_evidence(
                        (start[0] - dy * shift, start[1] + dx * shift),
                        (end[0] - dy * shift, end[1] + dx * shift),
                        1, image,
                    )
                    self.assertTrue(report["accepted"], report)

    def test_blank_white_and_shaded_floors_do_not_support_diagonal(self):
        for color in ("white", (150, 150, 150)):
            with self.subTest(color=color):
                report = wall_evidence((20, 20), (220, 160), 2,
                                       Image.new("RGB", (240, 180), color))
                self.assertFalse(report["accepted"], report)
                self.assertEqual(report["supported_count"], 0)

    def test_colored_annotation_is_not_wall_support(self):
        for color in ((220, 30, 30), (100, 180, 225), (225, 180, 180)):
            with self.subTest(color=color):
                image = Image.new("RGB", (240, 180), "white")
                ImageDraw.Draw(image).line((20, 30, 220, 130), fill=color, width=3)
                report = wall_evidence((20, 30), (220, 130), 3, image)
                self.assertFalse(report["accepted"], report)
                self.assertEqual(report["supported_count"], 0)

    def test_long_supported_wall_cannot_bridge_small_meaningful_gap(self):
        image = Image.new("RGB", (640, 100), "white")
        pen = ImageDraw.Draw(image)
        pen.line((20, 50, 306, 50), fill="black", width=2)
        pen.line((314, 50, 620, 50), fill="black", width=2)
        report = wall_evidence((20, 50), (620, 50), 2, image)
        self.assertGreater(report["support"], 0.95)
        self.assertFalse(report["accepted"], report)
        self.assertEqual(report["reason"], "unsupported_gap")
        self.assertGreater(report["longest_unsupported_px"], 6)

    def test_single_missing_pixel_is_tolerated(self):
        image = Image.new("RGB", (240, 100), "white")
        pen = ImageDraw.Draw(image)
        pen.line((20, 50, 220, 50), fill="black", width=1)
        pen.point((100, 50), fill="white")
        report = wall_evidence((20, 50), (220, 50), 1, image)
        self.assertTrue(report["accepted"], report)

    def test_checker_does_not_snap_to_a_nearby_line(self):
        image = Image.new("RGB", (240, 100), "white")
        ImageDraw.Draw(image).line((20, 50, 220, 50), fill="black", width=1)
        report = wall_evidence((20, 54), (220, 54), 2, image)
        self.assertFalse(report["accepted"], report)
        self.assertEqual(report["supported_count"], 0)

    def test_gray_fill_boundary_without_line_is_not_a_wall(self):
        image = Image.new("RGB", (240, 100), "white")
        ImageDraw.Draw(image).rectangle((0, 50, 239, 99), fill=(160, 160, 160))
        report = wall_evidence((20, 50), (220, 50), 2, image)
        self.assertFalse(report["accepted"], report)

    def test_outside_source_does_not_manufacture_white_flanks(self):
        image = Image.new("RGB", (240, 100), "black")
        report = wall_evidence((-5, 0), (220, 0), 2, image)
        self.assertFalse(report["accepted"], report)
        self.assertEqual(report["reason"], "outside_source")
        self.assertEqual(report["supported_count"], 0)

    def test_transparent_background_is_blank_paper(self):
        image = Image.new("RGBA", (240, 100), (0, 0, 0, 0))
        self.assertFalse(wall_evidence((20, 50), (220, 50), 2, image)["accepted"])
        ImageDraw.Draw(image).line((20, 50, 220, 50), fill=(0, 0, 0, 255), width=2)
        self.assertTrue(wall_evidence((20, 50), (220, 50), 2, image)["accepted"])

    def test_invalid_geometry_is_rejected(self):
        image = Image.new("RGB", (100, 100), "white")
        for start, end, thickness in (
            ((10, 10), (10, 10), 2),
            ((10, 10), (80, 80), 0),
            ((float("nan"), 10), (80, 80), 2),
        ):
            with self.subTest(start=start, end=end, thickness=thickness):
                report = wall_evidence(start, end, thickness, image)
                self.assertFalse(report["accepted"], report)
                self.assertEqual(report["reason"], "invalid_geometry")

    def test_implausible_thickness_is_rejected_before_image_conversion(self):
        image = Image.new("RGB", (240, 100), "white")
        with mock.patch.object(image, "convert", side_effect=AssertionError("must not scan")):
            report = wall_evidence((20, 50), (220, 50), 33, image)
        self.assertFalse(report["accepted"], report)
        self.assertEqual(report["reason"], "unsupported_thickness")
        self.assertEqual(report["count"], 0)

    def test_extreme_length_is_rejected_without_thinning_samples_or_scanning(self):
        image = Image.new("RGB", (240, 100), "white")
        with mock.patch.object(image, "convert", side_effect=AssertionError("must not scan")):
            report = wall_evidence((20, 50), (10**12, 50), 2, image)
        self.assertFalse(report["accepted"], report)
        self.assertEqual(report["reason"], "scan_limit")
        self.assertEqual(report["count"], 0)

    def test_shared_deadline_is_observed_during_scan(self):
        image = Image.new("RGB", (4000, 100), "white")
        ImageDraw.Draw(image).line((20, 50, 3980, 50), fill="black", width=2)
        with mock.patch("app.services.floorplans.providers.monotonic", return_value=0) as clock:
            def expire_after_scan_begins(values):
                clock.return_value = 2
                return median(values)

            with extraction_deadline(1), \
                    mock.patch("app.services.floorplans.wall_evidence.median",
                               side_effect=expire_after_scan_begins) as samples:
                with self.assertRaisesRegex(ProviderError, "time limit"):
                    wall_evidence((20, 50), (3980, 50), 2, image)
                # Stop within the first scan batch, rather than finishing all
                # 7,920 sample positions after the shared deadline has expired.
                self.assertGreater(samples.call_count, 0)
                self.assertLessEqual(samples.call_count, 256)

    def test_shared_cancellation_is_observed_during_scan(self):
        image = Image.new("RGB", (4000, 100), "white")
        ImageDraw.Draw(image).line((20, 50, 3980, 50), fill="black", width=2)
        cancelled = Event()

        def cancel_after_scan_begins(values):
            cancelled.set()
            return median(values)

        with mock.patch("app.services.floorplans.providers.monotonic", return_value=0), \
                extraction_deadline(1, cancelled=cancelled), \
                mock.patch("app.services.floorplans.wall_evidence.median",
                           side_effect=cancel_after_scan_begins) as samples:
            with self.assertRaisesRegex(ProviderError, "cancelled"):
                wall_evidence((20, 50), (3980, 50), 2, image)
            self.assertGreater(samples.call_count, 0)
            self.assertLessEqual(samples.call_count, 256)


if __name__ == "__main__":
    unittest.main()
