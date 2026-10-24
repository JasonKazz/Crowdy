"""Run real extraction and render the recovered geometry for visual evaluation.

From backend/: python scripts/evaluate_extraction.py IMAGE --provider claude
Artifacts (including provider observations) stay in ignored data/ storage.
"""
import argparse
import base64
import json
from pathlib import Path
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.schemas.extraction import ImageUpload, ExtractionRequest
from app.services.floorplans.images import save_image, extract_image
from app.services.floorplans.providers import load_environment


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("image", type=Path)
    parser.add_argument("--provider", choices=("claude", "gemini"), default="claude")
    parser.add_argument("--env", type=Path)
    parser.add_argument("--output", type=Path, default=Path("data/pipeline-evaluation"))
    args = parser.parse_args()
    load_environment(args.env)
    source = save_image(ImageUpload(filename=args.image.name,
        image_base64=base64.b64encode(args.image.read_bytes()).decode()), args.output)
    started = time.monotonic()
    def progress(message):
        print(f"{time.monotonic()-started:.0f}s: {message}", flush=True)
    result = extract_image(ExtractionRequest(image_id=source.id, provider=args.provider), args.output, progress)
    output = args.output / f"{args.image.stem}-{args.provider}-result.json"
    output.write_text(json.dumps(result, indent=2))
    candidate = result["results"][0]
    print(json.dumps({k:v for k,v in candidate.items() if k != "layout"}, indent=2), flush=True)
    # Canonical stage output can be inspected even if calibration needs input.
    canonical = args.output / "extractions" / candidate["extraction_id"] / "stages" / "canonical.json"
    if canonical.is_file():
        render(canonical, args.output / "images" / source.id / "source.png", output.with_suffix(".png"))
    if candidate.get("error"):
        raise SystemExit(1)


def render(canonical, source, destination):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.patches import Polygon
    from PIL import Image
    data = json.loads(canonical.read_text())
    image = Image.open(source)
    fig, ax = plt.subplots(figsize=(20, 12))
    ax.imshow(image, alpha=.7)
    points = lambda ps: [(p["x"],p["y"]) for p in ps]
    ax.add_patch(Polygon(points(data["floor_outline"]), fill=False, edgecolor="#1976d2", linewidth=2))
    for item in data["walls"]:
        ax.plot([item["start"]["x"],item["end"]["x"]], [item["start"]["y"],item["end"]["y"]], color="#ef6c00", linewidth=2)
    for item in data["doors"]:
        ax.plot([item["start"]["x"],item["end"]["x"]], [item["start"]["y"],item["end"]["y"]], color="#00acc1", linewidth=4)
    for key, color in (("furniture", "#d81b60"), ("exits", "#00c853")):
        for item in data[key]:
            ax.add_patch(Polygon(points(item["polygon"]), facecolor=color, edgecolor=color, alpha=.45))
    for ref in data["scale_references"]:
        a,b=ref["start"],ref["end"]
        ax.plot([a["x"],b["x"]],[a["y"],b["y"]],color="blue",linewidth=2)
        ax.text((a["x"]+b["x"])/2,(a["y"]+b["y"])/2,ref["label"],color="blue",fontsize=8)
    ax.set(xlim=(0,image.width), ylim=(image.height,0), title="Blue: boundary/scale · Orange: walls · Cyan: doors · Pink: furniture · Green: exterior exits")
    ax.set_aspect("equal")
    fig.tight_layout()
    fig.savefig(destination, dpi=140)
    plt.close(fig)
    print(f"Overlay: {destination}")

if __name__ == "__main__":
    main()
