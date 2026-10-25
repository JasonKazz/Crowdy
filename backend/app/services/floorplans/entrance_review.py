"""Local exterior-wall surveys and separate clear doorway observations."""
import math
from pydantic import Field
from shapely.geometry import LineString, Point, Polygon

from app.schemas.scenario import InputModel
from app.schemas.extraction import DrawingPoint, DrawingRegion


class ClearOpening(InputModel):
    start: DrawingPoint
    end: DrawingPoint


class EntranceSurvey(InputModel):
    boundary_path: list[DrawingPoint] = Field(max_length=60,
        description="Ordered actual exterior building perimeter across the visible entrance area, INCLUDING recesses/vestibules and doorway thresholds. Extend beyond the whole bank to visible wall corners on both sides; do not add door swing arcs. Empty if the boundary cannot be identified.")
    openings: list[ClearOpening] = Field(max_length=20,
        description="Each individual clearly visible exterior clear opening, bounded by fixed jambs/piers. Separate independent door groups; no entire facade or guessed opening.")
    warnings: list[str] = Field(max_length=12)


ENTRANCE_PROMPT = """STAGE: survey this exterior entrance area at high resolution.
Trace the ACTUAL building perimeter as boundary_path, from visible wall linework before the
entrance bank to visible wall linework after it. Follow vestibules, corners and recesses.
The boundary runs through closed-door THRESHOLDS, not door swing arcs or the outer ends of open leaves.
Recover EACH clear exterior doorway with its actual two jambs. Adjacent leaves sharing an
uninterrupted opening may form one double-door opening. Fixed piers/solid wall sections divide
independent openings: return them separately. Never replace a whole entrance facade with one
huge door. Do not infer doors solely from Entrance text, crop edges or annotation arrows.
Every returned opening must lie on a straight portion of the traced exterior boundary.
Colored annotation circles, furniture, red dimension lines and door swing arcs are not the perimeter.
Return no openings if outside/inside and clear jambs cannot actually be identified. Report occlusion.
"""


def replace_boundary_section(drawing, path, image_size):
    """Replace a bounded observed arc, keeping the rest of the footprint intact."""
    vertices = [(p.x,p.y) for p in drawing.floor_outline]
    old = Polygon(vertices)
    line = LineString([*vertices,vertices[0]])
    observed = LineString(path) if len(path)>=2 else None
    if observed is None or not observed.is_simple or observed.length<2:
        return False
    width,height=image_size
    if any(not (0<=x<=width and 0<=y<=height) for x,y in path):
        return False
    max_shift=max(12,min(image_size)*.08)
    if any(Point(p).distance(line)>max_shift for p in path):
        return False
    begin,end=line.project(Point(path[0])),line.project(Point(path[-1]))
    # A survey endpoint can land a fraction of a source pixel beside an
    # existing corner. A tiny connector back to the old ring then crosses the
    # adjacent edge and makes the whole otherwise valid survey self-intersect.
    # Join only these endpoint roundoffs to the original ring. Door jambs and
    # the surveyed boundary between the endpoints remain authoritative.
    path=list(path)
    for index,station in ((0,begin),(-1,end)):
        seam=line.interpolate(station)
        if Point(path[index]).distance(seam)<=2:
            path[index]=seam.coords[0]
    forward=(end-begin)%line.length
    if forward>line.length/2:
        path=list(reversed(path));begin,end=end,begin;forward=line.length-forward
    if forward<2 or forward>line.length*.3 or not .6*forward<=observed.length<=1.7*forward:
        return False
    # Remaining perimeter follows the original ring, from survey end to start.
    cumulatives=[0.0]
    for a,b in zip(vertices,[*vertices[1:],vertices[0]]):
        cumulatives.append(cumulatives[-1]+math.dist(a,b))
    outside=[(distance-end)%line.length for distance in cumulatives[:-1]]
    rest=[vertex for distance,vertex in sorted(zip(outside,vertices))
          if 1e-6<distance<line.length-forward-1e-6]
    candidate=[*path,line.interpolate(end).coords[0],*rest,line.interpolate(begin).coords[0]]
    cleaned=[]
    for p in candidate:
        if not cleaned or math.dist(p,cleaned[-1])>1e-6:cleaned.append(p)
    if len(cleaned)>300:return False
    revised=Polygon(cleaned)
    if (not revised.is_valid or revised.area<=0 or abs(revised.area-old.area)>old.area*.03
            or revised.exterior.is_ccw!=old.exterior.is_ccw):
        return False
    drawing.floor_outline=[DrawingPoint(x=x,y=y) for x,y in cleaned]
    return True


