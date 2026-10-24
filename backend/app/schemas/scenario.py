import math
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
    desired_speed: float | None = Field(default=None, gt=0)

class AgentDefaults(InputModel):
    radius: float = Field(gt=0)
    desired_speed: float = Field(gt=0)


class SimulationSettings(InputModel):
    dt: float = Field(gt=0)
    sample_interval: float = Field(gt=0)
    max_time: float = Field(gt=0)
    blocked_exit_ids: list[str] = Field(default_factory=list)
    behavior_mode: Literal["idealized", "behavioral"] = "idealized"
    behavior_seed: int = Field(default=42, ge=0, le=2**32 - 1)


class Population(InputModel):
    count: int = Field(ge=1, le=5000)
    seed: int = Field(default=42, ge=0, le=2**32 - 1)
    spawn_area_ids: list[str] = Field(min_length=1)


class ExitBoundary(InputModel):
    id: str = Field(min_length=1)
    start: Point
    end: Point
    outward: Point
    outside_space: Literal["open", "corridor"]

    @model_validator(mode="after")
    def valid_normal(self):
        length = math.dist(self.start, self.end)
        normal_length = math.hypot(*self.outward)
        dot = sum((self.end[i] - self.start[i]) * self.outward[i] for i in range(2))
        if length < 1e-6 or not math.isclose(normal_length, 1, abs_tol=1e-6) or abs(dot) > length * 1e-6:
            raise ValueError("Exit boundary needs distinct endpoints and a perpendicular unit outward normal")
        return self


class Scenario(InputModel):
    name: str = Field(min_length=1)
    units: Literal["meters"]

    walkable_areas: list[Region] = Field(min_length=1)
    obstacles: list[Region]
    exits: list[Region] = Field(min_length=1)
    exit_boundaries: list[ExitBoundary] = Field(default_factory=list)
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
        for name in ("walkable_areas", "obstacles", "exits", "occupants", "exit_boundaries"):
            ids = [item.id for item in getattr(self, name)]
            if len(ids) != len(set(ids)):
                raise ValueError(f"{name} IDs must be unique")
        if {boundary.id for boundary in self.exit_boundaries} - {region.id for region in self.exits}:
            raise ValueError("Exit boundaries must reference known exits")
        blocked = self.settings.blocked_exit_ids
        if len(blocked) != len(set(blocked)):
            raise ValueError("Blocked exit IDs must be unique")
        unknown = sorted(set(blocked) - {region.id for region in self.exits})
        if unknown:
            raise ValueError(f"Unknown blocked exit IDs: {', '.join(unknown)}")
        return self
