from pathlib import Path

import matplotlib

matplotlib.use("Agg")

import matplotlib.pyplot as plt
from matplotlib.patches import Circle
from shapely.plotting import plot_polygon

from app.schemas.scenario import Scenario
from app.simulation.geometry import build_geometry, region_to_polygon


def main():
    repo_root = Path(__file__).resolve().parents[3]
    example_path = repo_root / "examples" / "simple_room.json"

    scenario = Scenario.model_validate_json(
        example_path.read_text(encoding="utf-8")
    )

    walkable = build_geometry(scenario)

    fig, ax = plt.subplots(figsize=(10, 7))

    plot_polygon(
        walkable,
        ax=ax,
        add_points=False,
        facecolor="#dbeafe",
        edgecolor="#1e293b",
    )

    for obstacle in scenario.obstacles:
        plot_polygon(
            region_to_polygon(obstacle),
            ax=ax,
            add_points=False,
            facecolor="#94a3b8",
            edgecolor="#334155",
        )

    for exit_region in scenario.exits:
        plot_polygon(
            region_to_polygon(exit_region),
            ax=ax,
            add_points=False,
            facecolor="#86efac",
            edgecolor="#166534",
        )

    for occupant in scenario.occupants:
        x, y = occupant.position

        ax.add_patch(Circle(
            (x, y),
            radius=scenario.agent_defaults.radius,
            facecolor="#f97316",
            edgecolor="#9a3412",
        ))

        ax.text(x, y + 0.3, occupant.id, ha="center", fontsize=9)

    ax.set_aspect("equal")
    ax.set_xlabel("x (meters)")
    ax.set_ylabel("y (meters)")
    ax.set_title(scenario.name)
    ax.grid(alpha=0.2)
    ax.margins(0.1)

    output_path = repo_root / "backend" / "data" / "simple_room.png"
    output_path.parent.mkdir(parents=True, exist_ok=True)

    fig.savefig(output_path, dpi=150, bbox_inches="tight")
    plt.close(fig)

    print(f"Walkable area: {walkable.area:.2f} square meters")
    print(f"Saved preview: {output_path}")


if __name__ == "__main__":
    main()