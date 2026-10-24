"""Boundary door geometry shared by layout compilation and exterior-exit checks."""

import math

from app.schemas.layout import ExitDoor
from app.schemas.scenario import Region


def exit_geometry(door: ExitDoor, floor: Region) -> tuple[Region, Region, Region]:
    points = floor.polygon
    if door.edge_index >= len(points):
        raise ValueError(f"Exit '{door.id}' references a missing floor edge")
    a, b = points[door.edge_index], points[(door.edge_index + 1) % len(points)]
    length = math.dist(a, b)
    if length < 1e-6:
        raise ValueError(f"Exit '{door.id}' references a zero-length floor edge")
    start, end = door.offset - door.width / 2, door.offset + door.width / 2
    if start < -1e-9 or end > length + 1e-9:
        raise ValueError(f"Exit '{door.id}' extends past its floor edge")
    ux, uy = (b[0] - a[0]) / length, (b[1] - a[1]) / length
    signed_area = sum(p[0] * q[1] - q[0] * p[1] for p, q in zip(points, points[1:] + points[:1]))
    nx, ny = (uy, -ux) if signed_area > 0 else (-uy, ux)

    def rectangle(inner, outer, inset=0):
        return [(a[0] + ux * along + nx * depth, a[1] + uy * along + ny * depth)
                for along, depth in ((start + inset, inner), (end - inset, inner),
                                     (end - inset, outer), (start + inset, outer))]

    # A small overlap with the interior prevents a numerical seam at the door.
    apron = Region(id=f"exit-apron:{door.id}", polygon=rectangle(-0.05, door.landing_depth))
    # Keep the removal stage just inside its apron, avoiding floating-point
    # boundary disagreements when a diagonal apron is unioned with the floor.
    target = Region(id=door.id, polygon=rectangle(door.landing_depth * 0.8, door.landing_depth - 0.01, 0.01))
    threshold = Region(id=door.id, polygon=rectangle(-0.05, 0.05))
    return apron, target, threshold
