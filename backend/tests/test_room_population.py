import json
import math
import os
from pathlib import Path
import unittest
from unittest.mock import patch
from fastapi.testclient import TestClient
from shapely.geometry import Point, Polygon
from app.api import app, SimulationRequest, run_editor_simulation
from app.schemas.layout import Layout
from app.services.population.rooms import native_room_zones, infer_room_type
from app.simulation.workspace_layout import native_to_editor

ROOT = Path(__file__).resolve().parents[2]

class RoomPopulationTests(unittest.TestCase):
    def setUp(self):
        self.layout=json.loads((ROOT/'examples/room_aware_office.json').read_text())
        self.plan=native_to_editor(self.layout)
        self.settings=dict(occupancy=40,mobility='standard',distribution='rooms',seed=42,body_width=.46,
                           population_config={'activity':'workday'})
        env=patch.dict(os.environ,{'CROWDY_BACKEND_TOKEN':''});env.start();self.addCleanup(env.stop)
        self.client=TestClient(app)

    def preview(self,settings=None):
        return self.client.post('/api/populations/preview',json={'plan':self.plan,'scenario':settings or self.settings})

    def test_activity_changes_counts_and_keeps_people_inside_assigned_rooms(self):
        work=self.preview().json()
        lunch=self.preview({**self.settings,'population_config':{'activity':'lunch'}}).json()
        counts=lambda p:{r['id']:r['count'] for r in p['room_population']['rooms']}
        self.assertGreater(counts(work)['workspace'],counts(lunch)['workspace'])
        self.assertGreater(counts(lunch)['lunch-room'],counts(work)['lunch-room'])
        for payload in (work,lunch):
            self.assertEqual(sum(counts(payload).values()),40)
            for person,room_id in zip(payload['occupants'],payload['room_population']['assignments']):
                room=next(r for r in self.layout['rooms'] if r['id']==room_id)
                self.assertTrue(Polygon(room['polygon']).covers(Point(person['position'])))
            positions=[p['position'] for p in payload['occupants']]
            self.assertTrue(all(math.dist(a,b)>=.51-1e-9 for i,a in enumerate(positions) for b in positions[i+1:]))

    def test_preview_matches_real_run_and_is_stable_across_closures(self):
        preview=self.preview().json()
        result=run_editor_simulation(SimulationRequest.model_validate({'plan':self.plan,'scenario':self.settings}))
        self.assertEqual(preview['occupants'],result['scenario']['occupants'])
        self.assertEqual(preview['room_population'],result['editor_metadata']['room_population'])
        self.assertEqual(len(result['evacuations']),40)
        self.assertEqual(self.preview().json()['occupants'],preview['occupants'])
        closed=self.preview({**self.settings,'blocked_exit_ids':[e['id'] for e in self.plan['exits']]}).json()
        self.assertEqual(closed['occupants'],preview['occupants'])
        self.assertNotEqual(self.preview({**self.settings,'seed':43}).json()['occupants'],preview['occupants'])

    def test_fixed_counts_and_type_override(self):
        response=self.preview({**self.settings,'population_config':{'room_counts':{'lunch-room':13}}})
        self.assertEqual(response.status_code,200,response.text)
        self.assertEqual({r['id']:r['count'] for r in response.json()['room_population']['rooms']},{'lunch-room':13,'workspace':27})
        normal=self.preview().json()['room_population']['rooms']
        changed=self.preview({**self.settings,'population_config':{'room_types':{'workspace':'storage'}}}).json()['room_population']['rooms']
        self.assertNotEqual([r['count'] for r in normal],[r['count'] for r in changed])

    def test_invalid_counts_and_missing_rooms_fail(self):
        for config,fragment in [({'room_counts':{'missing':1}},'missing rooms'),({'room_counts':{'workspace':41}},'exceeding'),
                                 ({'room_counts':{'workspace':2,'lunch-room':2}},'unassigned')]:
            response=self.preview({**self.settings,'population_config':config})
            self.assertEqual(response.status_code,422,response.text)
            self.assertIn(fragment,response.json()['detail'])
        for count in (-1,1.5,True):
            self.assertEqual(self.preview({**self.settings,'population_config':{'room_counts':{'workspace':count}}}).status_code,422)

    def test_no_silent_spill_into_another_room(self):
        self.plan['native']['layout']['rooms'][0]['polygon']=[[9,1],[9.3,1],[9.3,1.3],[9,1.3]]
        response=self.preview({**self.settings,'population_config':{'room_counts':{'workspace':40}}})
        self.assertEqual(response.status_code,422)
        self.assertIn('workspace',response.json()['detail'])

    def test_geometry_recovers_missing_rooms_and_overlap_has_one_owner(self):
        layout=Layout.model_validate({**self.layout,'rooms':[],'room_labels':{},'room_types':{}})
        zones,_=native_room_zones(layout)
        self.assertEqual(len([z for z in zones if z.source=='geometry']),2)
        self.assertEqual(infer_room_type('Room_103'),'unknown')
        self.assertEqual(infer_room_type('Break room'),'cafeteria')
        self.assertEqual(infer_room_type('Classroom 4'),'classroom')
        data={**self.layout,'rooms':self.layout['rooms']+[{'id':'overlap','polygon':[[4,1],[12,1],[12,9],[4,9]]}]}
        zones,_=native_room_zones(Layout.model_validate(data))
        self.assertTrue(all(a.shape.intersection(b.shape).area<1e-8 for i,a in enumerate(zones) for b in zones[i+1:]))

    def test_unknown_plan_uses_open_floor(self):
        self.plan=native_to_editor({**self.layout,'rooms':[],'room_labels':{},'room_types':{},'walls':[],'doors':[]})
        response=self.preview()
        self.assertEqual(response.status_code,200,response.text)
        self.assertEqual(response.json()['room_population']['rooms'][0]['label'],'Open floor')

    def test_door_jamb_roundoff_narrows_only_small_endpoint_conflicts(self):
        from copy import deepcopy
        from app.services.floorplans.images import refine_jamb_roundoff
        walls=[dict(id='parent',start=[0,0],end=[8,0],thickness=.1),
               dict(id='adjacent',start=[2,0],end=[2,-4],thickness=.12)]
        original=deepcopy(walls)
        doors=[dict(id='door',wall_id='parent',offset=3,width=1.9)]
        notes=[]
        refine_jamb_roundoff(walls,doors,.04,notes)
        self.assertEqual(walls,original)
        self.assertLess(doors[0]['width'],1.9)
        self.assertAlmostEqual(doors[0]['offset']-doors[0]['width']/2,2.06,places=7)
        self.assertTrue(notes)
        for centre,width in [(2.8,2),(2,2)]:
            doors=[dict(id='door',wall_id='parent',offset=centre,width=width)]
            old=deepcopy(doors)
            refine_jamb_roundoff(walls,doors,.04,[])
            self.assertEqual(doors,old,'Large or middle-of-opening obstructions remain review errors')

    def test_pinned_person_in_doorway_is_retained_and_counted_once(self):
        from types import SimpleNamespace
        from app.services.population.placement import describe_existing
        person=SimpleNamespace(position=(8,4))
        metadata={}
        describe_existing(self.plan,self.settings,SimpleNamespace(occupants=[person]),metadata,Layout.model_validate(self.layout))
        self.assertEqual(sum(room['count'] for room in metadata['rooms']),1)
        self.assertEqual(person.position,(8,4))

    def test_baseline_room_config_is_frozen_without_moving_people(self):
        initial=self.preview().json()
        reference={'occupants':initial['occupants'],'radius':.23,'mobility':'standard','distribution':'rooms','seed':42,
                   'population_config':self.settings['population_config']}
        body={'plan':self.plan,'scenario':self.settings,'starting_population':reference}
        second=self.client.post('/api/populations/preview',json=body)
        self.assertEqual(second.status_code,200,second.text)
        self.assertEqual(second.json()['occupants'],initial['occupants'])
        self.assertEqual(sum(r['count'] for r in second.json()['room_population']['rooms']),40)
        body['scenario']={**self.settings,'population_config':{'activity':'lunch'}}
        response=self.client.post('/api/populations/preview',json=body)
        self.assertEqual(response.status_code,422)
        self.assertIn('Baseline room placement',response.json()['detail'])

if __name__=='__main__':unittest.main()
