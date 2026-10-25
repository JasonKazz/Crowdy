"""Pinned author-published ZIP-N weights; setup-only network access."""

import hashlib
import os
from pathlib import Path
import tempfile
import urllib.request

REVISION = "5885abd667066660bd094cec2d584e5926371914"
SHA256 = "30474977b7979394469802b0b5e57476391252c86a1e5fd3248aa255d28d817e"
SIZE = 13735297
URL = f"https://huggingface.co/Yiming-M/ZIP-N/resolve/{REVISION}/checkpoints/nwpu/best_mae.pth"


def verify_weights(path):
    path = Path(path)
    if path.stat().st_size != SIZE or hashlib.sha256(path.read_bytes()).hexdigest() != SHA256:
        raise RuntimeError("ZIP-N weights do not match the pinned official checkpoint SHA-256.")


def prepare_weights(output):
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists():
        verify_weights(output)
        return output
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=output.parent, suffix=".download", delete=False) as target:
            temporary = Path(target.name)
            with urllib.request.urlopen(URL, timeout=30) as source:
                received = 0
                while chunk := source.read(64 * 1024):
                    received += len(chunk)
                    if received > SIZE:
                        raise RuntimeError("ZIP-N checkpoint exceeds the pinned size.")
                    target.write(chunk)
        verify_weights(temporary)
        os.replace(temporary, output)
        return output
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
