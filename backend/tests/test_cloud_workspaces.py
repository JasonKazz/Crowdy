"""Durable workspace contracts on local disks and realistic Azure SDK doubles."""

import base64
import copy
import io
import json
import os
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from azure.core import MatchConditions
from azure.core.exceptions import ResourceExistsError, ResourceModifiedError, ResourceNotFoundError
from fastapi.testclient import TestClient
from PIL import Image

from app import api
from app.services import azure_storage, workspaces
from app.services.floorplans.storage import read_artifact, write_artifact
from app.simulation.workspace_layout import native_to_editor

SAMPLE = json.loads((Path(__file__).parent / "fixtures/editor-sample.json").read_text())


def payload(identifier="ws-regression"):
    return {"id": identifier, "name": "Saved studio", **copy.deepcopy(SAMPLE)}


def encoded_image(format="PNG", mode="RGB", size=(32, 18)):
    data = io.BytesIO()
    Image.new(mode, size).save(data, format)
    return data.getvalue()


class MemoryContainer:
    def __init__(self):
        self.objects = {}
        self.lock = threading.Lock()
        self.version = 0

    def get_blob_client(self, name):
        container = self

        class Blob:
            def upload_blob(self, data, *, overwrite, content_settings, **condition):
                with container.lock:
                    current = container.objects.get(name)
                    if not overwrite and current:
                        raise ResourceExistsError("Already exists")
                    if condition:
                        if condition["match_condition"] is not MatchConditions.IfNotModified:
                            raise AssertionError("Updates must use an ETag condition")
                        if not current or current[1] != condition["etag"]:
                            raise ResourceModifiedError("ETag changed")
                    container.version += 1
                    etag = f'"version-{container.version}"'
                    container.objects[name] = (bytes(data), etag, content_settings.content_type)
                    return {"etag": etag}

            def download_blob(self):
                with container.lock:
                    if name not in container.objects:
                        raise ResourceNotFoundError("Missing blob")
                    raw, etag, _ = container.objects[name]
                return SimpleNamespace(readall=lambda: raw, properties=SimpleNamespace(etag=etag))

            def delete_blob(self):
                with container.lock:
                    if container.objects.pop(name, None) is None:
                        raise ResourceNotFoundError("Missing blob")

        return Blob()

    def list_blobs(self, *, name_starts_with):
        with self.lock:
            return [SimpleNamespace(name=name) for name in self.objects if name.startswith(name_starts_with)]


