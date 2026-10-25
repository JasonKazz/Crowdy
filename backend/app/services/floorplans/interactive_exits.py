"""Bounded source-detail review when whole-plan doorway observations are incomplete."""

from concurrent.futures import ThreadPoolExecutor
from contextvars import copy_context
import io
import json
import math
import re

from PIL import Image
from shapely.geometry import LineString, Point, Polygon
from shapely.ops import substring

from app.schemas.extraction import ExtractedDrawing
from app.services.floorplans.entrance_review import (
    ENTRANCE_PROMPT, EntranceSurvey, apply_survey, install_openings, replace_boundary_section,
)
from app.services.floorplans.providers import ProviderError, extract_structured
from app.services.floorplans.staged import for_provider, to_pixels

MAX_ENTRANCE_REGIONS = 6


def uncertain_exits(drawing):
    if not drawing.exits:
        return True
    # A partial count must not suppress review just because one door was found.
    for note in drawing.warnings:
        if (re.search(r"exterior|outer wall|perimeter", note, re.I)
                and re.search(r"door|exit|opening|entrance", note, re.I)
                and re.search(r"unclear|unreadable|too small|not .*reliab|not .*clear|no exits|no openings|partial|omit|missing|uncertain|approximate", note, re.I)):
            return True
    boundary = Polygon([(p.x, p.y) for p in drawing.floor_outline]).boundary
    # Compare observations in SOURCE PIXELS, before a user supplies scale.
    # A threshold touching the edge needs no correction. A coarse marker that
    # misses the outline needs a source survey, rather than an invented snap.
    vertices = [(p.x, p.y) for p in drawing.floor_outline]
    for marker in drawing.exits:
        shape = Polygon([(p.x, p.y) for p in marker.polygon])
        if shape.distance(boundary) > 2:
            return True
        left, top, right, bottom = shape.bounds
        center = Point((left + right) / 2, (top + bottom) / 2)
        edges = [LineString([a, b]) for a, b in zip(vertices, [*vertices[1:], vertices[0]])
                 if math.dist(a, b) > 1e-6]
        if not edges:
            return True
        edge = min(edges, key=center.distance)
        a, b = edge.coords
        ux, uy = (b[0] - a[0]) / edge.length, (b[1] - a[1]) / edge.length
        spans = [(p.x - a[0]) * ux + (p.y - a[1]) * uy for p in marker.polygon]
        if min(spans) < -2 or max(spans) > edge.length + 2:
            return True
    return False


def entrance_windows(drawing, size):
    """Cover the actual perimeter with at most six overlapping local views.

    Arc lengths keep curved buildings and entrance recesses in context, instead
    of spending requests on blank image tiles. Each core owns one sixth of the
    perimeter; the image halo supplies wall linework on either side.
    """
    vertices = [(p.x, p.y) for p in drawing.floor_outline]
    boundary = LineString([*vertices, vertices[0]])
    count = min(MAX_ENTRANCE_REGIONS, max(2, math.ceil(boundary.length / 900)))
    windows = []
    for index in range(count):
        core = substring(boundary, index / count, (index + 1) / count, normalized=True)
        left, top, right, bottom = core.bounds
        bounds = (max(0, math.floor(left - 80)), max(0, math.floor(top - 80)),
                  min(size[0], math.ceil(right + 80)), min(size[1], math.ceil(bottom + 80)))
        if bounds[2] - bounds[0] >= 2 and bounds[3] - bounds[1] >= 2:
            windows.append((bounds, list(core.coords)))
    return windows


