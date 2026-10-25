"""Whole-view density estimates for wide crowds; never invent person boxes."""

import math
from threading import Lock
from time import perf_counter
from uuid import uuid4

from app.estimator import Estimate, EstimatorBusy, ImageDimensions, InferenceDetails


class DensityEstimator:
    def __init__(self, settings):
        self.settings = settings
        self._model = None
        self._lock = Lock()
        self.ready = False

    def load(self):
        if not self.settings.density_model_path.is_file():
            raise RuntimeError("ZIP weights are missing. Run python -m app.download_model before starting.")
        import torch
        from app.density_model import load_zip
        from app.density_weights import verify_weights
        from PIL import Image

        verify_weights(self.settings.density_model_path)
        torch.set_num_threads(self.settings.threads)
        self._model = load_zip(self.settings.density_model_path, self.settings.device)
        with Image.new("RGB", (self.settings.density_min_size, self.settings.density_min_size)) as blank:
            self.estimate(blank)
        self.ready = True

    def estimate(self, frame):
        if not self._lock.acquire(blocking=False):
            raise EstimatorBusy()
        try:
            if self._model is None:
                raise RuntimeError("ZIP is not initialized.")
            started = perf_counter()
            raw = self._count(frame)
            if not math.isfinite(raw) or raw < 0:
                raise RuntimeError("Density model returned an invalid count.")
            capped = raw > self.settings.max_detections
            elapsed = perf_counter() - started
            complete = not capped and elapsed <= self.settings.inference_seconds
            warnings = ["Density estimates infer crowd size from image patterns; they are not individual detections or verified attendance. Occlusion, scale, lighting and camera domain can cause substantial error."]
            if capped:
                warnings.append("The estimated crowd exceeds the configured count limit; the displayed count is capped. Review the raw density estimate.")
            if elapsed > self.settings.inference_seconds:
                warnings.append("The processing time budget was exceeded; use a smaller view before applying this estimate.")
            return Estimate(estimate_id=uuid4().hex, count=min(self.settings.max_detections, math.floor(raw + .5)),
                detections=[], density_count=raw, method="density", image=ImageDimensions(width=frame.width, height=frame.height),
                model=self.settings.density_model_path.name, processing_ms=round(elapsed * 1000, 2), warnings=warnings,
                inference=InferenceDetails(strategy="whole", tiles_processed=1, tiles_planned=1,
                    complete=complete, truncated=capped, max_detections=self.settings.max_detections))
        finally:
            self._lock.release()

    def _count(self, frame):
        import torch
        from torchvision.transforms.functional import normalize, to_tensor

        # Preserve the whole view and aspect ratio. The author's NWPU inference
        # uses CLIP RGB normalization and a minimum input edge. Bound large
        # images to 4K/10MP before tensor allocation; no density map is resized
        # or summed across overlapping tiles (which would duplicate mass).
        width, height = frame.size
        scale = max(1., self.settings.density_min_size / min(width, height))
        scale = min(scale, self.settings.density_max_size / max(width, height),
                    math.sqrt(10_000_000 / (width * height)))
        target = (max(1, round(width * scale)), max(1, round(height * scale)))
        source = frame if target == frame.size else frame.resize(target, resample=3)
        try:
            tensor = to_tensor(source).unsqueeze(0).to(self.settings.device)
            tensor = normalize(tensor, [.48145466, .4578275, .40821073], [.26862954, .26130258, .27577711])
            with torch.inference_mode():
                density = self._model(tensor)
                if density.ndim != 4 or density.shape[:2] != (1, 1) or not torch.isfinite(density).all() or (density < 0).any():
                    raise RuntimeError("Density model returned an invalid map.")
                return float(density.sum().item())
        finally:
            if source is not frame:
                source.close()
