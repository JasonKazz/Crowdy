"""Run with ``python -m unittest discover -s tests -v``; no weights required."""

import importlib
import os
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
from pathlib import Path
from threading import Event
from types import ModuleType, SimpleNamespace
from unittest.mock import Mock, patch

from fastapi.testclient import TestClient
from PIL import Image, UnidentifiedImageError

from app.config import Settings
from app.estimator import (
    CrowdEstimator,
    Estimate,
    EstimatorBusy,
    ImageDimensions,
    VISIBLE_PEOPLE_WARNING,
)
from app.images import InvalidImage, decode_image
from app.main import create_app


TOKEN = "test-token"
AUTH = {"Authorization": f"Bearer {TOKEN}"}


def image_bytes(image_format="PNG", size=(12, 8), **save_options):
    with Image.new("RGB", size, "red") as image:
        output = BytesIO()
        image.save(output, image_format, **save_options)
        return output.getvalue()


def multipart(parts, boundary="test-boundary"):
    """Build a body explicitly, including malformed and oversized requests."""
    chunks = []
    for name, filename, content_type, data in parts:
        disposition = f'Content-Disposition: form-data; name="{name}"'
        if filename is not None:
            disposition += f'; filename="{filename}"'
        chunks.extend([
            f"--{boundary}\r\n{disposition}\r\n".encode(),
            f"Content-Type: {content_type}\r\n\r\n".encode(),
            data,
            b"\r\n",
        ])
    chunks.append(f"--{boundary}--\r\n".encode())
    return b"".join(chunks), f"multipart/form-data; boundary={boundary}"


class FakeEstimator:
    def __init__(self):
        self.ready = False
        self.frames = []
        self.load_calls = 0
        self.error = None

    def load(self):
        self.load_calls += 1
        self.ready = True

    def estimate(self, frame):
        if self.error is not None:
            raise self.error
        self.frames.append((frame.size, frame.mode))
        return Estimate(
            estimate_id="test-estimate", count=0, detections=[],
            image=ImageDimensions(width=frame.width, height=frame.height),
            model="fake.pt", processing_ms=0.1,
            warnings=[VISIBLE_PEOPLE_WARNING],
        )


class SettingsTests(unittest.TestCase):
    def test_missing_or_padded_token_fails_closed(self):
        for token in ("", " ", " padded", "padded "):
            with self.subTest(token=token), self.assertRaises(ValueError):
                Settings(token=token)
        with patch.dict(os.environ, {"CROWDY_CROWD_ESTIMATION_TOKEN": ""}):
            with self.assertRaises(ValueError):
                create_app()

    def test_import_does_not_require_config_or_create_a_model(self):
        with patch.dict(os.environ, {"CROWDY_CROWD_ESTIMATION_TOKEN": ""}):
            with patch("app.estimator.CrowdEstimator.load", side_effect=AssertionError("model loaded")):
                module = importlib.reload(importlib.import_module("app.main"))
        self.assertFalse(any(isinstance(value, CrowdEstimator) for value in vars(module).values()))
        self.assertEqual(os.environ.get("YOLO_AUTOINSTALL"), "false")
        detector = CrowdEstimator(Settings(token=TOKEN))
        self.assertFalse(detector.ready)
        self.assertIsNone(detector._model)

    def test_invalid_settings_are_rejected(self):
        for overrides in (
            {"confidence": float("nan")}, {"iou": 0}, {"confidence": 1.01},
            {"image_size": 321}, {"image_size": 2080}, {"threads": 0},
            {"max_detections": 0}, {"max_upload_bytes": 0}, {"max_pixels": 30_000_001},
        ):
            with self.subTest(overrides=overrides), self.assertRaises(ValueError):
                Settings(token=TOKEN, **overrides)


