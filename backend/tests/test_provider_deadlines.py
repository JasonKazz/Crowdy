import asyncio
import json
import os
import threading
import time
import unittest
from unittest.mock import AsyncMock, patch

import httpx

from app.schemas.extraction import ExtractedDrawing
from app.services.floorplans.providers import (
    ProviderError, extract_drawing, extraction_deadline, request_json,
)
from test_images import drawing_fixture


class ContinuousBody(httpx.AsyncByteStream):
    def __init__(self):
        self.closed = False
        self.active = False

    async def __aiter__(self):
        self.active = True
        try:
            while True:
                await asyncio.sleep(.005)
                yield b" "
        finally:
            self.active = False

    async def aclose(self):
        self.closed = True


class ProviderDeadlineTests(unittest.TestCase):
    def client(self, response):
        return httpx.AsyncClient(transport=httpx.MockTransport(lambda _: response))

    def test_expired_deadline_never_opens_a_client(self):
        with patch("app.services.floorplans.providers._provider_client") as client:
            with self.assertRaisesRegex(ProviderError, "time limit"):
                request_json("https://provider.example", {}, {}, deadline=time.monotonic() - 1)
        client.assert_not_called()

    def test_absolute_deadline_cancels_a_slow_body_and_closes_before_returning(self):
        body = ContinuousBody()
        client = self.client(httpx.Response(200, stream=body))
        started = time.monotonic()
        with patch("app.services.floorplans.providers._provider_client", return_value=client):
            with self.assertRaisesRegex(ProviderError, "time limit"):
                request_json("https://provider.example", {}, {}, deadline=started + .08)
        self.assertLess(time.monotonic() - started, .5)
        self.assertTrue(body.closed)
        self.assertFalse(body.active)
        self.assertTrue(client.is_closed)

    def test_context_deadline_is_shared_by_successive_calls_without_resetting(self):
        async def first(_):
            await asyncio.sleep(.04)
            return httpx.Response(200, json={"ok": True})

        first_client = httpx.AsyncClient(transport=httpx.MockTransport(first))
        body = ContinuousBody()
        second_client = self.client(httpx.Response(200, stream=body))
        started = time.monotonic()
        with patch("app.services.floorplans.providers._provider_client", side_effect=[first_client, second_client]):
            with extraction_deadline(started + .10):
                self.assertEqual(request_json("https://provider.example", {}, {}), {"ok": True})
                with self.assertRaisesRegex(ProviderError, "time limit"):
                    request_json("https://provider.example", {}, {})
        self.assertLess(time.monotonic() - started, .5)
        self.assertTrue(body.closed)
        self.assertFalse(body.active)
        self.assertTrue(first_client.is_closed and second_client.is_closed)

    def test_retry_after_must_fit_the_callers_remaining_time(self):
        response = httpx.Response(503, headers={"Retry-After": "1"})
        client = self.client(response)
        with patch("app.services.floorplans.providers._provider_client", return_value=client), \
                patch("app.services.floorplans.providers.asyncio.sleep", new_callable=AsyncMock) as sleep:
            with self.assertRaisesRegex(ProviderError, "HTTP 503.*1 attempt"):
                request_json("https://provider.example", {}, {}, deadline=time.monotonic() + .05)
        sleep.assert_not_called()
        self.assertTrue(response.is_closed)

    def test_external_cancellation_stops_active_body_before_worker_returns(self):
        cancelled = threading.Event()
        body = ContinuousBody()
        client = self.client(httpx.Response(200, stream=body))
        timer = threading.Timer(.05, cancelled.set)
        self.addCleanup(timer.cancel)
        timer.start()
        started = time.monotonic()
        with patch("app.services.floorplans.providers._provider_client", return_value=client):
            with extraction_deadline(started + 2, cancelled=cancelled):
                with self.assertRaisesRegex(ProviderError, "cancelled"):
                    request_json("https://provider.example", {}, {})
        self.assertLess(time.monotonic() - started, .5)
        self.assertTrue(body.closed)
        self.assertFalse(body.active)
        self.assertTrue(client.is_closed)

    def test_context_restores_outer_budget_and_does_not_leak_after_exit(self):
        with extraction_deadline(time.monotonic() + 5):
            with self.assertRaisesRegex(ProviderError, "time limit"):
                with extraction_deadline(time.monotonic() - 1):
                    self.fail("Expired context must not run")
            client = self.client(httpx.Response(200, json={"ok": True}))
            with patch("app.services.floorplans.providers._provider_client", return_value=client):
                self.assertEqual(request_json("https://provider.example", {}, {}), {"ok": True})
        cancelled = threading.Event()
        cancelled.set()
        with self.assertRaisesRegex(ProviderError, "cancelled"):
            with extraction_deadline(time.monotonic() + 5, cancelled=cancelled):
                self.fail("Cancelled context must not run")
        client = self.client(httpx.Response(200, json={"ok": True}))
        with patch("app.services.floorplans.providers._provider_client", return_value=client):
            self.assertEqual(request_json("https://provider.example", {}, {}), {"ok": True})

    def test_drawing_call_forwards_explicit_deadline_and_retains_validation(self):
        response = {"stop_reason": "end_turn", "content": [{"type": "text", "text": json.dumps(drawing_fixture())}]}
        deadline = time.monotonic() + 10
        with patch.dict(os.environ, {"ANTHROPIC_API_KEY": "test-only"}, clear=True), \
                patch("app.services.floorplans.providers.request_json", return_value=response) as request:
            drawing, _ = extract_drawing("claude", b"image", 1000, 500, deadline=deadline)
        self.assertEqual(request.call_args.kwargs, {"deadline": deadline})
        self.assertEqual(drawing, ExtractedDrawing.model_validate(drawing_fixture()))


if __name__ == "__main__":
    unittest.main()
