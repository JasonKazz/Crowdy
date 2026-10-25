"""Read-only image evidence for an already proposed solid wall fragment.

This is a conservative support check, not wall detection. Callers must split out
observed door openings first. No endpoint search, snapping, or geometry changes
are performed. Neutral furniture/dimension lines can resemble walls; a positive
result alone does not establish that a line is an architectural partition.
"""

import math
from statistics import median

from PIL import Image

from app.services.floorplans.providers import _check_extraction_budget


# These are physical source-pixel limits, independent of model coordinate space.
# Reject larger requests instead of widening the search or thinning samples,
# which could accidentally accept unrelated linework or skip a real doorway.
MAX_WALL_THICKNESS_PX = 32
MAX_CENTER_SAMPLES = 16_384
_BUDGET_CHECK_INTERVAL = 128


def wall_evidence(
    start: tuple[float, float],
    end: tuple[float, float],
    thickness: float,
    source: Image.Image,
) -> dict:
    """Check for continuous neutral, dark linework near a solid centerline.

    Coordinates and thickness are in source-image pixels. Evidence is searched
    only within ``thickness / 2 + 1`` pixels of the supplied centerline, allowing
    raster rounding without moving the proposed wall. A high overall support
    fraction cannot compensate for a meaningful continuous blank gap.

    Faint lines need at least 12 intensity levels of local contrast on average
    and 6 on each flank. Colored marks and uniform gray room fills provide no
    support. Missing image pixels are never treated as white background. Very
    wide/long proposals are rejected before scanning; active extraction deadline
    and cancellation checks also run throughout the scan.
    """
    _check_extraction_budget()
    result = {
        "accepted": False,
        "support": 0.0,
        "count": 0,
        "supported_count": 0,
        "in_bounds_fraction": 0.0,
        "longest_unsupported_px": 0.0,
        "allowed_gap_px": 0.0,
        "median_contrast": 0.0,
        "reason": "invalid_geometry",
    }
    try:
        sx, sy = map(float, start)
        ex, ey = map(float, end)
        thickness = float(thickness)
    except (TypeError, ValueError):
        return result
    if not all(math.isfinite(v) for v in (sx, sy, ex, ey, thickness)) or thickness <= 0:
        return result
    length = math.hypot(ex - sx, ey - sy)
    if not math.isfinite(length) or length < 1:
        return result
    if thickness > MAX_WALL_THICKNESS_PX or thickness > max(source.size):
        result["reason"] = "unsupported_thickness"
        return result
    if length > MAX_CENTER_SAMPLES / 2:
        result["reason"] = "scan_limit"
        return result

    # Transparent source backgrounds should behave like a white plan sheet.
    if "A" in source.getbands() or "transparency" in source.info:
        rgba = source.convert("RGBA")
        rgb = Image.new("RGBA", rgba.size, "white")
        rgb.alpha_composite(rgba)
        rgb = rgb.convert("RGB")
    else:
        rgb = source.convert("RGB")
    _check_extraction_budget()
    pixels = rgb.load()
    width, height = rgb.size

    def neutral_gray(x: float, y: float) -> float | None:
        px, py = round(x), round(y)
        if not (0 <= px < width and 0 <= py < height):
            return None
        r, g, b = pixels[px, py]
        if max(r, g, b) - min(r, g, b) > 30:
            return None
        return (r + g + b) / 3

    nx, ny = -(ey - sy) / length, (ex - sx) / length
    radius = thickness / 2 + 1
    # A dense normal profile avoids skipping the very short pixel intersections
    # made by one-pixel diagonal raster lines. This does not widen the corridor.
    offset_count = max(1, math.ceil(radius * 8))
    offsets = [radius * i / offset_count for i in range(-offset_count, offset_count + 1)]
    flank = radius + 2
    count = max(4, math.ceil(length * 2))
    step = length / count
    supported_count = in_bounds_count = run = longest_run = 0
    contrasts = []

    for i in range(count):
        if i % _BUDGET_CHECK_INTERVAL == 0:
            _check_extraction_budget()
        t = (i + 0.5) / count
        x, y = sx + (ex - sx) * t, sy + (ey - sy) * t
        center_is_in_bounds = 0 <= x < width and 0 <= y < height
        in_bounds_count += center_is_in_bounds
        center = [
            value
            for offset in offsets
            if (value := neutral_gray(x + nx * offset, y + ny * offset)) is not None
        ]
        sides = []
        for sign in (-1, 1):
            values = [
                value
                for offset in (-0.5, 0, 0.5)
                if (value := neutral_gray(x + nx * (sign * flank + offset),
                                          y + ny * (sign * flank + offset))) is not None
            ]
            sides.append(median(values) if len(values) >= 2 else None)
        supported = False
        if center_is_in_bounds and center and all(side is not None for side in sides):
            darkest = min(center)
            contrast = (sides[0] + sides[1]) / 2 - darkest
            supported = min(sides) - darkest >= 6 and contrast >= 12
            if supported:
                contrasts.append(contrast)
        if supported:
            supported_count += 1
            run = 0
        else:
            run += 1
            longest_run = max(longest_run, run)

    _check_extraction_budget()
    support = supported_count / count
    longest_gap = longest_run * step
    # Ignore up to ~two pixels of raster dropout, but never a door-sized gap.
    allowed_gap = max(2.0, min(4.0, thickness + 0.5))
    accepted = support >= 0.85 and longest_gap <= allowed_gap and in_bounds_count == count
    if in_bounds_count != count:
        reason = "outside_source"
    elif support < 0.85:
        reason = "insufficient_linework"
    elif longest_gap > allowed_gap:
        reason = "unsupported_gap"
    else:
        reason = "consistent_linework"
    result.update(
        accepted=accepted,
        support=round(support, 4),
        count=count,
        supported_count=supported_count,
        in_bounds_fraction=round(in_bounds_count / count, 4),
        longest_unsupported_px=round(longest_gap, 3),
        allowed_gap_px=allowed_gap,
        median_contrast=round(median(contrasts), 3) if contrasts else 0.0,
        reason=reason,
    )
    return result
