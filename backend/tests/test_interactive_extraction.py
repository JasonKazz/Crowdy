"""Interactive floor-plan orchestration with synthetic images and observations."""

import base64
import asyncio
import copy
import json
import os
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

import httpx
from app.schemas.extraction import ExtractedDrawing, ExtractionRequest, ImageUpload, ScaleReference
from app.services.floorplans.images import extract_image, finish_calibration, save_image
from app.services.floorplans.interactive import INTERACTIVE_REVIEW_WARNING, extraction_scope
from app.services.floorplans.providers import ProviderError
from app.services.floorplans.structure_pass import StructuralDrawing
from test_images import drawing_fixture, gemini_fixture, image_bytes


def structure_fixture():
    drawing = drawing_fixture()
    return StructuralDrawing.model_validate({
        "wall_paths": [{"id": "partition", "points": [drawing["walls"][0]["start"], drawing["walls"][0]["end"]], "thickness": 10}],
        "openings": [{"id": "door", "path_id": "partition", "segment_index": 0,
                      "start": drawing["doors"][0]["start"], "end": drawing["doors"][0]["end"]}],
        "exits": drawing["exits"], "coverage": "complete", "warnings": [],
    })


class InteractiveExtractionTests(unittest.TestCase):
    def setUp(self):
        self.environment = patch.dict(os.environ, {
            "CROWDY_FLOORPLAN_EXTRACTION_MODE": "", "BLOB_READ_WRITE_TOKEN": "",
            "AZURE_STORAGE_ACCOUNT_URL": "", "AZURE_STORAGE_CONTAINER": "",
        })
        self.environment.start()
        self.addCleanup(self.environment.stop)
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)

    def source(self, size=(2396, 1346)):
        return save_image(ImageUpload(filename="synthetic-plan.png", image_base64=base64.b64encode(image_bytes(size)).decode()), self.root)

    def test_large_and_compact_uploads_use_the_interactive_path_at_canonical_resolution(self):
        for size in ((1000, 500), (2396, 1346), (3072, 1536)):
            with self.subTest(size=size):
                source = self.source(size)
                drawing = ExtractedDrawing.model_validate(drawing_fixture())
                progress = []
                with patch("app.services.floorplans.images.extract_drawing", return_value=(drawing, "fixture-model")) as provider, \
                        patch("app.services.floorplans.staged.extract_staged") as diagnostic:
                    result = extract_image(ExtractionRequest(image_id=source.id, provider="claude", meters_per_pixel=.02, scale_confirmed=True), self.root, progress.append)["results"][0]
                self.assertNotIn("error", result)
                diagnostic.assert_not_called()
                self.assertEqual(provider.call_args.args[2:], size)
                self.assertEqual(result["counts"], {"rooms": 2, "walls": 1, "doors": 1, "furniture": 1, "exits": 2})
                self.assertIn(INTERACTIVE_REVIEW_WARNING, result["warnings"])
                self.assertIn("Reading the whole floor plan", progress)
                self.assertFalse(any("detail" in message for message in progress))
                context = json.loads((self.root / "extractions" / result["extraction_id"] / "context.json").read_text())
                self.assertEqual(context["extraction_mode"], "interactive")
                self.assertEqual(drawing.model_dump(), ExtractedDrawing.model_validate(drawing_fixture()).model_dump(), "Review messaging must not alter model geometry")

    def test_both_provider_coordinate_contracts_still_produce_identical_geometry(self):
        source = self.source((1000, 500))

        def provider(name, _image, _width, _height):
            return ExtractedDrawing.model_validate(gemini_fixture() if name == "gemini" else drawing_fixture()), "fixture-model"

        with patch("app.services.floorplans.images.extract_drawing", side_effect=provider):
            gemini, claude = extract_image(ExtractionRequest(image_id=source.id, provider="both", meters_per_pixel=.02), self.root)["results"]
        for key in ("walkable_areas", "rooms", "walls", "doors", "furniture", "exits"):
            self.assertEqual(gemini["layout"][key], claude["layout"][key])

    def test_missing_scale_reuses_saved_observations_without_another_provider_call(self):
        source = self.source((1000, 500))
        with patch("app.services.floorplans.images.extract_drawing", return_value=(ExtractedDrawing.model_validate(drawing_fixture()), "fixture-model")) as provider:
            pending = extract_image(ExtractionRequest(image_id=source.id, provider="claude"), self.root)["results"][0]
            self.assertTrue(pending["needs_scale"])
            self.assertIn(INTERACTIVE_REVIEW_WARNING, pending["warnings"])
            result = finish_calibration(pending["extraction_id"], ScaleReference(kind="dimension", label="18 m", start={"x": 50, "y": 50}, end={"x": 950, "y": 50}, distance=18, unit="m"), self.root)
        provider.assert_called_once()
        self.assertEqual(result["counts"]["doors"], 1)
        self.assertIn(INTERACTIVE_REVIEW_WARNING, result["warnings"])

    def test_outline_only_response_is_saved_for_diagnostics_and_fails_without_fabrication(self):
        source = self.source()
        observed = {**drawing_fixture(), "walls": [], "doors": [], "furniture": [], "exits": [], "warnings": ["Door jambs could not be read."]}
        empty_review = StructuralDrawing(wall_paths=[], openings=[], exits=[], coverage="partial", warnings=["No jambs visible."])
        with patch("app.services.floorplans.images.extract_drawing", return_value=(ExtractedDrawing.model_validate(observed), "fixture-model")), \
                patch("app.services.floorplans.interactive.extract_structured", return_value=(empty_review, "fixture-model")) as review:
            result = extract_image(ExtractionRequest(image_id=source.id, provider="claude"), self.root)["results"][0]
        review.assert_called_once()
        self.assertIn("No complete layout was imported", result["error"])
        directory = self.root / "extractions" / result["extraction_id"]
        raw = json.loads((directory / "observations.json").read_text())
        self.assertEqual(raw["walls"], [])
        self.assertEqual(raw["exits"], [])
        self.assertIn(observed["warnings"][0], raw["warnings"])
        self.assertFalse((directory / "candidate.json").exists())

    def test_empty_furniture_is_valid_when_observed_structure_or_exits_exist(self):
        source = self.source((1000, 500))
        observed = {**drawing_fixture(), "furniture": []}
        with patch("app.services.floorplans.images.extract_drawing", return_value=(ExtractedDrawing.model_validate(observed), "fixture-model")):
            result = extract_image(ExtractionRequest(image_id=source.id, provider="claude", meters_per_pixel=.02), self.root)["results"][0]
        self.assertNotIn("error", result)
        self.assertEqual(result["counts"]["furniture"], 0)
        self.assertEqual(result["counts"]["exits"], 2)
        self.assertFalse(any("missing furniture" in warning.lower() for warning in result["warnings"]))

    def test_one_missing_exit_followup_preserves_all_original_walls_doors_and_furniture(self):
        source = self.source((1000, 500))
        drawing = ExtractedDrawing.model_validate({**drawing_fixture(), "exits": []})
        with patch("app.services.floorplans.images.extract_drawing", return_value=(drawing, "fixture-model")) as whole, \
                patch("app.services.floorplans.interactive.extract_structured", return_value=(structure_fixture(), "fixture-model")) as review:
            result = extract_image(ExtractionRequest(image_id=source.id, provider="claude", meters_per_pixel=.02), self.root)["results"][0]
        whole.assert_called_once()
        review.assert_called_once()
        self.assertNotIn("error", result)
        raw = json.loads((self.root / "extractions" / result["extraction_id"] / "observations.json").read_text())
        for key in ("walls", "doors", "furniture"):
            self.assertEqual(raw[key], drawing.model_dump(mode="json")[key])
        self.assertEqual(len(raw["exits"]), 2)
        prompt = review.call_args.args[2]
        self.assertIn("FLOOR OUTLINE", prompt)
        self.assertIn("Gray floor/access-zone shading", prompt)
        self.assertIn("1000 by 500", prompt)
        self.assertIs(review.call_args.args[3], StructuralDrawing)
        record = json.loads((self.root / "extractions" / result["extraction_id"] / "structure-review.json").read_text())
        self.assertFalse(record["adopted_walls"])
        self.assertTrue(record["adopted_exits"])

    def test_zero_wall_followup_adds_observed_paths_and_parented_openings_without_replacing_exits(self):
        source = self.source((1000, 500))
        drawing = ExtractedDrawing.model_validate({**drawing_fixture(), "walls": [], "doors": []})
        with patch("app.services.floorplans.images.extract_drawing", return_value=(drawing, "fixture-model")), \
                patch("app.services.floorplans.interactive.extract_structured", return_value=(structure_fixture(), "fixture-model")) as review:
            result = extract_image(ExtractionRequest(image_id=source.id, provider="claude", meters_per_pixel=.02), self.root)["results"][0]
        review.assert_called_once()
        self.assertNotIn("error", result)
        raw = json.loads((self.root / "extractions" / result["extraction_id"] / "observations.json").read_text())
        self.assertEqual(raw["exits"], drawing.model_dump(mode="json")["exits"])
        self.assertEqual(len(raw["walls"]), 1)
        self.assertEqual(len(raw["doors"]), 1)
        self.assertEqual(raw["doors"][0]["wall_id"], raw["walls"][0]["id"])
        self.assertTrue(raw["walls"][0]["id"].startswith("structure_review:"))

    def test_quality_followup_failure_keeps_initial_observations_and_never_retries_geometry(self):
        source = self.source((1000, 500))
        drawing = ExtractedDrawing.model_validate({**drawing_fixture(), "exits": []})
        with patch("app.services.floorplans.images.extract_drawing", return_value=(drawing, "fixture-model")) as whole, \
                patch("app.services.floorplans.interactive.extract_structured", side_effect=ProviderError("Review unavailable")) as review:
            result = extract_image(ExtractionRequest(image_id=source.id, provider="claude", meters_per_pixel=.02), self.root)["results"][0]
        whole.assert_called_once()
        review.assert_called_once()
        self.assertIn("Review unavailable", result["error"])
        directory = self.root / "extractions" / result["extraction_id"]
        self.assertEqual(json.loads((directory / "whole-plan.json").read_text()), drawing.model_dump(mode="json"))
        self.assertFalse((directory / "candidate.json").exists())

    def test_followup_http_uses_remaining_import_budget_and_closes_before_returning(self):
        source = self.source((1000, 500))
        drawing = ExtractedDrawing.model_validate({**drawing_fixture(), "exits": []})

        class SlowBody(httpx.AsyncByteStream):
            closed = False
            active = False

            async def __aiter__(self):
                self.active = True
                try:
                    while True:
                        await asyncio.sleep(.01)
                        yield b" "
                finally:
                    self.active = False

            async def aclose(self):
                self.closed = True

        body = SlowBody()
        calls = []

        def transport(request):
            calls.append(request)
            return httpx.Response(200, stream=body)

        client = httpx.AsyncClient(transport=httpx.MockTransport(transport))
        started = time.monotonic()
        with patch.dict(os.environ, {"AI_GATEWAY_API_KEY": "synthetic-test-key"}), \
                patch("app.services.floorplans.images.extract_drawing", return_value=(drawing, "fixture-model")), \
                patch("app.services.floorplans.providers._provider_client", return_value=client):
            result = extract_image(ExtractionRequest(image_id=source.id, provider="claude", meters_per_pixel=.02), self.root, deadline=started + .07)["results"][0]
        self.assertIn("time limit", result["error"])
        self.assertLess(time.monotonic() - started, .5)
        self.assertEqual(len(calls), 1)
        self.assertTrue(body.closed)
        self.assertFalse(body.active)
        self.assertTrue(client.is_closed)

    def test_misaligned_exit_is_not_silently_removed_to_produce_a_success(self):
        source = self.source((1000, 500))
        observed = copy.deepcopy(drawing_fixture())
        observed["exits"][0]["polygon"] = [{"x": 400, "y": 200}, {"x": 430, "y": 200}, {"x": 430, "y": 230}, {"x": 400, "y": 230}]
        with patch("app.services.floorplans.images.extract_drawing", return_value=(ExtractedDrawing.model_validate(observed), "fixture-model")):
            result = extract_image(ExtractionRequest(image_id=source.id, provider="claude", meters_per_pixel=.02), self.root)["results"][0]
        self.assertIn("error", result)
        raw = json.loads((self.root / "extractions" / result["extraction_id"] / "observations.json").read_text())
        self.assertEqual(len(raw["exits"]), 2)
        self.assertEqual(raw["exits"][0]["id"], observed["exits"][0]["id"])

    def test_expired_or_cancelled_import_never_starts_a_provider_request(self):
        source = self.source()
        cancelled = threading.Event()
        cancelled.set()
        for options in ({"deadline": time.monotonic() - 1}, {"cancelled": cancelled}):
            with self.subTest(options=options), patch("app.services.floorplans.images.extract_drawing") as provider:
                with self.assertRaises(ProviderError):
                    extract_image(ExtractionRequest(image_id=source.id, provider="claude"), self.root, **options)
                provider.assert_not_called()

    def test_comparison_does_not_restart_an_exhausted_budget_for_its_second_provider(self):
        source = self.source((1000, 500))

        def slow_provider(*_args):
            time.sleep(.05)
            return ExtractedDrawing.model_validate(drawing_fixture()), "fixture-model"

        with patch("app.services.floorplans.images.extract_drawing", side_effect=slow_provider) as provider:
            results = extract_image(ExtractionRequest(image_id=source.id, provider="both"), self.root, deadline=time.monotonic() + .025)["results"]
        provider.assert_called_once()
        self.assertEqual(len(results), 2)
        self.assertTrue(all("time limit" in result["error"] for result in results))

    def test_interactive_scope_cannot_extend_its_callers_deadline(self):
        expected = time.monotonic() + 2
        with extraction_scope("interactive", deadline=expected) as observed:
            self.assertEqual(observed, expected)

    def test_diagnostic_mode_is_an_explicit_server_setting(self):
        source = self.source()

        def diagnostic(_provider, _image, _width, _height, directory, _progress):
            (directory / "report.json").write_text("{}")
            return ExtractedDrawing.model_validate(drawing_fixture()), "diagnostic-model"

        with patch.dict(os.environ, {"CROWDY_FLOORPLAN_EXTRACTION_MODE": "diagnostic_staged"}), \
                patch("app.services.floorplans.staged.extract_staged", side_effect=diagnostic) as staged, \
                patch("app.services.floorplans.images.extract_drawing") as interactive:
            result = extract_image(ExtractionRequest(image_id=source.id, provider="claude", meters_per_pixel=.02), self.root)["results"][0]
        staged.assert_called_once()
        interactive.assert_not_called()
        self.assertNotIn("error", result)
        self.assertNotIn(INTERACTIVE_REVIEW_WARNING, result["warnings"])


if __name__ == "__main__":
    unittest.main()
