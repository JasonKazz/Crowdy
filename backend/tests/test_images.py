import asyncio
import time
import httpx
import base64
import copy
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from PIL import Image
from shapely.geometry import Point

from app.schemas.extraction import ExtractedDrawing, ExtractionInfo, ExtractionRequest, ImageUpload, SourceImage
from app.services.floorplans.images import (
    draft_layout, drawing_to_layout, extract_image, image_path, load_image, save_image,
)
from app.services.floorplans.layout import compile_layout
from app.services.floorplans.providers import (
    ProviderError, extract_drawing, load_environment, output_schema, provider_status, request_json,
)
from app.simulation.geometry import build_geometry


def point(x, y):
    return {"x": x, "y": y}


def region(identifier, x1, y1, x2, y2):
    return {"id": identifier, "label": identifier, "polygon": [
        point(x1, y1), point(x2, y1), point(x2, y2), point(x1, y2),
    ]}


def drawing_fixture():
    """Known pixel geometry, used only as an explicit fake provider response in tests."""
    return {
        "name": "Two-room test office",
        "floor_outline": region("floor", 50, 50, 950, 450)["polygon"],
        "rooms": [region("office", 50, 50, 500, 450), region("meeting", 500, 50, 950, 450)],
        "furniture": [region("table", 150, 150, 250, 250)],
        "walls": [{"id": "partition", "start": point(500, 50), "end": point(500, 450), "thickness": 10}],
        "doors": [{"id": "door", "wall_id": "partition", "start": point(500, 200), "end": point(500, 260)}],
        "exits": [region("exit-west", 50, 70, 80, 130), region("exit-east", 920, 370, 950, 430)],
        "warnings": [],
        "scale_references": [],
        "scale_objects": [],
    }


def gemini_fixture():
    drawing = copy.deepcopy(drawing_fixture())
    def normalize(value):
        if isinstance(value, dict):
            if set(value) == {"x", "y"}:
                value["y"] *= 2  # 1000x500 image -> axes independently normalized to 1000.
            else:
                for child in value.values():
                    normalize(child)
        elif isinstance(value, list):
            for child in value:
                normalize(child)
    normalize(drawing)
    drawing["walls"][0]["thickness"] *= 2
    return drawing


def image_bytes(size=(1000, 500), format="PNG"):
    output = io.BytesIO()
    Image.new("RGB", size, "white").save(output, format)
    return output.getvalue()


def upload_fixture():
    return ImageUpload(filename="plan.png", image_base64=base64.b64encode(image_bytes()).decode())


def info(provider="claude"):
    return ExtractionInfo(id="b" * 32, provider=provider, model="test-only", elapsed_seconds=1, warnings=[])


def source():
    return SourceImage(id="a" * 32, width_px=1000, height_px=500,
                       meters_per_pixel=.02, scale_confirmed=True)


