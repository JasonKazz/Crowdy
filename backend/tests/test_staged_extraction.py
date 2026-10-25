import copy
from contextvars import ContextVar
import io
import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image
from shapely.geometry import Polygon

from app.schemas.extraction import ExtractedDrawing, ExtractionInfo, SourceImage
from app.services.floorplans.images import drawing_to_layout
from app.services.floorplans.providers import ProviderError, output_schema
from app.services.floorplans.staged import (Structure, Details, ScaleReadings, to_pixels,
    for_provider, merge, tiles, same_wall, extract_staged)
from app.services.floorplans.structure_pass import StructuralDrawing, DoorReview
from app.services.floorplans.entrance_review import EntranceSurvey
from test_images import point, region, drawing_fixture


def structure_fixture():
    return {**{k: v for k, v in drawing_fixture().items() if k in
        ('name', 'floor_outline', 'rooms', 'walls', 'doors', 'exits', 'warnings')},
        'scale_windows': [], 'dense_furniture': False}


def detail_fixture():
    return {'furniture': [], 'walls': [], 'doors': [], 'exits': [],
            'scale_objects': [], 'scale_references': [], 'round_table_rows': [], 'warnings': []}


class StagedExtractionTests(unittest.TestCase):
    def test_normalized_non_square_crop_maps_to_canonical_pixels(self):
        item = Details.model_validate({**detail_fixture(), 'furniture': [region('desk',100,200,300,600)],
            'walls': [{'id':'w','start':point(100,0),'end':point(100,1000),'thickness':10}]})
        converted = to_pixels(item, 'gemini', (800,400), (500,100), 2)
        self.assertEqual(converted['furniture'][0]['polygon'][0], point(660,260))
        self.assertEqual(converted['walls'][0]['thickness'], 8)

    def test_provider_round_trip_preserves_scale_endpoints_and_thickness(self):
        drawing = ExtractedDrawing.model_validate(drawing_fixture())
        normalized = for_provider(drawing, 'gemini', (1000,500))
        pixels = to_pixels(normalized, 'gemini', (1000,500))
        self.assertEqual(pixels, drawing.model_dump())

    def test_overlapping_crops_own_each_table_once_and_remap_scale_id(self):
        first = {**detail_fixture(), 'furniture':[region('desk',350,100,450,180)],
                 'scale_objects':[{'kind':'office_desk','object_id':'desk'}]}
        second = copy.deepcopy(first)
        drawing, _ = merge(structure_fixture(), [(first,(0,0,500,500)), (second,(500,0,1000,500))], [], (1000,500))
        self.assertEqual(len(drawing.furniture),1)
        self.assertEqual(drawing.scale_objects[0].object_id,drawing.furniture[0].id)

    def test_seam_centroid_belongs_to_right_core_only(self):
        first = {**detail_fixture(), 'furniture':[region('table',480,100,520,180)]}
        drawing, _ = merge(structure_fixture(), [(first,(0,0,500,500)),(first,(500,0,1000,500))], [], (1000,500))
        self.assertEqual(len(drawing.furniture),1)
        self.assertTrue(drawing.furniture[0].id.startswith('tile_1'))

    def test_nearby_tables_keep_real_aisle(self):
        item = {**detail_fixture(),'furniture':[region('a',100,100,200,180),region('b',205,100,305,180)]}
        drawing,_=merge(structure_fixture(),[(item,(0,0,1000,500))],[],(1000,500))
        self.assertEqual(len(drawing.furniture),2)
        self.assertEqual(drawing.furniture[1].polygon[0].x,205)

    def test_duplicate_wall_fragments_merge_without_sealing_door(self):
        structure=structure_fixture()
        item={**detail_fixture(), 'walls':[{'id':'partition','start':point(500,120),'end':point(500,400),'thickness':10}],
              'doors':[{'id':'door','wall_id':'partition','start':point(500,200),'end':point(500,260)}]}
        drawing, report=merge(structure,[(item,(0,0,1000,500))],[],(1000,500))
        self.assertEqual(len(drawing.walls),1)
        self.assertEqual(len(drawing.doors),1)
        self.assertEqual(drawing.doors[0].wall_id,drawing.walls[0].id)
        self.assertEqual(report['duplicate_walls'],1)

    def test_parallel_walls_are_not_merged(self):
        a={'start':point(100,100),'end':point(100,400),'thickness':10}
        b={'start':point(108,100),'end':point(108,400),'thickness':10}
        self.assertFalse(same_wall(a,b))

    def test_outside_furniture_is_flagged_instead_of_silently_accepted(self):
        item={**detail_fixture(),'furniture':[region('table',0,0,100,100)]}
        drawing, report=merge(structure_fixture(),[(item,(0,0,1000,500))],[],(1000,500))
        self.assertEqual(len(drawing.furniture),0)
        self.assertEqual(report['invalid_geometry'],1)
        self.assertTrue(any('Review required' in note for note in drawing.warnings))

    def test_dense_tiles_overlap_but_cores_do_not(self):
        regions=tiles((1000,500),Polygon([(0,0),(1000,0),(1000,500),(0,500)]),384)
        self.assertEqual(len(regions),6)
        self.assertLess(regions[1][1][0],regions[1][0][0])
        self.assertEqual(regions[0][0][2],regions[1][0][0])

    def test_task_schemas_do_not_require_unrelated_geometry(self):
        self.assertNotIn('furniture',output_schema(Structure)['properties'])
        self.assertEqual(set(output_schema(ScaleReadings)['properties']),{'scale_references','warnings'})

    def test_round_table_rows_expand_as_separate_circular_obstacles(self):
        item=Details.model_validate({**detail_fixture(),'round_table_rows':[{
            'id':'row','first':point(100,100),'last':point(300,100),'count':3,'radius':20}]})
        data=to_pixels(item,'claude',(1000,500))
        self.assertEqual(len(data['furniture']),3)
        shapes=[Polygon([(p['x'],p['y']) for p in item['polygon']]) for item in data['furniture']]
        self.assertAlmostEqual(shapes[0].distance(shapes[1]),60)
        self.assertAlmostEqual(shapes[2].centroid.x,300)

    def test_cut_off_scale_span_is_rejected_even_if_provider_claims_visible(self):
        observed=ScaleReadings.model_validate({'warnings':[],'scale_references':[{
            'kind':'dimension','label':'185 ft','start':point(50,100),'end':point(1000,100),
            'distance':185,'unit':'ft','fully_visible':True,'legible':True}]})
        data=to_pixels(observed,'claude',(1000,500))
        self.assertEqual(data['scale_references'],[])
        self.assertIn('Rejected incomplete',data['warnings'][0])

    def test_restricted_area_is_not_converted_to_solid_furniture(self):
        observation=Details.model_validate({**detail_fixture(),'furniture':[
            {**region('staff',100,100,300,300),'kind':'access_zone'},
            {**region('desk',400,100,450,150),'kind':'furniture'}]})
        data=to_pixels(observation,'claude',(1000,500))
        self.assertEqual([item['id'] for item in data['furniture']],['desk'])
        self.assertNotIn('kind',data['furniture'][0])
        self.assertIn('access_zone',data['warnings'][0])

    def test_staged_draft_rejects_bad_exit_without_losing_other_geometry(self):
        drawing=ExtractedDrawing.model_validate(drawing_fixture())
        drawing.exits.append(type(drawing.exits[0]).model_validate(region('bad-interior-exit',400,200,450,250)))
        source=SourceImage(id='a'*32,width_px=1000,height_px=500,meters_per_pixel=.02,scale_confirmed=True)
        info=ExtractionInfo(id='b'*32,provider='claude',model='unit-test',elapsed_seconds=0,warnings=[])
        with self.assertRaisesRegex(ValueError,'exterior edge'):
            drawing_to_layout(drawing,source,'claude',info,40)
        layout=drawing_to_layout(drawing,source,'claude',info,40,allow_review=True)
        self.assertEqual(len(layout.exits),2)
        self.assertEqual(len(layout.furniture),1)
        self.assertTrue(any('bad-interior-exit' in note and 'omitted' in note for note in layout.extraction.warnings))

    def test_failed_detail_region_does_not_return_a_complete_candidate(self):
        image=Image.new('RGB',(1000,500),'white');stream=io.BytesIO();image.save(stream,'PNG')
        structure=Structure.model_validate(structure_fixture())
        def provider(_,__,___,schema):
            if schema is Structure:return structure,'fake-test-model'
            raise ProviderError('Region unavailable')
        with tempfile.TemporaryDirectory() as directory, patch('app.services.floorplans.staged.extract_structured',side_effect=provider):
            with self.assertRaisesRegex(ProviderError,'No complete layout'):
                extract_staged('claude',stream.getvalue(),1000,500,Path(directory))
            report=json.loads((Path(directory)/'report.json').read_text())
            self.assertTrue(report['failures'])
            self.assertFalse((Path(directory)/'canonical.json').exists())

    def test_diagnostic_crop_and_door_workers_inherit_the_import_context(self):
        marker = ContextVar('diagnostic-import-test', default=None)
        token = marker.set('shared-import-context')
        self.addCleanup(marker.reset, token)
        calls = []

        def provider(_provider, _image, _prompt, schema):
            calls.append((schema, threading.current_thread().name, marker.get()))
            if schema is Structure:
                observed = Structure.model_validate(structure_fixture())
            elif schema is StructuralDrawing:
                observed = StructuralDrawing(wall_paths=[{'id':'partition','points':[point(500,100),point(500,350)],'thickness':10}],
                                             openings=[],exits=[],coverage='complete',warnings=[])
            elif schema is Details:
                observed = Details.model_validate(detail_fixture())
            elif schema is ScaleReadings:
                observed = ScaleReadings(scale_references=[],warnings=[])
            elif schema is DoorReview:
                observed = DoorReview(doors=[],warnings=[])
            elif schema is EntranceSurvey:
                observed = EntranceSurvey(boundary_path=[],openings=[],warnings=[])
            else:
                self.fail(f'Unexpected stage schema {schema}')
            return observed, 'fake-test-model'

        image=Image.new('RGB',(1000,500),'white');stream=io.BytesIO();image.save(stream,'PNG')
        with tempfile.TemporaryDirectory() as directory, \
                patch('app.services.floorplans.staged.extract_structured',side_effect=provider), \
                patch('app.services.floorplans.staged.verify_wall_pixels',return_value={}):
            extract_staged('claude',stream.getvalue(),1000,500,Path(directory))
        self.assertTrue(any(schema is Details for schema,_,_ in calls))
        self.assertTrue(any(schema is DoorReview for schema,_,_ in calls))
        worker_calls = [value for _,name,value in calls if name.startswith('ThreadPoolExecutor')]
        self.assertTrue(worker_calls)
        self.assertTrue(all(value == 'shared-import-context' for value in worker_calls),
                        'Deadline/cancellation context must reach every crop and door-review HTTP call')


if __name__=='__main__':unittest.main()
