"""Frame-oriented inference shared by still-image and live-camera uploads."""

import math
from typing import Literal
from threading import Lock
from time import perf_counter
from uuid import uuid4

from PIL import Image
from pydantic import BaseModel, Field, model_serializer

from app.config import Settings
from app.tiling import EstimationLimit, merge_detections, plan_tiles

VISIBLE_PEOPLE_WARNING = "Counts include visible detected people only; occluded or small people may be missed."


class Detection(BaseModel):
    confidence: float = Field(ge=0, le=1)
    bbox: tuple[float, float, float, float]


class ImageDimensions(BaseModel):
    width: int
    height: int


class InferenceDetails(BaseModel):
    strategy: str
    tiles_processed: int
    tiles_planned: int
    complete: bool
    truncated: bool
    max_detections: int


class Estimate(BaseModel):
    estimate_id: str
    count: int = Field(ge=0)
    detections: list[Detection]
    image: ImageDimensions
    model: str
    processing_ms: float
    warnings: list[str]
    inference: InferenceDetails | None = None
    method: Literal["detections", "density"] = "detections"
    density_count: float | None = Field(default=None, ge=0, allow_inf_nan=False)

    @model_serializer(mode="wrap")
    def without_absent_density(self, handler):
        data = handler(self)
        if self.density_count is None:
            data.pop("density_count", None)
        return data


class EstimatorBusy(Exception):
    pass


class CrowdEstimator:
    def __init__(self, settings: Settings):
        self.settings = settings
        self._model = None
        self._lock = Lock()
        self.ready = False

    def load(self):
        # Never download weights during a request or silently substitute a model.
        if not self.settings.model_path.is_file():
            raise RuntimeError("YOLO weights are missing. Run python -m app.download_model before starting.")
        import cv2
        import torch
        from ultralytics import YOLO

        torch.set_num_threads(self.settings.threads)
        cv2.setNumThreads(self.settings.threads)
        self._model = YOLO(str(self.settings.model_path), task="detect")
        if self._model.task != "detect" or self._model.names[0] != "person":
            raise RuntimeError("Use detection weights with COCO class 0 named person.")
        # Initialize the predictor/native kernels before readiness succeeds.
        warmup_size = min(self.settings.image_size, self.settings.tile_size)
        with Image.new("RGB", (warmup_size, warmup_size)) as blank:
            self.estimate(blank)
        self.ready = True

    def estimate(self, frame: Image.Image) -> Estimate:
        if not self._lock.acquire(blocking=False):
            raise EstimatorBusy()
        try:
            if self._model is None:
                raise RuntimeError("YOLO is not initialized.")
            started = perf_counter()
            needs_tiles = max(frame.size) > self.settings.tile_size
            if needs_tiles and self.settings.max_tiles < 2:
                raise EstimationLimit("Image needs too many source-resolution tiles. Crop it into smaller views.")
            tiles = plan_tiles(frame.width, frame.height, self.settings.tile_size,
                               self.settings.tile_overlap, self.settings.max_tiles - int(needs_tiles))
            candidates, processed, tile_capped = [], 0, False
            tile_limit = min(1000, self.settings.max_detections)
            overview = len(tiles) > 1
            planned = len(tiles) + int(overview)
            if overview:
                # Preserve close-up people larger than a slice. Only large
                # boxes enter fusion; small people use source-resolution tiles.
                large, capped = self._predict(frame, tile_limit)
                tile_capped |= capped
                minimum_span = self.settings.tile_size * (1 - self.settings.tile_overlap)
                candidates.extend((item, -1) for item in large if max(
                    item.bbox[2] - item.bbox[0], item.bbox[3] - item.bbox[1]) > minimum_span)
                processed += 1
            for index, tile in enumerate(tiles):
                # The native inference call cannot be interrupted safely. Check
                # the shared frame budget between calls; never report an
                # unfinished scan as a complete count.
                if processed and perf_counter() - started >= self.settings.inference_seconds:
                    break
                with frame.crop(tile.box) as crop:
                    detections, capped = self._predict(crop, tile_limit)
                processed += 1
                tile_capped |= capped
                for detection in detections:
                    x1, y1, x2, y2 = detection.bbox
                    bbox = (x1 + tile.box[0], y1 + tile.box[1], x2 + tile.box[0], y2 + tile.box[1])
                    if tile.owns(bbox):
                        candidates.append((Detection(confidence=detection.confidence, bbox=bbox), index))
            detections, output_capped, merged_all = merge_detections(candidates, self.settings.max_detections,
                within_budget=lambda: perf_counter() - started < self.settings.inference_seconds)
            warnings = [VISIBLE_PEOPLE_WARNING]
            if tile_capped or output_capped:
                warnings.append("The detection limit was reached; this image may contain more people than reported.")
            scanned_all = processed == planned
            complete = scanned_all and merged_all and not (tile_capped or output_capped)
            if not scanned_all or not merged_all:
                warnings.append("The processing time limit was reached before every tile was scanned; this is a partial count. Use smaller views.")
            return Estimate(
                estimate_id=uuid4().hex, count=len(detections), detections=detections,
                image=ImageDimensions(width=frame.width, height=frame.height),
                model=self.settings.model_path.name,
                processing_ms=round((perf_counter() - started) * 1000, 2), warnings=warnings,
                inference=InferenceDetails(strategy="tiled" if overview else "whole",
                    tiles_processed=processed, tiles_planned=planned, complete=complete,
                    truncated=tile_capped or output_capped, max_detections=self.settings.max_detections),
            )
        finally:
            self._lock.release()

    def _predict(self, frame, limit):
        results = self._model.predict(
            source=frame, classes=[0], conf=self.settings.confidence,
            iou=self.settings.iou, imgsz=self.settings.image_size,
            max_det=limit, device=self.settings.device,
            # Use the one-to-many head explicitly. The NMS-free one-to-one
            # YOLO26 head has a smaller trained output budget (typically300).
            nms=True, verbose=False, save=False, stream=False, augment=False,
        )
        if len(results) != 1:
            raise RuntimeError("Expected one prediction for one tile.")
        boxes = results[0].boxes
        detections = []
        if boxes is not None:
            for xyxy, confidence, class_id in zip(boxes.xyxy.cpu().tolist(), boxes.conf.cpu().tolist(), boxes.cls.cpu().tolist(), strict=True):
                if class_id != 0:
                    continue
                if not all(math.isfinite(value) for value in [*xyxy, confidence]):
                    raise RuntimeError("Detector returned nonfinite values.")
                if confidence < self.settings.confidence:
                    continue
                x1, y1, x2, y2 = xyxy
                bbox = (max(0.0, min(frame.width, x1)), max(0.0, min(frame.height, y1)),
                        max(0.0, min(frame.width, x2)), max(0.0, min(frame.height, y2)))
                if bbox[2] > bbox[0] and bbox[3] > bbox[1]:
                    detections.append(Detection(confidence=confidence, bbox=bbox))
        return detections, len(detections) >= limit
