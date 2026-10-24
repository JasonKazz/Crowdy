"""Wall-only observations, independent of dense furniture extraction."""
import math
from typing import Literal

from pydantic import Field

from app.schemas.scenario import InputModel
from app.schemas.extraction import DrawingPoint, DrawingWall, DrawingDoor, DrawingRegion


class WallPath(InputModel):
    id: str
    points: list[DrawingPoint] = Field(min_length=2, max_length=60,
        description="Ordered centerline vertices of ONE actual partition. Follow corners/curves with short segments; reuse shared junction coordinates. Never connect across a real open passage.")
    thickness: float = Field(gt=0)


class PathDoor(InputModel):
    id: str
    path_id: str
    segment_index: int = Field(ge=0, description="Zero-based segment in the named wall path that contains BOTH opening jambs.")
    start: DrawingPoint
    end: DrawingPoint


class StructuralDrawing(InputModel):
    wall_paths: list[WallPath] = Field(max_length=120)
    openings: list[PathDoor] = Field(max_length=120)
    exits: list[DrawingRegion] = Field(max_length=30)
    coverage: Literal["complete", "partial"]
    warnings: list[str] = Field(max_length=20)


STRUCTURAL_PROMPT = """STAGE: architectural WALLS AND DOORWAYS ONLY. Ignore furniture inventory.
Inspect every visible physical partition in this magnified crop, even thin/light-gray lines
and walls around or WITHIN gray-shaded staff offices, breakout rooms, restrooms and service rooms.
The gray FILL is an access annotation, but BLACK/GRAY WALL LINES inside and around it are real
partitions and must still be traced. A room polygon or access-zone label does not replace its walls.
Trace straight, angled and curved partitions as wall_paths, with ordered centerline points.
A path is one continuous wall; use enough short segments for a curved wall, including circular rooms.
At shared corners/junctions reuse exactly the same point. Do not use a rectangular room bounding box.
Only include actual linework supported by the image. Exclude chair rings, table edges, dimension lines,
text leaders, stage hatching, foldable furniture, diagram markers and the exterior building boundary.
Do not omit all walls because door symbols are unclear: trace visible SOLID WALL SEGMENTS ending
at real passages. Where two door jambs and their parent are clear, include the full virtual wall
centerline through the opening, and put the gap in openings (path_id plus zero-based segment_index).
Doors need both jambs on the same segment. Door swing arcs are evidence, not barriers.
For a clear open passage with no leaf symbol, preserve the gap between solid wall ends; do not close it.
For exterior exits, use a thin polygon at each individual visible clear opening. Separate door groups
when fixed piers/mullions/solid wall sections divide them. Never turn a whole entrance facade into one
opening. Do not interpret arbitrary crop edges, labels alone, or interior doors as exterior exits.
Report unreadable/occluded partitions by location and use coverage=partial. Do not infer hidden walls.
Return empty arrays only for a crop that actually contains no identifiable partitions/openings.
"""


def expand_structure(observation: StructuralDrawing):
    """Give every polyline segment a stable parent ID for the existing compiler."""
    walls, doors, notes = [], [], list(observation.warnings)
    identifiers = set()
    for path in observation.wall_paths:
        if path.id in identifiers:
            raise ValueError("Structural pass returned duplicate wall path IDs")
        identifiers.add(path.id)
        for index, (start,end) in enumerate(zip(path.points,path.points[1:])):
            if math.hypot(end.x-start.x,end.y-start.y) < 1e-6:
                notes.append(f"Ignored zero-length segment {path.id}:{index}")
                continue
            walls.append(DrawingWall(id=f"{path.id}:{index}",start=start,end=end,thickness=path.thickness))
    wall_ids={wall.id for wall in walls}
    for opening in observation.openings:
        parent=f"{opening.path_id}:{opening.segment_index}"
        if parent not in wall_ids:
            notes.append(f"Review opening {opening.id}: no matching wall segment")
            continue
        doors.append(DrawingDoor(id=opening.id,wall_id=parent,start=opening.start,end=opening.end))
    if observation.coverage=="partial":
        notes.insert(0,"Structural crop is partially obscured/unreadable; inspect its wall and doorway coverage.")
    return {"walls":[wall.model_dump() for wall in walls], "doors":[door.model_dump() for door in doors],
            "exits":[item.model_dump() for item in observation.exits], "furniture":[],
            "scale_objects":[],"scale_references":[],"warnings":notes}


class DoorReview(InputModel):
    doors: list[DrawingDoor] = Field(max_length=120)
    warnings: list[str] = Field(max_length=12)


DOOR_PROMPT = """STAGE: interior doorway verification ONLY.
The supplied wall proposals use the SAME coordinates as this image. Look for actual paired
jambs, door leaves/swing symbols and clear openings on these wall centerlines. Return doors
with the exact supplied wall_id and the two observed jamb coordinates; these are openings,
not leaf tips or swing arc endpoints. Ignore exterior exits and any apparent gap caused only
by a colored annotation circle or text overlay. Do not invent a door to connect a room.
If a visible opening has no corresponding supplied wall, report its location in warnings.
Return no door for a wall with no clearly identifiable opening.\nWALL PROPOSALS:\n"""
