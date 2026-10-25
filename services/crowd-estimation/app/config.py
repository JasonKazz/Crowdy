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
    max_detections: int = 10000
    tile_size: int = 640
    tile_overlap: float = 0.2
    max_tiles: int = 128
    inference_seconds: float = 25
    max_upload_bytes: int = 10 * 1024 * 1024
    max_pixels: int = 30_000_000
    threads: int = 2
    method: str = "density"
    density_model_path: Path = Path("models/zip-n-nwpu.pth")
    density_min_size: int = 896
    density_max_size: int = 4096

    def __post_init__(self):
        if not self.token or self.token != self.token.strip():
            raise ValueError("Set CROWDY_CROWD_ESTIMATION_TOKEN to a nonempty server-to-server secret.")
        if not all(math.isfinite(value) and 0 < value <= 1 for value in (self.confidence, self.iou)):
            raise ValueError("Confidence and IoU thresholds must be greater than 0 and at most 1.")
        if not 320 <= self.image_size <= 2048 or self.image_size % 32:
            raise ValueError("CROWDY_YOLO_IMAGE_SIZE must be a multiple of 32 between 320 and 2048.")
        if not 1 <= self.max_detections <= 10000:
            raise ValueError("CROWDY_YOLO_MAX_DETECTIONS must be between 1 and 10000.")
        if not 320 <= self.tile_size <= 2048 or self.tile_size % 32:
            raise ValueError("CROWDY_YOLO_TILE_SIZE must be a multiple of 32 between 320 and 2048.")
        if not math.isfinite(self.tile_overlap) or not .1 <= self.tile_overlap <= .5:
            raise ValueError("CROWDY_YOLO_TILE_OVERLAP must be between 0.1 and 0.5.")
        if not 1 <= self.max_tiles <= 256 or not math.isfinite(self.inference_seconds) or not 1 <= self.inference_seconds <= 120:
            raise ValueError("Inference limits must be 1–256 tiles and 1–120 seconds.")
        if not 1 <= self.threads <= 16:
            raise ValueError("CROWDY_YOLO_THREADS must be between 1 and 16.")
        if self.method not in {"density", "detections"}:
            raise ValueError("CROWDY_COUNT_METHOD must be density or detections.")
        if not 320 <= self.density_min_size <= 1024 or not 1024 <= self.density_max_size <= 4096:
            raise ValueError("Density input edges must be 320–1024 minimum and 1024–4096 maximum.")
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
            max_detections=int(os.environ.get("CROWDY_YOLO_MAX_DETECTIONS", "10000")),
            tile_size=int(os.environ.get("CROWDY_YOLO_TILE_SIZE", "640")),
            tile_overlap=float(os.environ.get("CROWDY_YOLO_TILE_OVERLAP", "0.2")),
            max_tiles=int(os.environ.get("CROWDY_YOLO_MAX_TILES", "128")),
            inference_seconds=float(os.environ.get("CROWDY_YOLO_INFERENCE_SECONDS", "25")),
            max_upload_bytes=int(os.environ.get("CROWDY_MAX_IMAGE_BYTES", str(10 * 1024 * 1024))),
            max_pixels=int(os.environ.get("CROWDY_MAX_IMAGE_PIXELS", "30000000")),
            threads=int(os.environ.get("CROWDY_YOLO_THREADS", "2")),
            method=os.environ.get("CROWDY_COUNT_METHOD", "density"),
            density_model_path=Path(os.environ.get("CROWDY_DENSITY_MODEL", "models/zip-n-nwpu.pth")),
            density_min_size=int(os.environ.get("CROWDY_DENSITY_MIN_SIZE", "896")),
            density_max_size=int(os.environ.get("CROWDY_DENSITY_MAX_SIZE", "4096")),
        )
