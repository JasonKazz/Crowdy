"""Prefer measured scale; otherwise estimate from several classified objects."""
import math
import re
import statistics

from shapely.geometry import Polygon

from app.schemas.extraction import CalibrationInfo, EstimatedObject, ExtractedDrawing, ScaleObject, ScaleReference, SourceImage

UNIT_METRES = {"m": 1, "cm": .01, "mm": .001, "ft": .3048, "in": .0254}
# Prototype assumptions, not standards or statistically calibrated confidence bounds.
# (nominal size, plausible lower size, plausible upper size), in metres.
OBJECT_SIZES = {"single_door": (.90, .75, 1.05), "office_chair": (.60, .45, .75),
                "office_desk": (1.40, 1.00, 1.80)}


def calibrate_drawing(source: SourceImage, drawing: ExtractedDrawing, provider: str):
    measured, reason = calibrate(source, drawing.scale_references, provider)
    if measured is not None:
        return measured, ""
    # Conflicting or unusable printed evidence needs human review, not a guess
    # that silently overrides a potentially meaningful dimension.
    if drawing.scale_references:
        return None, reason
    estimated, estimate_reason = estimate_scale(source, drawing, provider)
    if estimated is None:
        supplemented, inferred_ids = supplement_scale_objects(source, drawing, provider)
        if inferred_ids:
            estimated, estimate_reason = estimate_scale(source, supplemented, provider, inferred_ids)
    return (estimated, "") if estimated is not None else (None, f"{reason} {estimate_reason}")


def _object_evidence(source, drawing, provider, inferred_ids=()):
    def pixel(point):
        return (point.x * source.width_px / 1000, point.y * source.height_px / 1000) if provider == "gemini" else (point.x, point.y)

    objects = {}
    ambiguous_ids = set()
    for collection, items in (("door", drawing.doors), ("exit", drawing.exits), ("furniture", drawing.furniture)):
        for item in items:
            if item.id in objects:
                ambiguous_ids.add(item.id)
            objects[item.id] = (collection, item)
    evidence = []
    seen_ids, seen_shapes = set(), set()
    for reference in drawing.scale_objects:
        if reference.object_id in seen_ids or reference.object_id in ambiguous_ids:
            continue
        seen_ids.add(reference.object_id)
        existing = objects.get(reference.object_id)
        if existing is None:
            continue
        collection, item = existing
        if (reference.kind == "single_door") != (collection in ("door", "exit")):
            continue
        points = [pixel(item.start), pixel(item.end)] if collection == "door" else [pixel(p) for p in item.polygon]
        if any(not (0 <= x <= source.width_px and 0 <= y <= source.height_px) for x, y in points):
            continue
        # Duplicate geometry under different IDs is still one observation.
        shape = tuple(sorted((round(x, 2), round(y, 2)) for x, y in points))
        if shape in seen_shapes:
            continue
        seen_shapes.add(shape)
        if collection == "door":
            pixels = math.dist(*points)
        else:
            polygon = Polygon(points)
            if not polygon.is_valid or polygon.area <= 0:
                continue
            corners = list(polygon.minimum_rotated_rectangle.exterior.coords)
            sides = [math.dist(a, b) for a, b in zip(corners, corners[1:])]
            pixels = max(sides)
            # Reject strip-like footprints. Semantic exclusions are in the prompt.
            if reference.kind != "single_door" and min(sides) / pixels < (.35 if reference.kind == "office_desk" else .55):
                continue
        if pixels < max(6, min(source.width_px, source.height_px) * .01):
            continue
        nominal = OBJECT_SIZES[reference.kind][0]
        evidence.append(EstimatedObject(**reference.model_dump(), observed_pixels=pixels, assumed_metres=nominal,
            origin="geometry" if reference.object_id in inferred_ids else "model"))
    return evidence


