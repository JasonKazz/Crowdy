"""Conservative image support checks for staged wall proposals.

These checks cannot identify walls by themselves. They only verify that a vision
proposal follows contrasting, neutral architectural linework. Rejected proposals
remain in stage artifacts for review rather than becoming invented barriers.
"""
import math
from PIL import Image
from shapely.geometry import LineString, Polygon


def verify_wall_pixels(drawing, source: Image.Image):
    rgb = source.convert('RGB')
    pixels = rgb.load()
    width, height = rgb.size
    floor=Polygon([(p.x,p.y) for p in drawing.floor_outline])
    records = []
    accepted = []
    parents = {door.wall_id for door in drawing.doors}

    def gray(x, y):
        x, y = round(x), round(y)
        if not (0 <= x < width and 0 <= y < height):
            return 255.0
        r, g, b = pixels[x, y]
        # Colored labels, table/chair symbols and marker overlays are not
        # evidence supporting a physical wall centerline.
        return 255.0 if max(r,g,b)-min(r,g,b) > 45 else (r+g+b)/3

    for wall in drawing.walls:
        start, end = (wall.start.x, wall.start.y), (wall.end.x, wall.end.y)
        length = math.dist(start, end)
        if length < 2:
            accepted.append(wall)
            continue
        nx, ny = -(end[1]-start[1])/length, (end[0]-start[0])/length
        count = max(8, min(180, round(length)))
        ts = [(i+.5)/count for i in range(count)]
        if wall.id in parents:
            # Check the solid wall on either side, excluding explicitly observed
            # doorway intervals. Door symbols do not exempt an entire proposal.
            ux,uy=(end[0]-start[0])/length,(end[1]-start[1])/length
            gaps=[]
            for door in drawing.doors:
                if door.wall_id!=wall.id:continue
                spans=[(p.x-start[0])*ux+(p.y-start[1])*uy for p in (door.start,door.end)]
                gaps.append((min(spans)-1,max(spans)+1))
            ts=[t for t in ts if not any(lo<=t*length<=hi for lo,hi in gaps)]
            if len(ts)<4:
                accepted.append(wall)
                records.append({'id':wall.id,'accepted':True,'support':None,'reason':'Too little solid parent wall to check around the observed door'})
                continue
        flank = max(5, min(9, wall.thickness/2+3))

        def support(a, b):
            found = 0
            for t in ts:
                shift = a*(1-t)+b*t
                x = start[0]*(1-t)+end[0]*t+nx*shift
                y = start[1]*(1-t)+end[1]*t+ny*shift
                center = min(gray(x+nx*k,y+ny*k) for k in (-1,0,1))
                left = sorted(gray(x+nx*k,y+ny*k) for k in (-flank-1,-flank,-flank+1))[1]
                right = sorted(gray(x+nx*k,y+ny*k) for k in (flank-1,flank,flank+1))[1]
                found += center < 195 and max(left,right)-center > 23
            return found/len(ts)

        original = support(0,0)
        best, shifts = original, (0,0)
        # Small, bounded corrections only; never move a guessed wall across
        # a room to the nearest unrelated line.
        if original < .8 and wall.id not in parents:
            for a in (-4,-2,0,2,4):
                for b in (-4,-2,0,2,4):
                    score = support(a,b)
                    if score > best+.025:
                        best, shifts = score, (a,b)
        moved=[(start[0]+nx*shifts[0],start[1]+ny*shifts[0]),
               (end[0]+nx*shifts[1],end[1]+ny*shifts[1])]
        if not floor.buffer(-wall.thickness/2-.05).covers(LineString(moved)):
            best,shifts=original,(0,0)
        keep = best >= .6
        record = {'id': wall.id, 'support': round(best,3), 'accepted':keep,
                  'endpoint_offsets_px': list(shifts)}
        if keep:
            if shifts != (0,0):
                wall = wall.model_copy(deep=True)
                wall.start.x += nx*shifts[0]; wall.start.y += ny*shifts[0]
                wall.end.x += nx*shifts[1]; wall.end.y += ny*shifts[1]
            accepted.append(wall)
        records.append(record)
    drawing.walls = accepted
    accepted_ids={wall.id for wall in accepted}
    drawing.doors=[door for door in drawing.doors if door.wall_id in accepted_ids]
    rejected = sum(not item['accepted'] for item in records)
    if rejected:
        drawing.warnings.insert(0, f"Wall coverage needs review: {rejected} proposed segments lacked consistent image linework and were excluded. The drawing may contain unrecognized partitions or doorways.")
    return records
