"""Workspace APIs accessed only by the authenticated Next.js server."""

import os
import secrets
from typing import Annotated

from fastapi import APIRouter, Depends, Header, HTTPException, Response
from pydantic import Field, ValidationError, field_validator, model_validator

from app.schemas.scenario import InputModel
from app.services import workspaces as storage
from app.services.azure_storage import StorageConflict, StorageUnavailable

router = APIRouter(prefix="/api/workspaces", tags=["workspaces"])
PRIVATE = {"Cache-Control": "private, no-store"}


def workspace_owner(authorization: str | None = Header(default=None),
                    x_crowdy_owner: str | None = Header(default=None)) -> str:
    token = os.environ.get("CROWDY_BACKEND_TOKEN", "").strip()
    if not token:
        raise HTTPException(503, "Workspace authentication is not configured", headers=PRIVATE)
    scheme, _, supplied = (authorization or "").partition(" ")
    if scheme.lower() != "bearer" or not secrets.compare_digest(supplied.encode(), token.encode()):
        raise HTTPException(401, "Backend authorization is required",
                            headers={**PRIVATE, "WWW-Authenticate": "Bearer"})
    owner = x_crowdy_owner or ""
    if not owner or owner != owner.strip() or len(owner) > 512 or any(ord(char) < 32 or ord(char) == 127 for char in owner):
        raise HTTPException(401, "Sign in to access your workspaces", headers=PRIVATE)
    return owner


Owner = Annotated[str, Depends(workspace_owner)]


class WorkspaceInput(InputModel):
    name: str = Field(min_length=1, max_length=80)
    plan: dict
    scenario: dict

    @field_validator("name")
    @classmethod
    def valid_name(cls, value):
        if not value.strip():
            raise ValueError("Choose a workspace name")
        return value.strip()

    @model_validator(mode="after")
    def valid_editor_data(self):
        # Validate native geometry, but keep all editor view and draft metadata.
        # Rendering fields such as native.floors/image must survive round trips.
        from app.api import EditorPlan, EditorSettings
        try:
            EditorPlan.model_validate(self.plan)
            aliases = {"blockedExitIds": "blocked_exit_ids", "behaviorMode": "behavior_mode", "bodyWidth": "body_width"}
            EditorSettings.model_validate({aliases.get(key, key): value for key, value in self.scenario.items()})
        except ValidationError:
            raise ValueError("Choose a valid floor plan and scenario") from None
        return self


class WorkspaceCreate(WorkspaceInput):
    id: str | None = Field(default=None, pattern=storage.IDENTIFIER.pattern)


class WorkspaceUpdate(WorkspaceInput):
    name: str | None = Field(default=None, min_length=1, max_length=80)
    expectedUpdatedAt: int | None = Field(default=None, ge=0, le=8_640_000_000_000_000)

    @field_validator("name")
    @classmethod
    def valid_name(cls, value):
        if value is None:
            return value
        return super().valid_name(value)


class SourceUpload(InputModel):
    id: str = Field(pattern=storage.IDENTIFIER.pattern)
    name: str = Field(min_length=1, max_length=255)
    image_base64: str = Field(min_length=1, max_length=14 * 1024 * 1024)

    @field_validator("name")
    @classmethod
    def valid_name(cls, value):
        if not value.strip():
            raise ValueError("Choose an image name")
        return value.strip()


def perform(operation, *args):
    try:
        return operation(*args)
    except storage.WorkspaceDeleted:
        raise HTTPException(410, "This workspace was deleted", headers=PRIVATE) from None
    except storage.SourceDeleted:
        raise HTTPException(410, "This source was deleted", headers=PRIVATE) from None
    except FileNotFoundError:
        raise HTTPException(404, "Workspace or source not found", headers=PRIVATE) from None
    except StorageConflict as exc:
        raise HTTPException(409, str(exc), headers=PRIVATE) from None
    except StorageUnavailable:
        raise HTTPException(503, "Workspace storage is unavailable. Try again shortly.", headers=PRIVATE) from None
    except ValueError as exc:
        raise HTTPException(422, str(exc), headers=PRIVATE) from None


@router.get("")
def list_workspaces(response: Response, owner: Owner):
    response.headers.update(PRIVATE)
    return {"workspaces": perform(storage.list_workspaces, owner)}


@router.post("", status_code=201)
def create_workspace(payload: WorkspaceCreate, response: Response, owner: Owner):
    response.headers.update(PRIVATE)
    return perform(storage.create_workspace, owner, payload.name, payload.plan, payload.scenario, payload.id)


@router.get("/{identifier}")
def get_workspace(identifier: str, response: Response, owner: Owner):
    response.headers.update(PRIVATE)
    return perform(storage.get_workspace, owner, identifier)


@router.put("/{identifier}")
def update_workspace(identifier: str, payload: WorkspaceUpdate, response: Response, owner: Owner):
    response.headers.update(PRIVATE)
    return perform(storage.update_workspace, owner, identifier, payload.name, payload.plan, payload.scenario,
                   payload.expectedUpdatedAt)


@router.delete("/{identifier}", status_code=204)
def delete_workspace(identifier: str, owner: Owner):
    perform(storage.delete_workspace, owner, identifier)
    return Response(status_code=204, headers=PRIVATE)


@router.get("/{identifier}/sources")
def list_sources(identifier: str, response: Response, owner: Owner):
    response.headers.update(PRIVATE)
    return {"sources": perform(storage.list_sources, owner, identifier)}


@router.post("/{identifier}/sources", status_code=201)
def add_source(identifier: str, payload: SourceUpload, response: Response, owner: Owner):
    response.headers.update(PRIVATE)
    return perform(storage.add_source, owner, identifier, payload.id, payload.name, payload.image_base64)


@router.get("/{identifier}/sources/{source_id}/image")
def source_image(identifier: str, source_id: str, owner: Owner):
    raw, media_type = perform(storage.get_source_image, owner, identifier, source_id)
    return Response(raw, media_type=media_type, headers={**PRIVATE, "X-Content-Type-Options": "nosniff"})


@router.delete("/{identifier}/sources/{source_id}", status_code=204)
def delete_source(identifier: str, source_id: str, owner: Owner):
    perform(storage.delete_source, owner, identifier, source_id)
    return Response(status_code=204, headers=PRIVATE)
