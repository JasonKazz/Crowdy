"""Density totals retain model mass and never masquerade as person boxes."""

import hashlib
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

from PIL import Image
from fastapi.testclient import TestClient

from app.config import Settings
from app.density import DensityEstimator
from app.density_weights import prepare_weights, verify_weights
from app.estimator import EstimatorBusy
from app.main import create_app
from test_service import image_bytes


class DensityTests(unittest.TestCase):
    def setUp(self):
        self.estimator = DensityEstimator(Settings(token="test"))
        self.estimator._model = Mock()
        self.frame = Image.new("RGB", (1000, 700))
        self.addCleanup(self.frame.close)

    def test_5000_person_density_total_is_an_estimate_without_fabricated_boxes(self):
        self.estimator._count = Mock(return_value=5500.5)
        result = self.estimator.estimate(self.frame)
        self.assertEqual(result.method, "density")
        self.assertEqual(result.count, 5501)
        self.assertEqual(result.density_count, 5500.5)
        self.assertEqual(result.detections, [])
        self.assertTrue(result.inference.complete)
        self.assertFalse(result.inference.truncated)

    def test_above_10000_retains_raw_total_and_blocks_automatic_full_count_use(self):
        self.estimator._count = Mock(return_value=12865.25)
        result = self.estimator.estimate(self.frame)
        self.assertEqual(result.count, 10000)
        self.assertEqual(result.density_count, 12865.25)
        self.assertFalse(result.inference.complete)
        self.assertTrue(result.inference.truncated)

    def test_nonfinite_or_negative_totals_fail_and_release_lock(self):
        for value in (-1, float("nan"), float("inf")):
            with self.subTest(value=value):
                self.estimator._count = Mock(return_value=value)
                with self.assertRaisesRegex(RuntimeError, "invalid count"):
                    self.estimator.estimate(self.frame)
                self.assertFalse(self.estimator._lock.locked())

    def test_slow_native_pass_is_explicitly_unusable(self):
        self.estimator._count = Mock(return_value=6052.)
        with patch("app.density.perf_counter", side_effect=[0, 26]):
            result = self.estimator.estimate(self.frame)
        self.assertFalse(result.inference.complete)
        self.assertFalse(result.inference.truncated)

    def test_busy_or_unloaded_never_falls_back_to_another_model(self):
        self.estimator._lock.acquire()
        with self.assertRaises(EstimatorBusy):
            self.estimator.estimate(self.frame)
        self.estimator._lock.release()
        self.estimator._model = None
        with self.assertRaisesRegex(RuntimeError, "not initialized"):
            self.estimator.estimate(self.frame)

    def test_pinned_download_validates_hash_and_cleans_incomplete_files(self):
        data = b"test checkpoint bytes"
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "model.pth"
            with patch("app.density_weights.SIZE", len(data)), \
                    patch("app.density_weights.SHA256", hashlib.sha256(data).hexdigest()), \
                    patch("app.density_weights.urllib.request.urlopen", return_value=io.BytesIO(data)):
                prepare_weights(output)
                verify_weights(output)
            output.write_bytes(b"corrupted")
            with self.assertRaisesRegex(RuntimeError, "SHA-256"):
                verify_weights(output)
            output.unlink()
            with patch("app.density_weights.urllib.request.urlopen", return_value=io.BytesIO(b"truncated")):
                with self.assertRaisesRegex(RuntimeError, "SHA-256"):
                    prepare_weights(output)
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_actual_4k_tensor_keeps_whole_density_mass_without_resizing_the_map(self):
        import torch
        # Exact 4K input; model-shaped density output. This checks conservation
        # and memory bounds, not real model accuracy (measured separately).
        density = torch.full((1, 1, 12, 16), 32., dtype=torch.float32)
        seen = []
        def model(tensor):
            seen.append(tuple(tensor.shape))
            return density
        self.estimator._model = model
        with Image.new("RGB", (3840, 2160)) as image:
            result = self.estimator.estimate(image)
        self.assertEqual(seen, [(1, 3, 2160, 3840)])
        self.assertEqual(result.density_count, 6144.)
        self.assertEqual(result.count, 6144)
        self.assertEqual(result.detections, [])

    def test_density_map_rejects_negative_or_nonfinite_values(self):
        import torch
        for value in (float("nan"), -1.):
            self.estimator._model = lambda tensor: torch.full((1, 1, 2, 2), value)
            with self.assertRaisesRegex(RuntimeError, "invalid map"):
                self.estimator.estimate(self.frame)

    def test_checkpoint_loader_uses_safe_tensors_only_and_rejects_wrong_architecture(self):
        from app.density_model import load_zip
        with patch("app.density_model.torch.load", return_value={"config": {}}) as load:
            with self.assertRaisesRegex(ValueError, "ZIP-N"):
                load_zip("untrusted.pth", "cpu")
        self.assertTrue(load.call_args.kwargs["weights_only"])

    def test_actual_http_adapter_preserves_density_method_raw_total_and_no_boxes(self):
        settings = Settings(token="test")
        self.estimator._count = Mock(return_value=6052.25)
        self.estimator.load = Mock(side_effect=lambda: setattr(self.estimator, "ready", True))
        with TestClient(create_app(settings, estimator=self.estimator)) as client:
            response = client.post("/v1/estimates", headers={"Authorization": "Bearer test"},
                                   files={"image": ("frame.png", image_bytes("PNG"), "image/png")})
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data["method"], "density")
        self.assertEqual(data["density_count"], 6052.25)
        self.assertEqual(data["count"], 6052)
        self.assertEqual(data["detections"], [])
        self.assertTrue(data["inference"]["complete"])


if __name__ == "__main__":
    unittest.main()
