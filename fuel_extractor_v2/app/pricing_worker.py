from __future__ import annotations

import hashlib
import json
import os
from datetime import datetime, timezone
from typing import Any

try:
    from fuel_extractor.app.markdown_convert import fetch_full_site_markdown, prune_marina_markdown
except ImportError:
    fetch_full_site_markdown = None
    prune_marina_markdown = None


class PricingWorkerError(Exception):
    pass


PRICING_SYSTEM_PROMPT = """
You are a Marine Facility Auditor. Your goal is to extract technical and financial data from marina website markdown.

RULES OF EXTRACTION:
1. DO NOT CALCULATE. Only extract the raw numbers and units as written.
2. LOOK FOR THE 'WELL': If a travel lift is mentioned, search specifically for the maximum BEAM (width) it can accommodate. This is distinct from the marina's slip width.
3. IDENTIFY THE 'CATAMARAN MULTIPLIER': Look for surcharges applied to catamarans (e.g., 1.5x length or double-slip pricing).
4. NAVIGATIONAL GATEKEEPING: Identify the most restrictive AIR DRAFT (bridge height) and WATER DEPTH (at MLW/Low Tide) required to reach the marina.
5. DIY PERMISSIONS: Determine if boat owners are permitted to perform their own maintenance (e.g., 'DIY allowed' vs 'Yard-only labor').

EDGE CASE RULES:
- If a value is not found, use null (not 0 or empty string)
- If multiple values are found (e.g., seasonal rates), report the highest rate
- If units are unclear, preserve the unit as written (e.g., "$/ft/mo" or "$/season")
- If depth is given at MLW vs MHW, report the more restrictive (shallower) value

OUTPUT SCHEMA:
Return ONLY valid JSON with this exact structure:
{
  "marina_name": "string",
  "rates": {
    "daily": {"value": number, "unit": "string", "is_per_foot": boolean},
    "monthly": {"value": number, "unit": "string", "is_per_foot": boolean},
    "annual": {"value": number, "unit": "string", "is_per_foot": boolean}
  },
  "surcharges": {
    "catamaran_multiplier": number,
    "liveaboard_fee": number,
    "liveaboard_unit": "string"
  },
  "navigational_limits": {
    "min_air_draft_ft": number,
    "air_draft_source": "string",
    "min_depth_ft": number,
    "depth_source": "string"
  },
  "haulout_specs": {
    "has_travel_lift": boolean,
    "max_beam_ft": number,
    "max_tons": number,
    "diy_allowed": boolean
  },
  "utility_policies": {
    "electricity_metered": boolean,
    "water_metered": boolean,
    "liveaboard_permitted": boolean
  },
  "source_quotes": ["string"]
}

EXAMPLE INPUT:
"Monthly rates: $18/ft for monohulls, $27/ft for catamarans. Liveaboard fee: $50/mo. Bridge clearance: 45ft at mean high water. Channel depth: 8ft at MLW. 50-ton travel lift, max beam 24ft. DIY work permitted in designated area."

EXAMPLE OUTPUT:
{
  "marina_name": null,
  "rates": {
    "daily": null,
    "monthly": {"value": 18, "unit": "$/ft/mo", "is_per_foot": true},
    "annual": null
  },
  "surcharges": {
    "catamaran_multiplier": 1.5,
    "liveaboard_fee": 50,
    "liveaboard_unit": "$/mo"
  },
  "navigational_limits": {
    "min_air_draft_ft": 45,
    "air_draft_source": "mean high water",
    "min_depth_ft": 8,
    "depth_source": "MLW"
  },
  "haulout_specs": {
    "has_travel_lift": true,
    "max_beam_ft": 24,
    "max_tons": 50,
    "diy_allowed": true
  },
  "utility_policies": {
    "electricity_metered": null,
    "water_metered": null,
    "liveaboard_permitted": null
  },
  "source_quotes": [
    "$18/ft for monohulls, $27/ft for catamarans",
    "Liveaboard fee: $50/mo",
    "Bridge clearance: 45ft at mean high water",
    "Channel depth: 8ft at MLW",
    "50-ton travel lift, max beam 24ft",
    "DIY work permitted in designated area"
  ]
}
"""


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _extraction_hash(payload: dict[str, Any]) -> str:
    digest_input = {
        "marina_name": payload.get("marina_name"),
        "monthly_base": payload.get("monthly_base"),
        "is_per_ft": payload.get("is_per_ft"),
        "catamaran_multiplier": payload.get("catamaran_multiplier"),
        "liveaboard_fee": payload.get("liveaboard_fee"),
        "min_air_draft_ft": payload.get("min_air_draft_ft"),
        "min_depth_ft": payload.get("min_depth_ft"),
        "lift_max_beam_ft": payload.get("lift_max_beam_ft"),
        "lift_max_tons": payload.get("lift_max_tons"),
    }
    serialized = json.dumps(digest_input, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(serialized.encode("utf-8")).hexdigest()


def extract_pricing_with_deepseek(
    base_url: str,
    timeout_seconds: int = 45,
    max_pages: int = 20,
    html_content: str = None,
) -> dict[str, Any]:
    """
    Extract pricing data from marina website using DeepSeek v4 via Fireworks.
    If html_content is provided, use it directly instead of fetching from URL.
    """
    api_key = os.getenv("FIREWORKS_API_KEY")
    if not api_key:
        raise PricingWorkerError("FIREWORKS_API_KEY environment variable not set")

    # 1. Get content (either from HTML or fetch from URL)
    if html_content:
        full_markdown = html_content
    elif fetch_full_site_markdown is not None:
        full_markdown = fetch_full_site_markdown(base_url, timeout_seconds, max_pages)
        # 2. Prune markdown to reduce token count while preserving data-dense content
        full_markdown = prune_marina_markdown(full_markdown)
    else:
        raise PricingWorkerError("html_content not provided and fuel_extractor module not available")

    # 2. Call Fireworks DeepSeek v4
    try:
        from fireworks.client import Fireworks
    except ImportError:
        raise PricingWorkerError(
            "fireworks-ai package not installed. Install with: pip install fireworks-ai"
        )

    client = Fireworks(api_key=api_key)

    try:
        response = client.chat.completions.create(
            model="accounts/fireworks/models/deepseek-v4-pro",
            messages=[
                {"role": "system", "content": PRICING_SYSTEM_PROMPT},
                {"role": "user", "content": full_markdown},
            ],
            temperature=0.1,  # Low temp for consistent extraction
            max_tokens=4096,
        )
    except Exception as exc:
        raise PricingWorkerError(f"Fireworks API call failed: {exc}") from exc

    # 3. Parse JSON response
    try:
        content = response.choices[0].message.content
        result = json.loads(content)
    except (json.JSONDecodeError, AttributeError, IndexError) as exc:
        raise PricingWorkerError(f"Failed to parse Fireworks response as JSON: {exc}") from exc

    # 4. Normalize to database schema
    normalized = _normalize_pricing_result(result)
    normalized["extraction_hash"] = _extraction_hash(normalized)
    normalized["fetched_at_utc"] = _utc_now_iso()

    return normalized


def _normalize_pricing_result(llm_output: dict[str, Any]) -> dict[str, Any]:
    """Normalize LLM output to database schema."""
    rates = llm_output.get("rates", {})
    surcharges = llm_output.get("surcharges", {})
    nav_limits = llm_output.get("navigational_limits", {})
    haulout = llm_output.get("haulout_specs", {})
    utilities = llm_output.get("utility_policies", {})

    # Extract monthly rate
    monthly_rate = rates.get("monthly", {})
    monthly_base = monthly_rate.get("value") if monthly_rate else None
    is_per_ft = monthly_rate.get("is_per_foot", False) if monthly_rate else None

    return {
        "marina_name": llm_output.get("marina_name"),
        "monthly_base": monthly_base,
        "is_per_ft": 1 if is_per_ft else 0 if is_per_ft is not None else None,
        "catamaran_multiplier": surcharges.get("catamaran_multiplier"),
        "liveaboard_fee": surcharges.get("liveaboard_fee"),
        "min_air_draft_ft": nav_limits.get("min_air_draft_ft"),
        "air_draft_source": nav_limits.get("air_draft_source"),
        "min_depth_ft": nav_limits.get("min_depth_ft"),
        "depth_source": nav_limits.get("depth_source"),
        "lift_max_beam_ft": haulout.get("max_beam_ft"),
        "lift_max_tons": haulout.get("max_tons"),
        "diy_allowed": 1 if haulout.get("diy_allowed") else 0 if haulout.get("diy_allowed") is not None else None,
        "electricity_metered": 1 if utilities.get("electricity_metered") else 0 if utilities.get("electricity_metered") is not None else None,
        "water_metered": 1 if utilities.get("water_metered") else 0 if utilities.get("water_metered") is not None else None,
        "liveaboard_permitted": 1 if utilities.get("liveaboard_permitted") else 0 if utilities.get("liveaboard_permitted") is not None else None,
        "source_quotes": llm_output.get("source_quotes", []),
    }
