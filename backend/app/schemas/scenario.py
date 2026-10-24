from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, model_validator

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


class Population(InputModel):
    count: int = Field(ge=1, le=5000)
    seed: int = Field(default=42, ge=0, le=2**32 - 1)
    spawn_area_ids: list[str] = Field(min_length=1)


class Scenario(InputModel):
    name: str = Field(min_length=1)
    units: Literal["meters"]

    walkable_areas: list[Region] = Field(min_length=1)
    obstacles: list[Region]
    exits: list[Region] = Field(min_length=1)
    occupants: list[Occupant] = Field(default_factory=list)
    population: Population | None = None

    agent_defaults: AgentDefaults
    settings: SimulationSettings

    @model_validator(mode="after")
    def check_people_source(self):
        if self.population is None and not self.occupants:
            raise ValueError("Provide occupants or a population configuration")
        if self.population is not None and self.occupants:
            raise ValueError("Use occupants or population, not both")
        for name in ("walkable_areas", "obstacles", "exits", "occupants"):
            ids = [item.id for item in getattr(self, name)]
            if len(ids) != len(set(ids)):
                raise ValueError(f"{name} IDs must be unique")
        return self
