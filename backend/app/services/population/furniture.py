"""Seat-oriented pre-alarm placement with separate, body-clear standing starts.

An inferred seat is an occupancy assumption, never an observed chair or a safety
capacity. Major furniture remains a collision barrier throughout evacuation.
"""
import math
import re


def furniture_kind(identifier, label="", fallback="obstacle"):
    text = re.sub(r"[_-]+", " ", f"{identifier} {label}".lower())
    if re.search(r"\b(sofa|couch|settee|armchair|lounge chair|bench)\b",text):
        return "sofa"
    if re.search(r"\b(desk|desks|workstation|workstations)\b",text):
        return "desk"
    if re.search(r"\b(table|tables)\b",text):
        return "table"
    if re.search(r"\b(chair|chairs|seat)\b",text):
        return "chair"
    return fallback


def is_minor_chair(region, labels):
    from shapely.geometry import Polygon
    shape=Polygon(region.polygon)
    left,bottom,right,top=shape.bounds
    return (furniture_kind(region.id,labels.get(region.id,""))=="chair"
            and shape.area <= 2 and max(right-left,top-bottom) <= 1.8)


def seating_candidates(plan, convert, radius):
    """Return (object, category, seat, standing, face) candidates in world metres."""
    from shapely.geometry import Polygon
    result=[]
    clear=radius+.08
    for item in sorted(plan['items'],key=lambda value:value['id']):
        kind=furniture_kind(item['id'],item['label'],item['kind'])
        if kind not in ('desk','table','sofa','chair'):
            continue
        if item.get('polygon'):
            shape=Polygon([convert(item['x']+p['x']*item['width'],item['y']+p['y']*item['height']) for p in item['polygon']])
        else:
            shape=Polygon([convert(item['x'],item['y']),convert(item['x']+item['width'],item['y']),
                           convert(item['x']+item['width'],item['y']+item['height']),convert(item['x'],item['y']+item['height'])])
        centre=shape.centroid
        def add(seat,standing,face):
            result.append(dict(object_id=item['id'],kind=kind,seat_position=seat,position=standing,facing=face,
                               inferred=kind!='chair'))
        if kind=='chair':
            # Orient an observed seat toward its nearest work surface.
            surfaces=[other for other in plan['items'] if furniture_kind(other['id'],other['label'],other['kind']) in ('desk','table')]
            targets=[convert(other['x']+other['width']/2,other['y']+other['height']/2) for other in surfaces]
            target=min(targets,key=lambda p:math.dist(p,(centre.x,centre.y))) if targets else (centre.x,centre.y+1)
            distance=math.dist(target,(centre.x,centre.y)) or 1
            add((centre.x,centre.y),(centre.x,centre.y),((target[0]-centre.x)/distance,(target[1]-centre.y)/distance))
            continue
        # The pixel sample has explicit decorative chair locations. Honor those
        # exact drawing positions instead of inventing a denser row of seats.
        if not plan.get('native'):
            x,y,w,h=item['x'],item['y'],item['width'],item['height']
            anchors=([(x+w/2,y+h+12)] if kind=='desk' else
                [(x+w*.25,y-12),(x+w*.75,y-12),(x+w*.25,y+h+12),(x+w*.75,y+h+12),
                 (x-12,y+h/2),(x+w+12,y+h/2)] if kind=='table' else [])
            if kind=='sofa':
                vertical=h>w
                count=max(1,int((h if vertical else w)/32/.65))
                for index in range(count):
                    seat=convert(x+w*.5,y+h*(index+.5)/count) if vertical else convert(x+w*(index+.5)/count,y+h*.5)
                    edge=convert(x,y+h*(index+.5)/count) if vertical else convert(x+w*(index+.5)/count,y+h)
                    outward=(-1,0) if vertical else (0,-1)
                    standing=(edge[0]+outward[0]*clear,edge[1]+outward[1]*clear)
                    add(seat,standing,outward)
                    result[-1]['side']='front'
                continue
            if anchors:
                for x,y in anchors:
                    point=convert(x,y)
                    d=math.dist(point,(centre.x,centre.y)) or 1
                    add(point,point,((centre.x-point[0])/d,(centre.y-point[1])/d))
                continue
        rectangle=shape.minimum_rotated_rectangle
        points=list(rectangle.exterior.coords)[:-1]
        edges=[(math.dist(a,b),a,b) for a,b in zip(points,points[1:]+points[:1])]
        longest=max(edge[0] for edge in edges)
        candidates=[]
        for length,a,b in edges:
            if kind in ('desk','sofa') and length < longest-1e-6:
                continue
            count=(max(1,int(length/.65)) if kind in ('table','sofa') else 1)
            for index in range(count):
                fraction=(index+.5)/count
                edge=(a[0]+(b[0]-a[0])*fraction,a[1]+(b[1]-a[1])*fraction)
                d=math.dist(edge,(centre.x,centre.y)) or 1
                outward=((edge[0]-centre.x)/d,(edge[1]-centre.y)/d)
                standing=(edge[0]+outward[0]*clear,edge[1]+outward[1]*clear)
                seat=(edge[0]-outward[0]*min(.2,d/2),edge[1]-outward[1]*min(.2,d/2)) if kind=='sofa' else standing
                candidates.append((length,a,b,seat,standing,outward if kind=='sofa' else (-outward[0],-outward[1])))
        if kind in ('desk','sofa'):
            # Each object has alternative sides. Keep these as alternatives for
            # placement; the picker uses just one desk/one sofa side.
            for _,a,b,seat,standing,face in candidates:
                add(seat,standing,face)
                result[-1]['side']=str((a,b))
        else:
            for _,_,_,seat,standing,face in candidates:add(seat,standing,face)
    return result
