import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

from fastapi.testclient import TestClient

from app import api
from app.services.floorplans.providers import ProviderError


class ImportStatusTests(unittest.TestCase):
    def setUp(self):
        env = patch.dict("os.environ", {"CROWDY_BACKEND_TOKEN": ""})
        env.start()
        self.addCleanup(env.stop)
        self.client = TestClient(api.app)
        self.addCleanup(self.client.close)

    def test_busy_provider_does_not_block_other_provider_or_local_operations(self):
        entered, release = threading.Event(), threading.Event()

        def pending(payload):
            if payload.provider == "gemini" and payload.filename:
                entered.set()
                if not release.wait(5):
                    raise AssertionError("Test did not release the extraction")
            return {"ok": True}

        image = {"filename": "test.png", "image_base64": "image", "provider": "gemini"}
        with patch("app.api.import_floorplan", side_effect=pending), ThreadPoolExecutor() as pool:
            task = pool.submit(self.client.post, "/api/floorplans", json=image)
            try:
                self.assertTrue(entered.wait(2))
                status = self.client.get("/api/floorplans").json()
                self.assertTrue(status["gemini"]["busy"])
                self.assertFalse(status["claude"]["busy"])
                self.assertNotIn("test.png", str(status))
                rejected = self.client.post("/api/floorplans", json=image)
                self.assertEqual(rejected.status_code, 429)
                self.assertIn("Gemini", rejected.json()["detail"])
                self.assertIn("Claude", rejected.json()["detail"])
                self.assertEqual(rejected.headers["Retry-After"], "3")
                other = self.client.post("/api/floorplans", json={**image, "provider": "claude"})
                self.assertEqual(other.status_code, 200)
                for payload in ({"layout": {}}, {"extraction_id": "a" * 32}):
                    self.assertEqual(self.client.post("/api/floorplans", json=payload).status_code, 200)
            finally:
                release.set()
                self.assertEqual(task.result(timeout=2).status_code, 200)
        self.assertFalse(self.client.get("/api/floorplans").json()["gemini"]["busy"])

    def test_error_releases_slot_for_the_next_image(self):
        image = {"filename": "test.png", "image_base64": "image", "provider": "gemini"}
        with patch("app.api.import_floorplan", side_effect=ProviderError("Image extraction exceeded the time limit")):
            response = self.client.post("/api/floorplans", json=image)
        self.assertEqual(response.status_code, 422)
        self.assertFalse(self.client.get("/api/floorplans").json()["gemini"]["busy"])
        with patch("app.api.import_floorplan", return_value={"ok": True}):
            self.assertEqual(self.client.post("/api/floorplans", json=image).status_code, 200)

    def test_omitted_provider_uses_claude_and_explicit_gemini_is_retained(self):
        image = {"filename": "test.png", "image_base64": "test-only-image"}
        with patch("app.api.import_floorplan", side_effect=lambda payload: {"provider": payload.provider}):
            response = self.client.post("/api/floorplans", json=image)
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.json()["provider"], "claude")
            self.assertFalse(api.import_status()["claude"]["busy"])
            response = self.client.post("/api/floorplans", json={**image, "provider": "gemini"})
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.json()["provider"], "gemini")
            self.assertFalse(api.import_status()["gemini"]["busy"])

    def test_invalid_upload_does_not_take_a_slot(self):
        response = self.client.post("/api/floorplans", json={"provider": "gemini"})
        self.assertEqual(response.status_code, 422)
        self.assertFalse(self.client.get("/api/floorplans").json()["gemini"]["busy"])
