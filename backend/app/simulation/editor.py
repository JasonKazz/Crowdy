"""Local development editor. Start with: python -m app.simulation.editor"""

import argparse
import json
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

from app.schemas.extraction import ExtractionRequest, ImageUpload
from app.schemas.layout import Layout, load_layout
from app.services.floorplans.images import draft_layout, extract_image, image_path, save_image
from app.services.floorplans.layout import compile_layout
from app.services.floorplans.providers import load_environment, provider_status
from app.services.population.generate import resolve_population
from app.simulation.animate import render_html
from app.simulation.engine import run_simulation
from app.simulation.geometry import build_geometry
from app.simulation.routing import plan_routes


MAX_BODY = 2 * 1024 * 1024
MAX_IMAGE_BODY = 14 * 1024 * 1024


def validate_layout(layout: Layout) -> dict:
    scenario = compile_layout(layout)
    resolved = resolve_population(scenario)
    geometry = build_geometry(resolved)
    return {
        "area_m2": geometry.area,
        "occupants": [person.model_dump(mode="json") for person in resolved.occupants],
        "routes": plan_routes(resolved, geometry, allow_trapped=True),
        "scenario": scenario.model_dump(mode="json"),
    }


def save_run(layout: Layout, output_dir: Path) -> tuple[str, dict]:
    """Each run keeps its editable input, compiled input, result, and playback."""
    scenario = compile_layout(layout)
    result = run_simulation(scenario)
    run_id = uuid.uuid4().hex
    run_dir = output_dir / run_id
    run_dir.mkdir(parents=True)
    documents = {
        "layout": layout.model_dump(mode="json"),
        "scenario": scenario.model_dump(mode="json"),
        "result": result,
    }
    for name, document in documents.items():
        (run_dir / f"{name}.json").write_text(
            json.dumps(document, indent=2, allow_nan=False), encoding="utf-8",
        )
    (run_dir / "playback.html").write_text(render_html(result), encoding="utf-8")
    return run_id, {"status": result["status"], "summary": result["summary"]}


class EditorServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, layout: Layout, output_dir: Path):
        super().__init__(address, EditorHandler)
        self.layout = layout
        self.output_dir = output_dir
        self.runs: set[str] = set()
        self.run_lock = threading.Lock()
        self.extraction_lock = threading.Lock()


