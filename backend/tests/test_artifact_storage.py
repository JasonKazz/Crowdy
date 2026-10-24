"""Durable imports survive another worker with an empty local filesystem."""

import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from fastapi.testclient import TestClient

from app import api
from app.schemas.extraction import ExtractedDrawing
from app.services.floorplans.images import finish_calibration, load_image
from app.services.floorplans.storage import (
    ArtifactStorageError, editor_storage_root, read_artifact, write_artifact,
)
from test_images import drawing_fixture, upload_fixture


class MemoryBlob:
    def __init__(self):
        self.objects = {}
        self.reads = []

    def put_blob(self, pathname, body, *, access, add_random_suffix, allow_overwrite, content_type):
        if access != "private" or add_random_suffix or not allow_overwrite:
            raise AssertionError("Artifacts must use stable private paths")
        self.objects[pathname] = bytes(body)
        return SimpleNamespace(pathname=pathname)

    def get_blob(self, pathname, *, access):
        if access != "private":
            raise AssertionError("Artifact reads must be private")
        self.reads.append(pathname)
        if pathname not in self.objects:
            raise FileNotFoundError(pathname)
        return SimpleNamespace(body=self.objects[pathname])


class ArtifactStorageTests(unittest.TestCase):
    def test_filesystem_mode_retains_existing_paths_and_needs_no_sdk(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"BLOB_READ_WRITE_TOKEN": ""}), \
                patch("app.services.floorplans.storage._blob_client", side_effect=AssertionError("Local mode must not use Blob")):
            root = Path(directory)
            path = root / "extractions" / ("a" * 32) / "context.json"
            write_artifact(root, path, b'{"local": true}')
            self.assertEqual(path.read_bytes(), b'{"local": true}')
            self.assertEqual(read_artifact(root, path), path.read_bytes())

    def test_serverless_root_is_temporary_unless_explicitly_configured(self):
        with patch.dict(os.environ, {"VERCEL": "1", "CROWDY_STORAGE_DIR": ""}):
            self.assertEqual(editor_storage_root(), Path("/tmp/crowdy/editor"))
        with patch.dict(os.environ, {"VERCEL": "1", "CROWDY_STORAGE_DIR": "/custom/artifacts"}):
            self.assertEqual(editor_storage_root(), Path("/custom/artifacts/editor"))

    def test_artifact_paths_cannot_escape_the_root(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "editor"
            for operation in (lambda path: write_artifact(root, path, b"data"), lambda path: read_artifact(root, path)):
                with self.assertRaisesRegex(ValueError, "Invalid artifact path"):
                    operation(root / ".." / "outside.json")

    def test_blob_errors_do_not_expose_upstream_credentials(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"BLOB_READ_WRITE_TOKEN": "test-only"}), \
                patch("app.services.floorplans.storage._blob_client", side_effect=RuntimeError("secret-from-upstream")):
            root = Path(directory)
            for operation in (lambda: write_artifact(root, root / "artifact.json", b"data"),
                              lambda: read_artifact(root, root / "artifact.json")):
                with self.assertRaisesRegex(ArtifactStorageError, "storage is unavailable") as caught:
                    operation()
                self.assertNotIn("secret-from-upstream", str(caught.exception))


class DurableImportTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.first_worker = Path(self.directory.name) / "worker-one"
        self.other_worker = Path(self.directory.name) / "worker-two"
        self.environment = patch.dict(os.environ, {
            "BLOB_READ_WRITE_TOKEN": "test-only-never-a-real-key",
            "CROWDY_STORAGE_DIR": str(self.first_worker),
            "CROWDY_BACKEND_TOKEN": "backend-test-token",
        })
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.blob = MemoryBlob()
        fake = patch("app.services.floorplans.storage._blob_client", return_value=self.blob)
        fake.start()
        self.addCleanup(fake.stop)
        self.client = TestClient(api.app)
        self.addCleanup(self.client.close)
        self.headers = {"Authorization": "Bearer backend-test-token"}

    def test_image_and_pending_calibration_survive_empty_second_worker(self):
        with patch("app.services.floorplans.images.extract_drawing", return_value=(
                ExtractedDrawing.model_validate(drawing_fixture()), "test-model")) as provider:
            response = self.client.post("/api/floorplans", json={
                **upload_fixture().model_dump(), "provider": "claude"}, headers=self.headers)
        self.assertEqual(response.status_code, 200, response.text)
        pending = response.json()
        self.assertTrue(pending["needs_scale"])
        provider.assert_called_once()
        prefix = f'crowdy/editor/extractions/{pending["extraction_id"]}'
        for name in ("observations.json", "context.json"):
            self.assertIn(f"{prefix}/{name}", self.blob.objects)

        # No request may rely on the previous worker's scratch space.
        self.first_worker.mkdir(parents=True, exist_ok=True)
        (self.first_worker / "unrelated-cache").write_bytes(b"old worker")
        shutil.rmtree(self.first_worker)
        os.environ["CROWDY_STORAGE_DIR"] = str(self.other_worker)
        image_path = f'/api/floorplans/images/{pending["image_id"]}'
        with TestClient(api.app) as second:
            self.assertEqual(second.get(image_path).status_code, 401)
            image = second.get(image_path, headers=self.headers)
            self.assertEqual(image.status_code, 200)
            self.assertTrue(image.content.startswith(b"\x89PNG"))
            source, raw = load_image(self.other_worker / "editor", pending["image_id"])
            self.assertEqual(source.id, pending["image_id"])
            self.assertEqual(raw, image.content)
            with patch("app.services.floorplans.images.extract_drawing", side_effect=AssertionError("Do not repeat the model call")):
                calibrated = second.post("/api/floorplans", json={
                    "extraction_id": pending["extraction_id"],
                    "manual_scale": {"kind": "dimension", "label": "18 m", "start": {"x": 50, "y": 50},
                        "end": {"x": 950, "y": 50}, "distance": 18, "unit": "m"},
                }, headers=self.headers)
        self.assertEqual(calibrated.status_code, 200, calibrated.text)
        plan = calibrated.json()["plan"]
        self.assertTrue(plan["native"]["layout"]["source_image"]["scale_confirmed"])
        candidate = json.loads(self.blob.objects[f"{prefix}/candidate.json"])
        self.assertEqual(candidate["layout"], plan["native"]["layout"])
        self.assertFalse(self.other_worker.exists(), "Blob mode must not depend on a writable project directory")

    def test_missing_artifacts_and_malformed_ids_fail_without_local_fallback(self):
        self.assertEqual(self.client.get("/api/floorplans/images/not-an-id", headers=self.headers).status_code, 400)
        self.assertEqual(self.blob.reads, [])
        self.assertEqual(self.client.get("/api/floorplans/images/" + "a" * 32, headers=self.headers).status_code, 404)
        with self.assertRaisesRegex(ValueError, "Invalid extraction ID"):
            finish_calibration("../escape", None, self.other_worker)
        with self.assertRaisesRegex(ValueError, "saved extraction was not found"):
            finish_calibration("b" * 32, None, self.other_worker)

