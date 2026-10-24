"""Small REST adapters. Credentials remain server-side; responses share one schema."""

import asyncio
import base64
import copy
import json
import math
import os
from pathlib import Path
import random
from urllib.parse import quote

import httpx
from dotenv import load_dotenv

from app.schemas.extraction import ExtractedDrawing


DEFAULT_MODELS = {"gemini": "gemini-3.8-flash", "claude": "claude-sonnet-5-5"}
KEY_NAMES = {"gemini": "GEMINI_API_KEY", "claude": "ANTHROPIC_API_KEY"}
MODEL_NAMES = {"gemini": "GEMINI_MODEL", "claude": "ANTHROPIC_MODEL"}
EXTRACTION_PROMPT = Path(__file__).with_name("floorplan_extraction.txt")
MAX_PROVIDER_ATTEMPTS = 3
PROVIDER_TIME_BUDGET = 175
RETRYABLE_HTTP_CODES = {408, 429, 500, 502, 503, 504, 529}


class ProviderError(RuntimeError):
    """An actionable error without credentials or raw upstream error bodies."""


def load_environment(env_file: Path | None = None):
    root = Path(__file__).resolve().parents[4]
    load_dotenv(env_file or root / ".env", override=False)


def provider_status() -> dict:
    return {provider: {
        "configured": bool(api_key(provider)),
        "model": os.environ.get(MODEL_NAMES[provider]) or DEFAULT_MODELS[provider],
    } for provider in KEY_NAMES}


def api_key(provider: str) -> str:
    key = os.environ.get(KEY_NAMES[provider], "").strip()
    if not key and provider == "claude":
        key = os.environ.get("CLAUDE_API_KEY", "").strip()
    return key


def request_json(url: str, headers: dict, payload: dict) -> dict:
    """Called by extraction workers, with one deadline covering retries and body reads."""
    content = json.dumps(payload, allow_nan=False).encode()
    try:
        return asyncio.run(_request_json(url, headers, content))
    except (TimeoutError, httpx.TransportError):
        # A timed-out POST may already have been processed. Do not duplicate it.
        raise ProviderError("Image extraction exceeded the time limit or lost its connection. "
                            "Retry or choose the other provider.") from None


def _provider_client():
    return httpx.AsyncClient(timeout=PROVIDER_TIME_BUDGET, follow_redirects=False)


async def _request_json(url: str, headers: dict, content: bytes) -> dict:
    # Socket/read timeouts alone can be extended indefinitely by a slow response.
    # Cancellation closes the HTTP connection before returning the extraction slot.
    async with asyncio.timeout(PROVIDER_TIME_BUDGET):
        async with _provider_client() as client:
            return await _request_attempts(client, url, headers, content)


async def _request_attempts(client, url, headers, content):
    deadline = asyncio.get_running_loop().time() + PROVIDER_TIME_BUDGET
    for attempt in range(MAX_PROVIDER_ATTEMPTS):
        async with client.stream("POST", url, content=content,
                                 headers={"Content-Type": "application/json", **headers}) as response:
            code = response.status_code
            retry_after = response.headers.get("Retry-After", "")
            if 200 <= code < 300:
                raw = bytearray()
                async for chunk in response.aiter_bytes():
                    raw.extend(chunk)
                    if len(raw) > 8 * 1024 * 1024:
                        raise ProviderError("The provider response was too large. Try a simpler floor plan.")
                try:
                    result = json.loads(raw)
                    if not isinstance(result, dict):
                        raise ValueError("Expected a JSON object")
                    return result
                except (ValueError, UnicodeError):
                    raise ProviderError("The provider returned an unreadable response. Retry extraction.") from None
        # Error bodies may contain request data; never forward them to the UI.
        delay = 2 ** attempt + random.uniform(0, .25)
        try:
            seconds = float(retry_after)
            if math.isfinite(seconds) and seconds >= 0:
                delay = max(delay, seconds)
        except ValueError:
            pass
        if (code in RETRYABLE_HTTP_CODES and attempt + 1 < MAX_PROVIDER_ATTEMPTS
                and asyncio.get_running_loop().time() + delay < deadline):
            await asyncio.sleep(delay)
            continue
        if code in (401, 403):
            message = "The provider rejected the key or account access. Check the root .env and restart."
        elif code == 404:
            message = "The selected model is unavailable. Set GEMINI_MODEL or ANTHROPIC_MODEL in .env."
        elif code == 429:
            message = "The provider rate limit or quota was reached. Check credits, then retry."
        elif code >= 500 or code == 408:
            attempts = f"{attempt + 1} attempt" + ("s" if attempt else "")
            message = (f"The provider is temporarily unavailable (HTTP {code}) after {attempts}. "
                       "Try again shortly or choose the other provider.")
        else:
            message = f"The provider rejected the request (HTTP {code}). Check model access and configuration."
        raise ProviderError(message) from None