class EditorHandler(BaseHTTPRequestHandler):
    def send_content(self, status: int, body: bytes, content_type: str):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, status: int, document: dict):
        self.send_content(status, json.dumps(document, allow_nan=False).encode(),
                          "application/json; charset=utf-8")

    def local_request(self) -> bool:
        port = self.server.server_address[1]
        hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}
        host = self.headers.get("Host")
        origin = self.headers.get("Origin")
        return host in hosts and (origin is None or origin == f"http://{host}")

    def do_GET(self):
        if not self.local_request():
            return self.send_json(403, {"error": "Use the editor's local address"})
        path = urlsplit(self.path).path
        if path == "/":
            page = Path(__file__).with_name("editor.html").read_bytes()
            return self.send_content(200, page, "text/html; charset=utf-8")
        if path in {"/editor-geometry.js", "/editor-image-tools.js", "/editor-population.js", "/editor-app.js"}:
            script = Path(__file__).with_name(path[1:]).read_bytes()
            return self.send_content(200, script, "text/javascript; charset=utf-8")
        if path == "/api/layout":
            return self.send_json(200, self.server.layout.model_dump(mode="json"))
        if path == "/api/providers":
            return self.send_json(200, provider_status())
        parts = path.strip("/").split("/")
        if len(parts) == 2 and parts[0] == "images":
            try:
                image = image_path(self.server.output_dir, parts[1])
                if image.is_file():
                    return self.send_content(200, image.read_bytes(), "image/png")
            except ValueError:
                pass
            return self.send_json(404, {"error": "Image not found"})
        if len(parts) == 3 and parts[0] == "runs" and parts[1] in self.server.runs:
            files = {"playback": ("playback.html", "text/html; charset=utf-8"),
                     **{name: (f"{name}.json", "application/json; charset=utf-8")
                        for name in ("layout", "scenario", "result")}}
            if parts[2] in files:
                name, mime = files[parts[2]]
                return self.send_content(200, (self.server.output_dir / parts[1] / name).read_bytes(), mime)
        self.send_json(404, {"error": "Not found"})

    def do_POST(self):
        if not self.local_request():
            return self.send_json(403, {"error": "Only same-origin local editor requests are allowed"})
        if self.headers.get_content_type() != "application/json":
            return self.send_json(415, {"error": "Send application/json"})
        path = urlsplit(self.path).path
        if path not in {"/api/import", "/api/validate", "/api/simulate", "/api/images", "/api/extract"}:
            return self.send_json(404, {"error": "Not found"})
        try:
            size = int(self.headers.get("Content-Length", "0"))
            maximum = MAX_IMAGE_BODY if path == "/api/images" else MAX_BODY
            if size <= 0 or size > maximum:
                return self.send_json(413, {"error": f"Provide a JSON document smaller than {maximum // (1024 * 1024)} MiB"})
            document = json.loads(self.rfile.read(size))
            if not isinstance(document, dict):
                raise ValueError("The layout must be a JSON object")
            if path == "/api/images":
                source = save_image(ImageUpload.model_validate(document), self.server.output_dir)
                return self.send_json(200, {"layout": draft_layout(source).model_dump(mode="json")})
            if path == "/api/extract":
                request = ExtractionRequest.model_validate(document)
                if not self.server.extraction_lock.acquire(blocking=False):
                    return self.send_json(409, {"error": "An image extraction is already running. Wait for it to finish."})
                try:
                    result = extract_image(request, self.server.output_dir)
                finally:
                    self.server.extraction_lock.release()
                return self.send_json(200, result)
            layout = load_layout(document)
            if path == "/api/import":
                return self.send_json(200, layout.model_dump(mode="json"))
            if path == "/api/validate":
                return self.send_json(200, validate_layout(layout))
            if not self.server.run_lock.acquire(blocking=False):
                return self.send_json(409, {"error": "A simulation is already running; wait for it to finish"})
            try:
                run_id, outcome = save_run(layout, self.server.output_dir)
                self.server.layout = layout
                self.server.runs.add(run_id)
            finally:
                self.server.run_lock.release()
            self.send_json(200, {**outcome, "run_id": run_id,
                                 "playback_url": f"/runs/{run_id}/playback"})
        except (ValueError, RuntimeError) as exc:
            self.send_json(422, {"error": str(exc)})
        except OSError:
            self.send_json(500, {"error": "Could not save this run; check the terminal and output folder"})


def main():
    root = Path(__file__).resolve().parents[3]
    parser = argparse.ArgumentParser(description="Edit a layout and run real backend simulations locally")
    parser.add_argument("layout", type=Path, nargs="?", default=root / "examples/editable_office.json")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--env-file", type=Path, help="Optional .env path; defaults to the repository root .env")
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("port must be between 1 and 65535")
    load_environment(args.env_file)
    layout = load_layout(json.loads(args.layout.read_text(encoding="utf-8")))
    try:
        server = EditorServer(("127.0.0.1", args.port), layout, root / "backend/data/editor")
    except OSError as exc:
        raise SystemExit(f"Could not start editor: {exc}. Try --port 8766.") from exc
    print(f"Crowdy editor: http://127.0.0.1:{args.port}", flush=True)
    print("Image providers: " + ", ".join(
        f"{provider}: {'configured' if details['configured'] else 'key missing'}"
        for provider, details in provider_status().items()
    ), flush=True)
    print("Leave this terminal running. Press Ctrl+C to stop. Export JSON to keep unfinished edits.", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nEditor stopped.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
