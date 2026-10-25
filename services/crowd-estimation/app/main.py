"""HTTP adapter for bounded still-image and ephemeral live-frame estimates."""

import logging
import secrets
from contextlib import asynccontextmanager

import anyio
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import UploadFile
from starlette.formparsers import MultiPartException, MultiPartParser

from app.config import Settings
from app.estimator import CrowdEstimator, Estimate, EstimatorBusy
from app.images import ALLOWED_TYPES, InvalidImage, decode_image, jpeg_preview
from app.live import (
    CreatedLiveSession,
    LiveSessionLimit,
    LiveSessionMissing,
    LiveSessionUnauthorized,
    LiveSessions,
    LiveSnapshot,
)

logger = logging.getLogger(__name__)
IMAGE_REQUEST_BODY = {"required": True, "content": {"multipart/form-data": {"schema": {
    "type": "object", "required": ["image"], "additionalProperties": False,
    "properties": {"image": {"type": "string", "format": "binary"}},
}}}}
LIVE_SECURITY = [{"serviceBearer": [], "liveCapability": []}]


class UploadTooLarge(MultiPartException):
    pass


class CompleteMultiPartParser(MultiPartParser):
    """Require a closing boundary; finalize() alone permits truncated bodies."""

    def on_end(self):
        self._complete = True
        super().on_end()

    async def parse(self):
        self._complete = False
        try:
            form = await super().parse()
            if not self._complete:
                raise MultiPartException("Incomplete multipart upload.")
            return form
        except BaseException:
            # Unfinished files are absent from FormData, so form.close() cannot
            # reach them. Also clean up if the client disconnects mid-upload.
            for partial_file in self._files_to_close_on_error:
                partial_file.close()
            raise


def failure(message: str, status: int, headers: dict | None = None):
    return JSONResponse({"error": message}, status_code=status, headers=headers)


