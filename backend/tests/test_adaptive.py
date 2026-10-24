"""Actual native trajectories exercise congestion decisions and physical limits."""
import math
import unittest
from types import SimpleNamespace
from unittest.mock import Mock
from shapely.geometry import Point, Polygon
from app.schemas.scenario import Occupant
from app.simulation.editor_adapter import editor_to_scenario
from app.simulation.engine import run_simulation
from app.simulation.geometry import build_geometry
from test_workspace_api import room_request


def congestion_scenario():
    payload=room_request(30)
    payload['plan']['walls'][2]['y2']=235.2
    payload['plan']['walls'][3]['y1']=260.8
    scenario=editor_to_scenario(payload['plan'],payload['scenario'])
    scenario.occupants=[Occupant(id=f'p{i:04d}',position=(3.8+(i%5)*.6,9.2+(i//5)*.6),desired_speed=1.2) for i in range(30)]
    scenario.settings.behavior_mode='behavioral'
    return scenario


class AdaptiveTests(unittest.TestCase):
    def test_congested_exit_switches_without_teleport_or_collision(self):
        scenario=congestion_scenario();result=run_simulation(scenario)
        self.assertEqual(result['status'],'completed')
        self.assertEqual(result['routing']['mode'],'adaptive')
        changes=result['routing']['exit_changes'];self.assertGreater(len(changes),0)
        self.assertEqual(result['routing'],run_simulation(scenario)['routing'])
        chain={a['agent_id']:a['exit_id'] for a in result['assignments']};last={};counts={}
        for change in changes:
            identifier=change['agent_id']
            self.assertEqual(change['from_exit_id'],chain[identifier])
            self.assertNotEqual(change['from_exit_id'],change['to_exit_id'])
            self.assertGreaterEqual(change['time']-last.get(identifier,-100),5)
            chain[identifier]=change['to_exit_id'];last[identifier]=change['time']
            counts[identifier]=counts.get(identifier,0)+1
            self.assertLessEqual(counts[identifier],3)
        for assignment in result['assignments']:
            self.assertEqual(assignment['final_exit_id'],chain[assignment['agent_id']])
        for event in result['evacuations']:
            self.assertEqual(event['exit_id'],chain[event['agent_id']])
        geometry=build_geometry(scenario);previous={}
        max_speed=max(b['desired_speed'] for b in result['behavior']['agents'])
        for frame in result['frames']:
            people=frame['agents']
            for i,person in enumerate(people):
                position=(person['x'],person['y'])
                self.assertGreaterEqual(Point(position).distance(geometry.boundary),.23-1e-5)
                for other in people[i+1:]:
                    self.assertGreaterEqual(math.dist(position,(other['x'],other['y'])),.46-1e-5)
                if person['id'] in previous:
                    old,time=previous[person['id']]
                    self.assertLessEqual(math.dist(old,position),max_speed*(frame['time']-time)+1e-5)
                previous[person['id']]=(position,frame['time'])

    def test_unreachable_alternative_and_committed_agents_are_not_switched(self):
        from app.simulation.adaptive import AdaptiveExitChoices
        from app.simulation.behavior import agent_behaviors
        from app.simulation.routing import RoutePlanner, plan_routes
        scenario=congestion_scenario()
        planner=RoutePlanner(build_geometry(scenario),scenario.agent_defaults.radius)
        routes=plan_routes(scenario,planner=planner)
        shapes={exit.id:Polygon(exit.polygon) for exit in scenario.exits}
        behaviors={b['agent_id']:b for b in agent_behaviors(scenario)}
        agents=[SimpleNamespace(id=i,position=p.position) for i,p in enumerate(scenario.occupants)]
        ids={i:p.id for i,p in enumerate(scenario.occupants)}
        exits={i:route['exit_id'] for i,route in enumerate(routes)}
        paths={i:route['path'] for i,route in enumerate(routes)}
        cursors={i:1 for i in ids}
        unreachable=Mock();unreachable.route.return_value=None
        chooser=AdaptiveExitChoices(scenario,unreachable,shapes,behaviors)
        chooser.reconsider(agents,ids,exits,paths,cursors,0,set())
        self.assertTrue(unreachable.route.called)
        self.assertEqual(chooser.events,[])
        unreachable.reset_mock()
        chooser.reconsider(agents,ids,exits,paths,cursors,0,set(ids))
        unreachable.route.assert_not_called()

    def test_direct_mode_keeps_initial_routes_and_closures_cannot_be_chosen(self):
        scenario=congestion_scenario();scenario.settings.behavior_mode='idealized'
        direct=run_simulation(scenario)
        self.assertEqual(direct['routing']['mode'],'fixed')
        self.assertEqual(direct['routing']['exit_changes'],[])
        self.assertTrue(all(a['exit_id']==a['final_exit_id'] for a in direct['assignments']))
        scenario.settings.behavior_mode='behavioral';scenario.settings.blocked_exit_ids=['east']
        closed=run_simulation(scenario)
        self.assertEqual(closed['routing']['exit_changes'],[])
        self.assertTrue(all(a['final_exit_id']=='west' for a in closed['assignments']))

if __name__=='__main__':unittest.main()
