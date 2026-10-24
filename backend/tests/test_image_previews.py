"""HTTP overlays fit hosting limits without changing canonical extraction pixels."""

import base64
import io
import os
import random
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient
from PIL import Image, ImageDraw

from app import api
from app.schemas.extraction import ImageUpload
from app.services.floorplans.images import MAX_PREVIEW_BYTES, load_image, save_image


class ImagePreviewTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name) / "editor"
        environment = patch.dict(os.environ, {"CROWDY_STORAGE_DIR": directory.name,
            "BLOB_READ_WRITE_TOKEN": "", "CROWDY_BACKEND_TOKEN": ""})
        environment.start()
        self.addCleanup(environment.stop)
        self.client = TestClient(api.app)
        self.addCleanup(self.client.close)

    def save(self, image, format, **options):
        encoded = io.BytesIO()
        image.save(encoded, format, **options)
        return save_image(ImageUpload(filename="floor-plan." + format.lower(),
            image_base64=base64.b64encode(encoded.getvalue()).decode()), self.root)

    def test_small_png_is_returned_unchanged(self):
        source = self.save(Image.new("RGB", (1000, 500), "white"), "PNG")
        _, canonical = load_image(self.root, source.id)
        response = self.client.get("/api/floorplans/images/" + source.id)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["content-type"], "image/png")
        self.assertEqual(response.content, canonical)
        self.assertIn("no-store", response.headers["cache-control"])
        self.assertEqual(response.headers["x-content-type-options"], "nosniff")

    def test_noisy_large_jpeg_gets_bounded_aligned_preview_and_keeps_source_png(self):
        rng = random.Random(42)
        image = Image.frombytes("RGB", (736, 736), rng.randbytes(736 * 736 * 3)).resize(
            (3072, 3072), Image.Resampling.BILINEAR)
        marks = ImageDraw.Draw(image)
        marks.rectangle((0, 0, 200, 200), fill="red")
        marks.rectangle((2871, 2871, 3071, 3071), fill="blue")
        source = self.save(image, "JPEG", quality=82)
        _, canonical = load_image(self.root, source.id)
        self.assertTrue(canonical.startswith(b"\x89PNG"))
        self.assertGreater(len(canonical), 4_500_000)

        response = self.client.get("/api/floorplans/images/" + source.id)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["content-type"], "image/jpeg")
        self.assertLessEqual(len(response.content), MAX_PREVIEW_BYTES)
        with Image.open(io.BytesIO(response.content)) as preview:
            self.assertEqual(preview.size, (source.width_px, source.height_px))
            self.assertEqual(preview.size, (3072, 3072))
            red, blue = preview.getpixel((100, 100)), preview.getpixel((2972, 2972))
            self.assertGreater(red[0], 230)
            self.assertLess(max(red[1:]), 25)
            self.assertGreater(blue[2], 230)
            self.assertLess(max(blue[:2]), 25)
        restored, unchanged = load_image(self.root, source.id)
        self.assertEqual(unchanged, canonical, "Preview encoding must not change the stored provider/extraction frame")
        self.assertEqual(restored, source)
