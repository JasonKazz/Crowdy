"""Durable account workspaces, with optimistic concurrency in every worker.

Each private manifest stores its workspace and source metadata together. Azure
ETags serialize manifest changes; local development uses process-safe flock and
atomic replacement. Blob names never contain user-supplied owner identifiers.
"""

import base64
import binascii
import copy
import fcntl
import hashlib
import io
import json
import os
import re
import tempfile
import time
import uuid
import warnings
from pathlib import Path

from PIL import Image, UnidentifiedImageError

from app.services import azure_storage
from app.services.azure_storage import StorageConflict, StorageUnavailable

IDENTIFIER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")
MAX_IMAGE_BYTES = 10 * 1024 * 1024
MAX_IMAGE_PIXELS = 30_000_000
MAX_SOURCES = 100


class WorkspaceDeleted(FileNotFoundError):
    """A durable tombstone lets browser migrations discard stale legacy copies."""


class SourceDeleted(FileNotFoundError):
    """A deleted source ID cannot be resurrected by a stale browser migration."""


def validate_id(identifier: str) -> str:
    if not IDENTIFIER.fullmatch(identifier):
        raise ValueError("Invalid workspace or source ID")
    return identifier


def _owner_prefix(owner: str) -> str:
    return "crowdy/accounts/" + hashlib.sha256(owner.encode()).hexdigest() + "/"


def _manifest_path(owner: str, identifier: str) -> str:
    return _owner_prefix(owner) + "workspaces/" + validate_id(identifier) + ".json"


def _local_root() -> Path:
    return Path(os.environ.get("CROWDY_STORAGE_DIR") or "data") / "persistent"


def _local_path(name: str) -> Path:
    root = _local_root().resolve()
    path = (root / name).resolve()
    if not path.is_relative_to(root):
        raise ValueError("Invalid storage path")
    return path


def _etag(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def _read(name: str) -> tuple[bytes, str]:
    if azure_storage.azure_configured():
        return azure_storage.read_blob(name)
    try:
        raw = _local_path(name).read_bytes()
        return raw, _etag(raw)
    except FileNotFoundError:
        raise
    except OSError:
        raise StorageUnavailable("Workspace storage is unavailable") from None


def _write(name: str, raw: bytes, content_type="application/json", *, expected_etag=None, create=False) -> None:
    if azure_storage.azure_configured():
        azure_storage.write_blob(name, raw, content_type, expected_etag=expected_etag, create=create)
        return
    temporary = None
    try:
        path = _local_path(name)
        path.parent.mkdir(parents=True, exist_ok=True)
        # Lock a stable sibling, because replacing the target changes its inode.
        with path.with_suffix(path.suffix + ".lock").open("a+b") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            if create and path.exists():
                raise StorageConflict("Workspace or source already exists")
            if expected_etag is not None:
                try:
                    current = _etag(path.read_bytes())
                except FileNotFoundError:
                    raise StorageConflict("Stored data changed; reload and try again") from None
                if current != expected_etag:
                    raise StorageConflict("Stored data changed; reload and try again")
            with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as output:
                temporary = output.name
                output.write(raw)
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, path)
            temporary = None
    except StorageConflict:
        raise
    except OSError:
        raise StorageUnavailable("Workspace storage is unavailable") from None
    finally:
        if temporary:
            Path(temporary).unlink(missing_ok=True)


def _delete(name: str) -> None:
    if azure_storage.azure_configured():
        azure_storage.delete_blob(name)
    else:
        try:
            _local_path(name).unlink(missing_ok=True)
        except OSError:
            raise StorageUnavailable("Workspace storage is unavailable") from None


def _list(prefix: str) -> list[str]:
    if azure_storage.azure_configured():
        return azure_storage.list_blobs(prefix)
    try:
        directory = _local_path(prefix)
        return [prefix + path.name for path in directory.glob("*.json")]
    except OSError:
        raise StorageUnavailable("Workspace storage is unavailable") from None


def _load(owner: str, identifier: str, *, allow_deleted=False) -> tuple[dict, str]:
    raw, etag = _read(_manifest_path(owner, identifier))
    try:
        document = json.loads(raw)
        if document["record"]["ownerId"] != owner or document["record"]["id"] != identifier:
            raise ValueError("Invalid stored owner")
        if document.get("deleted") and not allow_deleted:
            raise WorkspaceDeleted("Workspace was deleted")
        return document, etag
    except (ValueError, KeyError, TypeError):
        raise StorageUnavailable("Saved workspace data could not be read") from None


