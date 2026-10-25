"""Bounded whole-plan imports with one conditional structural review."""

from contextlib import contextmanager
import json
import os
import threading
import time

from app.schemas.extraction import ExtractedDrawing
from app.services.floorplans.providers import ProviderError, extract_structured, extraction_deadline
from app.services.floorplans.structure_pass import STRUCTURAL_PROMPT, StructuralDrawing, expand_structure

INTERACTIVE_TIME_BUDGET = 85
DIAGNOSTIC_TIME_BUDGET = 600
EXTRACTION_MODE_ENV = "CROWDY_FLOORPLAN_EXTRACTION_MODE"
INTERACTIVE_REVIEW_WARNING = (
    "Whole-plan extraction is a draft. Compare all walls, doors, exits and furniture with the source image "
    "before running a simulation; small or unclear features may be missed."
)


def extraction_mode() -> str:
    mode = os.environ.get(EXTRACTION_MODE_ENV, "").strip() or "interactive"
    if mode not in {"interactive", "diagnostic_staged"}:
        raise ProviderError(f"Set {EXTRACTION_MODE_ENV} to interactive or diagnostic_staged.")
    return mode


def check_extraction_time(deadline: float, cancelled: threading.Event | None = None):
    if cancelled is not None and cancelled.is_set():
        raise ProviderError("Image import was cancelled. Your current floor plan is unchanged.")
    if time.monotonic() >= deadline:
        raise ProviderError("Image import exceeded its processing time limit. Try a cropped floor plan or the other provider.")


def validate_interactive_observations(drawing: ExtractedDrawing):
    # A model can produce room labels and an outline while explicitly abstaining
    # from every physical feature. Do not present that as a completed extraction.
    # An unfurnished/open hall with observed exits remains a valid observation.
    if not any((drawing.walls, drawing.doors, drawing.furniture, drawing.exits)):
        raise ProviderError(
            "No usable walls, door openings, exits or furniture could be identified. "
            "No complete layout was imported. Try a clearer image of one floor or a smaller crop."
        )


def review_interactive_structure(provider: str, image: bytes, width: int, height: int,
                                 drawing: ExtractedDrawing, progress=None):
    """At most one targeted whole-frame follow-up; never tile or retry geometry.

    Existing walls/doors win when already observed. The follow-up can recover
    missing structure and missing exterior openings, without deduplicating away
    any original observations or guessing connections between them.
    """
    if drawing.exits and (drawing.walls or not drawing.rooms):
        return drawing, None
    if progress:
        progress("Checking walls and exterior openings")
    coordinates = (
        "Use the SAME independently normalized 0..1000 x/y coordinates as the supplied outline. "
        "Wall thickness is thousandths of the shorter image dimension."
        if provider == "gemini" else
        f"Use absolute pixels in the SAME {width} by {height} full image. Wall thickness is in pixels."
    )
    prompt = (
        "Inspect this WHOLE floor-plan image for architectural walls and actual door openings. "
        "There are no detail tiles or later passes. Gray floor/access-zone shading does not erase the "
        "visible thin wall linework within it. Trace identifiable partitions even when their door symbols are faint. "
        "Paired door leaves/jamb symbols at an exterior wall are observed openings: locate their actual jambs; "
        "do not merely list their locations in warnings. Do not invent an opening when jambs are unreadable. "
        "Floor/mezzanine labels can refer to different levels; do not invent connections or treat stairs as exterior exits. "
        + coordinates + "\n" + STRUCTURAL_PROMPT + "\n"
        "The first observation supplies this floor outline in the same coordinate frame. Use it to align "
        "actual exterior threshold markers to its straight boundary edges, at the observed jambs. "
        "If the image contradicts the outline, report that uncertainty; do not move an opening to an unrelated edge "
        "or invent geometry just to make validation succeed.\nFLOOR OUTLINE:\n"
        + json.dumps([point.model_dump() for point in drawing.floor_outline])
    )
    observed, model = extract_structured(provider, image, prompt, StructuralDrawing)
    expanded = expand_structure(observed)
    expected_segments = sum(len(path.points) - 1 for path in observed.wall_paths)
    if len(expanded["walls"]) != expected_segments or len(expanded["doors"]) != len(observed.openings):
        raise ProviderError("The structural review contained invalid wall segments or door references. No complete layout was imported.")
    data = drawing.model_dump(mode="json")
    if not drawing.walls:
        # Prefix IDs so independently generated names cannot collide with an
        # original door/obstacle/exit. Do not replace any existing door record.
        wall_ids = {wall["id"]: f"structure_review:{wall['id']}" for wall in expanded["walls"]}
        data["walls"] = [{**wall, "id": wall_ids[wall["id"]]} for wall in expanded["walls"]]
        door_ids = {door["id"] for door in data["doors"]}
        for door in expanded["doors"]:
            identifier = f"structure_review:{door['id']}"
            while identifier in door_ids:
                identifier = f"structure_review:{identifier}"
            door_ids.add(identifier)
            data["doors"].append({**door, "id": identifier, "wall_id": wall_ids[door["wall_id"]]})
    if not drawing.exits:
        data["exits"] = expanded["exits"]
    notes = [f"Structural review: {note}" for note in expanded["warnings"]]
    if not data["exits"]:
        notes.insert(0, "No exterior opening could be verified. Add or correct observed exits over the image before running.")
    data["warnings"] = list(dict.fromkeys([*notes, *drawing.warnings]))[:30]
    reviewed = ExtractedDrawing.model_validate(data)
    return reviewed, {"model": model, "observations": observed.model_dump(mode="json"),
                      "adopted_walls": not bool(drawing.walls), "adopted_exits": not bool(drawing.exits)}


@contextmanager
def extraction_scope(mode: str, *, deadline: float | None = None, cancelled: threading.Event | None = None):
    # The caller can start the budget before upload decoding/storage. All
    # providers in a comparison share that deadline, rather than restarting it.
    budget = INTERACTIVE_TIME_BUDGET if mode == "interactive" else DIAGNOSTIC_TIME_BUDGET
    expires = time.monotonic() + budget
    if deadline is not None:
        expires = min(expires, deadline)
    with extraction_deadline(expires, cancelled=cancelled):
        check_extraction_time(expires, cancelled)
        yield expires