def supplement_scale_objects(source, drawing, provider):
    """Recover omitted classifier entries using labeled, already extracted geometry.

    Furniture anchors must agree before inferring any single-width door. Wide
    double openings fail that check; this is still an assumption, not proof of
    a door's leaf count or an independently measured scale.
    """
    references = list(drawing.scale_objects)
    known = {item.object_id for item in references}
    inferred_ids = set()
    for item in drawing.furniture:
        label = item.label.lower().strip()
        if item.id in known or re.search(r"\b(bank|group|row|conference|reception|welcome|counter|bench|lounge|sofa)\b", label):
            continue
        if re.search(r"\bdesk\b", label):
            kind = "office_desk"
        elif re.search(r"\b(office|task|swivel|desk) chair\b", label) or (label == "chair" and "office" in drawing.name.lower()):
            kind = "office_chair"
        else:
            continue
        references.append(ScaleObject(object_id=item.id, kind=kind))
        known.add(item.id)
        inferred_ids.add(item.id)
    supplemented = drawing.model_copy(update={"scale_objects": references})
    evidence = _object_evidence(source, supplemented, provider)
    anchors = [item for item in evidence if item.kind != "single_door"]
    if len(anchors) >= 2:
        anchor_scales = [item.assumed_metres / item.observed_pixels for item in anchors]
        anchor = statistics.median(anchor_scales)
        if all(abs(value / anchor - 1) <= .20 for value in anchor_scales):
            for door in drawing.doors:
                if door.id in known:
                    continue
                reference = ScaleObject(object_id=door.id, kind="single_door")
                candidate = drawing.model_copy(update={"scale_objects": [reference]})
                door_evidence = _object_evidence(source, candidate, provider, {door.id})
                # Apply the final category-balanced consensus, not a separate
                # relative-to-furniture cutoff that can reject overlapping ranges.
                if door_evidence and _estimate_evidence(source, [*evidence, *door_evidence])[0] is not None:
                    references.append(reference)
                    evidence.extend(door_evidence)
                    inferred_ids.add(door.id)
    return drawing.model_copy(update={"scale_objects": references}), inferred_ids


def estimate_scale(source: SourceImage, drawing: ExtractedDrawing, provider: str, inferred_ids=()):
    return _estimate_evidence(source, _object_evidence(source, drawing, provider, inferred_ids))


def _estimate_evidence(source, evidence):
    groups, intervals = {}, []
    for item in evidence:
        nominal, low, high = OBJECT_SIZES[item.kind]
        groups.setdefault(item.kind, []).append(nominal / item.observed_pixels)
        intervals.append((low / item.observed_pixels, high / item.observed_pixels))
    if len(evidence) < 3 or len(groups) < 2:
        return None, "An estimate needs at least three clear objects across two types (doors, office chairs, desks)."
    # Give each category equal weight so repeated chairs cannot drown out doors.
    medians = [statistics.median(values) for values in groups.values()]
    scale = statistics.median(medians)
    if any(abs(value / scale - 1) > .25 for values in groups.values() for value in values):
        return None, "Door and furniture sizes suggest conflicting scales. Use a known measurement."
    low, high = max(pair[0] for pair in intervals), min(pair[1] for pair in intervals)
    if low > high:
        return None, "Object-size assumptions do not agree. Use a known measurement."
    scale = min(high, max(low, scale))
    if any(abs(value / scale - 1) > .25 for values in groups.values() for value in values):
        return None, "Object-size assumptions do not agree. Use a known measurement."
    if max(source.width_px, source.height_px) * scale > 1000:
        return None, "The estimated building size is implausibly large. Use a known measurement."
    counts = {kind: sum(obj.kind == kind for obj in evidence) for kind in groups}
    names = {"single_door": "single door", "office_chair": "office chair", "office_desk": "office desk"}
    label = ", ".join(f"{count} {names[kind]}{'s' if count != 1 else ''} (assumed {OBJECT_SIZES[kind][0]:g} m)" for kind, count in counts.items())
    return source.model_copy(update={"meters_per_pixel": scale, "scale_confirmed": False,
        "calibration": CalibrationInfo(method="estimated", label=label, estimated_objects=evidence,
                                       meters_per_pixel_range=(low, high))}), ""


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