class WorkspaceContract:
    cloud = False

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        environment = patch.dict(os.environ, {
            "CROWDY_STORAGE_DIR": str(Path(self.directory.name) / "worker-one"),
            "CROWDY_BACKEND_TOKEN": "test-backend-token",
            "AZURE_STORAGE_ACCOUNT_URL": "https://test.blob.core.windows.net" if self.cloud else "",
            "AZURE_STORAGE_CONNECTION_STRING": "", "BLOB_READ_WRITE_TOKEN": "",
        })
        environment.start()
        self.addCleanup(environment.stop)
        self.blobs = MemoryContainer()
        azure = patch("app.services.azure_storage.container_client", return_value=self.blobs)
        azure.start()
        self.addCleanup(azure.stop)
        self.client = TestClient(api.app)
        self.addCleanup(self.client.close)
        self.alice = {"Authorization": "Bearer test-backend-token", "X-Crowdy-Owner": "auth0|alice/private"}
        self.bob = {**self.alice, "X-Crowdy-Owner": "auth0|bob"}
        self.url = "/api/workspaces/ws-regression"

    def create(self, value=None):
        response = self.client.post("/api/workspaces", headers=self.alice, json=value or payload())
        self.assertEqual(response.status_code, 201, response.text)
        return response.json()

    def upload(self, source_id="source-1", raw=None, name="venue.png"):
        raw = encoded_image() if raw is None else raw
        return self.client.post(self.url + "/sources", headers=self.alice, json={
            "id": source_id, "name": name, "image_base64": base64.b64encode(raw).decode()})

    def test_authentication_fails_closed_even_with_an_owner_header(self):
        for token in ("", "   "):
            os.environ["CROWDY_BACKEND_TOKEN"] = token
            response = self.client.get("/api/workspaces", headers=self.alice)
            self.assertEqual(response.status_code, 503)
        os.environ["CROWDY_BACKEND_TOKEN"] = "test-backend-token"
        for headers in ({}, {"X-Crowdy-Owner": "forged"}, {**self.alice, "Authorization": "Bearer wrong"},
                        {"Authorization": self.alice["Authorization"]}, {**self.alice, "X-Crowdy-Owner": " bad "}):
            self.assertEqual(self.client.get("/api/workspaces", headers=headers).status_code, 401)

    def test_workspace_survives_a_new_worker_and_preserves_editor_view(self):
        value = payload()
        layout = json.loads((Path(__file__).resolve().parents[2] / "examples/narrow_table_regression.json").read_text())
        value["plan"] = native_to_editor(layout)
        value["plan"]["native"]["image"] = {"id": "a" * 32, "x": 21, "y": 50, "width": 300, "height": 250}
        value["plan"]["native"]["issues"] = ["Doorway draft"]
        value["scenario"].update(behaviorMode="behavioral", bodyWidth=.6, blockedExitIds=[], seed=14)
        original = self.create(value)
        self.assertEqual(original["plan"], value["plan"])
        self.assertEqual(original["scenario"], value["scenario"])
        if self.cloud:
            os.environ["CROWDY_STORAGE_DIR"] = str(Path(self.directory.name) / "empty-worker")
            self.assertFalse(Path(self.directory.name, "worker-one").exists())
        with TestClient(api.app) as another_worker:
            restored = another_worker.get(self.url, headers=self.alice)
        self.assertEqual(restored.json(), original)
        self.assertEqual(restored.headers["cache-control"], "private, no-store")
        self.assertEqual(self.client.get("/api/workspaces", headers=self.alice).json(), {"workspaces": [original]})
        if self.cloud:
            self.assertTrue(all("auth0" not in name and "alice" not in name for name in self.blobs.objects))

    def test_room_population_settings_survive_create_update_and_worker_reload(self):
        value = payload()
        layout = json.loads((Path(__file__).resolve().parents[2] / "examples/room_aware_office.json").read_text())
        value["plan"] = native_to_editor(layout)
        value["scenario"].update(
            distribution="normal", occupancy=40, bodyWidth=.6, behaviorMode="behavioral", seed=14,
            population={"buildingType": "office", "activity": "workday", "roomCounts": {"workspace": 24},
                        "roomTypes": {"lunch-room": "cafeteria"}},
        )
        original = self.create(value)
        self.assertEqual(original["plan"], value["plan"])
        self.assertEqual(original["scenario"], value["scenario"])

        update = {key: copy.deepcopy(value[key]) for key in ("plan", "scenario")}
        update["expectedUpdatedAt"] = original["updatedAt"]
        update["scenario"]["distribution"] = "rooms"
        update["scenario"]["population"].update(activity="lunch", roomCounts={"lunch-room": 13})
        response = self.client.put(self.url, headers=self.alice, json=update)
        self.assertEqual(response.status_code, 200, response.text)
        latest = response.json()
        self.assertEqual(latest["scenario"], update["scenario"])
        self.assertEqual(latest["plan"], value["plan"])
        with TestClient(api.app) as another_worker:
            self.assertEqual(another_worker.get(self.url, headers=self.alice).json(), latest)

    def test_invalid_population_settings_cannot_replace_a_saved_workspace(self):
        original = self.create()
        for population in ([], None, {"activity": "invalid"}, {"roomCounts": {"workspace": -1}},
                           {"roomCounts": {"workspace": True}}, {"roomTypes": {"workspace": "invalid"}}):
            with self.subTest(population=population):
                update = {key: copy.deepcopy(original[key]) for key in ("plan", "scenario")}
                update["expectedUpdatedAt"] = original["updatedAt"]
                update["scenario"].update(distribution="rooms", population=population)
                response = self.client.put(self.url, headers=self.alice, json=update)
                self.assertEqual(response.status_code, 422, response.text)
                self.assertEqual(self.client.get(self.url, headers=self.alice).json(), original)

    def test_other_account_cannot_read_mutate_or_delete_anything(self):
        self.create()
        self.assertEqual(self.upload().status_code, 201)
        self.assertEqual(self.client.get("/api/workspaces", headers=self.bob).json(), {"workspaces": []})
        cases = [("get", self.url, {}), ("put", self.url, {"json": {k: v for k, v in payload().items() if k != "id"}}),
                 ("delete", self.url, {}), ("get", self.url + "/sources", {}),
                 ("get", self.url + "/sources/source-1/image", {}), ("delete", self.url + "/sources/source-1", {}),
                 ("post", self.url + "/sources", {"json": {"id": "source-2", "name": "x", "image_base64": "AAAA"}})]
        for method, url, options in cases:
            with self.subTest(method=method, url=url):
                self.assertEqual(getattr(self.client, method)(url, headers=self.bob, **options).status_code, 404)
        self.assertEqual(self.client.get(self.url, headers=self.alice).status_code, 200)
        # Different accounts can choose identical IDs without sharing objects.
        self.assertEqual(self.client.post("/api/workspaces", headers=self.bob, json=payload()).status_code, 201)

    def test_updates_require_current_version_and_keep_original_when_conflicted(self):
        original = self.create()
        data = {k: v for k, v in payload().items() if k not in {"id", "name"}}
        data["expectedUpdatedAt"] = original["updatedAt"]
        data["scenario"]["occupancy"] = 20
        response = self.client.put(self.url, headers=self.alice, json=data)
        self.assertEqual(response.status_code, 200, response.text)
        latest = response.json()
        self.assertGreater(latest["updatedAt"], original["updatedAt"])
        self.assertEqual(latest["createdAt"], original["createdAt"])
        self.assertEqual(latest["name"], original["name"])
        self.assertEqual(self.client.put(self.url, headers=self.alice, json=data).status_code, 409)
        self.assertEqual(self.client.get(self.url, headers=self.alice).json(), latest)

    def test_concurrent_editor_saves_do_not_overwrite_each_other(self):
        original = self.create()
        barrier = threading.Barrier(2)
        save = workspaces._save
        attempts = threading.local()

        def simultaneous(*args, **kwargs):
            if not getattr(attempts, "attempt", False):
                attempts.attempt = True
                barrier.wait(timeout=5)
            return save(*args, **kwargs)

        def update(count):
            try:
                workspaces.update_workspace(self.alice["X-Crowdy-Owner"], "ws-regression", None,
                                            SAMPLE["plan"], {**SAMPLE["scenario"], "occupancy": count}, original["updatedAt"])
                return 200
            except azure_storage.StorageConflict:
                return 409

        with patch("app.services.workspaces._save", side_effect=simultaneous), ThreadPoolExecutor(max_workers=2) as pool:
            self.assertEqual(sorted(pool.map(update, (20, 30))), [200, 409])

    def test_editor_save_retries_source_only_etag_changes_without_losing_sources(self):
        original = self.create()
        save = workspaces._save
        injected = False

        def upload_before_save(*args, **kwargs):
            nonlocal injected
            if not injected:
                injected = True
                workspaces.add_source(self.alice["X-Crowdy-Owner"], "ws-regression", "concurrent-source",
                                      "venue.png", base64.b64encode(encoded_image()).decode())
            return save(*args, **kwargs)

        data = {k: v for k, v in payload().items() if k != "id"}
        data["expectedUpdatedAt"] = original["updatedAt"]
        data["scenario"]["occupancy"] = 22
        with patch("app.services.workspaces._save", side_effect=upload_before_save):
            updated = self.client.put(self.url, headers=self.alice, json=data)
        self.assertEqual(updated.status_code, 200, updated.text)
        self.assertEqual(updated.json()["scenario"]["occupancy"], 22)
        sources = self.client.get(self.url + "/sources", headers=self.alice).json()["sources"]
        self.assertEqual([source["id"] for source in sources], ["concurrent-source"])

    def test_source_bytes_and_metadata_survive_worker_and_match_real_image_type(self):
        original = self.create()
        for source_id, image_format, mime in (("png", "PNG", "image/png"), ("jpg", "JPEG", "image/jpeg"), ("webp", "WEBP", "image/webp")):
            raw = encoded_image(image_format)
            response = self.upload(source_id, raw, "wrong-extension.gif")
            self.assertEqual(response.status_code, 201, response.text)
            metadata = response.json()
            self.assertEqual((metadata["type"], metadata["size"], metadata["width"], metadata["height"]), (mime, len(raw), 32, 18))
            if self.cloud:
                os.environ["CROWDY_STORAGE_DIR"] = str(Path(self.directory.name) / "empty-worker")
            image = self.client.get(self.url + f"/sources/{source_id}/image", headers=self.alice)
            self.assertEqual(image.content, raw)
            self.assertEqual(image.headers["content-type"], mime)
            self.assertEqual(image.headers["x-content-type-options"], "nosniff")
        self.assertEqual(len(self.client.get(self.url + "/sources", headers=self.alice).json()["sources"]), 3)
        self.assertEqual(self.client.get(self.url, headers=self.alice).json()["updatedAt"], original["updatedAt"])
        self.assertEqual(self.upload("png").status_code, 409)
        self.assertEqual(self.client.delete(self.url + "/sources/png", headers=self.alice).status_code, 204)
        self.assertEqual(self.client.get(self.url + "/sources/png/image", headers=self.alice).status_code, 410)
        self.assertEqual(self.upload("png").status_code, 410)
        self.assertEqual(self.client.delete(self.url + "/sources/png", headers=self.alice).status_code, 204)

    def test_upload_preserves_image_when_manifest_commit_acknowledgement_is_lost(self):
        self.create()
        save = workspaces._save
        for source_id, failure in (("lost-ack", azure_storage.StorageUnavailable), ("retry-after-commit", azure_storage.StorageConflict)):
            def committed_then_error(*args, **kwargs):
                save(*args, **kwargs)
                raise failure("Simulated lost write acknowledgement")

            with patch("app.services.workspaces._save", side_effect=committed_then_error):
                response = self.upload(source_id)
            self.assertEqual(response.status_code, 201, response.text)
            image = self.client.get(self.url + f"/sources/{source_id}/image", headers=self.alice)
            self.assertEqual(image.status_code, 200)
            self.assertEqual(image.content, encoded_image())

    def test_upload_keeps_bytes_when_commit_state_cannot_be_read(self):
        self.create()
        save, load = workspaces._save, workspaces._load
        failed = False

        def committed_then_unavailable(*args, **kwargs):
            nonlocal failed
            save(*args, **kwargs)
            failed = True
            raise azure_storage.StorageUnavailable("Simulated network outage")

        def readable_until_commit(*args, **kwargs):
            if failed:
                raise azure_storage.StorageUnavailable("Simulated network outage")
            return load(*args, **kwargs)

        with patch("app.services.workspaces._save", side_effect=committed_then_unavailable), \
                patch("app.services.workspaces._load", side_effect=readable_until_commit):
            response = self.upload("unknown-commit")
        self.assertEqual(response.status_code, 503)
        self.assertEqual(self.client.get(self.url + "/sources/unknown-commit/image", headers=self.alice).status_code, 200)

    def test_upload_cleans_confirmed_unreferenced_bytes_after_failed_manifest_write(self):
        self.create()
        with patch("app.services.workspaces._save", side_effect=azure_storage.StorageUnavailable("Simulated rejected write")):
            self.assertEqual(self.upload("failed-upload").status_code, 503)
        self.assertEqual(self.client.get(self.url + "/sources", headers=self.alice).json(), {"sources": []})
        prefix = workspaces._owner_prefix(self.alice["X-Crowdy-Owner"]) + "sources/"
        if self.cloud:
            self.assertFalse(any(name.startswith(prefix) for name in self.blobs.objects))
        else:
            self.assertFalse(any(path.is_file() and path.suffix != ".lock"
                                 for path in workspaces._local_path(prefix).rglob("*")))

    def test_failed_source_delete_retains_cleanup_reference_and_retry_finishes(self):
        self.create()
        self.assertEqual(self.upload().status_code, 201)
        with patch("app.services.workspaces._delete", side_effect=azure_storage.StorageUnavailable("Simulated delete outage")):
            response = self.client.delete(self.url + "/sources/source-1", headers=self.alice)
        self.assertEqual(response.status_code, 503)
        document, _ = workspaces._load(self.alice["X-Crowdy-Owner"], "ws-regression")
        pending_blob = document["pendingDeletes"]["source-1"]["blob"]
        self.assertEqual(workspaces._read(pending_blob)[0], encoded_image())
        self.assertEqual(self.client.get(self.url + "/sources/source-1/image", headers=self.alice).status_code, 410)
        self.assertEqual(self.client.delete(self.url + "/sources/source-1", headers=self.alice).status_code, 204)
        with self.assertRaises(FileNotFoundError):
            workspaces._read(pending_blob)
        self.assertEqual(self.upload().status_code, 410)

    def test_workspace_delete_includes_pending_source_deletions(self):
        self.create()
        self.assertEqual(self.upload().status_code, 201)
        document, _ = workspaces._load(self.alice["X-Crowdy-Owner"], "ws-regression")
        pending_blob = document["sources"]["source-1"]["blob"]
        with patch("app.services.workspaces._delete", side_effect=azure_storage.StorageUnavailable("Simulated delete outage")):
            self.assertEqual(self.client.delete(self.url + "/sources/source-1", headers=self.alice).status_code, 503)
        self.assertEqual(self.client.delete(self.url, headers=self.alice).status_code, 204)
        with self.assertRaises(FileNotFoundError):
            workspaces._read(pending_blob)

    def test_workspace_body_allows_two_mib_while_simulation_limit_stays_one_mib(self):
        value = payload()
        layout = json.loads((Path(__file__).resolve().parents[2] / "examples/narrow_table_regression.json").read_text())
        value["plan"] = native_to_editor(layout)
        value["plan"]["native"]["draftNote"] = "x" * (api.MAX_BODY_BYTES + 1)
        response = self.client.post("/api/workspaces", headers=self.alice, json=value)
        self.assertEqual(response.status_code, 201, response.text[:300])
        self.assertEqual(response.json()["plan"]["native"]["draftNote"], value["plan"]["native"]["draftNote"])
        value["plan"]["native"]["draftNote"] = "x" * api.MAX_WORKSPACE_BODY_BYTES
        response = self.client.post("/api/workspaces", headers=self.alice, json=value)
        self.assertEqual(response.status_code, 413)
        self.assertIn("2 MiB", response.json()["detail"])
        response = self.client.post("/api/simulations", headers=self.alice, content=b"x" * (api.MAX_BODY_BYTES + 1))
        self.assertEqual(response.status_code, 413)

    def test_invalid_uploads_and_geometry_are_rejected_before_persistence(self):
        self.create()
        invalid = (b"not an image", encoded_image("GIF"), encoded_image()[:24],
                   encoded_image(mode="1", size=(6000, 6000)), b"x" * (workspaces.MAX_IMAGE_BYTES + 1))
        for raw in invalid:
            with self.subTest(size=len(raw)):
                self.assertEqual(self.upload(raw=raw).status_code, 422)
        bad_base64 = {"id": "bad", "name": "invalid.png", "image_base64": "this-is-not-base64"}
        self.assertEqual(self.client.post(self.url + "/sources", headers=self.alice, json=bad_base64).status_code, 422)
        data = payload("../escape")
        self.assertEqual(self.client.post("/api/workspaces", headers=self.alice, json=data).status_code, 422)
        data = payload("ws-invalid")
        data["plan"]["area"] = -2
        self.assertEqual(self.client.post("/api/workspaces", headers=self.alice, json=data).status_code, 422)
        self.assertEqual(self.client.get(self.url + "/sources", headers=self.alice).json(), {"sources": []})

    def test_delete_removes_private_contents_and_prevents_stale_migration_resurrection(self):
        self.create()
        self.assertEqual(self.upload().status_code, 201)
        self.assertEqual(self.client.delete(self.url, headers=self.alice).status_code, 204)
        self.assertEqual(self.client.get(self.url, headers=self.alice).status_code, 410)
        self.assertEqual(self.client.get(self.url + "/sources/source-1/image", headers=self.alice).status_code, 410)
        self.assertEqual(self.client.get("/api/workspaces", headers=self.alice).json(), {"workspaces": []})
        self.assertEqual(self.client.post("/api/workspaces", headers=self.alice, json=payload()).status_code, 409)
        self.assertEqual(self.client.delete(self.url, headers=self.alice).status_code, 204)
        self.assertEqual(self.client.get(self.url, headers=self.bob).status_code, 404)
        if self.cloud:
            self.assertFalse(any("/sources/" in name for name in self.blobs.objects))
            tombstones = [json.loads(value[0]) for name, value in self.blobs.objects.items() if name.endswith(".json")]
            self.assertEqual(len(tombstones), 1)
            self.assertNotIn("plan", tombstones[0]["record"])