def apply_survey(drawing, marker_id, survey, size, offset, native_size, provider):
    """Validate local observations before replacing coarse bank/outline guesses."""
    sx,sy=((native_size[0]/1000,native_size[1]/1000) if provider=='gemini'
           else (native_size[0]/size[0],native_size[1]/size[1]))
    point=lambda p:(p.x*sx+offset[0],p.y*sy+offset[1])
    path=[point(p) for p in survey.boundary_path]
    # All observations must be inside this actual source crop.
    in_crop=lambda p:offset[0]<=p[0]<=offset[0]+native_size[0] and offset[1]<=p[1]<=offset[1]+native_size[1]
    observed=LineString(path) if len(path)>=2 and all(in_crop(p) for p in path) else None
    verified=[]
    for opening in survey.openings:
        a,b=point(opening.start),point(opening.end)
        if not in_crop(a) or not in_crop(b) or math.dist(a,b)<2:continue
        if observed is None or not observed.buffer(2).covers(LineString([a,b])):continue
        # Endpoints on the observed wall, rather than slightly offset swing lines.
        a=observed.interpolate(observed.project(Point(a))).coords[0]
        b=observed.interpolate(observed.project(Point(b))).coords[0]
        if math.dist(a,b)>=2:verified.append((a,b))
    if observed is not None and verified:
        # Door jambs must bound ONE straight floor edge. A noisy survey may
        # place a redundant near-collinear vertex within the clear opening;
        # flatten that small wobble only inside its observed jamb interval.
        spans=sorted((min(observed.project(Point(a)),observed.project(Point(b))),
                      max(observed.project(Point(a)),observed.project(Point(b))),a,b) for a,b in verified)
        accepted=[];last=-1
        for lo,hi,a,b in spans:
            if lo < last-1e-6:continue
            accepted.append((lo,hi,a,b));last=hi
        stations=[(observed.project(Point(p)),p) for p in path]
        stations=[(d,p) for d,p in stations if not any(lo+1e-6<d<hi-1e-6 for lo,hi,_,_ in accepted)]
        for lo,hi,a,b in accepted:
            if observed.project(Point(a))>observed.project(Point(b)):a,b=b,a
            stations.extend([(lo,a),(hi,b)])
        path=[]
        for _,p in sorted(stations,key=lambda item:item[0]):
            if not path or math.dist(p,path[-1])>1e-6:path.append(p)
        verified=[(a,b) for _,_,a,b in accepted]
    return path, verified


def install_openings(drawing, marker_id, path, openings):
    """Replace overlapping coarse bank markers, never unrelated entrances."""
    observed=LineString(path)
    intervals=[sorted(observed.project(Point(p)) for p in pair) for pair in openings]
    kept=[]
    for marker in drawing.exits:
        shape=Polygon([(p.x,p.y) for p in marker.polygon]);center=shape.centroid
        stations=[observed.project(Point(p.x,p.y)) for p in marker.polygon]
        lower,upper=min(stations),max(stations)
        # A survey may miss a real doorway between two that it can read. Only
        # replace markers overlapping an actual new opening, not every marker
        # inside the envelope of the entire entrance bank. A wide coarse bank
        # still gets replaced when it covers an individual verified opening.
        duplicate=(center.distance(observed)<=max(6,math.sqrt(shape.area)/2) and any(
            min(upper,end)-max(lower,start) > .5*min(upper-lower,end-start)
            for start,end in intervals))
        if marker.id!=marker_id and not duplicate:kept.append(marker)
    for index,(a,b) in enumerate(openings):
        length=math.dist(a,b);nx,ny=-(b[1]-a[1])/length,(b[0]-a[0])/length
        polygon=[DrawingPoint(x=p[0]+sign*nx*.5,y=p[1]+sign*ny*.5)
                 for p,sign in ((a,1),(b,1),(b,-1),(a,-1))]
        kept.append(DrawingRegion(id=f'{marker_id}:opening_{index+1}',label='Observed exterior doorway',polygon=polygon))
    if len(kept)>30:
        raise ValueError("Too many exterior openings in one extraction; review the entrance observations")
    drawing.exits=kept
