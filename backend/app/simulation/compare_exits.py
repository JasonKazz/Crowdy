"""Run a matched baseline and blocked-exit case, then save both for HTML playback."""

import argparse
import json
from pathlib import Path

from app.schemas.scenario import Scenario
from app.services.scenarios.compare import compare_exit_availability


def main():
    repo_root = Path(__file__).resolve().parents[3]
    parser = argparse.ArgumentParser(description="Compare all-open and blocked-exit runs")
    parser.add_argument(
        "scenario", nargs="?", type=Path,
        default=repo_root / "examples" / "two_exit_room.json",
    )
    parser.add_argument(
        "--block-exit", action="append", required=True,
        help="Exit ID to close for the entire run; repeat for several exits",
    )
    args = parser.parse_args()
    input_path = args.scenario.resolve()
    try:
        scenario = Scenario.model_validate_json(input_path.read_text(encoding="utf-8"))
        pair = compare_exit_availability(scenario, args.block_exit)
    except (OSError, ValueError) as exc:
        parser.error(str(exc))

    output_dir = repo_root / "backend" / "data"
    output_dir.mkdir(parents=True, exist_ok=True)
    for name in ("baseline", "blocked"):
        path = output_dir / f"{input_path.stem}_{name}_result.json"
        path.write_text(json.dumps(pair[name], indent=2, allow_nan=False), encoding="utf-8")
        result = pair[name]
        summary = result["summary"]
        print(f"{name.title()}: {result['status']}; "
              f"{summary['evacuated_count']} evacuated, "
              f"{summary['remaining_count']} remaining")
        for exit_id, count in summary["per_exit_counts"].items():
            label = " (blocked)" if exit_id in result["scenario"]["settings"]["blocked_exit_ids"] else ""
            print(f"  {exit_id}{label}: {count}")
        clearance = summary["clearance_time"]
        print(f"  Clearance: {clearance:.2f} s" if clearance is not None else "  Clearance: incomplete")
        print(f"  Saved: {path}")

    report = pair["comparison"]
    path = output_dir / f"{input_path.stem}_comparison.json"
    path.write_text(json.dumps(report, indent=2, allow_nan=False), encoding="utf-8")
    print("Same starting people and positions: yes")
    delta = report["clearance_time_change_s"]
    if delta is None:
        print("Clearance change: unavailable because a run did not complete")
    else:
        print(f"Clearance change (blocked - baseline): {delta:+.2f} s")
    print(f"Saved comparison: {path}")


if __name__ == "__main__":
    main()
