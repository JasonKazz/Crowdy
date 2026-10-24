"""HTTP entry point for the native JuPedSim engine.

Run from backend/: python -m uvicorn app.api:app --host 127.0.0.1 --port 8000
"""

import logging
import os
import secrets
import threading
import time
from importlib.metadata import version
from typing import Literal

from fastapi import FastAPI, Header, HTTPException, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import ConfigDict, Field, model_validator
from starlette.concurrency import run_in_threadpool

from app.schemas.scenario import InputModel, Occupant
from app.schemas.layout import Layout
from app.schemas.rooms import PopulationConfig, RoomType
from app.schemas.extraction import ImageUpload, ExtractionRequest, ScaleReference
from app.services.floorplans.images import save_image, extract_image, finish_calibration, load_image_bytes, image_preview
from app.services.floorplans.storage import editor_storage_root
from app.services.floorplans.providers import load_environment, provider_status
from app.services.floorplans.calibration import recalibrate_layout
from app.services.floorplans.import_jobs import create_job, update_job, job_status
from app.simulation.workspace_layout import editor_native_layout, native_to_editor
from app.simulation.editor_adapter import POPULATION_SEED, editor_to_scenario, placement_access
from app.simulation.engine import run_simulation

MAX_BODY_BYTES = 1_048_576
ENGINE_VERSION = version("jupedsim")
_simulation_lock = threading.Lock()
logger = logging.getLogger(__name__)
load_environment()
_import_guard = threading.Lock()
_active_imports: dict[str, float] = {}


def import_status():
    with _import_guard:
        return {provider: {"busy": provider in _active_imports,
                "elapsed_seconds": int(time.monotonic() - _active_imports[provider])
                if provider in _active_imports else 0} for provider in ("gemini", "claude")}


def import_with_slot(payload, progress=None):
    # The worker owns the slot until it actually stops, even if the browser disconnects.
    try:
        return import_floorplan(payload, progress) if progress else import_floorplan(payload)
    finally:
        with _import_guard:
            _active_imports.pop(payload.provider, None)


class BodyLimitMiddleware:
    def __init__(self, app, limit=MAX_BODY_BYTES):
        self.app = app
        self.limit = limit

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        headers = dict(scope.get("headers", []))
        limit = 14 * 1024 * 1024 if scope.get("path") == "/api/floorplans" else self.limit
        try:
            declared = int(headers.get(b"content-length", b"0"))
        except ValueError:
            return await JSONResponse({"detail": "Invalid Content-Length"}, status_code=400)(scope, receive, send)
        if declared < 0:
            return await JSONResponse({"detail": "Invalid Content-Length"}, status_code=400)(scope, receive, send)
        if declared > limit:
            return await self.too_large(scope, receive, send)
        body = bytearray()
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            if message["type"] != "http.request":
                continue
            chunk = message.get("body", b"")
            if len(body) + len(chunk) > limit:
                return await self.too_large(scope, receive, send)
            body.extend(chunk)
            if not message.get("more_body", False):
                break
        delivered = False

        async def replay():
            nonlocal delivered
            if not delivered:
                delivered = True
                return {"type": "http.request", "body": bytes(body), "more_body": False}
            return await receive()

        return await self.app(scope, replay, send)

    async def too_large(self, scope, receive, send):
        response = JSONResponse(
            {"detail": "Image request exceeds the 14 MB encoded limit. Choose an image up to 10 MB."
             if scope.get("path") == "/api/floorplans" else
             "Floor-plan request exceeds the 1 MB limit. Reduce the layout size and try again."},
            status_code=413,
            headers={"Cache-Control": "private, no-store"},
        )
        return await response(scope, receive, send)


class NormalizedPoint(InputModel):
    x: float = Field(ge=0, le=1)
    y: float = Field(ge=0, le=1)


class ViewTransform(InputModel):
    pixels_per_metre: float = Field(gt=0)
    offset_x: float
    offset_y: float


class NativeView(InputModel):
    model_config = ConfigDict(extra="ignore")
    layout: Layout
    transform: ViewTransform


class EditorItem(InputModel):
    id: str = Field(min_length=1, max_length=128)
    label: str = Field(min_length=1, max_length=80)
    kind: Literal["desk", "table", "shelf", "sofa", "plant", "obstacle"]
    x: float = Field(ge=0, le=900)
    y: float = Field(ge=0, le=600)
    width: float = Field(gt=0, le=900)
    height: float = Field(gt=0, le=600)
    polygon: list[NormalizedPoint] | None = Field(default=None, min_length=3, max_length=300)

    @model_validator(mode="after")
    def within_canvas(self):
        if self.x + self.width > 900 or self.y + self.height > 600:
            raise ValueError("Furniture must be inside the 900 × 600 canvas")
        return self


