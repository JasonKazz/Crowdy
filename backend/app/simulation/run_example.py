from pathlib import Path

from app.schemas.scenario import Scenario


def main():
    repo_root = Path(__file__).resolve().parents[3]
    example_path = repo_root / "examples" / "simple_room.json"

    scenario = Scenario.model_validate_json(
        example_path.read_text(encoding="utf-8")
    )

    print(f"Loaded: {scenario.name}")
    print(f"Walkable areas: {len(scenario.walkable_areas)}")
    print(f"Obstacles: {len(scenario.obstacles)}")
    print(f"Exits: {len(scenario.exits)}")
    print(f"Occupants: {len(scenario.occupants)}")


if __name__ == "__main__":
    main()