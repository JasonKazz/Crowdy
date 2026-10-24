"""Provider-neutral drawing observations, before conversion into simulation meters."""

from typing import Literal

from pydantic import Field

from app.schemas.scenario import InputModel


class DrawingPoint(InputModel):
    x: float
    y: float


class DrawingRegion(InputModel):
    id: str = Field(min_length=1)
    label: str
    polygon: list[DrawingPoint] = Field(min_length=3, max_length=300)


class DrawingWall(InputModel):
    id: str = Field(min_length=1)
    start: DrawingPoint
    end: DrawingPoint
    thickness: float = Field(gt=0)


class DrawingDoor(InputModel):
    id: str = Field(min_length=1)
    wall_id: str
    start: DrawingPoint
    end: DrawingPoint


class ExtractedDrawing(InputModel):
    name: str
    floor_outline: list[DrawingPoint] = Field(min_length=3, max_length=300)
    rooms: list[DrawingRegion] = Field(max_length=100)
    furniture: list[DrawingRegion] = Field(max_length=200)
    walls: list[DrawingWall] = Field(max_length=200)
    doors: list[DrawingDoor] = Field(max_length=200)
    exits: list[DrawingRegion] = Field(max_length=30)
    warnings: list[str] = Field(max_length=30)


class SourceImage(InputModel):
    id: str = Field(pattern=r"^[a-f0-9]{32}$")
    width_px: int = Field(ge=1, le=1092)
    height_px: int = Field(ge=1, le=1092)
    meters_per_pixel: float = Field(gt=0, le=100)
    scale_confirmed: bool = False


class ExtractionInfo(InputModel):
    id: str = Field(pattern=r"^[a-f0-9]{32}$")
    provider: Literal["gemini", "claude"]
    model: str
    elapsed_seconds: float = Field(ge=0)
    warnings: list[str]


class ImageUpload(InputModel):
    filename: str = Field(min_length=1, max_length=255)
    image_base64: str


class ExtractionRequest(InputModel):
    image_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    provider: Literal["gemini", "claude", "both"]
    meters_per_pixel: float = Field(gt=0, le=100)
    scale_confirmed: bool
    people_count: int = Field(default=40, ge=1, le=5000)