class ImageTests(unittest.TestCase):
    def test_allowed_still_formats_become_rgb(self):
        for file_format, media_type in (("PNG", "image/png"), ("JPEG", "image/jpeg"), ("WEBP", "image/webp")):
            with self.subTest(file_format=file_format):
                with decode_image(image_bytes(file_format), media_type, 1000) as image:
                    self.assertEqual(image.size, (12, 8))
                    self.assertEqual(image.mode, "RGB")

    def test_exif_orientation_changes_detection_coordinates(self):
        exif = Image.Exif()
        exif[274] = 6  # A 90-degree clockwise display rotation.
        data = image_bytes("JPEG", size=(12, 8), exif=exif)
        with decode_image(data, "image/jpeg", 1000) as image:
            self.assertEqual(image.size, (8, 12))
            self.assertIsNone(image.getexif().get(274))

    def test_transparency_is_composited_on_white_before_inference(self):
        for file_format, media_type in (("PNG", "image/png"), ("WEBP", "image/webp")):
            with self.subTest(file_format=file_format):
                output = BytesIO()
                with Image.new("RGBA", (2, 1)) as source:
                    source.putdata([(255, 0, 0, 0), (255, 0, 0, 128)])
                    source.save(output, file_format, lossless=True)
                with decode_image(output.getvalue(), media_type, 1000) as image:
                    self.assertEqual(image.mode, "RGB")
                    self.assertEqual(image.getpixel((0, 0)), (255, 255, 255))
                    self.assertEqual(image.getpixel((1, 0)), (255, 127, 127))

        with self.subTest(file_format="PNG", mode="palette"):
            output = BytesIO()
            with Image.new("P", (2, 1)) as source:
                source.putpalette([255, 0, 0, 0, 0, 255])
                source.putdata([0, 1])
                source.save(output, "PNG", transparency=b"\x00\x80")
            with decode_image(output.getvalue(), "image/png", 1000) as image:
                self.assertEqual(image.mode, "RGB")
                self.assertEqual(image.getpixel((0, 0)), (255, 255, 255))
                self.assertEqual(image.getpixel((1, 0)), (127, 127, 255))

    def test_mismatched_corrupt_and_oversized_images_fail(self):
        for data, content_type, limit in (
            (image_bytes("PNG"), "image/jpeg", 1000),
            (b"not an image", "image/png", 1000),
            (image_bytes("PNG")[:30], "image/png", 1000),
            (image_bytes("PNG"), "image/png", 95),
        ):
            with self.subTest(content_type=content_type, limit=limit), self.assertRaises(InvalidImage):
                decode_image(data, content_type, limit)

    def test_animated_png_is_rejected(self):
        output = BytesIO()
        with Image.new("RGB", (4, 4), "red") as first, Image.new("RGB", (4, 4), "blue") as second:
            first.save(output, "PNG", save_all=True, append_images=[second], duration=100, loop=0)
        with self.assertRaisesRegex(InvalidImage, "still image"):
            decode_image(output.getvalue(), "image/png", 1000)


