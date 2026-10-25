"""Body-clear visibility routes and look-ahead steering for JuPedSim agents."""

import hashlib
import heapq
import math
import jupedsim

from shapely.geometry import LineString, Point, Polygon
from shapely.ops import nearest_points
from shapely.prepared import prep

from app.simulation.geometry import build_geometry, region_to_polygon
from app.simulation.budget import check_simulation_budget


class VisibilityGraph:
    def __init__(self, polygon):
        self.polygon = polygon
        self.visible_space = prep(polygon.buffer(1e-8, join_style="mitre"))
        self.vertices = list(dict.fromkeys(tuple(p) for ring in [polygon.exterior, *polygon.interiors]
                                          for p in list(ring.coords)[:-1]))
        self.edges = [[] for _ in self.vertices]
        for i, a in enumerate(self.vertices):
            for j in range(i):
                b = self.vertices[j]
                if self.visible(a, b):
                    distance = math.dist(a, b)
                    self.edges[i].append((j, distance))
                    self.edges[j].append((i, distance))

    def visible(self, a, b):
        return self.visible_space.covers(LineString([a, b]))

    def path(self, start, goal):
        if self.visible(start, goal):
            return [start, goal]
        count = len(self.vertices)
        points = [*self.vertices, start, goal]
        edges = [*self.edges, [], []]
        for i, point in enumerate(self.vertices):
            # Copy only adjacency lists that receive an endpoint connection.
            extra = []
            for index in (count, count + 1):
                if self.visible(point, points[index]):
                    distance = math.dist(point, points[index])
                    extra.append((index, distance))
                    edges[index].append((i, distance))
            if extra:
                edges[i] = [*edges[i], *extra]
        distances, previous, queue = {count: 0}, {}, [(0, count)]
        while queue:
            cost, index = heapq.heappop(queue)
            if cost > distances[index]:
                continue
            if index == count + 1:
                result = [points[index]]
                while index != count:
                    index = previous[index]
                    result.append(points[index])
                return result[::-1]
            for neighbor, distance in edges[index]:
                value = cost + distance
                if value < distances.get(neighbor, math.inf):
                    distances[neighbor] = value
                    previous[neighbor] = index
                    heapq.heappush(queue, (value, neighbor))
        return None


class MeshGraph:
    """Use the installed engine's navmesh for plans with many table vertices.

    Building an all-pairs visibility graph is quadratic in obstacle corners.
    The mesh uses the same already-eroded, body-clear polygon as the small-plan
    planner, so choosing it does not change physical body clearance.
    """
    def __init__(self, polygon):
        self.polygon = polygon
        self.engine = jupedsim.RoutingEngine(polygon.buffer(1e-8))
        self.visible_space = prep(polygon.buffer(1e-8))

    def path(self, start, goal):
        if self.visible_space.covers(LineString([start, goal])):
            return [start, goal]
        if not self.engine.is_routable(start) or not self.engine.is_routable(goal):
            return None
        return self.engine.compute_waypoints(start, goal)


def routing_graph(component):
    vertices = len(component.exterior.coords) + sum(len(ring.coords) for ring in component.interiors)
    return MeshGraph(component) if vertices > 160 else VisibilityGraph(component)


def body_clear_components(geometry, radius):
    """The same passable floor components for placement and route planning."""
    safe = geometry.buffer(-(radius + 0.02), quad_segs=3)
    return [safe] if isinstance(safe, Polygon) else list(getattr(safe, "geoms", []))


class RoutePlanner:
    def __init__(self, geometry: Polygon, radius: float):
        self.radius = radius
        self.body_space = geometry.buffer(-radius + 1e-7, quad_segs=8)
        self.visible_body_space = prep(self.body_space.buffer(1e-7, join_style="mitre"))
        # Round offsets represent circular bodies at sharp door jambs. Mitre
        # offsets can create artificial spikes that close a perfectly usable door.
        self.components = body_clear_components(geometry, radius)
        self.graphs = [routing_graph(component) for component in self.components if not component.is_empty]
        self.target_areas = {}

    def route(self, start, exit_polygon, preferred=None):
        start_point = Point(start)
        choices = []
        for graph_index, graph in enumerate(self.graphs):
            component = graph.polygon
            key = (graph_index, id(exit_polygon))
            cached = self.target_areas.get(key)
            if cached is None:
                target_area = component.intersection(exit_polygon)
                self.target_areas[key] = (exit_polygon, target_area)
            else:
                _, target_area = cached
            if target_area.is_empty or target_area.area < 1e-8:
                continue
            entry = start_point if component.covers(start_point) else nearest_points(component, start_point)[0]
            if entry.distance(start_point) > 0.04 or not self.visible_body_space.covers(LineString([start_point, entry])):
                continue
            goal = target_area.representative_point()
            if preferred is not None:
                desired = Point(preferred)
                goal = desired if target_area.covers(desired) else nearest_points(target_area, desired)[0]
            path = graph.path((entry.x, entry.y), (goal.x, goal.y))
            if path is None:
                continue
            points = [tuple(start)]
            if entry.distance(start_point) > 1e-6:
                points.append((entry.x, entry.y))
            points.extend(tuple(point) for point in path[1:])
            distance = sum(math.dist(a, b) for a, b in zip(points, points[1:]))
            choices.append((distance, points))
        return min(choices, key=lambda choice: choice[0]) if choices else None

    def next_target(self, position, path, cursor):
        # Skip corners as soon as the full body has a clear line to a later
        # target. Crowds need not all touch the same tiny waypoint circle.
        # A neighbor can push someone back behind a corner after it was skipped;
        # re-check earlier corners too instead of keeping an occluded target.
        for index in range(len(path) - 1, 0, -1):
            if self.visible_body_space.covers(LineString([position, path[index]])):
                return path[index], index
        return path[cursor], cursor

    def update_route(self, position, path, cursor, exit_polygon):
        """Recover locally when a crowd displaces someone behind a door jamb.

        An old visible corner may be far behind someone who already passed it.
        Route from the actual position instead of walking back to that corner.
        Keep the same destination so recovery does not change exit or door lane.
        """
        target, index = self.next_target(position, path, cursor)
        if index < cursor or not self.visible_body_space.covers(LineString([position, target])):
            replacement = self.route(position, exit_polygon, preferred=path[-1])
            if replacement is not None:
                _, path = replacement
                target, index = self.next_target(position, path, 1)
        return target, path, index


