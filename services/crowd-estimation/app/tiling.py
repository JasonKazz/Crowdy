"""Bounded source-pixel tiles and cross-tile duplicate suppression."""

from dataclasses import dataclass
import math


class EstimationLimit(ValueError):
    pass


@dataclass(frozen=True)
class Tile:
    box: tuple[int, int, int, int]
    core: tuple[float, float, float, float]

    def owns(self, bbox):
        x, y = (bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2
        return self.core[0] <= x < self.core[2] and self.core[1] <= y < self.core[3]


def plan_tiles(width, height, size, overlap, maximum):
    step = max(1, int(size * (1 - overlap)))

    def starts(length):
        count = max(1, math.ceil(max(0, length - size) / step) + 1)
        if count > maximum:
            raise EstimationLimit("Image needs too many source-resolution tiles. Crop it into smaller views.")
        return [min(index * step, max(0, length - size)) for index in range(count)]

    xs, ys = starts(width), starts(height)
    if len(xs) * len(ys) > maximum:
        raise EstimationLimit("Image needs too many source-resolution tiles. Crop it into smaller views.")

    def bounds(values, index, length):
        left = 0 if index == 0 else (values[index - 1] + size + values[index]) / 2
        right = length if index == len(values) - 1 else (values[index] + size + values[index + 1]) / 2
        return left, right

    result = []
    for row, y in enumerate(ys):
        top, bottom = bounds(ys, row, height)
        for col, x in enumerate(xs):
            left, right = bounds(xs, col, width)
            result.append(Tile((x, y, min(x + size, width), min(y + size, height)),
                               (left, top, right, bottom)))
    return result


def merge_detections(candidates, limit, iou_threshold=.55, within_budget=lambda: True):
    """NMS only across tiles; preserve the model's same-tile person decisions.

    Unique tile cores own box centres. This second pass handles small centre
    jitter at a seam. A spatial hash bounds comparisons for large crowds.
    """
    cells, kept = {}, []
    cell_size = 128

    def occupied(box):
        return [(x, y) for x in range(int(box[0] // cell_size), int(box[2] // cell_size) + 1)
                for y in range(int(box[1] // cell_size), int(box[3] // cell_size) + 1)]

    work = 0
    for position, (detection, tile_index) in enumerate(sorted(candidates, key=lambda item: -item[0].confidence)):
        if position and position % 128 == 0 and not within_budget():
            return [item[0] for item in kept], False, False
        box = detection.bbox
        keys = occupied(box)
        nearby = {index for key in keys for index in cells.get(key, ())}
        duplicate = False
        for index in nearby:
            work += 1
            if work % 128 == 0 and not within_budget():
                return [item[0] for item in kept], False, False
            other, other_tile = kept[index]
            if other_tile == tile_index:
                continue
            b = other.bbox
            intersection = max(0, min(box[2], b[2]) - max(box[0], b[0])) * max(0, min(box[3], b[3]) - max(box[1], b[1]))
            union = (box[2] - box[0]) * (box[3] - box[1]) + (b[2] - b[0]) * (b[3] - b[1]) - intersection
            if union > 0 and intersection / union > iou_threshold:
                duplicate = True
                break
        if duplicate:
            continue
        index = len(kept)
        kept.append((detection, tile_index))
        for key in keys:
            cells.setdefault(key, []).append(index)
        # One extra unique person establishes actual truncation at the cap.
        if len(kept) > limit:
            return [item[0] for item in kept[:limit]], True, True
    return [item[0] for item in kept], False, True