class ApiTests(unittest.TestCase):
    def setUp(self):
        self.estimator = FakeEstimator()
        self.client = TestClient(create_app(Settings(token=TOKEN), estimator=self.estimator))
        self.client.__enter__()

    def tearDown(self):
        self.client.__exit__(None, None, None)
        self.assertFalse(self.estimator.ready)

    def upload(self, data=None, content_type="image/png", name="image", **kwargs):
        if data is None:
            data = image_bytes()
        return self.client.post(
            "/v1/estimates", headers=AUTH,
            files={name: ("untrusted-filename.xyz", data, content_type)}, **kwargs,
        )

    def test_health_readiness_and_lifespan(self):
        self.assertEqual(self.estimator.load_calls, 1)
        self.assertEqual(self.client.get("/healthz").json(), {"status": "ok"})
        self.assertEqual(self.client.get("/readyz").status_code, 200)
        self.estimator.ready = False
        self.assertEqual(self.client.get("/healthz").status_code, 200)
        self.assertEqual(self.client.get("/readyz").status_code, 503)
        response = self.upload()
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.headers["retry-after"], "5")
        self.assertEqual(self.estimator.frames, [])

    def test_auth_happens_before_reading_the_body(self):
        def unreadable_body():
            raise AssertionError("Unauthorized request body must not be consumed")
            yield b"unreachable"

        for token in (None, "Bearer wrong", TOKEN, f"bearer {TOKEN}"):
            headers = {} if token is None else {"Authorization": token}
            response = self.client.post("/v1/estimates", headers=headers, content=unreadable_body())
            self.assertEqual(response.status_code, 401)
            self.assertEqual(response.headers["www-authenticate"], "Bearer")
            self.assertEqual(response.headers["cache-control"], "no-store")
        self.assertEqual(self.estimator.frames, [])

    def test_success_with_zero_people_is_not_a_placeholder_error(self):
        response = self.upload()
        self.assertEqual(response.status_code, 200, response.text)
        result = response.json()
        self.assertEqual(result["count"], 0)
        self.assertEqual(result["detections"], [])
        self.assertEqual(result["image"], {"width": 12, "height": 8})
        self.assertEqual(self.estimator.frames, [((12, 8), "RGB")])
        self.assertEqual(response.headers["cache-control"], "no-store")
        self.assertEqual(response.headers["x-content-type-options"], "nosniff")

    def test_api_passes_exif_oriented_image_to_detector(self):
        exif = Image.Exif()
        exif[274] = 6
        response = self.upload(image_bytes("JPEG", exif=exif), "image/jpeg")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["image"], {"width": 8, "height": 12})

    def test_unsupported_type_corruption_and_mismatch(self):
        for data, media_type, expected in (
            (b"GIF89a", "image/gif", 415),
            (b"garbage", "image/png", 422),
            (image_bytes(), "image/jpeg", 422),
            (b"", "image/png", 400),
        ):
            with self.subTest(media_type=media_type, expected=expected):
                self.assertEqual(self.upload(data, media_type).status_code, expected)
        self.assertEqual(self.estimator.frames, [])

    def test_loaded_model_pillow_patch_cannot_activate_optional_plugins(self):
        original_open = Image.open
        optional_heif_plugin = Mock(side_effect=ModuleNotFoundError("pi_heif is not installed"))

        def model_patched_open(*args, **kwargs):
            # Ultralytics replaces Image.open at import time with this fallback
            # behavior. It must never control decoding of service uploads.
            try:
                return original_open(*args, **kwargs)
            except UnidentifiedImageError:
                optional_heif_plugin()

        with patch("PIL.Image.open", side_effect=model_patched_open):
            response = self.upload(b"not a readable image", "image/png")
            self.assertEqual(response.status_code, 422, response.text)
            self.assertEqual(self.upload().status_code, 200)
        optional_heif_plugin.assert_not_called()

    def test_requires_exactly_one_image_file_and_no_extra_fields(self):
        cases = [
            [],
            [("wrong", "a.png", "image/png", image_bytes())],
            [("image", None, "text/plain", b"image text")],
            [("image", "a.png", "image/png", image_bytes()), ("image", "b.png", "image/png", image_bytes())],
            [("image", "a.png", "image/png", image_bytes()), ("threshold", None, "text/plain", b"0.01")],
        ]
        for parts in cases:
            body, media_type = multipart(parts)
            with self.subTest(parts=len(parts)):
                response = self.client.post("/v1/estimates", content=body, headers={**AUTH, "Content-Type": media_type})
                self.assertEqual(response.status_code, 400, response.text)
        self.assertEqual(self.estimator.frames, [])

    def test_non_multipart_request_is_rejected(self):
        response = self.client.post("/v1/estimates", headers=AUTH, json={"image": "data"})
        self.assertEqual(response.status_code, 415)

    def test_incomplete_multipart_is_rejected_and_closes_partial_files(self):
        body, media_type = multipart([("image", "a.png", "image/png", image_bytes())])
        terminal = b"--test-boundary--\r\n"
        truncated_bodies = {
            "unfinished_file": body[:-len(terminal) - 2],
            "unfinished_next_part": body[:-len(terminal)] + b"--test-boundary\r\n",
        }
        for name, truncated in truncated_bodies.items():
            with self.subTest(truncation=name):
                opened_files = []

                def tracked_file(*args, **kwargs):
                    file = tempfile.SpooledTemporaryFile(*args, **kwargs)
                    opened_files.append(file)
                    return file

                try:
                    with patch("starlette.formparsers.SpooledTemporaryFile", side_effect=tracked_file):
                        response = self.client.post(
                            "/v1/estimates", content=truncated,
                            headers={**AUTH, "Content-Type": media_type},
                        )
                    self.assertEqual(response.status_code, 400, response.text)
                    self.assertTrue(opened_files, "Fixture must reach file creation before truncation")
                    self.assertTrue(all(file.closed for file in opened_files), "Partial uploads must be closed")
                finally:
                    for file in opened_files:
                        file.close()
        self.assertEqual(self.estimator.frames, [])

    def test_oversized_file_even_when_multipart_stream_fits(self):
        config = Settings(token=TOKEN, max_upload_bytes=10)
        with TestClient(create_app(config, estimator=FakeEstimator())) as client:
            response = client.post("/v1/estimates", headers=AUTH, files={"image": ("a.png", image_bytes(), "image/png")})
        self.assertEqual(response.status_code, 413)

    def test_chunked_upload_cannot_bypass_stream_limit(self):
        config = Settings(token=TOKEN, max_upload_bytes=10)
        body, media_type = multipart([("image", "a.png", "image/png", b"x" * 70_000)])
        with TestClient(create_app(config, estimator=FakeEstimator())) as client:
            for claimed_length in (None, "1"):
                with self.subTest(content_length=claimed_length):
                    def chunks():
                        for offset in range(0, len(body), 8192):
                            yield body[offset:offset + 8192]

                    headers = {**AUTH, "Content-Type": media_type}
                    if claimed_length is not None:
                        headers["Content-Length"] = claimed_length
                    request = client.build_request("POST", "/v1/estimates", content=chunks(), headers=headers)
                    if claimed_length is None:
                        self.assertNotIn("content-length", request.headers)
                    response = client.send(request)
                    self.assertEqual(response.status_code, 413, response.text)

    def test_content_length_is_validated_but_not_trusted(self):
        body, media_type = multipart([("image", "a.png", "image/png", image_bytes())])
        for length, expected in (("-1", 400), ("invalid", 400), ("999999999", 413)):
            with self.subTest(length=length):
                response = self.client.post("/v1/estimates", content=body, headers={**AUTH, "Content-Type": media_type, "Content-Length": length})
                self.assertEqual(response.status_code, expected)

    def test_pixel_limit_is_enforced(self):
        with TestClient(create_app(Settings(token=TOKEN, max_pixels=95), estimator=FakeEstimator())) as client:
            response = client.post("/v1/estimates", headers=AUTH, files={"image": ("a.png", image_bytes(), "image/png")})
        self.assertEqual(response.status_code, 422)

    def test_inference_failure_response_hides_internal_details(self):
        self.estimator.error = RuntimeError("secret /private/model/path or token")
        with self.assertLogs("app.main", level="ERROR"):
            response = self.upload()
        self.assertEqual(response.status_code, 500)
        self.assertEqual(response.json(), {"error": "Crowd estimation failed. Retry with another image."})
        self.estimator.error = None
        self.assertEqual(self.upload().status_code, 200)

    def test_estimator_busy_is_retryable(self):
        self.estimator.error = EstimatorBusy()
        response = self.upload()
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.headers["retry-after"], "2")

    def test_concurrent_requests_are_rejected_without_queueing(self):
        entered = Event()
        release = Event()
        original_estimate = self.estimator.estimate

        def blocking_estimate(frame):
            entered.set()
            if not release.wait(5):
                raise AssertionError("Test failed to release inference")
            return original_estimate(frame)

        self.estimator.estimate = blocking_estimate
        with ThreadPoolExecutor(max_workers=1) as pool:
            first = pool.submit(self.upload)
            try:
                self.assertTrue(entered.wait(5), "First request did not begin inference")
                second = self.upload()
                self.assertEqual(second.status_code, 503)
                self.assertEqual(second.headers["retry-after"], "2")
            finally:
                release.set()
            self.assertEqual(first.result(timeout=5).status_code, 200)
        self.assertEqual(len(self.estimator.frames), 1)
        self.assertEqual(self.upload().status_code, 200)