def preferred_exit_point(agent_id, polygon, boundary):
    if boundary is None:
        return None
    digest = hashlib.sha256(f"{agent_id}:{boundary.id}".encode()).digest()
    fraction = .12 + .76 * int.from_bytes(digest[:4], "big") / (2**32 - 1)
    a,b = boundary.start,boundary.end
    width=math.dist(a,b)
    along=.01+(width-.02)*fraction
    depth=min(sum((p[i]-a[i])*boundary.outward[i] for i in range(2)) for p in polygon.exterior.coords)+.08
    return tuple(a[i]+(b[i]-a[i])*along/width+boundary.outward[i]*depth for i in range(2))


def plan_routes(scenario, geometry=None, planner=None, allow_trapped=False):
    planner = planner or RoutePlanner(geometry if geometry is not None else build_geometry(scenario), scenario.agent_defaults.radius)
    blocked = set(scenario.settings.blocked_exit_ids)
    boundaries = {boundary.id: boundary for boundary in scenario.exit_boundaries}
    exits = [(region, region_to_polygon(region)) for region in sorted(scenario.exits, key=lambda r: r.id)
             if region.id not in blocked]
    routes = []
    for index, person in enumerate(scenario.occupants):
        if index % 16 == 0:
            check_simulation_budget()
        choices = []
        # The distance to a target's bounding box is a lower bound on every
        # body-clear route to it. Stop only when no remaining exit can beat the
        # best actual route; this retains exact routing and stable tie breaking.
        def lower_bound(pair):
            region, polygon = pair
            left, bottom, right, top = polygon.bounds
            x, y = person.position
            return (math.hypot(max(left-x, 0, x-right), max(bottom-y, 0, y-top)), region.id)
        best = math.inf
        for region, polygon in sorted(exits, key=lower_bound):
            if lower_bound((region, polygon))[0] > best + 1e-9:
                break
            preferred = None
            boundary = boundaries.get(region.id)
            if boundary:
                digest = hashlib.sha256(f"{person.id}:{region.id}".encode()).digest()
                fraction = .12 + .76 * int.from_bytes(digest[:4], "big") / (2**32 - 1)
                # Fitting an outside target around a concave footprint may
                # reorder/add polygon vertices. Door lanes follow the actual
                # threshold, never whichever polygon edge happens to come first.
                a,b=boundary.start,boundary.end
                width=math.dist(a,b)
                along=.01+(width-.02)*fraction
                depth=min(sum((p[i]-a[i])*boundary.outward[i] for i in range(2))
                          for p in region.polygon)+.08
                preferred=tuple(a[i]+(b[i]-a[i])*along/width+boundary.outward[i]*depth for i in range(2))
            planned = planner.route(person.position, polygon, preferred)
            if planned:
                distance, points = planned
                choices.append((distance, region.id, points))
                best = min(best, distance)
        if not choices:
            if allow_trapped:
                routes.append({"agent_id": person.id, "exit_id": None, "route_length": None,
                               "path": [person.position], "status": "trapped",
                               "reason": "No body-clear route to an available exit"})
                continue
            raise ValueError(f"No body-clear route to an available exit for occupant '{person.id}' "
                             f"(radius {scenario.agent_defaults.radius:g} m). Move furniture, widen the passage, or choose another exit.")
        distance, exit_id, points = min(choices, key=lambda choice: (choice[0], choice[1]))
        routes.append({"agent_id": person.id, "exit_id": exit_id, "route_length": distance, "path": points})
    return routes
