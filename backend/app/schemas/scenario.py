from typing import Literal
from pydantic import BaseModel, ConfigDict, Field

Point = tuple[float, float]

class InputModel(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        allow_inf_nan=False,
    )

class Region(InputModel):
    id: str = Field(min_length=1)
    polygon: list[Point] = Field(min_length=3)

class Occupant(InputModel):
    id: str = Field(min_length=1)
    position: Point

class AgentDefaults(InputModel):
    radius: float = Field(gt=0)
    desired_speed: float = Field(gt=0)


class SimulationSettings(InputModel):
    dt: float = Field(gt=0)
    sample_interval: float = Field(gt=0)
    max_time: float = Field(gt=0)


class Scenario(InputModel):
    name: str = Field(min_length=1)
    units: Literal["meters"]

    walkable_areas: list[Region] = Field(min_length=1)
    obstacles: list[Region]
    exits: list[Region] = Field(min_length=1)
    occupants: list[Occupant] = Field(min_length=1)

    agent_defaults: AgentDefaults
    settings: SimulationSettings