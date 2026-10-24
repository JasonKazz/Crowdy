"""HTTP entry point for the native JuPedSim engine.

Run from backend/: python -m uvicorn app.api:app --host 127.0.0.1 --port 8000
"""

import logging
import os
import secrets
import threading
from importlib.metadata import version
from typing import Literal

from fastapi import FastAPI, Header, HTTPException, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import Field, model_validator
from starlette.concurrency import run_in_threadpool

from app.schemas.scenario import InputModel
from app.simulation.editor_adapter import POPULATION_SEED, editor_to_scenario
from app.simulation.engine import run_simulation

MAX_BODY_BYTES = 1_048_576
ENGINE_VERSION = version("jupedsim")
_simulation_lock = threading.Lock()
logger = logging.getLogger(__name__)


class BodyLimitMiddleware:
    def __init__(self, app, limit=MAX_BODY_BYTES):
        self.app = app
        self.limit = limit

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        headers = dict(scope.get("headers", []))
        try:
            declared = int(headers.get(b"content-length", b"0"))
        except ValueError:
            return await JSONResponse({"detail": "Invalid Content-Length"}, status_code=400)(scope, receive, send)
        if declared < 0:
            return await JSONResponse({"detail": "Invalid Content-Length"}, status_code=400)(scope, receive, send)
        if declared > self.limit:
            return await self.too_large(scope, receive, send)
        body = bytearray()
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            if message["type"] != "http.request":
                continue
            chunk = message.get("body", b"")
            if len(body) + len(chunk) > self.limit:
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
            {"detail": "Floor-plan request exceeds the 1 MB limit. Reduce the layout size and try again."},
            status_code=413,
            headers={"Cache-Control": "private, no-store"},
        )
        return await response(scope, receive, send)


class EditorItem(InputModel):
    id: str = Field(min_length=1, max_length=128)
    label: str = Field(min_length=1, max_length=80)
    kind: Literal["desk", "table", "shelf", "sofa", "plant", "obstacle"]
    x: float = Field(ge=0, le=900)
    y: float = Field(ge=0, le=600)
    width: float = Field(ge=8, le=900)
    height: float = Field(ge=8, le=600)

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


class EditorPlan(InputModel):
    id: str = Field(min_length=1, max_length=128)
    name: str = Field(min_length=1, max_length=80)
    width: Literal[900]
    height: Literal[600]
    area: float = Field(gt=0, le=10000)
    items: list[EditorItem] = Field(max_length=200)
    walls: list[EditorWall] = Field(max_length=300)
    exits: list[EditorExit] = Field(min_length=1, max_length=20)

    @model_validator(mode="after")
    def unique_ids(self):
        for name in ("items", "exits"):
            values = [item.id for item in getattr(self, name)]
            if len(values) != len(set(values)):
                raise ValueError(f"{name} IDs must be unique")
        return self


class EditorSettings(InputModel):
    occupancy: int = Field(ge=1, le=200)
    mobility: Literal["standard", "mixed"]
    distribution: Literal["uniform", "workstations"]


class SimulationRequest(InputModel):
    plan: EditorPlan
    scenario: EditorSettings


app = FastAPI(title="Crowdy JuPedSim service", version="1.0.0")
app.add_middleware(BodyLimitMiddleware)


@app.exception_handler(RequestValidationError)
async def invalid_request(_request, exception):
    # Return useful field locations without reflecting a full uploaded layout.
    return JSONResponse(
        {"detail": "Invalid floor plan or scenario", "errors": [
            {"field": ".".join(str(part) for part in error["loc"]), "message": error["msg"]}
            for error in exception.errors()[:12]
        ]},
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
    scenario = editor_to_scenario(plan, settings)
    result = run_simulation(scenario)
    # Preserve native simulation timestamps and outcomes. Micrometre coordinate
    # precision keeps maximum-size results small enough for the Next.js proxy.
    for frame in result["frames"]:
        for agent in frame["agents"]:
            agent["x"] = round(agent["x"], 6)
            agent["y"] = round(agent["y"], 6)
    result["engine"] = "jupedsim"
    result["engine_version"] = ENGINE_VERSION
    result["editor_metadata"] = {"seed": POPULATION_SEED, "walking_profile": settings["mobility"], "distribution": settings["distribution"], "pixels_per_metre": 32}
    return result


@app.post("/api/simulations")
async def simulate(payload: SimulationRequest, response: Response, authorization: str | None = Header(default=None)):
    expected_token = os.environ.get("CROWDY_BACKEND_TOKEN")
    if expected_token:
        scheme, _, supplied_token = (authorization or "").partition(" ")
        if scheme.lower() != "bearer" or not secrets.compare_digest(supplied_token.encode(), expected_token.encode()):
            raise HTTPException(status_code=401, detail="Backend authorization is required", headers={"WWW-Authenticate": "Bearer", "Cache-Control": "private, no-store"})
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
