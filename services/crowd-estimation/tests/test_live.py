"""Live-frame capabilities, lifecycle, bounds, and shared inference admission."""

import base64
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from io import BytesIO
from threading import Event
from unittest.mock import patch

from fastapi.testclient import TestClient
from PIL import Image

from app.config import Settings
from app.images import MAX_PREVIEW_BYTES, MAX_PREVIEW_EDGE, jpeg_preview
from app.live import MAX_LIVE_SESSIONS, SESSION_TTL_SECONDS, LiveSessionMissing, LiveSessions
from app.main import create_app
from test_service import AUTH, TOKEN, FakeEstimator, image_bytes, multipart


class LiveTests(unittest.TestCase):
    def setUp(self):
        self.clock = [100.0]
        self.started = datetime(2026, 1, 1, tzinfo=UTC)
        self.sessions = LiveSessions(
            clock=lambda: self.clock[0],
            wall_clock=lambda: self.started + timedelta(seconds=self.clock[0] - 100),
        )
        self.estimator = FakeEstimator()
        self.app = create_app(Settings(token=TOKEN), estimator=self.estimator, live_sessions=self.sessions)
        self.client = TestClient(self.app)
        self.client.__enter__()
        self.addCleanup(self.client.__exit__, None, None, None)
        response = self.client.post("/v1/live-sessions", headers=AUTH)
        self.assertEqual(response.status_code, 201, response.text)
        self.created = response.json()
        self.url = "/v1/live-sessions/" + self.created["session_id"]
        self.viewer = {**AUTH, "X-Crowdy-Live-Token": self.created["viewer_token"]}
        self.camera = {**AUTH, "X-Crowdy-Live-Token": self.created["camera_token"]}

    def frame(self, data=None, content_type="image/png", headers=None):
        return self.client.post(
            self.url + "/frames", headers=self.camera if headers is None else headers,
            files={"image": ("frame.png", image_bytes() if data is None else data, content_type)},
        )

    def test_creation_and_waiting_snapshot_contain_separate_capabilities(self):
        self.assertEqual(set(self.created), {"session_id", "viewer_token", "camera_token", "expires_at"})
        self.assertRegex(self.created["session_id"], r"^[0-9a-f]{32}$")
        for key in ("camera_token", "viewer_token"):
            self.assertRegex(self.created[key], r"^[A-Za-z0-9_-]{43}$")
        self.assertNotEqual(self.created["camera_token"], self.created["viewer_token"])
        expiry = datetime.fromisoformat(self.created["expires_at"])
        self.assertEqual(expiry, self.started + timedelta(seconds=SESSION_TTL_SECONDS))
        response = self.client.get(self.url, headers=self.viewer)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {
            "session_id": self.created["session_id"], "expires_at": self.created["expires_at"],
            "sequence": 0, "updated_at": None, "estimate": None, "preview": None, "status": "waiting",
        })
        self.assertEqual(response.headers["cache-control"], "no-store")

    def test_every_live_operation_requires_the_service_bearer(self):
        operations = [
            ("POST", "/v1/live-sessions", self.viewer),
            ("GET", self.url, self.viewer),
            ("DELETE", self.url, self.viewer),
            ("POST", self.url + "/pause", self.camera),
            ("POST", self.url + "/frames", self.camera),
        ]
        for method, url, valid_headers in operations:
            with self.subTest(method=method, url=url):
                headers = {**valid_headers, "Authorization": "Bearer wrong"}
                response = self.client.request(method, url, headers=headers)
                self.assertEqual(response.status_code, 401)
                self.assertEqual(response.headers["www-authenticate"], "Bearer")
        self.assertEqual(self.client.get(self.url, headers=self.viewer).json()["sequence"], 0)

    def test_camera_and_viewer_capabilities_cannot_substitute_for_each_other(self):
        for headers in (AUTH, {**AUTH, "X-Crowdy-Live-Token": "invalid"}, self.camera):
            with self.subTest(headers_role="read/delete", token_present=len(headers) > 1):
                self.assertEqual(self.client.get(self.url, headers=headers).status_code, 401)
                self.assertEqual(self.client.delete(self.url, headers=headers).status_code, 401)
        for headers in (AUTH, {**AUTH, "X-Crowdy-Live-Token": "invalid"}, self.viewer):
            self.assertEqual(self.frame(headers=headers).status_code, 401)
            self.assertEqual(self.client.post(self.url + "/pause", headers=headers).status_code, 401)
        self.assertEqual(self.estimator.frames, [])

    def test_frame_authentication_precedes_body_reads(self):
        def unreadable_body():
            raise AssertionError("Unauthorized frame must not be consumed")
            yield b"unreachable"

        for headers in (AUTH, self.viewer, {**self.camera, "Authorization": "Bearer wrong"}):
            response = self.client.post(self.url + "/frames", headers=headers, content=unreadable_body())
            self.assertEqual(response.status_code, 401)

    def test_capability_is_bound_to_its_session(self):
        other = self.client.post("/v1/live-sessions", headers=AUTH).json()
        wrong = {**AUTH, "X-Crowdy-Live-Token": other["camera_token"]}
        self.assertEqual(self.frame(headers=wrong).status_code, 401)
        self.assertNotIn(other["camera_token"], self.frame(headers=wrong).text)
        self.assertEqual(self.client.get(self.url, headers=self.viewer).json()["status"], "waiting")

    def test_frame_updates_snapshot_preview_and_monotonic_sequence(self):
        response = self.frame(image_bytes(size=(1600, 900)))
        self.assertEqual(response.status_code, 200, response.text)
        live = response.json()
        self.assertEqual(live["status"], "live")
        self.assertEqual(live["sequence"], 1)
        self.assertEqual(live["estimate"]["count"], 0)
        self.assertEqual(datetime.fromisoformat(live["updated_at"]), self.started)
        self.assertEqual(live["expires_at"], self.created["expires_at"])
        self.assertNotIn(self.created["viewer_token"], response.text)
        self.assertNotIn(self.created["camera_token"], response.text)
        prefix, encoded = live["preview"].split(",", 1)
        self.assertEqual(prefix, "data:image/jpeg;base64")
        preview = base64.b64decode(encoded, validate=True)
        self.assertLessEqual(len(preview), MAX_PREVIEW_BYTES)
        with Image.open(BytesIO(preview)) as image:
            self.assertEqual(image.format, "JPEG")
            self.assertEqual(image.size, (MAX_PREVIEW_EDGE, 360))
            self.assertFalse(image.getexif())
        self.assertEqual(self.client.get(self.url, headers=self.viewer).json(), live)
        paused = self.client.post(self.url + "/pause", headers=self.camera).json()
        self.assertEqual(paused["status"], "paused")
        self.assertEqual(paused["sequence"], 2)
        self.assertEqual(paused["estimate"], live["estimate"])
        self.clock[0] += 2
        resumed = self.frame().json()
        self.assertEqual(resumed["status"], "live")
        self.assertEqual(resumed["sequence"], 3)
        self.assertNotEqual(resumed["updated_at"], live["updated_at"])
        self.assertEqual(resumed["expires_at"], self.created["expires_at"])
        self.assertEqual(resumed["estimate"]["image"], {"width": 12, "height": 8})

    def test_live_uploads_share_still_validation(self):
        for data, media_type, status in (
            (b"GIF89a", "image/gif", 415), (b"bad", "image/png", 422),
            (image_bytes(), "image/jpeg", 422), (b"", "image/png", 400),
        ):
            with self.subTest(media_type=media_type, status=status):
                self.assertEqual(self.frame(data, media_type).status_code, status)
        body, media_type = multipart([
            ("image", "a.png", "image/png", image_bytes()),
            ("image", "b.png", "image/png", image_bytes()),
        ])
        response = self.client.post(self.url + "/frames", headers={**self.camera, "Content-Type": media_type}, content=body)
        self.assertEqual(response.status_code, 400)
        self.assertEqual(self.client.get(self.url, headers=self.viewer).json()["sequence"], 0)
        self.assertEqual(self.estimator.frames, [])

    def test_live_upload_size_pixel_and_stream_limits_are_enforced(self):
        for overrides, data, expected in (
            ({"max_upload_bytes": 10}, image_bytes(), 413),
            ({"max_pixels": 95}, image_bytes(), 422),
            ({"max_upload_bytes": 10}, b"x" * 70_000, 413),
        ):
            with self.subTest(overrides=overrides, expected=expected):
                with TestClient(create_app(Settings(token=TOKEN, **overrides), estimator=FakeEstimator())) as client:
                    created = client.post("/v1/live-sessions", headers=AUTH).json()
                    body, media_type = multipart([("image", "frame.png", "image/png", data)])
                    response = client.post(
                        "/v1/live-sessions/" + created["session_id"] + "/frames", content=body,
                        headers={**AUTH, "X-Crowdy-Live-Token": created["camera_token"],
                                 "Content-Type": media_type, "Content-Length": "1"},
                    )
                    self.assertEqual(response.status_code, expected, response.text)

    def test_expiry_is_fixed_and_does_not_extend_with_polling_or_frames(self):
        self.clock[0] += SESSION_TTL_SECONDS - 1
        self.assertEqual(self.frame().status_code, 200)
        self.assertEqual(self.client.get(self.url, headers=self.viewer).status_code, 200)
        self.clock[0] += 1
        self.assertEqual(self.client.get(self.url, headers=self.viewer).status_code, 404)
        self.assertEqual(self.frame().status_code, 404)
        self.assertEqual(self.client.post(self.url + "/pause", headers=self.camera).status_code, 404)
        self.assertEqual(self.client.delete(self.url, headers=self.viewer).status_code, 404)

    def test_active_session_limit_and_eviction(self):
        for _ in range(MAX_LIVE_SESSIONS - 1):
            self.assertEqual(self.client.post("/v1/live-sessions", headers=AUTH).status_code, 201)
        full = self.client.post("/v1/live-sessions", headers=AUTH)
        self.assertEqual(full.status_code, 503)
        self.assertEqual(full.headers["retry-after"], "30")
        self.assertEqual(self.client.delete(self.url, headers=self.viewer).status_code, 204)
        self.assertEqual(self.client.post("/v1/live-sessions", headers=AUTH).status_code, 201)
        self.assertEqual(self.client.post("/v1/live-sessions", headers=AUTH).status_code, 503)
        self.clock[0] += SESSION_TTL_SECONDS
        self.assertEqual(self.client.post("/v1/live-sessions", headers=AUTH).status_code, 201)

    def test_deleted_session_rejects_both_capabilities(self):
        self.assertEqual(self.frame().status_code, 200)
        response = self.client.delete(self.url, headers=self.viewer)
        self.assertEqual(response.status_code, 204)
        self.assertEqual(response.content, b"")
        self.assertEqual(self.client.get(self.url, headers=self.viewer).status_code, 404)
        self.assertEqual(self.frame().status_code, 404)

    def block_inference(self):
        entered, release = Event(), Event()
        original = self.estimator.estimate

        def blocking(frame):
            entered.set()
            if not release.wait(5):
                raise AssertionError("Test failed to release inference")
            return original(frame)

        self.estimator.estimate = blocking
        self.addCleanup(release.set)
        return entered, release

    def test_delete_during_inference_cannot_resurrect_session(self):
        entered, release = self.block_inference()
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(self.frame)
            try:
                self.assertTrue(entered.wait(5))
                self.assertEqual(self.client.delete(self.url, headers=self.viewer).status_code, 204)
            finally:
                release.set()
            self.assertEqual(pending.result(timeout=5).status_code, 404)
        self.assertEqual(self.client.get(self.url, headers=self.viewer).status_code, 404)

    def test_inference_and_polling_do_not_make_an_older_frame_fresh(self):
        entered, release = self.block_inference()
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(self.frame)
            try:
                self.assertTrue(entered.wait(5))
                self.clock[0] += 25
            finally:
                release.set()
            response = pending.result(timeout=5)
        self.assertEqual(response.status_code, 200, response.text)
        live = response.json()
        admitted_at = datetime.fromisoformat(live["updated_at"])
        self.assertEqual(admitted_at, self.started,
                         "The published frame age must include the time spent in inference")
        self.clock[0] += 20
        polled = self.client.get(self.url, headers=self.viewer).json()
        self.assertEqual(polled["updated_at"], live["updated_at"])
        current_time = self.started + timedelta(seconds=self.clock[0] - 100)
        self.assertEqual((current_time - admitted_at).total_seconds(), 45,
                         "The frontend's 45-second freshness cutoff must include processing time")
        self.assertEqual(datetime.fromisoformat(self.frame().json()["updated_at"]), current_time,
                         "Only a newly admitted frame may advance the observation timestamp")

    def test_pause_during_inference_discards_old_frame_and_new_frame_resumes(self):
        completed = self.frame().json()
        entered, release = self.block_inference()
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(self.frame, image_bytes(size=(60, 40)))
            try:
                self.assertTrue(entered.wait(5))
                paused = self.client.post(self.url + "/pause", headers=self.camera).json()
                self.assertEqual(paused["status"], "paused")
                self.assertEqual(paused["sequence"], 2)
                self.assertEqual(paused["estimate"], completed["estimate"])
            finally:
                release.set()
            late = pending.result(timeout=5)
            self.assertEqual(late.status_code, 200)
            self.assertEqual(late.json(), paused)
        snapshot = self.client.get(self.url, headers=self.viewer).json()
        self.assertEqual(snapshot["estimate"], completed["estimate"])
        self.assertEqual(snapshot["preview"], completed["preview"])
        self.assertEqual(snapshot["updated_at"], completed["updated_at"])
        resumed = self.frame().json()
        self.assertEqual(resumed["status"], "live")
        self.assertEqual(resumed["sequence"], 3)

    def test_expiry_during_inference_discards_result(self):
        entered, release = self.block_inference()
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(self.frame)
            try:
                self.assertTrue(entered.wait(5))
                self.clock[0] += SESSION_TTL_SECONDS
            finally:
                release.set()
            self.assertEqual(pending.result(timeout=5).status_code, 404)

    def test_live_and_still_estimates_share_one_nonqueued_inference_slot(self):
        def still():
            return self.client.post("/v1/estimates", headers=AUTH,
                                    files={"image": ("frame.png", image_bytes(), "image/png")})

        for first, second in ((self.frame, still), (still, self.frame)):
            with self.subTest(first=first.__name__):
                entered, release = self.block_inference()
                with ThreadPoolExecutor(max_workers=1) as pool:
                    pending = pool.submit(first)
                    try:
                        self.assertTrue(entered.wait(5))
                        busy = second()
                        self.assertEqual(busy.status_code, 503)
                        self.assertEqual(busy.headers["retry-after"], "2")
                        # Polling remains responsive during inference.
                        self.assertEqual(self.client.get(self.url, headers=self.viewer).status_code, 200)
                    finally:
                        release.set()
                    self.assertEqual(pending.result(timeout=5).status_code, 200)

    def test_shutdown_erases_sessions(self):
        sessions = LiveSessions()
        with TestClient(create_app(Settings(token=TOKEN), estimator=FakeEstimator(), live_sessions=sessions)) as client:
            created = client.post("/v1/live-sessions", headers=AUTH).json()
            self.assertEqual(sessions.snapshot(created["session_id"], created["viewer_token"]).status, "waiting")
        with self.assertRaises(LiveSessionMissing):
            sessions.snapshot(created["session_id"], created["viewer_token"])

    def test_openapi_documents_both_credentials(self):
        schema = self.client.get("/openapi.json").json()
        self.assertEqual(schema["paths"]["/v1/live-sessions/{session_id}/frames"]["post"]["security"],
                         [{"serviceBearer": [], "liveCapability": []}])
        self.assertEqual(schema["components"]["securitySchemes"]["liveCapability"]["name"], "X-Crowdy-Live-Token")


class PreviewTests(unittest.TestCase):
    def test_preview_drops_exif_and_limits_encoded_size(self):
        with Image.new("RGB", (1000, 1000), "red") as image:
            image.info["exif"] = b"do not retain metadata"
            with patch("app.images.MAX_PREVIEW_BYTES", 1024):
                preview = jpeg_preview(image)
        raw = base64.b64decode(preview.split(",", 1)[1], validate=True)
        self.assertLessEqual(len(raw), 1024)
        with Image.open(BytesIO(raw)) as image:
            self.assertFalse(image.getexif())
            self.assertLess(image.width, MAX_PREVIEW_EDGE)


if __name__ == "__main__":
    unittest.main()
