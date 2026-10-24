"""Boundary door geometry shared by layout compilation and exterior-exit checks."""

import math

from app.schemas.layout import ExitDoor
from app.schemas.scenario import ExitBoundary, Region


def exit_geometry(door: ExitDoor, floor: Region, radius: float = .2) -> tuple[Region, Region, Region]:
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

    outside_width = door.outside_width or door.width + 2 * door.landing_depth
    if door.outside_space == "open" and outside_width < door.width:
        raise ValueError(f"Exit '{door.id}' open outside width cannot be narrower than its doorway")
    spread = (outside_width - door.width) / 2 if door.outside_space == "open" else 0
    transition = min(.25, door.landing_depth * .2)

    def position(along, depth):
        return (a[0] + ux * along + nx * depth, a[1] + uy * along + ny * depth)

    # A small overlap with the interior prevents a numerical seam at the door.
    apron = Region(id=f"exit-apron:{door.id}", polygon=[position(start, -0.05), position(end, -0.05),
        position(end, 0), position(end + spread, transition), position(end + spread, door.landing_depth),
        position(start - spread, door.landing_depth), position(start - spread, transition), position(start, 0)])
    # Evacuation ends at the door, not at the far end of an invented outside
    # route. Offset by the body radius so the entire person has cleared the wall.
    target = Region(id=door.id, polygon=[position(start + .01, radius + .02),
        position(end - .01, radius + .02), position(end - .01, radius + .20),
        position(start + .01, radius + .20)])
    threshold = Region(id=door.id, polygon=[position(start, -.05), position(end, -.05),
                                           position(end, .05), position(start, .05)])
    return apron, target, threshold


def exit_boundary(door: ExitDoor, floor: Region) -> ExitBoundary:
    _, _, threshold = exit_geometry(door, floor)
    a, b, c, d = threshold.polygon
    start = tuple((a[i] + d[i]) / 2 for i in range(2))
    end = tuple((b[i] + c[i]) / 2 for i in range(2))
    outward = tuple((d[i] - a[i]) / 0.1 for i in range(2))
    return ExitBoundary(id=door.id, start=start, end=end, outward=outward, outside_space=door.outside_space)