class EditorWall(InputModel):
    x1: float = Field(ge=0, le=900)
    y1: float = Field(ge=0, le=600)
    x2: float = Field(ge=0, le=900)
    y2: float = Field(ge=0, le=600)


class EditorExit(InputModel):
    id: str = Field(min_length=1, max_length=128)
    label: str = Field(min_length=1, max_length=80)
    x: float = Field(ge=0, le=900)
    y: float = Field(ge=0, le=600)


class CanvasPoint(InputModel):
    x: float = Field(ge=0, le=900)
    y: float = Field(ge=0, le=600)


class EditorRoom(InputModel):
    model_config = ConfigDict(extra="ignore")
    id: str = Field(min_length=1, max_length=128)
    label: str = Field(min_length=1, max_length=80)
    room_type: RoomType = "unknown"
    polygon: list[CanvasPoint] = Field(min_length=3, max_length=1200)


class EditorPlan(InputModel):
    id: str = Field(min_length=1, max_length=128)
    name: str = Field(min_length=1, max_length=80)
    width: Literal[900]
    height: Literal[600]
    area: float = Field(gt=0)
    items: list[EditorItem] = Field(max_length=1200)
    walls: list[EditorWall] = Field(max_length=1200)
    exits: list[EditorExit] = Field(max_length=30)
    rooms: list[EditorRoom] = Field(default_factory=list, max_length=100)
    native: NativeView | None = None

    @model_validator(mode="after")
    def unique_ids(self):
        for name in ("items", "exits", "rooms"):
            values = [item.id for item in getattr(self, name)]
            if len(values) != len(set(values)):
                raise ValueError(f"{name} IDs must be unique")
        return self


class EditorSettings(InputModel):
    occupancy: int = Field(ge=1, le=200)
    mobility: Literal["standard", "mixed"]
    distribution: Literal["uniform", "workstations", "rooms"]
    seed: int = Field(default=42, ge=0, le=2**32 - 1)
    blocked_exit_ids: list[str] = Field(default_factory=list, max_length=30)
    behavior_mode: Literal["idealized", "behavioral"] = "idealized"
    body_width: float = Field(default=.46, ge=.4, le=.7)
    population_config: PopulationConfig = Field(default_factory=PopulationConfig)


class StartingPopulation(InputModel):
    occupants: list[Occupant] = Field(min_length=1, max_length=200)
    radius: float = Field(gt=0)
    mobility: Literal["standard", "mixed"]
    distribution: Literal["uniform", "workstations", "rooms"]
    seed: int = Field(ge=0, le=2**32 - 1)
    population_config: PopulationConfig | None = None


class SimulationRequest(InputModel):
    plan: EditorPlan
    scenario: EditorSettings
    starting_population: StartingPopulation | None = None


app = FastAPI(title="Crowdy JuPedSim service", version="1.0.0")
app.add_middleware(BodyLimitMiddleware)


@app.exception_handler(RequestValidationError)
async def invalid_request(_request, exception):
    # Return useful field locations without reflecting a full uploaded layout.
    errors = [
        {"field": ".".join(str(part) for part in error["loc"] if part != "body"), "message": error["msg"]}
        for error in exception.errors()[:12]
    ]
    detail = "Invalid floor plan or scenario: " + "; ".join(
        f"{error['field']}: {error['message']}" for error in errors[:3]
    )
    return JSONResponse(
        {"detail": detail, "errors": errors},
        status_code=422,
        headers={"Cache-Control": "private, no-store"},
    )


@app.get("/health")
def health(response: Response):
    response.headers["Cache-Control"] = "no-store"
    return {"engine": "jupedsim", "version": ENGINE_VERSION, "status": "busy" if _simulation_lock.locked() else "ready"}


