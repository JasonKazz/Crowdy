"""Decode bounded still images without retaining originals or trusting filenames."""

import warnings
from io import BytesIO

from PIL import Image, ImageOps, UnidentifiedImageError

from app import pillow_open

ALLOWED_TYPES = {"image/png": "PNG", "image/jpeg": "JPEG", "image/webp": "WEBP"}


class InvalidImage(ValueError):
    pass


def decode_image(data: bytes, content_type: str, max_pixels: int) -> Image.Image:
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with pillow_open(BytesIO(data), formats=tuple(ALLOWED_TYPES.values())) as source:
                if source.format != ALLOWED_TYPES.get(content_type):
                    raise InvalidImage("Image contents must match the PNG, JPEG, or WebP content type.")
                if getattr(source, "n_frames", 1) != 1:
                    raise InvalidImage("Upload a still image. Animated images and video are not supported.")
                if source.width * source.height > max_pixels:
                    raise InvalidImage(f"Resize the image below {max_pixels:,} pixels.")
                source.verify()
            # verify() invalidates the decoder. Reopen, orient, and detach pixels
            # from the upload so detections use the displayed image coordinates.
            with pillow_open(BytesIO(data), formats=tuple(ALLOWED_TYPES.values())) as source:
                oriented = ImageOps.exif_transpose(source)
                try:
                    if "A" in oriented.getbands() or "transparency" in oriented.info:
                        # Match the frontend's displayed white background;
                        # invisible RGB data must not become detected people.
                        with oriented.convert("RGBA") as rgba:
                            background = Image.new("RGB", rgba.size, "white")
                            with rgba.getchannel("A") as alpha:
                                background.paste(rgba, mask=alpha)
                            return background
                    return oriented.convert("RGB")
                finally:
                    oriented.close()
    except InvalidImage:
        raise
    except (UnidentifiedImageError, OSError, ValueError, SyntaxError,
            Image.DecompressionBombError, Image.DecompressionBombWarning) as error:
        raise InvalidImage("The image could not be decoded. Choose a readable PNG, JPEG, or WebP.") from error
