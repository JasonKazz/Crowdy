"""Server-owned settings; clients cannot select models, devices, or thresholds."""

import math
import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Settings:
    token: str
    model_path: Path = Path("models/yolo26n.pt")
    device: str = "cpu"
    confidence: float = 0.25
    iou: float = 0.45
    image_size: int = 1280
    max_detections: int = 1000
    max_upload_bytes: int = 10 * 1024 * 1024
    max_pixels: int = 30_000_000
    threads: int = 2

    def __post_init__(self):
        if not self.token or self.token != self.token.strip():
            raise ValueError("Set CROWDY_CROWD_ESTIMATION_TOKEN to a nonempty server-to-server secret.")
        if not all(math.isfinite(value) and 0 < value <= 1 for value in (self.confidence, self.iou)):
            raise ValueError("Confidence and IoU thresholds must be greater than 0 and at most 1.")
        if not 320 <= self.image_size <= 2048 or self.image_size % 32:
            raise ValueError("CROWDY_YOLO_IMAGE_SIZE must be a multiple of 32 between 320 and 2048.")
        if not 1 <= self.max_detections <= 5000:
            raise ValueError("CROWDY_YOLO_MAX_DETECTIONS must be between 1 and 5000.")
        if not 1 <= self.threads <= 16:
            raise ValueError("CROWDY_YOLO_THREADS must be between 1 and 16.")
        if not 1 <= self.max_upload_bytes <= 10 * 1024 * 1024 or not 1 <= self.max_pixels <= 30_000_000:
            raise ValueError("Image limits must be positive and no larger than 10 MiB / 30 million pixels.")

    @classmethod
    def from_env(cls):
        return cls(
            token=os.environ.get("CROWDY_CROWD_ESTIMATION_TOKEN", ""),
            model_path=Path(os.environ.get("CROWDY_YOLO_MODEL", "models/yolo26n.pt")),
            device=os.environ.get("CROWDY_YOLO_DEVICE", "cpu"),
            confidence=float(os.environ.get("CROWDY_YOLO_CONFIDENCE", "0.25")),
            iou=float(os.environ.get("CROWDY_YOLO_IOU", "0.45")),
            image_size=int(os.environ.get("CROWDY_YOLO_IMAGE_SIZE", "1280")),
            max_detections=int(os.environ.get("CROWDY_YOLO_MAX_DETECTIONS", "1000")),
            max_upload_bytes=int(os.environ.get("CROWDY_MAX_IMAGE_BYTES", str(10 * 1024 * 1024))),
            max_pixels=int(os.environ.get("CROWDY_MAX_IMAGE_PIXELS", "30000000")),
            threads=int(os.environ.get("CROWDY_YOLO_THREADS", "2")),
        )