def output_schema() -> dict:
    """Inline references and keep the JSON-schema subset accepted by both APIs.

    Full size/range checks still run against ExtractedDrawing after parsing.
    """
    schema = ExtractedDrawing.model_json_schema()
    definitions = schema.pop("$defs", {})

    def simplify(value):
        if isinstance(value, list):
            return [simplify(item) for item in value]
        if not isinstance(value, dict):
            return value
        if "$ref" in value:
            return simplify(copy.deepcopy(definitions[value["$ref"].split("/")[-1]]))
        unsupported = {"title", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum",
                       "minLength", "maxLength", "minItems", "maxItems", "pattern", "default"}
        result = {key: simplify(item) for key, item in value.items() if key not in unsupported}
        if result.get("type") == "object":
            result["additionalProperties"] = False
            result["required"] = list(result.get("properties", {}))
        return result

    return simplify(schema)


def extraction_prompt(provider: str, width: int, height: int) -> str:
    coordinates = (
        "Use normalized x and y coordinates from 0 to 1000 across the entire image; "
        "origin is top-left. Thickness is in thousandths of the shorter image dimension."
        if provider == "gemini" else
        f"Use absolute pixel coordinates in this {width} by {height} pixel image; "
        "origin is top-left, x right, y down. Thickness is in pixels."
    )
    return EXTRACTION_PROMPT.read_text(encoding="utf-8").format(coordinates=coordinates)


def extract_drawing(provider: str, image: bytes, width: int, height: int) -> tuple[ExtractedDrawing, str]:
    if provider not in KEY_NAMES:
        raise ProviderError("Choose Gemini or Claude.")
    key = api_key(provider)
    if not key:
        raise ProviderError(f"Add {KEY_NAMES[provider]} to the root .env and restart the editor.")
    model = provider_status()[provider]["model"]
    encoded = base64.b64encode(image).decode("ascii")
    prompt = extraction_prompt(provider, width, height)
    schema = output_schema()
    if provider == "gemini":
        response = request_json(
            f"https://generativelanguage.googleapis.com/v1beta/models/{quote(model, safe='')}:generateContent",
            {"x-goog-api-key": key},
            {"contents": [{"parts": [
                {"inlineData": {"mimeType": "image/png", "data": encoded}}, {"text": prompt},
            ]}], "generationConfig": {
                "maxOutputTokens": 16384,
                "responseFormat": {"text": {"mimeType": "APPLICATION_JSON", "schema": schema}},
            }},
        )
        candidates = response.get("candidates", [])
        if not candidates or candidates[0].get("finishReason") not in (None, "STOP"):
            raise ProviderError("Gemini did not finish a usable extraction. Try a clearer or simpler plan.")
        text = "".join(part.get("text", "") for part in candidates[0].get("content", {}).get("parts", [])
                       if not part.get("thought"))
    else:
        response = request_json(
            "https://api.anthropic.com/v1/messages",
            {"x-api-key": key, "anthropic-version": "2023-06-01"},
            {"model": model, "max_tokens": 16384,
             "messages": [{"role": "user", "content": [
                 {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": encoded}},
                 {"type": "text", "text": prompt},
             ]}], "output_config": {"format": {"type": "json_schema", "schema": schema}}},
        )
        if response.get("stop_reason") not in (None, "end_turn"):
            raise ProviderError("Claude did not finish a usable extraction. Try a clearer or simpler plan.")
        text = "".join(part.get("text", "") for part in response.get("content", []) if part.get("type") == "text")
    try:
        return ExtractedDrawing.model_validate_json(text), model
    except ValueError:
        raise ProviderError("The extracted drawing did not match the required layout format. Retry or simplify the image.") from None
