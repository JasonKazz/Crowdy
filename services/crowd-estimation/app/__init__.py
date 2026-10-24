"""Crowdy's independent crowd-estimation service."""

import os

# Keep Pillow's native opener before Ultralytics replaces PIL.Image.open with
# an optional HEIF fallback. Uploads support only the installed still decoders.
from PIL.Image import open as pillow_open

# Apply before any service entry point imports Ultralytics. Dependency installs
# belong to the build; the explicit download_model command still fetches weights.
os.environ["YOLO_AUTOINSTALL"] = "false"
