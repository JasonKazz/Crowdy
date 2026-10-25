"""Bound playback bytes while retaining every person and native outcome."""

import json

from app.limits import MAX_SIMULATION_RESULT_BYTES


def bound_simulation_result(result, limit=MAX_SIMULATION_RESULT_BYTES):
    execution = result.get("execution", {})
    if execution.get("population_count", 0) > 200:
        for assignment in result["assignments"]:
            assignment.pop("path", None)
        room_data = result.get("editor_metadata", {}).get("room_population")
        if room_data:
            room_data.pop("normal_placements", None)
            room_data.pop("assignments", None)
        execution["omitted_duplicate_details"] = ["planned_route_vertices", "placement_detail_arrays"]
    def size():
        return len(json.dumps(result, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode())
    while size() > limit - 1024 and len(result["frames"]) > 2:
        frames = result["frames"]
        result["frames"] = [frames[0], *frames[2:-1:2], frames[-1]]
        execution["playback_temporally_thinned"] = True
        execution["playback_sample_interval"] = max((b["time"] - a["time"] for a, b in zip(result["frames"], result["frames"][1:])), default=0)
    if size() > limit - 1024:
        raise ValueError("This full-agent result exceeds the bounded response size even at minimum playback cadence. Reduce the crowd or simplify the layout.")
    return result