class ImageTests(unittest.TestCase):
    def test_enclosed_counter_cavity_is_one_solid_editable_barrier(self):
        from shapely.geometry import Polygon
        drawing = drawing_fixture()
        drawing["furniture"] = [region("top", 150, 150, 350, 175),
            region("left", 150, 175, 175, 350), region("right", 325, 175, 350, 350),
            region("bottom", 175, 325, 325, 350)]
        layout = drawing_to_layout(ExtractedDrawing.model_validate(drawing), source(), "claude", info(), 12)
        self.assertEqual(len(layout.furniture), 1)
        self.assertTrue(Polygon(layout.furniture[0].polygon).covers(Point(5, 5)))
        compile_layout(layout)
        self.assertTrue(any("enclosed cavity" in note for note in layout.extraction.warnings))
        # Moving the joined object cannot leave a hidden filler at its old site.
        layout.furniture[0].polygon = [(x+1, y) for x,y in layout.furniture[0].polygon]
        self.assertTrue(build_geometry(compile_layout(layout)).contains(Point(3.5, 5)))

    def test_open_u_counter_preserves_its_accessible_work_area(self):
        drawing = drawing_fixture()
        drawing["furniture"] = [region("top", 150, 150, 350, 175),
            region("left", 150, 175, 175, 350), region("right", 325, 175, 350, 350)]
        layout = drawing_to_layout(ExtractedDrawing.model_validate(drawing), source(), "claude", info(), 12)
        self.assertEqual(len(layout.furniture), 3)
        self.assertTrue(build_geometry(compile_layout(layout)).contains(Point(5, 5)))
        self.assertFalse(any("enclosed cavity" in note for note in layout.extraction.warnings))

    def test_small_plan_uses_one_larger_frame_for_overlay_and_provider(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            upload = ImageUpload(filename="small.png", image_base64=base64.b64encode(image_bytes((500, 375))).decode())
            saved = save_image(upload, root)
            self.assertEqual((saved.width_px, saved.height_px), (1000, 750))
            loaded, raw = load_image(root, saved.id)
            self.assertEqual(saved, loaded)
            with Image.open(io.BytesIO(raw)) as image:
                self.assertEqual(image.size, (saved.width_px, saved.height_px))

    def test_upload_decodes_resizes_and_persists_a_known_image(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            upload = ImageUpload(filename="large.jpg", image_base64=base64.b64encode(image_bytes((2200, 1100), "JPEG")).decode())
            saved = save_image(upload, root)
            self.assertEqual((saved.width_px, saved.height_px), (1092, 546))
            self.assertFalse(saved.scale_confirmed)
            loaded, raw = load_image(root, saved.id)
            self.assertEqual(saved, loaded)
            with Image.open(io.BytesIO(raw)) as image:
                self.assertEqual(image.format, "PNG")
                self.assertEqual(image.size, (1092, 546))

    def test_invalid_images_and_large_dimensions_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for raw in ("not base64!", base64.b64encode(b"not an image").decode()):
                with self.assertRaises(ValueError):
                    save_image(ImageUpload(filename="bad.png", image_base64=raw), root)
            with self.assertRaisesRegex(ValueError, "accepts PNG"):
                save_image(ImageUpload(filename="plan.gif", image_base64=base64.b64encode(image_bytes(format="GIF")).decode()), root)
            with patch("app.services.floorplans.images.MAX_IMAGE_PIXELS", 100):
                with self.assertRaisesRegex(ValueError, "30 million"):
                    save_image(upload_fixture(), root)

    def test_image_paths_cannot_escape_storage(self):
        for identifier in ("../secret", "a" * 31, "z" * 32):
            with self.assertRaises(ValueError):
                image_path(Path("/tmp"), identifier)

    def test_provider_coordinate_systems_compile_to_identical_meter_geometry(self):
        claude = drawing_to_layout(ExtractedDrawing.model_validate(drawing_fixture()), source(), "claude", info(), 12)
        gemini = drawing_to_layout(ExtractedDrawing.model_validate(gemini_fixture()), source(), "gemini", info("gemini"), 12)
        self.assertEqual(compile_layout(claude), compile_layout(gemini))
        self.assertEqual(claude.walkable_areas[0].polygon[0], (1, 9))
        self.assertAlmostEqual(claude.doors[0].offset, 3.6)
        self.assertAlmostEqual(claude.doors[0].width, 1.2)
        geometry = build_geometry(compile_layout(claude))
        self.assertTrue(geometry.contains(Point(10, 5.4)))
        self.assertFalse(geometry.contains(Point(10, 8)))
        self.assertFalse(geometry.contains(Point(4, 6)))

    def test_unconfirmed_scale_and_image_frame_cannot_be_simulated(self):
        draft = draft_layout(source().model_copy(update={"scale_confirmed": False}))
        with self.assertRaisesRegex(ValueError, "Set the image scale"):
            compile_layout(draft)
        draft.source_image.scale_confirmed = True
        with self.assertRaisesRegex(ValueError, "Extract a layout"):
            compile_layout(draft)

    def test_missing_exits_are_editable_but_prevent_simulation(self):
        drawing = drawing_fixture()
        drawing["exits"] = []
        layout = drawing_to_layout(ExtractedDrawing.model_validate(drawing), source(), "claude", info(), 12)
        self.assertEqual(layout.exits, [])
        with self.assertRaisesRegex(ValueError, "exterior exit"):
            compile_layout(layout)

    def test_fragmented_parent_is_extended_only_through_observed_opening(self):
        drawing = drawing_fixture()
        expected = drawing_to_layout(ExtractedDrawing.model_validate(drawing), source(), "claude", info(), 12)
        drawing["walls"][0]["end"] = point(500, 200)
        drawing["walls"].append({"id": "lower-fragment", "start": point(500, 260),
                                 "end": point(500, 450), "thickness": 10})
        observed = drawing_to_layout(ExtractedDrawing.model_validate(drawing), source(), "claude", info(), 12)
        self.assertAlmostEqual(build_geometry(compile_layout(observed)).symmetric_difference(
            build_geometry(compile_layout(expected))).area, 0)
        self.assertIn("no solid wall was added", observed.extraction.warnings[0])

    def test_door_far_from_wall_is_not_projected_into_a_false_opening(self):
        drawing = drawing_fixture()
        drawing["doors"][0]["start"]["x"] += 50
        drawing["doors"][0]["end"]["x"] += 50
        with self.assertRaisesRegex(ValueError, "does not align"):
            drawing_to_layout(ExtractedDrawing.model_validate(drawing), source(), "claude", info(), 12)

    def test_unknown_door_parent_and_out_of_image_geometry_are_rejected(self):
        drawing = drawing_fixture()
        drawing["doors"][0]["wall_id"] = "missing"
        with self.assertRaisesRegex(ValueError, "no matching wall"):
            drawing_to_layout(ExtractedDrawing.model_validate(drawing), source(), "claude", info(), 12)
        drawing = drawing_fixture()
        drawing["floor_outline"][0]["x"] = 1001
        with self.assertRaisesRegex(ValueError, "outside the image"):
            drawing_to_layout(ExtractedDrawing.model_validate(drawing), source(), "claude", info(), 12)

    def test_comparison_keeps_independent_outputs_and_partial_provider_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            saved = save_image(upload_fixture(), root)
            request = ExtractionRequest(image_id=saved.id, provider="both", meters_per_pixel=.02,
                                        scale_confirmed=True, people_count=12)
            def fake_provider(provider, image, width, height):
                self.assertTrue(image.startswith(b"\x89PNG"))
                self.assertEqual((width, height), (1000, 500))
                if provider == "gemini":
                    return ExtractedDrawing.model_validate(gemini_fixture()), "fake-gemini"
                raise ProviderError("Claude test failure")
            with patch("app.services.floorplans.images.extract_drawing", side_effect=fake_provider):
                results = extract_image(request, root)["results"]
            self.assertEqual(results[0]["issues"], [])
            self.assertEqual(results[0]["layout"]["population"]["count"], 12)
            self.assertEqual(results[1]["error"], "Claude test failure")
            snapshots = list((root / "extractions").glob("*/observations.json"))
            self.assertEqual(len(snapshots), 1)
            self.assertEqual(json.loads(snapshots[0].read_text()), gemini_fixture())


class ProviderTests(unittest.TestCase):
    def test_accepts_claude_key_alias_without_exposing_it(self):
        with patch.dict(os.environ, {"CLAUDE_API_KEY": "fake-alias-key"}, clear=True):
            status = provider_status()
        self.assertTrue(status["claude"]["configured"])
        self.assertNotIn("fake-alias-key", json.dumps(status))

    def test_env_loading_reads_only_requested_file_and_preserves_exported_values(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {}, clear=True):
            file = Path(directory) / ".env"
            file.write_text('GEMINI_API_KEY="fake-local"\nANTHROPIC_API_KEY=fake-claude\n')
            os.environ["GEMINI_API_KEY"] = "fake-exported"
            load_environment(file)
            self.assertEqual(os.environ["GEMINI_API_KEY"], "fake-exported")
            status = provider_status()
            self.assertTrue(status["claude"]["configured"])
            self.assertNotIn("fake-", json.dumps(status))

    def test_shared_schema_avoids_unsupported_constraints(self):
        encoded = json.dumps(output_schema())
        for forbidden in ('"$ref"', '"$defs"', '"maxItems"', '"exclusiveMinimum"'):
            self.assertNotIn(forbidden, encoded)
        self.assertIn('"additionalProperties": false', encoded)

    def test_requests_use_headers_for_keys_and_the_documented_structured_formats(self):
        with patch.dict(os.environ, {"GEMINI_API_KEY": "fake-gemini", "ANTHROPIC_API_KEY": "fake-claude"}, clear=True):
            for provider, drawing in (("gemini", gemini_fixture()), ("claude", drawing_fixture())):
                response = {"candidates": [{"finishReason": "STOP", "content": {"parts": [{"text": json.dumps(drawing)}]}}]} if provider == "gemini" else {
                    "stop_reason": "end_turn", "content": [{"type": "text", "text": json.dumps(drawing)}]}
                with patch("app.services.floorplans.providers.request_json", return_value=response) as transport:
                    observed, model = extract_drawing(provider, b"image-bytes", 1000, 500)
                    url, headers, payload = transport.call_args.args
                self.assertEqual(observed, ExtractedDrawing.model_validate(drawing))
                self.assertNotIn("fake-", url)
                self.assertNotIn("fake-", json.dumps(payload))
                self.assertTrue(headers.get("x-goog-api-key") or headers.get("x-api-key"))
                if provider == "gemini":
                    self.assertEqual(payload["generationConfig"]["responseFormat"]["text"]["mimeType"], "APPLICATION_JSON")
                else:
                    self.assertEqual(payload["output_config"]["format"]["type"], "json_schema")

    def test_missing_key_incomplete_and_malformed_outputs_fail_cleanly(self):
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(ProviderError, "GEMINI_API_KEY"):
                extract_drawing("gemini", b"image", 1000, 500)
        with patch.dict(os.environ, {"ANTHROPIC_API_KEY": "fake"}, clear=True):
            for response in ({"stop_reason": "max_tokens"}, {"stop_reason": "end_turn", "content": [{"type": "text", "text": "wrong"}]}):
                with patch("app.services.floorplans.providers.request_json", return_value=response):
                    with self.assertRaises(ProviderError):
                        extract_drawing("claude", b"image", 1000, 500)

    def transport(self, responses):
        calls = []
        def handle(request):
            calls.append(request)
            item = responses[min(len(calls) - 1, len(responses) - 1)]
            if isinstance(item, Exception):
                raise item
            return item
        client = httpx.AsyncClient(transport=httpx.MockTransport(handle))
        return patch("app.services.floorplans.providers._provider_client", return_value=client), calls

    def test_http_errors_never_forward_upstream_bodies_or_keys(self):
        transport, _ = self.transport([httpx.Response(401, text="secret-token")])
        with transport, self.assertRaises(ProviderError) as caught:
            request_json("https://api.example", {"x-api-key": "secret-token"}, {})
        self.assertNotIn("secret-token", str(caught.exception))

    def test_transient_503_retries_then_returns_success(self):
        responses = [httpx.Response(503, text="private"), httpx.Response(503), httpx.Response(200, json={"ok": True})]
        transport, calls = self.transport(responses)
        with transport, patch("app.services.floorplans.providers.asyncio.sleep", new_callable=AsyncMock) as sleep, \
                patch("app.services.floorplans.providers.random.uniform", return_value=0):
            self.assertEqual(request_json("https://api.example", {}, {}), {"ok": True})
        self.assertEqual(len(calls), 3)
        self.assertEqual([call.args[0] for call in sleep.call_args_list], [1, 2])
        self.assertTrue(all(response.is_closed for response in responses))

    def test_persistent_503_stops_and_sanitizes_the_error(self):
        transport, calls = self.transport([httpx.Response(503, text="secret-token") for _ in range(3)])
        with transport, patch("app.services.floorplans.providers.asyncio.sleep", new_callable=AsyncMock) as sleep:
            with self.assertRaisesRegex(ProviderError, "HTTP 503.*3 attempts") as caught:
                request_json("https://api.example", {"x-api-key": "secret-token"}, {})
        self.assertEqual(len(calls), 3)
        self.assertEqual(sleep.call_count, 2)
        self.assertNotIn("secret-token", str(caught.exception))

    def test_client_errors_are_not_retried(self):
        for code in (400, 401, 402, 403, 404):
            with self.subTest(code=code):
                transport, calls = self.transport([httpx.Response(code)])
                with transport, patch("app.services.floorplans.providers.asyncio.sleep", new_callable=AsyncMock) as sleep:
                    with self.assertRaises(ProviderError):
                        request_json("https://api.example", {}, {})
                self.assertEqual(len(calls), 1)
                sleep.assert_not_called()

    def test_retry_after_is_respected(self):
        transport, calls = self.transport([httpx.Response(429, headers={"Retry-After": "5"}), httpx.Response(200, json={})])
        with transport, patch("app.services.floorplans.providers.asyncio.sleep", new_callable=AsyncMock) as sleep:
            self.assertEqual(request_json("https://api.example", {}, {}), {})
        sleep.assert_awaited_once_with(5)
        self.assertEqual(len(calls), 2)

    def test_retry_after_beyond_budget_stops_without_waiting(self):
        transport, calls = self.transport([httpx.Response(503, headers={"Retry-After": "600"})])
        with transport, patch("app.services.floorplans.providers.asyncio.sleep", new_callable=AsyncMock) as sleep:
            with self.assertRaisesRegex(ProviderError, "HTTP 503.*1 attempt"):
                request_json("https://api.example", {}, {})
        self.assertEqual(len(calls), 1)
        sleep.assert_not_called()

    def test_network_timeouts_do_not_duplicate_possibly_processed_requests(self):
        transport, calls = self.transport([httpx.ReadTimeout("private")])
        with transport, self.assertRaisesRegex(ProviderError, "time limit"):
            request_json("https://api.example", {}, {})
        self.assertEqual(len(calls), 1)

    def test_slow_continuous_response_hits_wall_clock_deadline_and_closes(self):
        class SlowBody(httpx.AsyncByteStream):
            closed = False
            async def __aiter__(self):
                while True:
                    await asyncio.sleep(.01)
                    yield b" "
            async def aclose(self):
                self.closed = True
        body = SlowBody()
        transport, calls = self.transport([httpx.Response(200, stream=body)])
        started = time.monotonic()
        with transport, patch("app.services.floorplans.providers.PROVIDER_TIME_BUDGET", .08):
            with self.assertRaisesRegex(ProviderError, "time limit"):
                request_json("https://api.example", {}, {})
        self.assertLess(time.monotonic() - started, 1)
        self.assertTrue(body.closed)
        self.assertEqual(len(calls), 1)

    def test_retry_wait_and_response_share_one_deadline(self):
        transport, calls = self.transport([httpx.Response(503), httpx.Response(200, json={})])
        # A real retry wait consumes the total budget; the next response never starts.
        sleep = asyncio.sleep
        async def stalled_sleep(_):
            await sleep(1.2)
        with transport, patch("app.services.floorplans.providers.PROVIDER_TIME_BUDGET", 1.05), \
                patch("app.services.floorplans.providers.random.uniform", return_value=0), \
                patch("app.services.floorplans.providers.asyncio.sleep", new=stalled_sleep):
            with self.assertRaisesRegex(ProviderError, "time limit"):
                request_json("https://api.example", {}, {})
        self.assertEqual(len(calls), 1)


if __name__ == "__main__":
    unittest.main()