class FilesystemWorkspaceTests(WorkspaceContract, unittest.TestCase):
    pass


class AzureWorkspaceTests(WorkspaceContract, unittest.TestCase):
    cloud = True

    def test_azure_failure_never_falls_back_to_disk_or_leaks_credentials(self):
        with patch("app.services.azure_storage.container_client", side_effect=RuntimeError("private upstream credential")):
            response = self.client.post("/api/workspaces", headers=self.alice, json=payload())
            self.assertEqual(response.status_code, 503, response.text)
            self.assertNotIn("credential", response.text)
            self.assertFalse(Path(self.directory.name, "worker-one").exists())

    def test_existing_floorplan_artifacts_prefer_azure_and_survive_empty_local_root(self):
        root = Path(self.directory.name) / "first" / "editor"
        path = root / "images" / ("a" * 32) / "source.png"
        raw = encoded_image()
        with patch.dict(os.environ, {"BLOB_READ_WRITE_TOKEN": "ignored-vercel-token"}), \
                patch("app.services.floorplans.storage._blob_client", side_effect=AssertionError("Azure takes precedence")):
            write_artifact(root, path, raw)
            other_root = Path(self.directory.name) / "second" / "editor"
            self.assertEqual(read_artifact(other_root, other_root / path.relative_to(root)), raw)
        self.assertFalse(root.exists())
        with patch("app.services.azure_storage.container_client", side_effect=RuntimeError("private")):
            with self.assertRaises(azure_storage.StorageUnavailable):
                read_artifact(root, path)
