"""Private Azure blobs shared by imports and account-scoped workspaces.

An explicit Azure configuration is authoritative. Service failures never switch
to an ephemeral filesystem or another storage provider.
"""

import os
from functools import lru_cache


class StorageUnavailable(OSError):
    pass


class StorageConflict(Exception):
    pass


def azure_configured() -> bool:
    return bool(os.environ.get("AZURE_STORAGE_ACCOUNT_URL", "").strip()
                or os.environ.get("AZURE_STORAGE_CONNECTION_STRING", "").strip())


@lru_cache(maxsize=4)
def _container_for(account_url: str, connection_string: str, container: str, client_id: str):
    from azure.identity import DefaultAzureCredential
    from azure.storage.blob import BlobServiceClient

    options = {"connection_timeout": 10, "read_timeout": 30, "retry_total": 2}
    if connection_string:
        service = BlobServiceClient.from_connection_string(connection_string, **options)
    else:
        credential = DefaultAzureCredential(managed_identity_client_id=client_id or None)
        service = BlobServiceClient(account_url=account_url, credential=credential, **options)
    return service.get_container_client(container)


def container_client():
    try:
        return _container_for(
            os.environ.get("AZURE_STORAGE_ACCOUNT_URL", "").strip(),
            os.environ.get("AZURE_STORAGE_CONNECTION_STRING", "").strip(),
            os.environ.get("AZURE_STORAGE_CONTAINER", "crowdy").strip(),
            os.environ.get("AZURE_CLIENT_ID", "").strip(),
        )
    except Exception:
        raise StorageUnavailable("Azure storage is unavailable") from None


def read_blob(path: str) -> tuple[bytes, str]:
    from azure.core.exceptions import ResourceNotFoundError
    try:
        download = container_client().get_blob_client(path).download_blob()
        return download.readall(), download.properties.etag
    except ResourceNotFoundError as exc:
        if str(getattr(exc, "error_code", "")) == "ContainerNotFound":
            raise StorageUnavailable("Azure storage is unavailable") from None
        raise FileNotFoundError("Stored file not found") from None
    except Exception:
        raise StorageUnavailable("Azure storage is unavailable") from None


def write_blob(path: str, data: bytes, content_type: str, *, expected_etag=None, create=False) -> str:
    from azure.core import MatchConditions
    from azure.core.exceptions import ResourceExistsError, ResourceModifiedError, ResourceNotFoundError
    from azure.storage.blob import ContentSettings
    try:
        condition = {"etag": expected_etag, "match_condition": MatchConditions.IfNotModified} if expected_etag is not None else {}
        result = container_client().get_blob_client(path).upload_blob(
            data, overwrite=not create, content_settings=ContentSettings(content_type=content_type), **condition)
        return result["etag"]
    except (ResourceExistsError, ResourceModifiedError):
        raise StorageConflict("Stored data changed; reload and try again") from None
    except ResourceNotFoundError:
        if expected_etag is not None:
            raise StorageConflict("Stored data changed; reload and try again") from None
        raise StorageUnavailable("Azure storage is unavailable") from None
    except Exception:
        raise StorageUnavailable("Azure storage is unavailable") from None


def list_blobs(prefix: str) -> list[str]:
    try:
        return [blob.name for blob in container_client().list_blobs(name_starts_with=prefix)]
    except Exception:
        raise StorageUnavailable("Azure storage is unavailable") from None


def delete_blob(path: str) -> None:
    from azure.core.exceptions import ResourceNotFoundError
    try:
        container_client().get_blob_client(path).delete_blob()
    except ResourceNotFoundError:
        pass
    except Exception:
        raise StorageUnavailable("Azure storage is unavailable") from None
