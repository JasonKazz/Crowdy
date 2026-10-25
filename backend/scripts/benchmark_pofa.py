"""Measure actual full-agent POFA runs without providers or external services.

From the repository root:
  PYTHONPATH=backend backend/.venv/bin/python backend/scripts/benchmark_pofa.py \
      --counts 200 1000 5000 --output /tmp/pofa-benchmark.json
"""

import argparse
import json
from pathlib import Path
import platform
import resource
import time

from app.api import SimulationRequest, run_editor_simulation


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--counts", type=int, nargs="+", default=[200, 1000, 5000])
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    source = Path(__file__).resolve().parents[2] / "frontend/src/lib/demos/pofa-verified.json"
    plan = json.loads(source.read_text())["plan"]
    reports = []
    for count in args.counts:
        payload = SimulationRequest(plan=plan, scenario={"occupancy": count, "mobility": "standard",
            "distribution": "normal", "seed": 42, "body_width": .46, "behavior_mode": "idealized"})
        started = time.perf_counter()
        result = run_editor_simulation(payload)
        peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        report = {"population": count, "platform": platform.platform(), "wall_seconds": time.perf_counter()-started,
            "max_rss_bytes": peak if platform.system() == "Darwin" else peak*1024,
            "json_bytes": len(json.dumps(result, separators=(",", ":")).encode()),
            "execution": result["execution"], "summary": result["summary"]}
        reports.append(report)
        args.output.write_text(json.dumps(reports, indent=2)+"\n")
        print(json.dumps(report), flush=True)


if __name__ == "__main__":
    main()
