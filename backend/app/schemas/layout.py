"""Editable geometry, kept separate from the simulator's compiled polygons."""

import math
from typing import Literal

from pydantic import Field, model_validator

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


class Layout(InputModel):
    schema_version: Literal[1] = 1
    name: str = Field(min_length=1)
    units: Literal["meters"] = "meters"
    walkable_areas: list[Region] = Field(min_length=1)
    furniture: list[Region] = Field(default_factory=list)
    walls: list[Wall] = Field(default_factory=list)
    doors: list[Door] = Field(default_factory=list)
    exits: list[Region] = Field(min_length=1)
    occupants: list[Occupant] = Field(default_factory=list)
    population: Population | None = None
    agent_defaults: AgentDefaults
    settings: SimulationSettings

    @model_validator(mode="after")
    def unique_ids(self):
        for field in ("walkable_areas", "furniture", "walls", "doors", "exits"):
            ids = [item.id for item in getattr(self, field)]
            if len(ids) != len(set(ids)):
                raise ValueError(f"{field} IDs must be unique")
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
