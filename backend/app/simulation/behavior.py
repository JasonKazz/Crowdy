"""Repeatable illustrative behavior; these distributions are not calibrated data.

Keep intrinsic walking speeds in Scenario. Per-run behavior is separate so a
comparison never accidentally applies variation twice or moves starting people.
"""

import hashlib
import random

from app.schemas.scenario import Scenario


def agent_behaviors(scenario: Scenario) -> list[dict]:
    behaviors = []
    for person in scenario.occupants:
        base_speed = person.desired_speed or scenario.agent_defaults.desired_speed
        delay, factor = 0.0, 1.0
        if scenario.settings.behavior_mode == "behavioral":
            # Stable across process restarts, input order, geometry and closures.
            digest = hashlib.sha256(f"crowdy-behavior-v1:{scenario.settings.behavior_seed}:{person.id}".encode()).digest()
            rng = random.Random(int.from_bytes(digest, "big"))
            delay = round(rng.triangular(0, 12, 3), 4)
            factor = round(rng.triangular(.85, 1.15, 1), 6)
        behaviors.append({"agent_id": person.id, "response_delay": delay,
                          "speed_factor": factor, "desired_speed": round(base_speed * factor, 6)})
    return behaviors