class Tensor:
    """Only the tensor methods used by the detector boundary."""
    def __init__(self, values):
        self.values = values

    def cpu(self):
        return self

    def tolist(self):
        return self.values


def model_returning(xyxy=None, confidences=None, classes=None, boxes_present=True):
    boxes = SimpleNamespace(xyxy=Tensor(xyxy or []), conf=Tensor(confidences or []), cls=Tensor(classes or []))
    return Mock(predict=Mock(return_value=[SimpleNamespace(boxes=boxes if boxes_present else None)]))


class DetectorTests(unittest.TestCase):
    def setUp(self):
        self.settings = Settings(token=TOKEN)
        self.estimator = CrowdEstimator(self.settings)
        self.frame = Image.new("RGB", (100, 50))
        self.addCleanup(self.frame.close)

    def test_no_detections_returns_real_zero(self):
        for boxes_present in (True, False):
            with self.subTest(boxes_present=boxes_present):
                self.estimator._model = model_returning(boxes_present=boxes_present)
                result = self.estimator.estimate(self.frame)
                self.assertEqual(result.count, 0)
                self.assertEqual(result.detections, [])
                self.assertEqual(result.image.width, 100)
                self.assertGreaterEqual(result.processing_ms, 0)

    def test_only_people_with_valid_clipped_boxes_are_counted(self):
        self.estimator._model = model_returning(
            xyxy=[[-10, -5, 105, 55], [5, 5, 25, 30], [2, 2, 15, 15], [2, 2, 2, 12], [101, 1, 110, 20]],
            confidences=[0.9, 0.9, 0.1, 0.8, 0.8], classes=[0, 2, 0, 0, 0],
        )
        result = self.estimator.estimate(self.frame)
        self.assertEqual(result.count, len(result.detections))
        self.assertEqual(result.count, 1)
        self.assertEqual(result.detections[0].bbox, (0, 0, 100, 50))
        options = self.estimator._model.predict.call_args.kwargs
        self.assertEqual(options["classes"], [0])
        self.assertFalse(options["save"])
        self.assertFalse(options["stream"])
        self.assertEqual(options["conf"], self.settings.confidence)

    def test_detection_cap_is_reported(self):
        self.estimator = CrowdEstimator(Settings(token=TOKEN, max_detections=1))
        self.estimator._model = model_returning([[1, 1, 10, 10]], [0.8], [0])
        result = self.estimator.estimate(self.frame)
        self.assertEqual(result.count, 1)
        self.assertTrue(any("limit was reached" in warning for warning in result.warnings))

    def test_nonfinite_or_inconsistent_model_output_fails_and_releases_lock(self):
        for model in (
            model_returning([[1, float("nan"), 10, 10]], [0.8], [0]),
            model_returning([[1, 1, 10, 10]], [], [0]),
            Mock(predict=Mock(return_value=[])),
        ):
            with self.subTest(model=model):
                self.estimator._model = model
                with self.assertRaises((RuntimeError, ValueError)):
                    self.estimator.estimate(self.frame)
                self.estimator._model = model_returning()
                self.assertEqual(self.estimator.estimate(self.frame).count, 0)

    def test_detector_lock_rejects_parallel_inference(self):
        self.estimator._model = model_returning()
        self.estimator._lock.acquire()
        try:
            with self.assertRaises(EstimatorBusy):
                self.estimator.estimate(self.frame)
        finally:
            self.estimator._lock.release()

    def test_missing_weights_fail_without_attempting_download(self):
        self.estimator = CrowdEstimator(Settings(token=TOKEN, model_path=Path("/nonexistent/crowdy-test.pt")))
        with self.assertRaisesRegex(RuntimeError, "weights are missing"):
            self.estimator.load()
        self.assertFalse(self.estimator.ready)

    def test_load_validates_person_model_and_warms_up_before_ready(self):
        model = model_returning()
        model.task = "detect"
        model.names = {0: "person"}
        torch = ModuleType("torch")
        torch.set_num_threads = Mock()
        cv2 = ModuleType("cv2")
        cv2.setNumThreads = Mock()
        ultralytics = ModuleType("ultralytics")
        ultralytics.YOLO = Mock(return_value=model)
        with tempfile.TemporaryDirectory() as directory:
            weights = Path(directory) / "test.pt"
            weights.touch()
            self.estimator = CrowdEstimator(Settings(token=TOKEN, model_path=weights, image_size=320))
            with patch.dict("sys.modules", {"torch": torch, "cv2": cv2, "ultralytics": ultralytics}):
                self.estimator.load()
                self.assertTrue(self.estimator.ready)
                self.assertEqual(model.predict.call_count, 1)
                ultralytics.YOLO.assert_called_once_with(str(weights), task="detect")
                torch.set_num_threads.assert_called_once_with(2)
                cv2.setNumThreads.assert_called_once_with(2)
                model.names = {0: "car"}
                invalid = CrowdEstimator(Settings(token=TOKEN, model_path=weights))
                with self.assertRaisesRegex(RuntimeError, "class 0 named person"):
                    invalid.load()
                self.assertFalse(invalid.ready)


if __name__ == "__main__":
    unittest.main()
