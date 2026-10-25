"""A partial source survey must preserve distinct previously observed doors."""

import unittest

from app.schemas.extraction import DrawingPoint, DrawingRegion, ExtractedDrawing
from app.services.floorplans.entrance_review import install_openings


def marker(identifier, lower, upper, *, x=0):
    return DrawingRegion(id=identifier, label=identifier, polygon=[
        DrawingPoint(x=x, y=lower), DrawingPoint(x=x+1, y=lower),
        DrawingPoint(x=x+1, y=upper), DrawingPoint(x=x, y=upper),
    ])


def drawing(exits):
    return ExtractedDrawing(name="Entrance survey", floor_outline=[
        DrawingPoint(x=0, y=0), DrawingPoint(x=1000, y=0),
        DrawingPoint(x=1000, y=500), DrawingPoint(x=0, y=500),
    ], rooms=[], walls=[], doors=[], furniture=[], exits=exits, warnings=[])


class EntranceDeduplicationTests(unittest.TestCase):
    def test_partial_survey_preserves_a_distinct_middle_door(self):
        original=marker("middle-door",190,210)
        observed=drawing([marker("first-door",90,110),original,marker("last-door",290,310)])
        install_openings(observed,"source-survey",[(0,50),(0,350)],
                         [((0,90),(0,110)),((0,290),(0,310))])
        self.assertEqual([item.id for item in observed.exits],
                         ["middle-door","source-survey:opening_1","source-survey:opening_2"])
        self.assertEqual(observed.exits[0],original)

    def test_the_same_door_is_deduplicated_with_rounding_and_reversed_path(self):
        for path in ([(0,50),(0,350)],[(0,350),(0,50)]):
            with self.subTest(path=path):
                observed=drawing([marker("rounded-original",90.5,110.5)])
                install_openings(observed,"source-survey",path,[((0,90),(0,110))])
                self.assertEqual([item.id for item in observed.exits],["source-survey:opening_1"])

    def test_a_coarse_bank_is_replaced_but_neighboring_doors_are_preserved(self):
        observed=drawing([marker("coarse-bank",80,320),marker("adjacent-door",110,130),
                          marker("different-wall",90,110,x=100)])
        install_openings(observed,"source-survey",[(0,50),(0,350)],
                         [((0,90),(0,110)),((0,290),(0,310))])
        self.assertEqual([item.id for item in observed.exits],
                         ["adjacent-door","different-wall","source-survey:opening_1","source-survey:opening_2"])


if __name__=="__main__":
    unittest.main()