def _save(owner: str, document: dict, **condition) -> None:
    raw = json.dumps(document, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode()
    _write(_manifest_path(owner, document["record"]["id"]), raw, **condition)


def _timestamp(previous=0) -> int:
    return max(time.time_ns() // 1_000_000, previous + 1)


def list_workspaces(owner: str) -> list[dict]:
    prefix = _owner_prefix(owner) + "workspaces/"
    records = []
    for path in _list(prefix):
        if not path.endswith(".json"):
            continue
        identifier = path.removeprefix(prefix).removesuffix(".json")
        try:
            document, _ = _load(owner, identifier)
        except FileNotFoundError:
            continue
        records.append(document["record"])
    return sorted(records, key=lambda record: record["updatedAt"], reverse=True)


def get_workspace(owner: str, identifier: str) -> dict:
    return _load(owner, identifier)[0]["record"]


def create_workspace(owner: str, name: str, plan: dict, scenario: dict, identifier=None) -> dict:
    identifier = validate_id(identifier or "ws-" + uuid.uuid4().hex)
    now = _timestamp()
    record = {"id": identifier, "ownerId": owner, "name": name.strip(), "plan": copy.deepcopy(plan),
              "scenario": copy.deepcopy(scenario), "createdAt": now, "updatedAt": now}
    _save(owner, {"record": record, "sources": {}, "pendingDeletes": {}, "deletedSourceIds": {}}, create=True)
    return record


def update_workspace(owner: str, identifier: str, name: str | None, plan: dict, scenario: dict,
                     expected_updated_at: int | None) -> dict:
    baseline = expected_updated_at
    for attempt in range(4):
        document, etag = _load(owner, identifier)
        record = document["record"]
        if baseline is None:
            baseline = record["updatedAt"]
        if baseline != record["updatedAt"]:
            raise StorageConflict("This workspace changed in another tab. Reload before saving.")
        record.update(plan=copy.deepcopy(plan), scenario=copy.deepcopy(scenario), updatedAt=_timestamp(record["updatedAt"]))
        if name is not None:
            record["name"] = name.strip()
        try:
            _save(owner, document, expected_etag=etag)
            return record
        except StorageConflict:
            # Source metadata can change the ETag without changing the editor
            # version. Retry that case while rejecting concurrent editor saves.
            if attempt == 3:
                raise


def delete_workspace(owner: str, identifier: str) -> None:
    document, etag = _load(owner, identifier, allow_deleted=True)
    # A tombstone prevents a concurrent source upload or migration resurrecting it.
    document["deleted"] = True
    _save(owner, document, expected_etag=etag)
    blobs = {source["blob"] for source in document["sources"].values()}
    blobs.update(source["blob"] for source in document.get("pendingDeletes", {}).values())
    for blob in blobs:
        _delete(blob)
    # Keep only a minimal tombstone after deleting private workspace contents.
    tombstone = {"record": {"id": identifier, "ownerId": owner}, "deleted": True, "sources": {}}
    raw, current_etag = _read(_manifest_path(owner, identifier))
    _save(owner, tombstone, expected_etag=current_etag)


def list_sources(owner: str, identifier: str) -> list[dict]:
    document, _ = _load(owner, identifier)
    return [entry["metadata"] for entry in document["sources"].values()]


def decode_source(encoded: str) -> tuple[bytes, str, int, int]:
    try:
        raw = base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error):
        raise ValueError("Choose a valid base64 PNG, JPEG, or WebP image") from None
    if not raw or len(raw) > MAX_IMAGE_BYTES:
        raise ValueError("Choose a PNG, JPEG, or WebP image up to 10 MiB")
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(raw)) as image:
                if image.format not in {"PNG", "JPEG", "WEBP"}:
                    raise ValueError("Choose a PNG, JPEG, or WebP image")
                width, height = image.size
                if width * height > MAX_IMAGE_PIXELS:
                    raise ValueError("Resize the image below 30 million pixels")
                media_type = {"PNG": "image/png", "JPEG": "image/jpeg", "WEBP": "image/webp"}[image.format]
                image.verify()
            # Verification checks structure; decode pixels to reject truncated images.
            with Image.open(io.BytesIO(raw)) as image:
                image.load()
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError, Image.DecompressionBombWarning):
        raise ValueError("Could not decode this image. Choose a readable PNG, JPEG, or WebP.") from None
    return raw, media_type, width, height


