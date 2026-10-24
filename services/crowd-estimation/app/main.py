"""HTTP adapter. No storage, simulation, camera, or frontend dependencies."""

import logging
import secrets
from contextlib import asynccontextmanager

import anyio
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import UploadFile
from starlette.formparsers import MultiPartException, MultiPartParser

from app.config import Settings
from app.estimator import CrowdEstimator, Estimate, EstimatorBusy
from app.images import ALLOWED_TYPES, InvalidImage, decode_image

logger = logging.getLogger(__name__)


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


def create_app(settings: Settings | None = None, estimator=None) -> FastAPI:
    config = settings if settings is not None else Settings.from_env()
    detector = estimator if estimator is not None else CrowdEstimator(config)

    @asynccontextmanager
    async def lifespan(app):
        await run_in_threadpool(detector.load)
        yield
        detector.ready = False

    app = FastAPI(title="Crowdy crowd estimation", version="0.1.0", lifespan=lifespan)
    app.state.estimator = detector
    capacity = anyio.CapacityLimiter(1)

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
        "requestBody": {"required": True, "content": {"multipart/form-data": {"schema": {
            "type": "object", "required": ["image"], "additionalProperties": False,
            "properties": {"image": {"type": "string", "format": "binary"}},
        }}}},
    })
    async def estimate(request: Request):
        authorization = request.headers.get("authorization", "")
        if not secrets.compare_digest(authorization.encode(), f"Bearer {config.token}".encode()):
            return failure("A valid service bearer token is required.", 401, {"WWW-Authenticate": "Bearer"})
        if not detector.ready:
            return failure("Model is not ready.", 503, {"Retry-After": "5"})
        try:
            capacity.acquire_nowait()
        except anyio.WouldBlock:
            return failure("Crowd estimation is busy. Retry shortly.", 503, {"Retry-After": "2"})
        try:
            return await process_image(request)
        finally:
            capacity.release()

    async def process_image(request: Request):
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
                    return detector.estimate(image)

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
            app.openapi_schema = schema
        return app.openapi_schema

    app.openapi = openapi
    return app
