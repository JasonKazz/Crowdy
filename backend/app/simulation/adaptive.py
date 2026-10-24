"""Congestion-aware exit reconsideration with commitment and hysteresis.

Queue-service estimates are illustrative, not calibrated pedestrian predictions.
The native engine still owns every position and every collision interaction.
"""
import math
from shapely.geometry import Point
from app.simulation.routing import preferred_exit_point


class AdaptiveExitChoices:
    def __init__(self,scenario,planner,exit_shapes,behaviors):
        self.scenario=scenario;self.planner=planner;self.shapes=exit_shapes;self.behaviors=behaviors
        self.boundaries={b.id:b for b in scenario.exit_boundaries}
        self.cooldown={};self.switch_count={};self.events=[]
        self.centres={key:shape.representative_point() for key,shape in exit_shapes.items()}
        self.widths={key:math.dist(self.boundaries[key].start,self.boundaries[key].end) if key in self.boundaries
                     else max(.6,min(shape.bounds[2]-shape.bounds[0],shape.bounds[3]-shape.bounds[1])) for key,shape in exit_shapes.items()}

    def reconsider(self,agents,agent_ids,agent_exits,paths,cursors,now,committed):
        active=[a for a in agents if agent_exits.get(a.id) is not None and a.id not in committed]
        if len(self.shapes)<2:return
        def distance(agent,exit_id):return Point(agent.position).distance(self.shapes[exit_id])
        def queue(agent,exit_id):
            current_distance=distance(agent,exit_id)
            # Count people physically near the doorway and at least as close to
            # it, rather than treating every remote assigned person as a queue.
            return sum(1 for other in active if other.id!=agent.id and agent_exits[other.id]==exit_id
                       and distance(other,exit_id)<4 and distance(other,exit_id)<=current_distance+.5)
        def remaining(agent):
            path=paths[agent.id];cursor=min(cursors[agent.id],len(path)-1)
            return math.dist(agent.position,path[cursor])+sum(math.dist(a,b) for a,b in zip(path[cursor:],path[cursor+1:]))
        for agent in sorted(active,key=lambda a:agent_ids[a.id]):
            identifier=agent_ids[agent.id];current=agent_exits[agent.id]
            if now<self.cooldown.get(identifier,-1) or self.switch_count.get(identifier,0)>=3 or distance(agent,current)<1:
                continue
            ahead=queue(agent,current)
            if ahead<3:continue
            speed=self.behaviors[identifier]['desired_speed']
            current_cost=remaining(agent)/speed+ahead/max(.65,1.2*self.widths[current])
            options=[]
            for exit_id,shape in sorted(self.shapes.items()):
                if exit_id==current:continue
                wait=queue(agent,exit_id)/max(.65,1.2*self.widths[exit_id])
                required=max(1.5,.2*current_cost)
                if distance(agent,exit_id)/speed+wait>=current_cost-required:continue
                boundary=self.boundaries.get(exit_id)
                preferred=preferred_exit_point(identifier,shape,boundary)
                route=self.planner.route(agent.position,shape,preferred)
                if route is None:continue
                length,path=route
                score=length/speed+wait
                if score<current_cost-required:options.append((score,exit_id,path))
            if not options:continue
            score,exit_id,path=min(options,key=lambda value:(value[0],value[1]))
            agent_exits[agent.id]=exit_id;paths[agent.id]=path;cursors[agent.id]=1
            self.cooldown[identifier]=now+5
            self.switch_count[identifier]=self.switch_count.get(identifier,0)+1
            self.events.append(dict(agent_id=identifier,from_exit_id=current,to_exit_id=exit_id,time=round(now,8),
                                    estimated_seconds_saved=round(current_cost-score,4),reason='congestion'))
