"""Isolated AI Gateway fixtures. No credentials, models, or paid requests needed."""

import base64
import json
import os
import unittest
from unittest.mock import AsyncMock, patch

import httpx
from pydantic import BaseModel, Field

from app.schemas.extraction import ExtractedDrawing
from app.services.floorplans.providers import (
    AI_GATEWAY_URL, GATEWAY_MODELS, ProviderError, extract_drawing,
    extract_structured, provider_status,
)
from test_images import drawing_fixture, gemini_fixture


def completion(drawing=None, **message_fields):
    return {"choices": [{"finish_reason": "stop", "message": {
        "role": "assistant", "content": json.dumps(drawing if drawing is not None else drawing_fixture()),
        **message_fields,
    }}]}


class StageResult(BaseModel):
    name: str
    count: int = Field(ge=1)


class GatewayProviderTests(unittest.TestCase):
    def setUp(self):
        self.environment = patch.dict(os.environ, {"AI_GATEWAY_API_KEY": "fake-gateway-secret"}, clear=True)
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def transport(self, responses):
        calls = []

        def handle(request):
            calls.append(request)
            response = responses[min(len(calls) - 1, len(responses) - 1)]
            if isinstance(response, Exception):
                raise response
            return response

        client = httpx.AsyncClient(transport=httpx.MockTransport(handle), follow_redirects=False)
        return patch("app.services.floorplans.providers._provider_client", return_value=client), calls

    def test_gateway_key_configures_both_providers_without_exposing_credentials(self):
        status = provider_status()
        self.assertEqual(status, {
            "gemini": {"configured": True, "model": "google/gemini-3.8-flash"},
            "claude": {"configured": True, "model": "anthropic/claude-sonnet-5.5"},
        })
        self.assertNotIn("fake-gateway-secret", json.dumps(status))

    def test_gateway_uses_vision_and_shared_schema_with_native_key_isolation(self):
        with patch.dict(os.environ, {
            "GEMINI_API_KEY": "fake-native-google", "ANTHROPIC_API_KEY": "fake-native-anthropic",
            "CLAUDE_API_KEY": "fake-native-alias", "GEMINI_MODEL": "native-google-model",
            "ANTHROPIC_MODEL": "native-anthropic-model", "AI_GATEWAY_BASE_URL": "https://untrusted.invalid",
            "OPENAI_BASE_URL": "https://untrusted.invalid", "AI_GATEWAY_URL": "https://untrusted.invalid",
        }):
            for provider, drawing in (("gemini", gemini_fixture()), ("claude", drawing_fixture())):
                with self.subTest(provider=provider):
                    transport, calls = self.transport([httpx.Response(200, json=completion(drawing))])
                    with transport:
                        observed, model = extract_drawing(provider, b"synthetic-image", 1000, 500)
                    self.assertEqual(observed, ExtractedDrawing.model_validate(drawing))
                    self.assertEqual(model, GATEWAY_MODELS[provider])
                    self.assertEqual(len(calls), 1)
                    request = calls[0]
                    self.assertEqual(str(request.url), AI_GATEWAY_URL)
                    self.assertEqual(request.headers["Authorization"], "Bearer fake-gateway-secret")
                    self.assertNotIn("x-goog-api-key", request.headers)
                    self.assertNotIn("x-api-key", request.headers)
                    self.assertNotIn("anthropic-version", request.headers)
                    self.assertNotIn("fake-native", str(request.headers))
                    payload = json.loads(request.content)
                    self.assertEqual(payload["model"], GATEWAY_MODELS[provider])
                    self.assertEqual(payload["stream"], False)
                    self.assertEqual(payload["max_tokens"], 16384)
                    self.assertEqual(payload["reasoning_effort"], "low")
                    content = payload["messages"][0]["content"]
                    self.assertEqual(content[0]["type"], "image_url")
                    self.assertEqual(content[0]["image_url"]["url"], "data:image/png;base64," + base64.b64encode(b"synthetic-image").decode())
                    self.assertIn("normalized x and y" if provider == "gemini" else "absolute pixel", content[1]["text"])
                    self.assertNotIn("fake-", request.content.decode())
                    output = payload["response_format"]
                    self.assertEqual(output["type"], "json_schema")
                    self.assertEqual(output["json_schema"]["strict"], True)
                    self.assertEqual(output["json_schema"]["schema"]["additionalProperties"], False)
                    self.assertNotIn('"$ref"', json.dumps(output))

    def test_gateway_model_overrides_are_independent_from_native_models(self):
        with patch.dict(os.environ, {
            "AI_GATEWAY_GEMINI_MODEL": "google/other-vision-model",
            "AI_GATEWAY_ANTHROPIC_MODEL": "anthropic/other-vision-model",
            "GEMINI_MODEL": "native-google-model", "ANTHROPIC_MODEL": "native-anthropic-model",
        }):
            for provider, model in (("gemini", "google/other-vision-model"), ("claude", "anthropic/other-vision-model")):
                self.assertEqual(provider_status()[provider]["model"], model)
                transport, calls = self.transport([httpx.Response(200, json=completion())])
                with transport:
                    self.assertEqual(extract_drawing(provider, b"image", 1000, 500)[1], model)
                self.assertEqual(json.loads(calls[0].content)["model"], model)
                self.assertNotIn("reasoning_effort", json.loads(calls[0].content),
                                 "Unknown custom models must retain their supported native defaults")

    def test_gateway_rejects_unqualified_or_wrong_provider_models_before_sending(self):
        for provider, variable, model in (
            ("gemini", "AI_GATEWAY_GEMINI_MODEL", "gemini-3.8-flash"),
            ("gemini", "AI_GATEWAY_GEMINI_MODEL", "anthropic/claude-sonnet-5.5"),
            ("claude", "AI_GATEWAY_ANTHROPIC_MODEL", "google/gemini-3.8-flash"),
            ("claude", "AI_GATEWAY_ANTHROPIC_MODEL", "https://untrusted.invalid/model"),
            ("gemini", "AI_GATEWAY_GEMINI_MODEL", "google/bad model"),
            ("gemini", "AI_GATEWAY_GEMINI_MODEL", "google/model\nAuthorization: private"),
        ):
            with self.subTest(model=model), patch.dict(os.environ, {variable: model}), \
                    patch("app.services.floorplans.providers.request_json") as transport:
                with self.assertRaisesRegex(ProviderError, variable):
                    extract_drawing(provider, b"image", 1000, 500)
                transport.assert_not_called()

    def test_blank_gateway_key_preserves_native_keys_models_and_formats(self):
        with patch.dict(os.environ, {
            "AI_GATEWAY_API_KEY": "  ", "GEMINI_API_KEY": "native-google-key", "CLAUDE_API_KEY": "native-alias-key",
            "GEMINI_MODEL": "native-google-model", "ANTHROPIC_MODEL": "native-anthropic-model",
            "AI_GATEWAY_GEMINI_MODEL": "google/ignored", "AI_GATEWAY_ANTHROPIC_MODEL": "anthropic/ignored",
        }):
            for provider in ("gemini", "claude"):
                response = {"candidates": [{"finishReason": "STOP", "content": {"parts": [{"text": json.dumps(gemini_fixture())}]}}]} if provider == "gemini" else {
                    "stop_reason": "end_turn", "content": [{"type": "text", "text": json.dumps(drawing_fixture())}]}
                transport, calls = self.transport([httpx.Response(200, json=response)])
                with transport:
                    observed, model = extract_drawing(provider, b"image", 1000, 500)
                self.assertIsInstance(observed, ExtractedDrawing)
                self.assertEqual(model, "native-google-model" if provider == "gemini" else "native-anthropic-model")
                self.assertEqual(provider_status()[provider]["model"], model)
                request = calls[0]
                self.assertNotIn("authorization", request.headers)
                self.assertEqual(request.url.host, "generativelanguage.googleapis.com" if provider == "gemini" else "api.anthropic.com")
                self.assertEqual(request.headers["x-goog-api-key" if provider == "gemini" else "x-api-key"], "native-google-key" if provider == "gemini" else "native-alias-key")

    def test_no_credentials_reports_both_supported_configuration_routes(self):
        with patch.dict(os.environ, {}, clear=True), patch("app.services.floorplans.providers.request_json") as transport:
            self.assertFalse(provider_status()["gemini"]["configured"])
            self.assertFalse(provider_status()["claude"]["configured"])
            for provider, native_name in (("gemini", "GEMINI_API_KEY"), ("claude", "ANTHROPIC_API_KEY")):
                with self.assertRaises(ProviderError) as caught:
                    extract_drawing(provider, b"image", 1000, 500)
                self.assertIn("AI_GATEWAY_API_KEY", str(caught.exception))
                self.assertIn(native_name, str(caught.exception))
            transport.assert_not_called()

    def test_gateway_refusal_is_sanitized_and_does_not_fall_back_to_native(self):
        transport, calls = self.transport([httpx.Response(200, json=completion(refusal="private refusal body"))])
        with transport, patch.dict(os.environ, {"ANTHROPIC_API_KEY": "fake-native"}):
            with self.assertRaisesRegex(ProviderError, "declined") as caught:
                extract_drawing("claude", b"image", 1000, 500)
        self.assertNotIn("private", str(caught.exception))
        self.assertEqual(len(calls), 1)
        self.assertEqual(str(calls[0].url), AI_GATEWAY_URL)

    def test_gateway_rejects_missing_incomplete_tool_and_malformed_responses(self):
        bad_responses = [{}, {"error": {"message": "private error body"}}, {"choices": None}, {"choices": []},
            {"choices": [None]}, {"choices": [{"finish_reason": "stop", "message": None}]},
            completion(content=None), completion(content=[]), completion(content=""),
            completion(content="private invalid JSON"), completion(role="tool")]
        for reason in (None, "length", "tool_calls", "content_filter"):
            response = completion()
            response["choices"][0]["finish_reason"] = reason
            bad_responses.append(response)
        for response in bad_responses:
            with self.subTest(response=response):
                transport, calls = self.transport([httpx.Response(200, json=response)])
                with transport, self.assertRaises(ProviderError) as caught:
                    extract_drawing("gemini", b"image", 1000, 500)
                self.assertNotIn("private", str(caught.exception))
                self.assertEqual(len(calls), 1)

    def test_gateway_stages_use_their_own_schema_and_local_validation(self):
        transport, calls = self.transport([httpx.Response(200, json=completion({"name": "Stage result", "count": 2}))])
        with transport:
            stage, _ = extract_structured("claude", b"image", "Inspect this stage.", StageResult)
        self.assertEqual(stage.count, 2)
        schema = json.loads(calls[0].content)["response_format"]["json_schema"]["schema"]
        self.assertEqual(set(schema["properties"]), {"name", "count"})
        self.assertNotIn("minimum", json.dumps(schema), "Wire grammar stays compatible while local checks remain strict")
        transport, _ = self.transport([httpx.Response(200, json=completion({"name": "Stage result", "count": 0}))])
        with transport, self.assertRaisesRegex(ProviderError, "required layout format"):
            extract_structured("claude", b"image", "Inspect this stage.", StageResult)

    def test_gateway_http_errors_are_actionable_sanitized_and_not_retried(self):
        for code, message in ((400, "HTTP 400"), (401, "AI_GATEWAY_API_KEY"), (402, "credits or billing"),
                              (403, "AI_GATEWAY_API_KEY"), (404, "AI_GATEWAY_GEMINI_MODEL"), (302, "HTTP 302")):
            with self.subTest(code=code):
                transport, calls = self.transport([httpx.Response(code, text="private fake-gateway-secret", headers={"Location": "https://untrusted.invalid"})])
                with transport, patch("app.services.floorplans.providers.asyncio.sleep", new_callable=AsyncMock) as sleep:
                    with self.assertRaisesRegex(ProviderError, message) as caught:
                        extract_drawing("claude", b"image", 1000, 500)
                self.assertNotIn("private", str(caught.exception))
                self.assertNotIn("fake-gateway-secret", str(caught.exception))
                self.assertEqual(len(calls), 1)
                sleep.assert_not_called()

    def test_gateway_retry_after_and_attempts_are_bounded_without_native_fallback(self):
        responses = [httpx.Response(429, headers={"Retry-After": "5"}), httpx.Response(503), httpx.Response(200, json=completion())]
        transport, calls = self.transport(responses)
        with transport, patch("app.services.floorplans.providers.asyncio.sleep", new_callable=AsyncMock) as sleep, \
                patch("app.services.floorplans.providers.random.uniform", return_value=0):
            extract_drawing("claude", b"image", 1000, 500)
        self.assertEqual(len(calls), 3)
        self.assertEqual([call.args[0] for call in sleep.call_args_list], [5, 2])
        self.assertTrue(all(str(call.url) == AI_GATEWAY_URL for call in calls))
        self.assertTrue(all(response.is_closed for response in responses))
        transport, calls = self.transport([httpx.Response(503, text="private") for _ in range(3)])
        with transport, patch("app.services.floorplans.providers.asyncio.sleep", new_callable=AsyncMock):
            with self.assertRaisesRegex(ProviderError, "HTTP 503.*3 attempts"):
                extract_drawing("gemini", b"image", 1000, 500)
        self.assertEqual(len(calls), 3)

    def test_gateway_network_loss_does_not_duplicate_a_possibly_processed_request(self):
        transport, calls = self.transport([httpx.ReadTimeout("private transport error")])
        with transport, patch.dict(os.environ, {"GEMINI_API_KEY": "fake-native"}):
            with self.assertRaisesRegex(ProviderError, "time limit") as caught:
                extract_drawing("gemini", b"image", 1000, 500)
        self.assertEqual(len(calls), 1)
        self.assertNotIn("private", str(caught.exception))

    def test_gateway_success_body_must_be_bounded_json(self):
        for response in (httpx.Response(200, text="private HTML"), httpx.Response(200, json=[]),
                         httpx.Response(200, content=b" " * (8 * 1024 * 1024 + 1))):
            transport, calls = self.transport([response])
            with transport, self.assertRaises(ProviderError) as caught:
                extract_drawing("claude", b"image", 1000, 500)
            self.assertEqual(len(calls), 1)
            self.assertNotIn("private", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
