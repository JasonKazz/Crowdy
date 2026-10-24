"""Local artifacts by default; private Blob is authoritative when configured."""

import os
from pathlib import Path


class ArtifactStorageError(OSError):
    """Storage failures with no credentials or upstream response data."""


def editor_storage_root() -> Path:
    default = "/tmp/crowdy" if os.environ.get("VERCEL") else "data"
    return Path(os.environ.get("CROWDY_STORAGE_DIR") or default) / "editor"


def _blob_client():
    # Optional for existing local installations that only use filesystem storage.
    try:
        from vercel.blob import sync as blob
    except ImportError:
        raise ArtifactStorageError("Private artifact storage is not installed") from None
    return blob


def _blob_path(root: Path, path: Path) -> str:
    try:
        relative = path.resolve().relative_to(root.resolve())
    except ValueError:
        raise ValueError("Invalid artifact path") from None
    if not relative.parts:
        raise ValueError("Invalid artifact path")
    return "crowdy/editor/" + relative.as_posix()


def write_artifact(root: Path, path: Path, data: bytes) -> None:
    pathname = _blob_path(root, path)
    if os.environ.get("BLOB_READ_WRITE_TOKEN", "").strip():
        try:
            _blob_client().put_blob(pathname, data, access="private",
                add_random_suffix=False, allow_overwrite=True,
                content_type="image/png" if path.suffix == ".png" else "application/json")
        except ArtifactStorageError:
            raise
        except Exception:
            raise ArtifactStorageError("Private artifact storage is unavailable") from None
    else:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)


def read_artifact(root: Path, path: Path) -> bytes:
    pathname = _blob_path(root, path)
    if os.environ.get("BLOB_READ_WRITE_TOKEN", "").strip():
        try:
            return _blob_client().get_blob(pathname, access="private").body
        except FileNotFoundError:
            raise FileNotFoundError("Artifact not found") from None
        except ArtifactStorageError:
            raise
        except Exception:
            raise ArtifactStorageError("Private artifact storage is unavailable") from None
    return path.read_bytes()
