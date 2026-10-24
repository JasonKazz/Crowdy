"""Exercise the local editor over HTTP, including a real saved simulation."""

import http.client
import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from app.schemas.layout import Layout
from app.simulation.editor import EditorHandler, EditorServer, MAX_BODY
from app.schemas.extraction import ExtractedDrawing
from test_images import drawing_fixture, gemini_fixture, upload_fixture


EXAMPLES = Path(__file__).resolve().parents[2] / "examples"


class EditorAPITests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.layout = Layout.model_validate_json(
            (EXAMPLES / "editable_office.json").read_text()
        )
        self.server = EditorServer(
            ("127.0.0.1", 0), self.layout, Path(self.directory.name)
        )
        self.port = self.server.server_address[1]
        self.quiet = patch.object(EditorHandler, "log_message")
        self.quiet.start()
        self.thread = threading.Thread(
            target=self.server.serve_forever,
            kwargs={"poll_interval": 0.01}, daemon=True,
        )
        self.thread.start()
        self.addCleanup(self.stop_server)

    def stop_server(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)
        self.quiet.stop()

    def request(self, method, path, document=None, *, raw=None, headers=None):
        headers = dict(headers or {})
        body = raw if raw is not None else (
            json.dumps(document) if document is not None else None
        )
        if method == "POST":
            headers.setdefault("Content-Type", "application/json")
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        try:
            connection.request(method, path, body=body, headers=headers)
            response = connection.getresponse()
            raw_content = response.read()
            mime = response.getheader("Content-Type", "")
            content = raw_content if mime == "image/png" else raw_content.decode()
            value = json.loads(content) if "application/json" in mime else content
            return response.status, value
        finally:
            connection.close()

    def test_serves_editor_assets_and_initial_document(self):
        status, page = self.request("GET", "/")
        self.assertEqual(status, 200)
        self.assertIn("Run simulation", page)
        status, script = self.request("GET", "/editor-geometry.js")
        self.assertEqual(status, 200)
        self.assertIn("doorOffset", script)
        status, script = self.request("GET", "/editor-population.js")
        self.assertEqual(status, 200)
        self.assertIn("withGeneratedPopulation", script)
        status, document = self.request("GET", "/api/layout")
        self.assertEqual(status, 200)
        self.assertEqual(document, self.layout.model_dump(mode="json"))

    def test_imports_legacy_scenario_without_rewriting_startup_document(self):
        legacy = json.loads((EXAMPLES / "simple_room.json").read_text())
        status, document = self.request("POST", "/api/import", legacy)
        self.assertEqual(status, 200)
        self.assertEqual(document["schema_version"], 1)
        self.assertEqual(document["furniture"], legacy["obstacles"])
        self.assertEqual([{key: person[key] for key in ("id", "position")} for person in document["occupants"]], legacy["occupants"])
        self.assertTrue(all(person["desired_speed"] is None for person in document["occupants"]))
        self.assertEqual(self.server.layout, self.layout)

    def test_validates_moved_door_and_returns_population(self):
        document = self.layout.model_dump(mode="json")
        document["doors"][0]["offset"] = 6
        status, result = self.request("POST", "/api/validate", document)
        self.assertEqual(status, 200)
        self.assertEqual(len(result["occupants"]), 40)
        self.assertAlmostEqual(result["area_m2"], 167.24)

    def test_invalid_edits_return_readable_errors_and_save_nothing(self):
        document = self.layout.model_dump(mode="json")
        document["doors"][0]["wall_id"] = "missing"
        for path in ("/api/validate", "/api/simulate"):
            status, result = self.request("POST", path, document)
            self.assertEqual(status, 422)
            self.assertIn("unknown wall", result["error"])
        self.assertEqual(list(Path(self.directory.name).iterdir()), [])

    def test_run_returns_real_metrics_and_accessible_saved_snapshots(self):
        document = self.layout.model_dump(mode="json")
        document["doors"][0]["offset"] = 6
        status, result = self.request("POST", "/api/simulate", document)
        self.assertEqual(status, 200)
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["summary"]["evacuated_count"], 40)
        status, page = self.request("GET", result["playback_url"])
        self.assertEqual(status, 200)
        self.assertIn("simulation-data", page)
        for name in ("layout", "scenario", "result"):
            status, saved = self.request("GET", f"/runs/{result['run_id']}/{name}")
            self.assertEqual(status, 200)
            if name == "layout":
                self.assertEqual(saved["doors"][0]["offset"], 6)
        _, latest = self.request("GET", "/api/layout")
        self.assertEqual(latest["doors"][0]["offset"], 6)

    def test_rejects_second_run_while_simulation_is_active(self):
        with self.server.run_lock:
            status, result = self.request(
                "POST", "/api/simulate", self.layout.model_dump(mode="json")
            )
        self.assertEqual(status, 409)
        self.assertIn("already running", result["error"])

    def test_rejects_malformed_oversized_and_non_json_requests(self):
        for raw in ("not JSON", "[]"):
            self.assertEqual(self.request("POST", "/api/import", raw=raw)[0], 422)
        self.assertEqual(self.request(
            "POST", "/api/import", raw="{}",
            headers={"Content-Type": "text/plain"},
        )[0], 415)
        self.assertEqual(self.request(
            "POST", "/api/import", raw="{}",
            headers={"Content-Length": str(MAX_BODY + 1)},
        )[0], 413)

    def test_local_server_rejects_foreign_origin_and_host(self):
        document = self.layout.model_dump(mode="json")
        self.assertEqual(self.request(
            "POST", "/api/validate", document,
            headers={"Origin": "https://unrelated.example"},
        )[0], 403)
        self.assertEqual(self.request(
            "GET", "/api/layout", headers={"Host": "unrelated.example"},
        )[0], 403)

    def test_unknown_endpoints_and_runs_return_not_found(self):
        self.assertEqual(self.request("GET", "/runs/missing/layout")[0], 404)
        self.assertEqual(self.request("POST", "/missing", {})[0], 404)

    def test_image_upload_comparison_edit_and_simulation_share_one_backend(self):
        status, uploaded = self.request("POST", "/api/images", upload_fixture().model_dump())
        self.assertEqual(status, 200)
        source = uploaded["layout"]["source_image"]
        self.assertFalse(source["scale_confirmed"])
        status, image = self.request("GET", f"/images/{source['id']}")
        self.assertEqual(status, 200)
        self.assertTrue(image.startswith(b"\x89PNG"))
        def fake_provider(provider, *args):
            drawing = gemini_fixture() if provider == "gemini" else drawing_fixture()
            return ExtractedDrawing.model_validate(drawing), f"fake-{provider}"
        with patch("app.services.floorplans.images.extract_drawing", side_effect=fake_provider):
            status, extracted = self.request("POST", "/api/extract", {
                "image_id": source["id"], "provider": "both", "meters_per_pixel": .02,
                "scale_confirmed": True, "people_count": 12,
            })
        self.assertEqual(status, 200)
        self.assertEqual(len(extracted["results"]), 2)
        layout = extracted["results"][0]["layout"]
        layout["furniture"][0]["polygon"] = [[x + 1, y] for x, y in layout["furniture"][0]["polygon"]]
        self.assertEqual(self.request("POST", "/api/validate", layout)[0], 200)
        status, run = self.request("POST", "/api/simulate", layout)
        self.assertEqual(status, 200)
        self.assertEqual(run["status"], "completed")
        self.assertEqual(run["summary"]["evacuated_count"], 12)
        _, saved = self.request("GET", f"/runs/{run['run_id']}/layout")
        self.assertEqual(saved["source_image"]["id"], source["id"])
        self.assertEqual(saved["extraction"]["provider"], "gemini")

    def test_provider_status_does_not_expose_credentials(self):
        with patch.dict("os.environ", {"GEMINI_API_KEY": "fake-secret-value"}, clear=True):
            status, configuration = self.request("GET", "/api/providers")
        self.assertEqual(status, 200)
        self.assertTrue(configuration["gemini"]["configured"])
        self.assertFalse(configuration["claude"]["configured"])
        self.assertNotIn("fake-secret-value", json.dumps(configuration))


if __name__ == "__main__":
    unittest.main()
