"""Explicit local evaluation; never run on startup or store uploaded images."""

import argparse
import json
from pathlib import Path
import struct
import zlib

from PIL import Image, ImageOps

from app.config import Settings
from app.estimator import CrowdEstimator


def ucf_annotation_count(path):
    """Read the point matrix dimensions in original UCF-CC-50 MATLAB v5 labels.

    This avoids adding a scientific-file dependency to the inference container.
    Only the original little-endian, one-matrix label format is accepted.
    """
    data = Path(path).read_bytes()
    if data[126:128] != b"IM":
        raise ValueError("Expected original little-endian MATLAB v5 annotations")
    kind, size = struct.unpack_from("<II", data, 128)
    matrix = zlib.decompress(data[136:136 + size]) if kind == 15 else data[128:]
    kind, _ = struct.unpack_from("<II", matrix)
    if kind != 14:
        raise ValueError("Expected one annotation matrix")
    _, flags_size = struct.unpack_from("<II", matrix, 8)
    position = 16 + ((flags_size + 7) // 8) * 8
    kind, size = struct.unpack_from("<II", matrix, position)
    if kind != 5 or size != 8:
        raise ValueError("Expected a two-dimensional annotation matrix")
    rows, columns = struct.unpack_from("<ii", matrix, position + 8)
    if columns != 2 or rows < 0:
        raise ValueError("Expected an N×2 head-point matrix")
    return rows


def main():
    parser = argparse.ArgumentParser(description="Evaluate actual local images; no downloads or uploads.")
    parser.add_argument("images", nargs="+", type=Path)
    parser.add_argument("--ucf-labels", action="store_true", help="Read adjacent original *_ann.mat UCF-CC-50 labels")
    args = parser.parse_args()
    settings = Settings.from_env()
    if settings.method == "density":
        from app.density import DensityEstimator
        detector = DensityEstimator(settings)
    else:
        detector = CrowdEstimator(settings)
    detector.load()
    for path in args.images:
        with Image.open(path) as source, ImageOps.exif_transpose(source).convert("RGB") as frame:
            estimate = detector.estimate(frame)
            report = {"image": path.name, "dimensions": estimate.image.model_dump(),
                      "count": estimate.count, "method": estimate.method,
                      "density_count": estimate.density_count,
                      "processing_ms": estimate.processing_ms, "inference": estimate.inference.model_dump()}
            if args.ucf_labels:
                truth = ucf_annotation_count(path.with_name(path.stem + "_ann.mat"))
                predicted = estimate.density_count if estimate.method == "density" else estimate.count
                report.update(annotated_count=truth, absolute_error=abs(predicted - truth),
                              relative_error=abs(predicted - truth) / truth if truth else None)
            print(json.dumps(report), flush=True)


if __name__ == "__main__":
    main()
