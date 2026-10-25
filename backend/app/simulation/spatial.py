"""Exact local point-clearance queries without scanning the entire crowd."""

import math


class SpatialIndex:
    def __init__(self, cell_size):
        self.cell_size = cell_size
        self.cells = {}

    def add(self, point, value=None):
        key = tuple(math.floor(axis / self.cell_size) for axis in point)
        self.cells.setdefault(key, []).append((point, value))

    def nearby(self, point, distance=None):
        distance = self.cell_size if distance is None else distance
        x, y = (math.floor(axis / self.cell_size) for axis in point)
        reach = math.ceil(distance / self.cell_size)
        for dx in range(-reach, reach + 1):
            for dy in range(-reach, reach + 1):
                yield from self.cells.get((x + dx, y + dy), ())

    def collides(self, point, distance=None):
        distance = self.cell_size if distance is None else distance
        return any(math.dist(point, other) < distance for other, _ in self.nearby(point, distance))
