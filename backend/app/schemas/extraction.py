"""Provider-neutral drawing observations, before conversion into simulation meters."""

from typing import Literal

from pydantic import Field, model_validator

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
    start: DrawingPoint = Field(description="Start of the continuous interior wall centerline, including door gaps.")
    end: DrawingPoint = Field(description="End of the same centerline, within the floor outline.")
    thickness: float = Field(gt=0, description="Full wall thickness, not half-width; units follow the coordinate contract.")


class DrawingDoor(InputModel):
    id: str = Field(min_length=1)
    wall_id: str = Field(description="ID of an existing interior parent wall in walls.")
    start: DrawingPoint = Field(description="One jamb of the clear opening, on the parent wall centerline.")
    end: DrawingPoint = Field(description="The other jamb, on the same centerline and within the parent endpoints.")


class ScaleReference(InputModel):
    kind: Literal["dimension", "scale_bar"]
    label: str = Field(min_length=1, max_length=200)
    start: DrawingPoint
    end: DrawingPoint
    distance: float = Field(gt=0)
    unit: Literal["m", "cm", "mm", "ft", "in"]


class ScaleObject(InputModel):
    object_id: str = Field(min_length=1, description="ID of an existing door, exterior exit, or furniture object. Use each physical object once.")
    kind: Literal["single_door", "office_chair", "office_desk"] = Field(
        description="Only clearly identifiable single-leaf doors, individual office chairs, or individual rectangular office desks; omit ambiguous objects.")


class EstimatedObject(ScaleObject):
    observed_pixels: float = Field(gt=0)
    assumed_metres: float = Field(gt=0)
    origin: Literal["model", "geometry"] = "model"


class CalibrationInfo(InputModel):
    method: Literal["automatic", "manual", "estimated"]
    label: str
    references: list[ScaleReference] = Field(default_factory=list)
    estimated_objects: list[EstimatedObject] = Field(default_factory=list, max_length=30)
    meters_per_pixel_range: tuple[float, float] | None = None

    @model_validator(mode="after")
    def estimated_evidence(self):
        if self.method == "estimated":
            if (len({obj.object_id for obj in self.estimated_objects}) < 3
                    or len({obj.kind for obj in self.estimated_objects}) < 2):
                raise ValueError("Estimated scale needs three distinct objects across two object types")
            if self.meters_per_pixel_range is None or not 0 < self.meters_per_pixel_range[0] <= self.meters_per_pixel_range[1]:
                raise ValueError("Estimated scale needs a positive, ordered assumption range")
        return self


class ExtractedDrawing(InputModel):
    name: str
    floor_outline: list[DrawingPoint] = Field(min_length=3, max_length=300,
        description="Usable interior building boundary in vertex order, including connected rooms and corridors.")
    rooms: list[DrawingRegion] = Field(max_length=100)
    furniture: list[DrawingRegion] = Field(max_length=200)
    walls: list[DrawingWall] = Field(max_length=200)
    doors: list[DrawingDoor] = Field(max_length=200)
    exits: list[DrawingRegion] = Field(max_length=30,
        description="Thin full-opening-width markers at visible exterior doorways; never interior room doors.")
    warnings: list[str] = Field(max_length=30,
        description="Ambiguous or unreadable features, identifying their object ID or location; do not invent geometry.")
    scale_references: list[ScaleReference] = Field(default_factory=list, max_length=20,
        description="Explicit dimension lines or graphical scale bars with readable lengths and units. Empty if absent; never estimate from objects or a paper-scale ratio alone.")
    scale_objects: list[ScaleObject] = Field(default_factory=list, max_length=30,
        description="Objects suitable for approximate scale when printed dimensions are absent. Identify existing IDs and types only; never invent measurements. Include multiple object types when visible.")


class SourceImage(InputModel):
    id: str = Field(pattern=r"^[a-f0-9]{32}$")
    width_px: int = Field(ge=1, le=1092)
    height_px: int = Field(ge=1, le=1092)
    meters_per_pixel: float = Field(gt=0, le=100)
    scale_confirmed: bool = False
    calibration: CalibrationInfo | None = None


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
    meters_per_pixel: float | None = Field(default=None, gt=0, le=100)
    scale_confirmed: bool = False
    people_count: int = Field(default=40, ge=1, le=5000)