def review_interactive_exits(provider, image, width, height, drawing, progress=None):
    """Observe real jambs at readable resolution, sharing the import deadline.

    Geometry is changed only by a validated survey of the original image.
    Missing/failed surveys remain explicit warnings and never synthesize exits.
    """
    canonical = ExtractedDrawing.model_validate(to_pixels(drawing, provider, (width, height)))
    if not uncertain_exits(canonical):
        return drawing, None
    source = Image.open(io.BytesIO(image)).convert("RGB")
    windows = entrance_windows(canonical, source.size)
    if progress:
        progress(f"Checking {len(windows)} exterior entrance regions at source resolution")

    def observe(index, window):
        bounds, core = window
        crop = source.crop(bounds)
        native_size = crop.size
        factor = 1000 / max(native_size)
        crop = crop.resize(tuple(max(1, round(side * factor)) for side in native_size), Image.Resampling.LANCZOS)
        sx, sy = crop.width / native_size[0], crop.height / native_size[1]
        local = [[(x - bounds[0]) * sx, (y - bounds[1]) * sy] for x, y in core]
        if provider == "gemini":
            local = [[x * 1000 / crop.width, y * 1000 / crop.height] for x, y in local]
            coordinate = "x and y independently range 0..1000 across THIS crop, origin top-left."
        else:
            coordinate = f"Absolute pixels in THIS {crop.width} by {crop.height} crop, origin top-left."
        prompt = (ENTRANCE_PROMPT + "\n" + coordinate
            + "\nThe approximate exterior boundary segment below locates the area to review. "
            "Trace that SAME boundary from the actual image, correcting its coarse curve/chords at real thresholds. "
            "Include ALL actual exterior openings on this segment. Other lines in the crop may be interior "
            "partitions or mezzanines; do not turn those into exterior exits. Return no openings when jambs are unreadable. "
            "The hint is approximate context, never evidence of a door.\nBOUNDARY SEGMENT:\n" + json.dumps(local))
        encoded = io.BytesIO()
        crop.save(encoded, "PNG")
        try:
            survey, model = extract_structured(provider, encoded.getvalue(), prompt, EntranceSurvey)
            return index, bounds, native_size, crop.size, survey, model, None
        except (ProviderError, ValueError) as exc:
            return index, bounds, native_size, crop.size, None, None, str(exc)

    # At most three requests at once, all under the same context/deadline. Results
    # are applied in perimeter order so overlap reconciliation is deterministic.
    with ThreadPoolExecutor(max_workers=3) as pool:
        futures = [pool.submit(copy_context().run, observe, index + 1, window)
                   for index, window in enumerate(windows)]
        observations = [future.result() for future in futures]
    records = []
    accepted = 0
    for index, bounds, native_size, size, survey, model, error in observations:
        record = {"region": index, "bounds": bounds, "model": model, "openings": 0}
        if error:
            record["error"] = error
            canonical.warnings.append(f"Exterior entrance region {index} could not be verified; inspect its openings.")
        else:
            snapshot = canonical.model_copy(deep=True)
            try:
                path, openings = apply_survey(canonical, "", survey, size, bounds[:2], native_size, provider)
                boundary = Polygon([(p.x, p.y) for p in canonical.floor_outline]).boundary
                revised = bool(openings) and replace_boundary_section(canonical, path, source.size)
                aligned = bool(openings) and boundary.buffer(2).covers(LineString(path))
                if revised or aligned:
                    install_openings(canonical, f"entrance-region-{index}", path, openings)
                    record.update(openings=len(openings), boundary_refined=bool(revised))
                    accepted += len(openings)
                canonical.warnings.extend(f"Exterior entrance region {index}: {note}" for note in survey.warnings)
                record["survey"] = survey.model_dump(mode="json")
            except ValueError as exc:
                canonical = snapshot
                record["error"] = str(exc)
                canonical.warnings.append(f"Exterior entrance region {index} needs review; no unverified geometry was added.")
        records.append(record)
    if accepted:
        original_notes = set(drawing.warnings)
        canonical.warnings = [f"Initial whole-plan observation: {note}" if note in original_notes else note
                              for note in canonical.warnings]
        canonical.warnings.insert(0, "Source-detail entrance surveys completed. Review the overlay against the image; other unclear openings may remain.")
    else:
        canonical.warnings.insert(0, "Source-detail review could not verify exterior door jambs. Add/correct observed exits before running.")
    canonical.warnings = list(dict.fromkeys(canonical.warnings))[:30]
    return for_provider(canonical, provider, source.size), {"regions": records, "verified_openings": accepted}
