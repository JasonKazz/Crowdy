"""Seat anchors are presentation poses; evacuation starts remain body-clear."""
import copy
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
from app.services.floorplans.layout import compile_layout
from app.services.population.furniture import furniture_kind
from app.simulation.editor_adapter import editor_to_scenario
from app.simulation.geometry import build_geometry
from app.simulation.workspace_layout import native_to_editor, world_point
from test_workspace_api import SAMPLE, room_request

ROOT=Path(__file__).resolve().parents[2]

class NormalPopulationTests(unittest.TestCase):
    def setUp(self):
        self.plan=copy.deepcopy(SAMPLE['plan'])
        self.settings=dict(occupancy=24,mobility='standard',distribution='normal',seed=42)
        env=patch.dict(os.environ,{'CROWDY_BACKEND_TOKEN':''});env.start();self.addCleanup(env.stop)
        self.client=TestClient(app);self.addCleanup(self.client.close)

    def preview(self):
        response=self.client.post('/api/populations/preview',json={'plan':self.plan,'scenario':self.settings})
        self.assertEqual(response.status_code,200,response.text)
        return response.json()

    def test_sample_uses_drawn_chairs_and_couch_fronts_and_few_walkers(self):
        preview=self.preview();meta=preview['room_population']
        self.assertEqual(len(preview['occupants']),24)
        self.assertGreaterEqual(meta['seated_count'],20)
        self.assertLessEqual(meta['circulating_count'],4)
        self.assertEqual(meta['seated_count']+meta['circulating_count'],24)
        placements=meta['normal_placements']
        self.assertEqual({p['kind'] for p in placements},{'desk','table','sofa','circulating'})
        desk=next(p for p in placements if p['object_id']=='desk-1')
        self.assertEqual(desk['seat_position'],[235/32,(600-215)/32])
        for person in (p for p in placements if p['kind']=='sofa'):
            self.assertEqual(person['facing'],[-1,0] if person['object_id']=='sofa-2' else [0,-1])
            item=next(i for i in self.plan['items'] if i['id']==person['object_id'])
            seat=person['seat_position'];x,y=seat[0]*32,600-seat[1]*32
            self.assertTrue(item['x']<x<item['x']+item['width'])
            self.assertTrue(item['y']<y<item['y']+item['height'])
        scenario=editor_to_scenario(self.plan,self.settings)
        geometry=build_geometry(scenario)
        positions=[p.position for p in scenario.occupants]
        self.assertTrue(all(Point(p).distance(geometry.boundary)>=.28-1e-8 for p in positions))
        self.assertTrue(all(math.dist(a,b)>=.51-1e-8 for i,a in enumerate(positions) for b in positions[i+1:]))
        self.assertEqual(preview,self.preview())
        result=run_editor_simulation(SimulationRequest(plan=self.plan,scenario=self.settings))
        self.assertEqual(result['scenario']['occupants'],preview['occupants'])
        self.assertEqual(result['summary']['evacuated_count'],24)

    def test_overflow_and_empty_furniture_do_not_invent_seats(self):
        self.settings['occupancy']=60
        meta=self.preview()['room_population']
        self.assertLess(meta['seated_count'],54)
        self.assertTrue(any('usable seating' in w for w in meta['warnings']))
        self.plan=room_request()['plan'];self.settings['occupancy']=12
        meta=self.preview()['room_population']
        self.assertEqual(meta['seated_count'],0)
        self.assertEqual(meta['circulating_count'],12)

    def test_work_surfaces_with_chairs_still_classify_as_solid_furniture(self):
        self.assertEqual(furniture_kind('f1','Meeting table with chairs'),'table')
        self.assertEqual(furniture_kind('f2','Desk and chair'),'desk')
        self.assertEqual(furniture_kind('f3','Office chair'),'chair')

    def test_native_observed_chair_retains_label_and_major_barriers(self):
        layout=json.loads((ROOT/'examples/room_aware_office.json').read_text())
        layout['furniture'].append({'id':'seat-1','polygon':[[1,1],[1.5,1],[1.5,1.5],[1,1.5]]})
        layout['furniture_labels']={'seat-1':'Office chair'}
        self.plan=native_to_editor(layout);self.settings['occupancy']=4
        chair=next(i for i in self.plan['items'] if i['id']=='seat-1')
        self.assertEqual(chair['kind'],'chair');self.assertEqual(chair['label'],'Office chair')
        obstacles={p.id for p in compile_layout(Layout.model_validate(layout)).obstacles}
        self.assertNotIn('seat-1',obstacles)
        self.assertTrue({p['id'] for p in layout['furniture'] if p['id']!='seat-1'}<=obstacles)
        placement=next(p for p in self.preview()['room_population']['normal_placements'] if p['object_id']=='seat-1')
        self.assertEqual(placement['seat_position'],[1.25,1.25])
        self.assertFalse(placement['inferred'])

    def test_fixed_room_counts_reserve_capacity_and_closures_do_not_reshuffle(self):
        self.plan=native_to_editor(json.loads((ROOT/'examples/room_aware_office.json').read_text()))
        self.settings.update(occupancy=24,population_config={'room_counts':{'workspace':20}})
        initial=self.preview()
        counts={r['id']:r['count'] for r in initial['room_population']['rooms']}
        self.assertEqual(counts,{'workspace':20,'lunch-room':4})
        self.settings['blocked_exit_ids']=[e['id'] for e in self.plan['exits']]
        self.assertEqual(initial['occupants'],self.preview()['occupants'])
        self.settings['seed']=43
        self.assertNotEqual(initial['occupants'],self.preview()['occupants'])

if __name__=='__main__':unittest.main()
