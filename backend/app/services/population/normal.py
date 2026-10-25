"""Normal occupancy uses usable furniture seats, then a small circulating crowd."""
import math
import random
from shapely.geometry import Point, Polygon
from shapely.ops import nearest_points, unary_union
from shapely.prepared import prep
from app.schemas.rooms import PopulationConfig
from app.services.population.furniture import seating_candidates
from app.services.population.rooms import plan_room_zones, zone_polygons, infer_building_type
from app.simulation.spatial import SpatialIndex
from app.simulation.budget import check_simulation_budget


def place_normally(plan,settings,walkable,base_floor,exits,radius,metadata,convert,layout=None):
    from app.simulation.editor_adapter import placement_access
    from app.simulation.workspace_layout import pixel_point
    config=PopulationConfig.model_validate(settings.get('population_config') or {})
    zones,warnings=plan_room_zones(plan,layout)
    known={zone.id for zone in zones}
    unknown=(set(config.room_counts)|set(config.room_types))-known
    if unknown:raise ValueError('Room settings reference missing rooms: '+', '.join(sorted(unknown))+'. Reset room overrides.')
    total=settings['occupancy'];fixed=config.room_counts
    if sum(fixed.values())>total:raise ValueError('Fixed room counts exceed total occupancy. Reduce the room counts or increase total occupancy.')
    spawn=walkable.intersection(base_floor).buffer(-(radius+.05))
    spawn=spawn.difference(unary_union([Polygon(e.polygon) for e in exits]).buffer(radius+.05))
    reachable,_=placement_access(walkable,exits,radius)
    spawn=spawn.intersection(reachable)
    if spawn.is_empty:raise ValueError('The floor has no body-clear starting space connected to a doorway.')
    safe=prep(spawn);rng=random.Random(settings.get('seed',42))
    positions=[];placements=[];counts={z.id:0 for z in zones};sides={};desk_owners=set()
    separation=2*radius+.05
    standing_index=SpatialIndex(separation);seat_index=SpatialIndex(separation)
    def owner(position):
        point=Point(position)
        return next((z for z in zones if z.shape.covers(point)),None)
    def accept(position,seat,kind,object_id=None,face=(1,0),inferred=False):
        zone=owner(position)
        if zone is None:return False
        if zone.id in fixed and counts[zone.id]>=fixed[zone.id]:return False
        reserved=sum(max(0,target-counts[key]) for key,target in fixed.items())
        if zone.id not in fixed and len(positions)+reserved>=total:return False
        if not safe.covers(Point(position)):return False
        if standing_index.collides(position):return False
        if not base_floor.covers(Point(seat)):return False
        if seat_index.collides(seat):return False
        positions.append(position);counts[zone.id]+=1
        standing_index.add(position);seat_index.add(seat)
        placements.append(dict(agent_id=f'p{len(positions):04d}',object_id=object_id,kind=kind,
            seat_position=seat,standing_position=position,facing=face,inferred=inferred,room_id=zone.id))
        return True
    candidates=seating_candidates(plan,convert,radius)
    # Observed chairs win over inferred furniture-perimeter positions.
    rng.shuffle(candidates);candidates.sort(key=lambda c:{'chair':0,'desk':1}.get(c['kind'],2))
    observed=[c['position'] for c in candidates if c['kind']=='chair']
    seated_goal=total if total<5 else math.floor(total*.9)
    for candidate in candidates:
        if len(positions)>=seated_goal:break
        identifier=candidate['object_id'];kind=candidate['kind']
        if kind=='desk' and identifier in desk_owners:continue
        if kind=='sofa' and identifier in sides and sides[identifier]!=candidate.get('side'):continue
        position=candidate['position'];seat=candidate['seat_position']
        if kind!='chair' and any(math.dist(position,p)<.75 for p in observed):continue
        if not safe.covers(Point(position)):
            projected=nearest_points(spawn,Point(position))[0]
            if projected.distance(Point(position))>.4:continue
            position=(projected.x,projected.y)
        if accept(position,seat,kind,identifier,candidate['facing'],candidate['inferred']):
            if kind=='desk':desk_owners.add(identifier)
            if kind=='sofa':sides[identifier]=candidate.get('side')
    seated=len(positions)
    # Honor fixed room counts first. A fixed room with insufficient physical
    # space produces an explicit error rather than moving its people elsewhere.
    for zone in zones:
        needed=fixed.get(zone.id,counts[zone.id])-counts[zone.id]
        if needed<=0:continue
        space=spawn.intersection(zone.shape)
        if space.is_empty:raise ValueError(f"Room '{zone.label}' has no clear starting space.")
        left,bottom,right,top=space.bounds
        for attempt in range(max(8000,needed*800)):
            if attempt%128==0:check_simulation_budget()
            p=(rng.uniform(left,right),rng.uniform(bottom,top))
            if not space.covers(Point(p)):continue
            accept(p,p,'circulating')
            if counts[zone.id]==fixed[zone.id]:break
        if counts[zone.id]!=fixed[zone.id]:raise ValueError(f"Could not place {fixed[zone.id]} people in room '{zone.label}' with body clearance.")
    left,bottom,right,top=spawn.bounds
    for attempt in range(max(8000,total*800)):
        if attempt%128==0:check_simulation_budget()
        if len(positions)==total:break
        p=(rng.uniform(left,right),rng.uniform(bottom,top))
        accept(p,p,'circulating')
    if len(positions)!=total:raise ValueError(f'Could place only {len(positions)} of {total} people. Reduce occupancy or reset fixed room counts.')
    to_canvas=(lambda p:pixel_point(p,plan['native']['transform'])) if plan.get('native') else (lambda p:{'x':p[0]*32,'y':600-p[1]*32})
    types={z.id:config.room_types.get(z.id,z.room_type) for z in zones}
    metadata.update(building_type=infer_building_type(types.values(),plan['name']),activity='normal',
        rooms=[dict(id=z.id,label=z.label,room_type=types[z.id],source=z.source,area=z.shape.area,
            usable_area=spawn.intersection(z.shape).area,count=counts[z.id],fixed=z.id in fixed,
            rings=zone_polygons(z.shape,to_canvas)) for z in zones],
        assignments=[p['room_id'] for p in placements],normal_placements=placements,
        seated_count=seated,circulating_count=total-seated,warnings=warnings)
    if seated<seated_goal:
        metadata['warnings'].append(f'Found {seated} usable seating positions for this crowd; {total-seated} people are in circulation. Reduce occupancy for a mostly seated scene, or correct missing chairs/furniture.')
    if any(p['inferred'] for p in placements):
        metadata['warnings'].append('Some seats are inferred from furniture edges; they are editable placement assumptions, not a counted inventory of visible chairs.')
    return positions