def create_app(settings: Settings | None = None, estimator=None, live_sessions: LiveSessions | None = None) -> FastAPI:
    config = settings if settings is not None else Settings.from_env()
    detector = estimator if estimator is not None else CrowdEstimator(config)
    sessions = live_sessions if live_sessions is not None else LiveSessions()

    @asynccontextmanager
    async def lifespan(app):
        await run_in_threadpool(detector.load)
        try:
            yield
        finally:
            detector.ready = False
            sessions.clear()

    app = FastAPI(title="Crowdy crowd estimation", version="0.1.0", lifespan=lifespan)
    app.state.estimator = detector
    app.state.live_sessions = sessions
    capacity = anyio.CapacityLimiter(1)

    @app.exception_handler(LiveSessionMissing)
    async def missing_live_session(_request, _error):
        return failure("Live session was not found or has expired.", 404)

    @app.exception_handler(LiveSessionUnauthorized)
    async def unauthorized_live_session(_request, _error):
        return failure("A valid live session token is required.", 401)

    @app.exception_handler(LiveSessionLimit)
    async def live_session_limit(_request, _error):
        return failure("Live sessions are busy. End an existing session or retry later.", 503, {"Retry-After": "30"})

    @app.middleware("http")
    async def private_responses(request, call_next):
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response

    @app.get("/healthz")
    async def health():
        return {"status": "ok"}

    @app.get("/readyz")
    async def readiness():
        if not detector.ready:
            return failure("Model is not ready.", 503)
        return {"status": "ready"}

    @app.post("/v1/estimates", response_model=Estimate, openapi_extra={
        "security": [{"serviceBearer": []}],
        "requestBody": IMAGE_REQUEST_BODY,
    })
    async def estimate(request: Request):
        if error := authorize_service(request):
            return error
        result = await admit_image(request)
        return result if isinstance(result, JSONResponse) else result[0]

    @app.post("/v1/live-sessions", response_model=CreatedLiveSession, status_code=201,
              openapi_extra={"security": [{"serviceBearer": []}]})
    async def create_live_session(request: Request):
        if error := authorize_service(request):
            return error
        return sessions.create()

    @app.get("/v1/live-sessions/{session_id}", response_model=LiveSnapshot,
             openapi_extra={"security": LIVE_SECURITY})
    async def get_live_session(session_id: str, request: Request):
        if error := authorize_service(request):
            return error
        return sessions.snapshot(session_id, request.headers.get("x-crowdy-live-token", ""))

    @app.delete("/v1/live-sessions/{session_id}", status_code=204,
                openapi_extra={"security": LIVE_SECURITY})
    async def delete_live_session(session_id: str, request: Request):
        if error := authorize_service(request):
            return error
        sessions.delete(session_id, request.headers.get("x-crowdy-live-token", ""))
        return Response(status_code=204)

    @app.post("/v1/live-sessions/{session_id}/pause", response_model=LiveSnapshot,
              openapi_extra={"security": LIVE_SECURITY})
    async def pause_live_session(session_id: str, request: Request):
        if error := authorize_service(request):
            return error
        return sessions.pause(session_id, request.headers.get("x-crowdy-live-token", ""))

    @app.post("/v1/live-sessions/{session_id}/frames", response_model=LiveSnapshot,
              openapi_extra={"security": LIVE_SECURITY, "requestBody": IMAGE_REQUEST_BODY})
    async def live_frame(session_id: str, request: Request):
        if error := authorize_service(request):
            return error
        ticket = sessions.begin_frame(session_id, request.headers.get("x-crowdy-live-token", ""))
        result = await admit_image(request, include_preview=True)
        if isinstance(result, JSONResponse):
            return result
        estimate, preview = result
        return sessions.finish_frame(ticket, estimate, preview)

    def authorize_service(request: Request):
        authorization = request.headers.get("authorization", "")
        if not secrets.compare_digest(authorization.encode(), f"Bearer {config.token}".encode()):
            return failure("A valid service bearer token is required.", 401, {"WWW-Authenticate": "Bearer"})

    async def admit_image(request: Request, *, include_preview=False):
        if not detector.ready:
            return failure("Model is not ready.", 503, {"Retry-After": "5"})
        try:
            capacity.acquire_nowait()
        except anyio.WouldBlock:
            return failure("Crowd estimation is busy. Retry shortly.", 503, {"Retry-After": "2"})
        try:
            return await process_image(request, include_preview=include_preview)
        finally:
            capacity.release()

    async def process_image(request: Request, *, include_preview=False):
        if request.headers.get("content-type", "").split(";", 1)[0].strip().lower() != "multipart/form-data":
            return failure("Send a multipart image field named image.", 415)
        # Count the whole stream as well as the file, including chunked requests.
        # Leave a small allowance for multipart headers; never trust Content-Length.
        limit = config.max_upload_bytes + 64 * 1024
        length = request.headers.get("content-length")
        if length is not None:
            try:
                if int(length) < 0:
                    raise ValueError()
                if int(length) > limit:
                    return failure("Image exceeds the upload limit.", 413)
            except ValueError:
                return failure("Invalid Content-Length.", 400)

        async def bounded_stream():
            size = 0
            async for chunk in request.stream():
                size += len(chunk)
                if size > limit:
                    raise UploadTooLarge("Image exceeds the upload limit.")
                yield chunk

        try:
            form = await CompleteMultiPartParser(request.headers, bounded_stream(), max_files=1, max_fields=0).parse()
        except UploadTooLarge:
            return failure("Image exceeds the upload limit.", 413)
        except (MultiPartException, ValueError):
            return failure("Send exactly one PNG, JPEG, or WebP file in the image field.", 400)
        try:
            files = form.multi_items()
            if len(files) != 1 or files[0][0] != "image" or not isinstance(files[0][1], UploadFile):
                return failure("Send exactly one file in the image field.", 400)
            upload = files[0][1]
            content_type = (upload.content_type or "").split(";", 1)[0].strip().lower()
            if content_type not in ALLOWED_TYPES:
                return failure("Choose a PNG, JPEG, or WebP still image.", 415)
            if upload.size is not None and upload.size > config.max_upload_bytes:
                return failure("Image exceeds the upload limit.", 413)
            data = await upload.read(config.max_upload_bytes + 1)
            if len(data) > config.max_upload_bytes:
                return failure("Image exceeds the upload limit.", 413)
            if not data:
                return failure("The image is empty.", 400)

            def infer():
                with decode_image(data, content_type, config.max_pixels) as image:
                    estimate = detector.estimate(image)
                    return estimate, jpeg_preview(image) if include_preview else None

            try:
                return await run_in_threadpool(infer)
            except InvalidImage as error:
                return failure(str(error), 422)
            except EstimatorBusy:
                return failure("Crowd estimation is busy. Retry shortly.", 503, {"Retry-After": "2"})
            except Exception:
                logger.exception("Crowd inference failed")
                return failure("Crowd estimation failed. Retry with another image.", 500)
        finally:
            await form.close()

    from fastapi.openapi.utils import get_openapi

    def openapi():
        if app.openapi_schema is None:
            schema = get_openapi(title=app.title, version=app.version, routes=app.routes)
            schema.setdefault("components", {}).setdefault("securitySchemes", {})["serviceBearer"] = {
                "type": "http", "scheme": "bearer",
            }
            schema["components"]["securitySchemes"]["liveCapability"] = {
                "type": "apiKey", "in": "header", "name": "X-Crowdy-Live-Token",
            }
            app.openapi_schema = schema
        return app.openapi_schema

    app.openapi = openapi
    return app
