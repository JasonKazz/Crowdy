"""Boundary door geometry shared by layout compilation and exterior-exit checks."""

import math
from shapely.geometry import LineString, Polygon
from shapely import union_all

from app.schemas.layout import ExitDoor
from app.schemas.scenario import ExitBoundary, Region


def _raw_geometry(door: ExitDoor, floor: Region, radius: float):
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


def exit_geometry(door: ExitDoor, floor: Region, radius: float = .2,
                  building=None) -> tuple[Region, Region, Region]:
    """Fit outside space to the actual footprint, preserving the doorway seam.

    Sideways dispersal may be clipped by another wing or a concave corner. No
    building area is carved away or silently added to the outside landing.
    Removal targets require the person's whole body to clear every nearby wall.
    """
    apron, target, threshold = _raw_geometry(door, floor, radius)
    building = Polygon(floor.polygon) if building is None else building
    raw = Polygon(apron.polygon)
    seam = Polygon(threshold.polygon)
    # Overlay arithmetic on angled walls can leave a microscopic crack
    # between the exterior polygon and its interior seam. A nanometre grid
    # joins that shared threshold without changing the building footprint.
    # An apron can wrap around the sidewalls of a recessed entrance. Merely
    # subtracting the building lets the subsequent floor union open every
    # touching sidewall as well as the measured doorway. A micrometre of
    # separation preserves those implicit walls; only the actual threshold
    # seam reconnects the outside space to the building.
    outside = raw.difference(building.buffer(1e-6, join_style="mitre"))
    # The overlap rectangle must not open the adjoining jamb sidewalls either.
    # Keep contact with the finite threshold alone, including at concave corners.
    doorway = LineString([tuple((threshold.polygon[0][i] + threshold.polygon[3][i]) / 2 for i in range(2)),
                          tuple((threshold.polygon[1][i] + threshold.polygon[2][i]) / 2 for i in range(2))])
    closed_boundary = building.boundary.difference(doorway.buffer(1e-8))
    seam = seam.difference(closed_boundary.buffer(1e-6, join_style="mitre", cap_style="flat"))
    fitted = union_all([outside, seam], grid_size=1e-9)
    safe_target = Polygon(target.polygon).difference(building.buffer(radius + .01, quad_segs=8))
    pieces = [safe_target] if isinstance(safe_target, Polygon) else [
        part for part in getattr(safe_target, "geoms", []) if isinstance(part, Polygon)]
    pieces = [part for part in pieces if not part.is_empty and part.area > 1e-8]
    if not pieces:
        raise ValueError(f"Exit '{door.id}' has no body-clear outside destination. Correct its doorway/boundary attachment.")
    safe_target = max(pieces, key=lambda part: part.area)
    components = [fitted] if isinstance(fitted, Polygon) else [
        part for part in getattr(fitted, "geoms", []) if isinstance(part, Polygon)]
    connected = [part for part in components if part.buffer(1e-8).covers(safe_target)]
    if not connected:
        raise ValueError(f"Exit '{door.id}' outside destination is disconnected from its doorway")
    fitted = max(connected, key=lambda part: part.area)
    if fitted.intersection(seam).area < 1e-8:
        raise ValueError(f"Exit '{door.id}' outside destination is disconnected from its doorway")
    if not fitted.is_valid or fitted.interiors or safe_target.interiors:
        raise ValueError(f"Exit '{door.id}' outside space needs a simpler, unobstructed boundary")
    return (Region(id=apron.id, polygon=list(fitted.exterior.coords)[:-1]),
            Region(id=target.id, polygon=list(safe_target.exterior.coords)[:-1]), threshold)


def exit_boundary(door: ExitDoor, floor: Region) -> ExitBoundary:
    _, _, threshold = _raw_geometry(door, floor, .2)
    a, b, c, d = threshold.polygon
    start = tuple((a[i] + d[i]) / 2 for i in range(2))
    end = tuple((b[i] + c[i]) / 2 for i in range(2))
    outward = tuple((d[i] - a[i]) / 0.1 for i in range(2))
    return ExitBoundary(id=door.id, start=start, end=end, outward=outward, outside_space=door.outside_space)