def run_editor_simulation(payload: SimulationRequest):
    plan = payload.plan.model_dump()
    settings = payload.scenario.model_dump()
    room_population = {}
    scenario = editor_to_scenario(plan, settings, payload.starting_population, room_population)
    result = run_simulation(scenario)
    from app.simulation.geometry import build_geometry
    _, excluded_area = placement_access(build_geometry(scenario), scenario.exits, scenario.agent_defaults.radius)
    # Preserve native simulation timestamps and outcomes. Micrometre coordinate
    # precision keeps maximum-size results small enough for the Next.js proxy.
    for frame in result["frames"]:
        for agent in frame["agents"]:
            agent["x"] = round(agent["x"], 6)
            agent["y"] = round(agent["y"], 6)
    result["engine"] = "jupedsim"
    result["engine_version"] = ENGINE_VERSION
    result["editor_metadata"] = {"seed": settings.get("seed", POPULATION_SEED), "walking_profile": settings["mobility"],
        "excluded_spawn_area_m2": 0 if payload.starting_population is not None else round(excluded_area, 4),
        "reused_starting_population": payload.starting_population is not None,
        "distribution": settings["distribution"], "room_population": room_population or None,
        "pixels_per_metre": plan["native"]["transform"]["pixels_per_metre"] if plan.get("native") else 32}
    return result


def require_backend_token(authorization):
    expected_token = os.environ.get("CROWDY_BACKEND_TOKEN")
    if expected_token:
        scheme, _, supplied_token = (authorization or "").partition(" ")
        if scheme.lower() != "bearer" or not secrets.compare_digest(supplied_token.encode(), expected_token.encode()):
            raise HTTPException(status_code=401, detail="Backend authorization is required", headers={"WWW-Authenticate": "Bearer", "Cache-Control": "private, no-store"})


@app.post("/api/populations/preview")
def population_preview(payload: SimulationRequest, response: Response, authorization: str | None = Header(default=None)):
    """Use the exact same placement path as Run, without advancing the engine."""
    require_backend_token(authorization)
    metadata = {}
    try:
        scenario = editor_to_scenario(payload.plan.model_dump(), payload.scenario.model_dump(),
                                      payload.starting_population, metadata)
    except (ValueError, RuntimeError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)[:600]) from exc
    response.headers["Cache-Control"] = "private, no-store"
    return {"occupants": [person.model_dump(mode="json") for person in scenario.occupants],
            "radius": scenario.agent_defaults.radius, "room_population": metadata or None}


@app.post("/api/simulations")
async def simulate(payload: SimulationRequest, response: Response, authorization: str | None = Header(default=None)):
    require_backend_token(authorization)
    if not _simulation_lock.acquire(blocking=False):
        raise HTTPException(status_code=429, detail="A simulation is already running. Wait for it to finish and try again.", headers={"Retry-After": "2", "Cache-Control": "private, no-store"})
    try:
        result = await run_in_threadpool(run_editor_simulation, payload)
        response.headers["Cache-Control"] = "private, no-store"
        return result
    except (ValueError, RuntimeError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)[:600], headers={"Cache-Control": "private, no-store"}) from exc
    except Exception as exc:
        logger.exception("Native simulation failed")
        raise HTTPException(status_code=500, detail="The JuPedSim engine could not complete this run. Review the layout or try again.", headers={"Cache-Control": "private, no-store"}) from exc
    finally:
        _simulation_lock.release()


class FloorPlanImport(InputModel):
    layout: dict | None = None
    editor_plan: EditorPlan | None = None
    filename: str | None = None
    image_base64: str | None = None
    provider: Literal["gemini", "claude"] = "gemini"
    image_width_m: float | None = Field(default=None, gt=0, le=1000)
    extraction_id: str | None = Field(default=None, pattern=r"^[a-f0-9]{32}$")
    manual_scale: ScaleReference | None = None
    async_import: bool = False


@app.get("/api/floorplans")
def floorplan_providers(response: Response):
    response.headers["Cache-Control"] = "private, no-store"
    status = import_status()
    return {provider: {**info, **status[provider]} for provider, info in provider_status().items()}


