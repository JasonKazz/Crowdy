"""Room semantics are placement assumptions, never physical barriers."""
from typing import Annotated, Literal
from pydantic import Field
from app.schemas.scenario import InputModel

BuildingType = Literal["auto", "office", "school", "venue", "residential", "other"]
RoomType = Literal["office", "classroom", "meeting", "cafeteria", "kitchen", "lounge",
                   "corridor", "lobby", "auditorium", "bedroom", "restroom", "storage", "unknown"]
Activity = Literal["auto", "workday", "meeting", "lunch", "class_time", "passing_period",
                   "assembly", "event", "residential_day", "residential_evening"]


class RoomClassification(InputModel):
    room_id: str = Field(min_length=1, max_length=128)
    room_type: RoomType


class PopulationConfig(InputModel):
    building_type: BuildingType = "auto"
    activity: Activity = "auto"
    room_counts: dict[str, Annotated[int, Field(strict=True, ge=0, le=200)]] = Field(default_factory=dict, max_length=101,
        description="Fixed counts for selected rooms. Unspecified rooms share the remaining population.")
    room_types: dict[str, RoomType] = Field(default_factory=dict, max_length=101)
