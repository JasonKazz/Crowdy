"""Calibrate only from explicit image evidence; never assume a door or room size."""
import math
import statistics

from app.schemas.extraction import CalibrationInfo, ScaleReference, SourceImage

UNIT_METRES = {"m": 1, "cm": .01, "mm": .001, "ft": .3048, "in": .0254}


def calibrate(source: SourceImage, references: list[ScaleReference], provider: str,
              manual: bool = False) -> tuple[SourceImage | None, str]:
    candidates = []
    for item in references:
        reference = item.model_copy(deep=True)
        if provider == "gemini" and not manual:
            for point in (reference.start, reference.end):
                point.x *= source.width_px / 1000
                point.y *= source.height_px / 1000
        points = (reference.start, reference.end)
        if any(not (0 <= p.x <= source.width_px and 0 <= p.y <= source.height_px) for p in points):
            if manual:
                raise ValueError("Place both measurement points inside the image")
            continue
        pixels = math.hypot(points[1].x - points[0].x, points[1].y - points[0].y)
        if pixels < (5 if manual else max(20, min(source.width_px, source.height_px) * .05)):
            if manual:
                raise ValueError("Choose two distinct points farther apart on the image")
            continue
        scale = reference.distance * UNIT_METRES[reference.unit] / pixels
        if 0 < scale <= 100:
            candidates.append((scale, reference, pixels))
    if not candidates:
        return None, "No readable dimension or scale bar was found. Mark one known distance to continue."
    median = statistics.median(scale for scale, _, _ in candidates)
    # Conflicting references can mean a misread unit, multiple drawing scales,
    # or a stretched scan. Do not choose whichever happens to look plausible.
    if any(abs(scale / median - 1) > .08 for scale, _, _ in candidates):
        return None, "The printed dimensions disagree. Mark one known distance to set the scale."
    scale, best, _ = max(candidates, key=lambda candidate: candidate[2])
    if max(source.width_px, source.height_px) * scale > 1000:
        return None, "The detected scale makes this image unusually large. Confirm one known distance."
    calibration = CalibrationInfo(method="manual" if manual else "automatic", label=best.label,
                                  references=[reference for _, reference, _ in candidates])
    return source.model_copy(update={"meters_per_pixel": scale, "scale_confirmed": True,
                                     "calibration": calibration}), ""


def recalibrate_layout(layout, reference: ScaleReference):
    if layout.source_image is None:
        raise ValueError("This layout has no source image to calibrate")
    source, reason = calibrate(layout.source_image, [reference], "claude", manual=True)
    if source is None:
        raise ValueError(reason)
    factor = source.meters_per_pixel / layout.source_image.meters_per_pixel
    data = layout.model_dump(mode="json")
    def point(p):
        return [value * factor for value in p]
    for collection in ("walkable_areas", "furniture", "rooms"):
        for region in data[collection]:
            region["polygon"] = [point(p) for p in region["polygon"]]
    for wall in data["walls"]:
        wall["start"], wall["end"] = point(wall["start"]), point(wall["end"])
        wall["thickness"] *= factor
    for door in data["doors"]:
        door["offset"] *= factor
        door["width"] *= factor
    for exit in data["exits"]:
        if "polygon" in exit:
            exit["polygon"] = [point(p) for p in exit["polygon"]]
        else:
            exit["offset"] *= factor
            exit["width"] *= factor
    for boundary in data["exit_boundaries"]:
        boundary["start"], boundary["end"] = point(boundary["start"]), point(boundary["end"])
    for person in data["occupants"]:
        person["position"] = point(person["position"])
    # Outside landings, agent dimensions, speeds, and time settings are physical
    # simulation parameters, not measurements taken from the source image.
    data["source_image"] = source.model_dump(mode="json")
    return type(layout).model_validate(data)
