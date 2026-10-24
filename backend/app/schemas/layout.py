"""Editable geometry, kept separate from the simulator's compiled polygons."""

import math
from typing import Literal

from pydantic import Field, model_validator

from app.schemas.extraction import ExtractionInfo, SourceImage

from app.schemas.scenario import (
    AgentDefaults, InputModel, Occupant, Point, Population, Region,
    Scenario, SimulationSettings,
)


class Wall(InputModel):
    id: str = Field(min_length=1)
    start: Point
    end: Point
    thickness: float = Field(gt=0)

    @model_validator(mode="after")
    def nonzero_length(self):
        if math.dist(self.start, self.end) < 1e-6:
            raise ValueError(f"Wall '{self.id}' must have distinct endpoints")
        return self


class Door(InputModel):
    id: str = Field(min_length=1)
    wall_id: str = Field(min_length=1)
    offset: float = Field(ge=0, description="Center distance from wall start, in meters")
    width: float = Field(gt=0)


class ExitDoor(InputModel):
    """An opening attached to an edge of the building's interior outline."""

    id: str = Field(min_length=1)
    floor_id: str = Field(min_length=1)
    edge_index: int = Field(ge=0)
    offset: float = Field(ge=0)
    width: float = Field(gt=0)
    landing_depth: float = Field(default=2.0, gt=0)


def exit_from_marker(marker: Region, floors: list[Region]) -> ExitDoor:
    """Upgrade an image observation to an opening, preserving its observed width.

    The model's rectangle only locates the door. Its projection along the nearest
    boundary edge supplies the width; its interior depth is never an exit zone.
    """
    xs, ys = zip(*marker.polygon)
    center = ((min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2)
    choices = []
    for floor in floors:
        points = floor.polygon
        for index, start in enumerate(points):
            end = points[(index + 1) % len(points)]
            length = math.dist(start, end)
            if length < 1e-6:
                continue
            ux, uy = (end[0] - start[0]) / length, (end[1] - start[1]) / length
            projection = (center[0] - start[0]) * ux + (center[1] - start[1]) * uy
            offset = min(length, max(0, projection))
            distance = math.dist(center, (start[0] + ux * offset, start[1] + uy * offset))
            spans = [(x - start[0]) * ux + (y - start[1]) * uy for x, y in marker.polygon]
            choices.append((distance, floor.id, index, offset, max(spans) - min(spans), length))
    if not choices:
        raise ValueError(f"Exit '{marker.id}' has no usable floor boundary")
    distance, floor_id, index, offset, width, length = min(choices)
    if distance > 0.75 or width < 1e-6 or width > length:
        raise ValueError(f"Exit '{marker.id}' is not near a usable exterior edge. Add an exterior exit door manually.")
    return ExitDoor(id=marker.id, floor_id=floor_id, edge_index=index,
                    offset=min(length - width / 2, max(width / 2, offset)), width=width)


class Layout(InputModel):
    schema_version: Literal[1] = 1
    name: str = Field(min_length=1)
    units: Literal["meters"] = "meters"
    walkable_areas: list[Region] = Field(min_length=1)
    furniture: list[Region] = Field(default_factory=list)
    walls: list[Wall] = Field(default_factory=list)
    doors: list[Door] = Field(default_factory=list)
    # Polygon exits remain supported for imported simulation scenarios with
    # explicit doorway/landing floor polygons. New editor exits are ExitDoors.
    exits: list[ExitDoor | Region] = Field(default_factory=list)
    rooms: list[Region] = Field(default_factory=list)
    room_labels: dict[str, str] = Field(default_factory=dict)
    source_image: SourceImage | None = None
    extraction: ExtractionInfo | None = None
    occupants: list[Occupant] = Field(default_factory=list)
    population: Population | None = None
    agent_defaults: AgentDefaults
    settings: SimulationSettings

    @model_validator(mode="after")
    def unique_ids(self):
        for field in ("walkable_areas", "furniture", "walls", "doors", "exits", "rooms"):
            ids = [item.id for item in getattr(self, field)]
            if len(ids) != len(set(ids)):
                raise ValueError(f"{field} IDs must be unique")
        if self.source_image and self.extraction:
            # Also upgrades previously exported image layouts without another
            # model call. Never reinterpret legacy simulation scenario exits.
            self.exits = [exit_from_marker(item, self.walkable_areas) if isinstance(item, Region)
                          else item for item in self.exits]
        return self


def load_layout(data: dict) -> Layout:
    """Existing scenarios import losslessly; their obstacles become furniture.

    Existing doorway/landing polygons stay walkable areas. They cannot be
    inferred reliably as editable doors; newly created doors belong to walls.
    """
    if "schema_version" in data:
        return Layout.model_validate(data)
    scenario = Scenario.model_validate(data).model_dump(mode="json")
    scenario["furniture"] = scenario.pop("obstacles")
    return Layout.model_validate(scenario)
