from __future__ import annotations

import json
import re
from typing import Any, Optional

import httpx


class ExtractionError(Exception):
    pass


class OllamaClient:
    def __init__(self, base_url: str = "http://127.0.0.1:11434", model: str = "llama3.2:3b"):
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.timeout = 120

    _EXTRACTION_PROMPT = """You are a precise fuel data extractor. Read the marina markdown and extract ONLY the following fields in JSON.

RULES:
- Return ONLY raw JSON. No explanations, no markdown, no extra text.
- If a value is NOT explicitly stated, use null. Do not guess.
- diesel_price/gasoline_price: extract the FULL price as a float (e.g., "$5.199/gallon" → 5.199)
- fuel_dock: true only if text explicitly indicates a fuel dock/fuel station/on-site fuel; false only if explicitly says no fuel; otherwise null.
- source_text: include the exact sentence where each price/boolean was found. If hours, ignore.
- last_updated: look for date phrases like "updated", "as of", "effective".
- confidence: assign 0.8-1.0 if clear fuel data with source, 0.4-0.7 if partial, 0.0-0.3 if uncertain.

JSON schema:
{
  "diesel_price": float | null,
  "is_valvtect": boolean | null,
  "gasoline_price": float | null,
  "fuel_dock": boolean | null,
  "is_non_ethanol": boolean | null,
  "last_updated": string | null,
  "source_text": string | null,
  "source_text_date": string | null,
  "confidence": float
}

Markdown:
"""

    def _clean_json_response(self, raw: str) -> str:
        text = raw.strip()
        text = re.sub(r"```json\s*", "", text, flags=re.IGNORECASE)
        text = re.sub(r"```\s*$", "", text, flags=re.IGNORECASE)
        text = re.sub(r"^[^{]*({.*})[^}]*$", r"\1", text, flags=re.DOTALL)
        return text.strip()

    def _validate_extraction(self, data: dict[str, Any]) -> dict[str, Any]:
        # Only validate keys that are present - optional fields can be missing
        confidence = data.get("confidence")
        if confidence is None:
            data["confidence"] = 0.0
        elif not isinstance(confidence, (int, float)) or not (0 <= confidence <= 1):
            raise ExtractionError("Invalid confidence value")

        return data

    def extract_fuel_data(self, markdown: str) -> dict[str, Any]:
        if not markdown or not markdown.strip():
            return {
                "diesel_price": None,
                "is_valvtect": None,
                "gasoline_price": None,
                "fuel_dock": None,
                "is_non_ethanol": None,
                "last_updated": None,
                "source_text": None,
                "source_text_date": None,
                "confidence": 0.0,
            }

        prompt = self._EXTRACTION_PROMPT + markdown

        try:
            with httpx.Client(timeout=self.timeout) as client:
                response = client.post(
                    f"{self.base_url}/api/generate",
                    json={
                        "model": self.model,
                        "prompt": prompt,
                        "stream": False,
                        "format": "json",
                        "options": {"temperature": 0.0},
                    },
                )
                response.raise_for_status()
                raw = response.json().get("response", "")
                cleaned = self._clean_json_response(raw)
                parsed = json.loads(cleaned)
                validated = self._validate_extraction(parsed)
                return validated
        except httpx.HTTPError as exc:
            raise ExtractionError(f"Ollama request failed: {exc}") from exc
        except json.JSONDecodeError as exc:
            raise ExtractionError(f"Failed to decode JSON response: {exc}") from exc
        except Exception as exc:
            raise ExtractionError(f"Extraction failed: {exc}") from exc
