import unittest
from PIL import Image, ImageDraw
from app.schemas.extraction import ExtractedDrawing
from app.services.floorplans.wall_pixels import verify_wall_pixels


def drawing(walls, doors=()):
    return ExtractedDrawing.model_validate(dict(name='linework',floor_outline=[dict(x=0,y=0),dict(x=200,y=0),dict(x=200,y=160),dict(x=0,y=160)],rooms=[],walls=walls,doors=list(doors),exits=[],furniture=[],scale_objects=[],scale_references=[],warnings=[]))


def wall(identifier, y):
    return dict(id=identifier,start=dict(x=20,y=y),end=dict(x=180,y=y),thickness=2)


class WallPixelTests(unittest.TestCase):
    def test_rejects_invented_diagonal_and_colored_annotation_keeps_gray_wall(self):
        image=Image.new('RGB',(200,160),'white');pen=ImageDraw.Draw(image)
        pen.rectangle((0,0,200,70), fill=(150,150,150))
        pen.line((20,35,180,35),fill=(65,65,65),width=2)
        pen.line((20,130,180,130),fill=(220,30,30),width=3)
        d=drawing([wall('physical',35),wall('blank-shading',50),wall('red-dimension',130)])
        report=verify_wall_pixels(d,image)
        self.assertEqual([w.id for w in d.walls],['physical'])
        self.assertEqual(sum(not r['accepted'] for r in report),2)
        self.assertIn('coverage needs review',d.warnings[0])

    def test_small_local_snap_but_no_jump_to_distant_line(self):
        image=Image.new('RGB',(200,160),'white');pen=ImageDraw.Draw(image)
        pen.line((20,60,180,60),fill='black',width=2)
        d=drawing([wall('near',63),wall('far',90)])
        verify_wall_pixels(d,image)
        self.assertEqual(len(d.walls),1)
        self.assertLessEqual(abs(d.walls[0].start.y-60),1)

    def test_explicit_door_gap_is_not_rejected_for_missing_pixels(self):
        image=Image.new('RGB',(200,160),'white');pen=ImageDraw.Draw(image)
        pen.line((20,60,39,60),fill='black',width=2)
        pen.line((81,60,180,60),fill='black',width=2)
        d=drawing([wall('parent',60)],[dict(id='door',wall_id='parent',start=dict(x=40,y=60),end=dict(x=80,y=60))])
        verify_wall_pixels(d,image)
        self.assertEqual(len(d.walls),1)
        self.assertEqual(d.doors[0].wall_id,d.walls[0].id)