def add_source(owner: str, identifier: str, source_id: str, name: str, encoded: str) -> dict:
    validate_id(source_id)
    document, _ = _load(owner, identifier)
    if source_id in document.get("deletedSourceIds", {}):
        raise SourceDeleted("This source was deleted")
    if source_id in document["sources"]:
        raise StorageConflict("This source already exists")
    if len(document["sources"]) >= MAX_SOURCES:
        raise ValueError("A workspace can store up to 100 source images")
    raw, media_type, width, height = decode_source(encoded)
    metadata = {"id": source_id, "name": name.strip(), "type": media_type, "size": len(raw),
                "width": width, "height": height, "addedAt": _timestamp()}
    # Each attempt gets immutable bytes; a losing request cannot replace a winner.
    blob = _owner_prefix(owner) + "sources/" + validate_id(identifier) + "/" + uuid.uuid4().hex
    _write(blob, raw, media_type, create=True)
    try:
        for attempt in range(4):
            document, etag = _load(owner, identifier)
            if source_id in document.get("deletedSourceIds", {}):
                raise SourceDeleted("This source was deleted")
            if source_id in document["sources"]:
                raise StorageConflict("This source already exists")
            if len(document["sources"]) >= MAX_SOURCES:
                raise ValueError("A workspace can store up to 100 source images")
            document["sources"][source_id] = {"metadata": metadata, "blob": blob}
            try:
                _save(owner, document, expected_etag=etag)
                return metadata
            except StorageConflict:
                if attempt == 3:
                    raise
    except Exception as error:
        # A failed HTTP acknowledgement does not prove the Azure write failed.
        # Read authoritative state before deleting bytes; SDK retries can also
        # report an ETag conflict after their first attempt actually committed.
        try:
            document, _ = _load(owner, identifier, allow_deleted=True)
        except FileNotFoundError:
            referenced = False
        except Exception:
            # Preserve the upload when storage cannot establish its ownership.
            # Keeping unreferenced bytes is safer than breaking committed data.
            raise error
        else:
            active = document.get("sources", {}).get(source_id)
            if active and active["blob"] == blob and not document.get("deleted"):
                return active["metadata"]
            references = list(document.get("sources", {}).values()) + list(document.get("pendingDeletes", {}).values())
            referenced = any(source["blob"] == blob for source in references)
        if not referenced:
            _delete(blob)
        raise error


def get_source_image(owner: str, identifier: str, source_id: str) -> tuple[bytes, str]:
    validate_id(source_id)
    document, _ = _load(owner, identifier)
    source = document["sources"].get(source_id)
    if source is None:
        if source_id in document.get("deletedSourceIds", {}):
            raise SourceDeleted("This source was deleted")
        raise FileNotFoundError("Source not found")
    return _read(source["blob"])[0], source["metadata"]["type"]


def delete_source(owner: str, identifier: str, source_id: str) -> None:
    validate_id(source_id)
    for attempt in range(4):
        document, etag = _load(owner, identifier)
        source = document["sources"].pop(source_id, None)
        if source is None:
            if source_id in document.get("pendingDeletes", {}):
                break
            if source_id in document.get("deletedSourceIds", {}):
                return
            raise FileNotFoundError("Source not found")
        document.setdefault("pendingDeletes", {})[source_id] = {"blob": source["blob"]}
        document.setdefault("deletedSourceIds", {})[source_id] = _timestamp()
        try:
            _save(owner, document, expected_etag=etag)
            break
        except StorageConflict:
            if attempt == 3:
                raise
    _finish_source_delete(owner, identifier, source_id)


def _finish_source_delete(owner: str, identifier: str, source_id: str) -> None:
    for attempt in range(4):
        # Workspace deletion can run concurrently and also owns these queued
        # references. Either operation may finish the same idempotent blob delete.
        document, etag = _load(owner, identifier, allow_deleted=True)
        pending = document.get("pendingDeletes", {})
        source = pending.get(source_id)
        if source is None:
            return
        _delete(source["blob"])
        pending.pop(source_id)
        try:
            _save(owner, document, expected_etag=etag)
            return
        except StorageConflict:
            if attempt == 3:
                raise