def import_floorplan(payload, progress=None):
    if payload.editor_plan is not None:
        if payload.editor_plan.native is None:
            raise ValueError("Import an image or native layout JSON to edit walls and doors")
        layout, _ = editor_native_layout(payload.editor_plan.model_dump())
        if payload.manual_scale:
            layout = recalibrate_layout(layout, payload.manual_scale)
        return {"plan": native_to_editor(layout.model_dump(), strict=False), "warnings": []}
    if payload.layout is not None:
        return {"plan": native_to_editor(payload.layout, strict=False), "warnings": []}
    root = editor_storage_root()
    if payload.extraction_id:
        if payload.manual_scale is None:
            raise ValueError("Mark a known distance to finish calibration")
        result = finish_calibration(payload.extraction_id, payload.manual_scale, root)
    else:
        if not payload.filename or not payload.image_base64:
            raise ValueError("Choose a backend layout JSON or a floor plan image")
        source = save_image(ImageUpload(filename=payload.filename, image_base64=payload.image_base64), root)
        result = extract_image(ExtractionRequest(image_id=source.id, provider=payload.provider,
            meters_per_pixel=payload.image_width_m / source.width_px if payload.image_width_m else None,
            scale_confirmed=bool(payload.image_width_m)), root, progress=progress)["results"][0]
    if result.get("needs_scale"):
        return result
    if "error" in result:
        raise ValueError(result["error"])
    return {"plan": native_to_editor(result["layout"], strict=False), "warnings": result.get("warnings", [])}


def run_import_job(identifier, payload):
    try:
        result = import_with_slot(payload, lambda message: update_job(identifier, progress=message))
        update_job(identifier, status="complete", progress="Import complete", result=result)
    except (ValueError, RuntimeError) as exc:
        update_job(identifier, status="failed", error=str(exc)[:600])
    except Exception:
        logger.exception("Floor plan import job failed")
        update_job(identifier, status="failed", error="Image import failed. Check backend storage and retry.")


@app.get("/api/floorplans/jobs/{identifier}")
def floorplan_job(identifier: str, response: Response, authorization: str | None = Header(default=None)):
    require_backend_token(authorization)
    if len(identifier) != 32 or any(c not in "0123456789abcdef" for c in identifier):
        raise HTTPException(status_code=400, detail="Invalid import job ID")
    result = job_status(identifier)
    if result is None:
        raise HTTPException(status_code=404, detail="Import job expired or the backend restarted. Upload the image again.")
    response.headers["Cache-Control"] = "private, no-store"
    return result


@app.get("/api/floorplans/images/{image_id}")
def floorplan_image(image_id: str, authorization: str | None = Header(default=None)):
    require_backend_token(authorization)
    root = editor_storage_root()
    try:
        image, media_type = image_preview(load_image_bytes(root, image_id))
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid image ID") from None
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Source image unavailable on this server") from None
    except OSError:
        raise HTTPException(status_code=503, detail="Source image storage is unavailable") from None
    return Response(image, media_type=media_type, headers={"Cache-Control": "private, no-store",
                                                        "X-Content-Type-Options": "nosniff"})


@app.post("/api/floorplans")
async def floorplan_import(payload: FloorPlanImport, response: Response, authorization: str | None = Header(default=None)):
    require_backend_token(authorization)
    extraction = (payload.layout is None and payload.editor_plan is None and payload.extraction_id is None
                  and bool(payload.filename and payload.image_base64))
    if extraction:
        with _import_guard:
            if payload.provider in _active_imports:
                elapsed = int(time.monotonic() - _active_imports[payload.provider])
                name = "Gemini" if payload.provider == "gemini" else "Claude"
                other = "Claude" if payload.provider == "gemini" else "Gemini"
                raise HTTPException(status_code=429, detail=(
                    f"{name} is still processing an earlier image ({elapsed}s elapsed). "
                    f"Wait for it to finish or choose {other}. JSON imports and layout edits remain available."),
                    headers={"Retry-After": "3"})
            _active_imports[payload.provider] = time.monotonic()
    try:
        # Vercel workers are request-scoped and may serve polling elsewhere.
        # Finish within this request instead of returning a process-local job.
        if extraction and payload.async_import and not os.environ.get("VERCEL"):
            identifier = None
            try:
                identifier = create_job()
                threading.Thread(target=run_import_job, args=(identifier, payload), daemon=True).start()
            except Exception:
                if identifier is not None:
                    update_job(identifier, status="failed", error="Could not start the import worker. Retry the upload.")
                with _import_guard:
                    _active_imports.pop(payload.provider, None)
                raise
            response.status_code = 202
            response.headers["Cache-Control"] = "private, no-store"
            return {"job_id": identifier, "status": "running"}
        result = await run_in_threadpool(import_with_slot if extraction else import_floorplan, payload)
        response.headers["Cache-Control"] = "private, no-store"
        return result
    except (ValueError, RuntimeError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)[:600]) from exc
    except OSError as exc:
        raise HTTPException(status_code=500, detail="Floor plan storage is unavailable. Check the backend data directory.") from exc
