"""Frame-oriented inference, reusable by a future video ingestion worker."""

import math
from threading import Lock
from time import perf_counter
from uuid import uuid4

from PIL import Image
from pydantic import BaseModel, Field

from app.config import Settings

VISIBLE_PEOPLE_WARNING = "Counts include visible detected people only; occluded or small people may be missed."


class Detection(BaseModel):
    confidence: float = Field(ge=0, le=1)
    bbox: tuple[float, float, float, float]


class ImageDimensions(BaseModel):
    width: int
    height: int


class Estimate(BaseModel):
    estimate_id: str
    count: int = Field(ge=0)
    detections: list[Detection]
    image: ImageDimensions
    model: str
    processing_ms: float
    warnings: list[str]


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
        with Image.new("RGB", (self.settings.image_size, self.settings.image_size)) as blank:
            self.estimate(blank)
        self.ready = True

    def estimate(self, frame: Image.Image) -> Estimate:
        if not self._lock.acquire(blocking=False):
            raise EstimatorBusy()
        try:
            if self._model is None:
                raise RuntimeError("YOLO is not initialized.")
            started = perf_counter()
            results = self._model.predict(
                source=frame, classes=[0], conf=self.settings.confidence,
                iou=self.settings.iou, imgsz=self.settings.image_size,
                max_det=self.settings.max_detections, device=self.settings.device,
                verbose=False, save=False, stream=False, augment=False,
            )
            if len(results) != 1:
                raise RuntimeError("Expected one prediction for one frame.")
            boxes = results[0].boxes
            detections = []
            if boxes is not None:
                # Defensively filter class IDs even though predict already does.
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
                    if bbox[2] <= bbox[0] or bbox[3] <= bbox[1]:
                        continue
                    detections.append(Detection(confidence=confidence, bbox=bbox))
            warnings = [VISIBLE_PEOPLE_WARNING]
            if len(detections) >= self.settings.max_detections:
                warnings.append("The detection limit was reached; this image may contain more people than reported.")
            return Estimate(
                estimate_id=uuid4().hex, count=len(detections), detections=detections,
                image=ImageDimensions(width=frame.width, height=frame.height),
                model=self.settings.model_path.name,
                processing_ms=round((perf_counter() - started) * 1000, 2), warnings=warnings,
            )
        finally:
            self._lock.release()
