from __future__ import annotations

from typing import Any


class ContractValidationError(Exception):
    pass


_OUTCOME_STATES = {
    "has_public_price",
    "fuel_available_price_hidden",
    "fuel_unknown",
    "fetch_blocked",
}

_BLOCKED_REASONS = {
    "access_denied_401",
    "access_denied_403",
    "rate_limited_429",
    "cloudflare_challenge",
    "dns_failure",
    "ssl_failure",
    "timeout",
}


def validate_seed_payload(seed: dict[str, Any]) -> None:
    if not isinstance(seed, dict):
        raise ContractValidationError("seed payload must be a dict")

    required_fields = (
        "marina_uid",
        "name",
        "lat",
        "lon",
        "fuel_candidate",
        "seed_reason",
        "seeded_at_utc",
    )
    for field in required_fields:
        if field not in seed:
            raise ContractValidationError(f"Missing required seed field: {field}")

    marina_uid = seed.get("marina_uid")
    if not isinstance(marina_uid, str) or not marina_uid.strip():
        raise ContractValidationError("marina_uid must be a non-empty string")

    name = seed.get("name")
    if not isinstance(name, str) or not name.strip():
        raise ContractValidationError("name must be a non-empty string")

    lat = seed.get("lat")
    lon = seed.get("lon")
    if not isinstance(lat, (float, int)):
        raise ContractValidationError("lat must be numeric")
    if not isinstance(lon, (float, int)):
        raise ContractValidationError("lon must be numeric")

    fuel_candidate = seed.get("fuel_candidate")
    if fuel_candidate not in (0, 1):
        raise ContractValidationError("fuel_candidate must be 0 or 1")

    seed_reason = seed.get("seed_reason")
    if not isinstance(seed_reason, str) or not seed_reason.strip():
        raise ContractValidationError("seed_reason must be a non-empty string")

    seeded_at_utc = seed.get("seeded_at_utc")
    if not isinstance(seeded_at_utc, str) or not seeded_at_utc.strip():
        raise ContractValidationError("seeded_at_utc must be a non-empty string")

    has_source_url = False
    for url_field in ("dockwa_url", "marinas_url", "website_url"):
        value = seed.get(url_field)
        if isinstance(value, str) and value.strip():
            has_source_url = True
            break

    if not has_source_url:
        raise ContractValidationError("At least one source URL is required: dockwa_url, marinas_url, or website_url")


def validate_extractor_output(payload: dict[str, Any]) -> None:
    if not isinstance(payload, dict):
        raise ContractValidationError("extractor output must be a dict")

    required_fields = (
        "marina_uid",
        "outcome_state",
        "reason_tag",
        "diesel_price",
        "gasoline_price",
        "fuel_dock",
        "last_updated",
        "source_url",
        "source_text",
        "provenance",
        "fetched_at_utc",
    )

    for field in required_fields:
        if field not in payload:
            raise ContractValidationError(f"Missing required output field: {field}")

    marina_uid = payload.get("marina_uid")
    if not isinstance(marina_uid, str) or not marina_uid.strip():
        raise ContractValidationError("marina_uid must be a non-empty string")

    outcome_state = payload.get("outcome_state")
    if outcome_state not in _OUTCOME_STATES:
        raise ContractValidationError("outcome_state is invalid")

    reason_tag = payload.get("reason_tag")
    if not isinstance(reason_tag, str) or not reason_tag.strip():
        raise ContractValidationError("reason_tag must be a non-empty string")

    for price_field in ("diesel_price", "gasoline_price"):
        value = payload.get(price_field)
        if value is not None and not isinstance(value, (float, int)):
            raise ContractValidationError(f"{price_field} must be numeric or null")

    fuel_dock = payload.get("fuel_dock")
    if fuel_dock is not None and not isinstance(fuel_dock, bool):
        raise ContractValidationError("fuel_dock must be boolean or null")

    last_updated = payload.get("last_updated")
    if last_updated is not None and not isinstance(last_updated, str):
        raise ContractValidationError("last_updated must be a string or null")

    source_url = payload.get("source_url")
    if source_url is not None and not isinstance(source_url, str):
        raise ContractValidationError("source_url must be a string or null")

    source_text = payload.get("source_text")
    if source_text is not None and not isinstance(source_text, str):
        raise ContractValidationError("source_text must be a string or null")

    provenance = payload.get("provenance")
    if not isinstance(provenance, dict):
        raise ContractValidationError("provenance must be an object")

    fetched_at_utc = payload.get("fetched_at_utc")
    if not isinstance(fetched_at_utc, str) or not fetched_at_utc.strip():
        raise ContractValidationError("fetched_at_utc must be a non-empty string")

    blocked_reason = payload.get("blocked_reason")
    if blocked_reason is not None and blocked_reason not in _BLOCKED_REASONS:
        raise ContractValidationError("blocked_reason is invalid")

    if outcome_state == "has_public_price":
        if payload.get("diesel_price") is None and payload.get("gasoline_price") is None:
            raise ContractValidationError("has_public_price requires at least one non-null price")

    if outcome_state == "fuel_available_price_hidden":
        if payload.get("fuel_dock") is not True:
            raise ContractValidationError("fuel_available_price_hidden requires fuel_dock=true")

    if outcome_state == "fetch_blocked":
        if blocked_reason is None:
            raise ContractValidationError("fetch_blocked requires blocked_reason")
