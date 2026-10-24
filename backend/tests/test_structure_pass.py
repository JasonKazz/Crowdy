import unittest
from shapely.geometry import Polygon

from app.schemas.extraction import ExtractedDrawing
from app.services.floorplans.structure_pass import StructuralDrawing, expand_structure
from app.services.floorplans.entrance_review import EntranceSurvey, apply_survey, replace_boundary_section, install_openings
from app.services.floorplans.staged import to_pixels
from test_images import point,drawing_fixture


class StructurePassTests(unittest.TestCase):
    def test_polyline_segments_keep_the_correct_door_parent(self):
        observation=StructuralDrawing.model_validate({'wall_paths':[{'id':'partition',
            'points':[point(100,100),point(300,100),point(300,300)],'thickness':8}],
            'openings':[{'id':'door','path_id':'partition','segment_index':1,'start':point(300,180),'end':point(300,240)}],
            'exits':[],'coverage':'complete','warnings':[]})
        expanded=expand_structure(observation)
        self.assertEqual([w['id'] for w in expanded['walls']],['partition:0','partition:1'])
        self.assertEqual(expanded['doors'][0]['wall_id'],'partition:1')
        mapped=to_pixels(expanded,'gemini',(800,400),(600,100))
        self.assertEqual(mapped['doors'][0]['start'],point(840,172))
        self.assertEqual(mapped['walls'][0]['thickness'],3.2)

    def test_invalid_parent_is_flagged_and_partial_coverage_stays_visible(self):
        observation=StructuralDrawing.model_validate({'wall_paths':[],'openings':[{
            'id':'door','path_id':'missing','segment_index':0,'start':point(1,1),'end':point(10,1)}],
            'exits':[],'coverage':'partial','warnings':[]})
        expanded=expand_structure(observation)
        self.assertEqual(expanded['doors'],[])
        self.assertTrue(any('no matching' in note for note in expanded['warnings']))
        self.assertIn('partially',expanded['warnings'][0])

    def test_local_boundary_survey_replaces_one_arc_without_reversing_floor(self):
        drawing=ExtractedDrawing.model_validate(drawing_fixture())
        old=Polygon([(p.x,p.y) for p in drawing.floor_outline])
        path=[(50,60),(48,70),(48,130),(50,140)]
        self.assertTrue(replace_boundary_section(drawing,path,(1000,500)))
        revised=Polygon([(p.x,p.y) for p in drawing.floor_outline])
        self.assertTrue(revised.is_valid)
        self.assertEqual(revised.exterior.is_ccw,old.exterior.is_ccw)
        self.assertLess(old.symmetric_difference(revised).area,200)
        self.assertFalse(replace_boundary_section(drawing,[(500,200),(700,200)],(1000,500)))

    def test_entrance_correction_can_recover_a_locally_misplaced_outline(self):
        drawing=ExtractedDrawing.model_validate(drawing_fixture())
        # Large overview drift is permitted locally, within a tight area budget.
        self.assertTrue(replace_boundary_section(drawing,[(50,60),(20,70),(20,130),(50,140)],(1000,500)))
        self.assertFalse(replace_boundary_section(drawing,[(50,60),(0,70),(0,400),(50,440)],(1000,500)))

    def test_separate_surveyed_doors_replace_bank_and_keep_unrelated_exit(self):
        drawing=ExtractedDrawing.model_validate(drawing_fixture())
        path=[(50,60),(50,150)]
        install_openings(drawing,'exit-west',path,[((50,70),(50,90)),((50,110),(50,130))])
        self.assertEqual(len(drawing.exits),3)
        self.assertIn('exit-east',[item.id for item in drawing.exits])
        self.assertNotIn('exit-west',[item.id for item in drawing.exits])
        self.assertTrue(all(item.label=='Observed exterior doorway' for item in drawing.exits if item.id.startswith('exit-west:')))

    def test_survey_straightens_only_the_clear_doorway_interval(self):
        survey=EntranceSurvey.model_validate({'boundary_path':[point(10,10),point(150,10.5),point(300,10)],
            'openings':[{'start':point(100,10.3),'end':point(200,10.3)}],'warnings':[]})
        path,openings=apply_survey(None,'bank',survey,(1000,500),(0,0),(1000,500),'claude')
        self.assertEqual(path[0],(10,10))
        self.assertEqual(path[-1],(300,10))
        self.assertIn(openings[0],list(zip(path,path[1:])))

    def test_survey_must_observe_jambs_on_the_perimeter_inside_its_crop(self):
        survey=EntranceSurvey.model_validate({'boundary_path':[point(10,10),point(900,10)],
            'openings':[{'start':point(100,10),'end':point(200,10)},
                        {'start':point(300,300),'end':point(400,300)}],'warnings':[]})
        path,openings=apply_survey(None,'bank',survey,(1000,500),(500,200),(500,250),'claude')
        self.assertEqual(len(openings),1)
        self.assertEqual(openings[0],((550,205),(600,205)))

if __name__=='__main__':unittest.main()
