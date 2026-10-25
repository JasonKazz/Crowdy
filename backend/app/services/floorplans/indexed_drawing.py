"""Interactive provider geometry whose door jambs belong to wall vertices.

The wire representation is separate from the stored ExtractedDrawing contract.
Both new and previously recorded provider observations decode to that contract.
"""

import copy
import math

from pydantic import Field, PrivateAttr, create_model, model_validator

from app.schemas.extraction import DrawingPoint, ExtractedDrawing
from app.schemas.scenario import InputModel


class IndexedOpening(InputModel):
    id: str = Field(min_length=1)
    segment_index: int = Field(ge=0, description="The actual clear doorway is between points[index] and points[index+1] of this SAME wall run. Those two vertices are the observed jambs, never swing-arc or leaf-tip endpoints.")


class IndexedWallRun(InputModel):
    id: str = Field(min_length=1)
    points: list[DrawingPoint] = Field(min_length=2, max_length=60,
        description="Ordered actual interior wall centerline vertices. Include BOTH jambs of every observed door as adjacent vertices; mark their segment as an opening. Follow real corners and recesses, never a shortcut across open floor.")
    thickness: float = Field(gt=0, description="Full physical wall thickness in the image coordinate contract.")
    openings: list[IndexedOpening] = Field(max_length=100)


class _IndexedGeometry(InputModel):
    wall_runs: list[IndexedWallRun] = Field(max_length=200,
        description="Actual continuous interior wall runs with observed jambs included in their vertices. Split disconnected walls into separate runs. The floor outline already supplies the exterior boundary.")
    _legacy_drawing: ExtractedDrawing | None = PrivateAttr(default=None)

    @model_validator(mode="wrap")
    @classmethod
    def read_recorded_observations(cls, value, handler):
        # Recorded responses and older adapters retain their original geometry.
        # They are never converted by moving independent jambs onto a wall.
        if isinstance(value, dict) and ("walls" in value or "doors" in value):
            legacy = ExtractedDrawing.model_validate(value)
            data = {key: item for key, item in value.items() if key not in {"walls", "doors"}}
            data["wall_runs"] = []
            observed = handler(data)
            observed._legacy_drawing = legacy
            return observed
        return handler(value)

    @model_validator(mode="after")
    def valid_indexed_geometry(self):
        runs, doors, segments = set(), set(), 0
        for run in self.wall_runs:
            if run.id in runs:
                raise ValueError("Interior wall run IDs must be unique")
            runs.add(run.id)
            segments += len(run.points) - 1
            if any(math.hypot(b.x - a.x, b.y - a.y) < 1e-6 for a, b in zip(run.points, run.points[1:])):
                raise ValueError("An interior wall run contains a zero-length segment")
            used = set()
            for door in run.openings:
                if door.id in doors or door.segment_index in used or door.segment_index >= len(run.points) - 1:
                    raise ValueError("Each interior doorway must reference one distinct existing jamb segment")
                doors.add(door.id)
                used.add(door.segment_index)
        if segments > 600 or len(doors) > 600:
            raise ValueError("The indexed drawing exceeds its interior geometry budget")
        return self

    def to_drawing(self):
        if self._legacy_drawing is not None:
            return self._legacy_drawing.model_copy(deep=True)
        data = self.model_dump(exclude={"wall_runs"})
        walls, doors, identifiers = [], [], set()
        for run in self.wall_runs:
            # Keep truly collinear adjacent vertices as one parent. Corners and
            # recesses remain separate parents; no architectural snapping occurs.
            groups, start = [], 0
            for index in range(1, len(run.points) - 1):
                a, b, c = run.points[index - 1:index + 2]
                ux, uy, vx, vy = b.x - a.x, b.y - a.y, c.x - b.x, c.y - b.y
                straight = abs(ux * vy - uy * vx) <= 1e-9 * max(math.hypot(ux, uy), math.hypot(vx, vy)) and ux * vx + uy * vy > 0
                if not straight:
                    groups.append((start, index))
                    start = index
            groups.append((start, len(run.points) - 1))
            for group, (first, last) in enumerate(groups):
                identifier = run.id if len(groups) == 1 else f"{run.id}:segment:{group}"
                while identifier in identifiers:
                    identifier = "_" + identifier
                identifiers.add(identifier)
                walls.append({"id": identifier, "start": run.points[first].model_dump(),
                              "end": run.points[last].model_dump(), "thickness": run.thickness})
                for door in run.openings:
                    if first <= door.segment_index < last:
                        doors.append({"id": door.id, "wall_id": identifier,
                                      "start": run.points[door.segment_index].model_dump(),
                                      "end": run.points[door.segment_index + 1].model_dump()})
        data.update(walls=walls, doors=doors)
        return ExtractedDrawing.model_validate(data)


# Reuse the existing non-structural fields and descriptions without adding the
# indexed wire format to public stored observations or native layout JSON.
IndexedDrawing = create_model("IndexedDrawing", __base__=_IndexedGeometry, __module__=__name__, **{
    name: (field.annotation, copy.deepcopy(field))
    for name, field in ExtractedDrawing.model_fields.items() if name not in {"walls", "doors"}
})
