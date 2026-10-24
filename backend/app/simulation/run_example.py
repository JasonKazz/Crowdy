import argparse
import json
from pathlib import Path

from app.schemas.scenario import Scenario
from app.simulation.engine import run_simulation


def main():
    repo_root = Path(__file__).resolve().parents[3]
    parser = argparse.ArgumentParser(description="Run a Crowdy scenario JSON file")
    parser.add_argument(
        "scenario", nargs="?", type=Path,
        default=repo_root / "examples" / "simple_room.json",
    )
    args = parser.parse_args()
    example_path = args.scenario.resolve()

    scenario = Scenario.model_validate_json(
        example_path.read_text(encoding="utf-8")
    )
    result = run_simulation(scenario)

    output_path = repo_root / "backend" / "data" / f"{example_path.stem}_result.json"
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(result, indent=2, allow_nan=False),
        encoding="utf-8",
    )

    summary = result["summary"]
    print(f"Status: {result['status']}")
    print(f"Evacuated: {summary['evacuated_count']}")
    print(f"Remaining: {summary['remaining_count']}")
    for exit_id, count in summary["per_exit_counts"].items():
        print(f"  {exit_id}: {count} evacuated")
    print(f"Recorded frames: {len(result['frames'])}")
    if summary["clearance_time"] is not None:
        print(f"Clearance time: {summary['clearance_time']:.2f} seconds")
    else:
        print("Clearance time: incomplete evacuation")
    print(f"Saved results: {output_path}")


if __name__ == "__main__":
    main()
