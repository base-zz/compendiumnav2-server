from __future__ import annotations

import hashlib
import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fuel_extractor.app.main import extract_fuel
from fuel_extractor.app.markdown_convert import fetch_dockwa_fuel_snapshot
from fuel_extractor.app.schemas import ExtractRequest, ExtractResponse

from .contracts import validate_extractor_output, validate_seed_payload
from .seed_consumer import mark_seed_status, read_pending_seeds
from .sync_event_writer import write_sync_event


class FuelWorkerError(Exception):
    pass


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _as_non_empty_string(value: Any, field_name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise FuelWorkerError(f"{field_name} must be a non-empty string")
    return value.strip()


def _choose_source_url(seed: dict[str, Any]) -> str:
    dockwa_url = seed.get("dockwa_url")
    if isinstance(dockwa_url, str) and dockwa_url.strip():
        return dockwa_url.strip()

    marinas_url = seed.get("marinas_url")
    if isinstance(marinas_url, str) and marinas_url.strip():
        normalized_marinas_url = marinas_url.strip()
        if not normalized_marinas_url.lower().startswith("https://marinas.com/map/"):
            return normalized_marinas_url

    website_url = seed.get("website_url")
    if isinstance(website_url, str) and website_url.strip():
        return website_url.strip()

    raise FuelWorkerError("seed requires at least one source URL: dockwa_url, marinas_url, or website_url")


def _to_extract_request(seed: dict[str, Any]) -> ExtractRequest:
    seed_id = seed.get("seed_id")
    marina_uid = _as_non_empty_string(seed.get("marina_uid"), "marina_uid")
    name = _as_non_empty_string(seed.get("name"), "name")

    if not isinstance(seed_id, int):
        raise FuelWorkerError("seed_id must be an int")

    lat = seed.get("lat")
    lon = seed.get("lon")
    if not isinstance(lat, (int, float)):
        raise FuelWorkerError("lat must be numeric")
    if not isinstance(lon, (int, float)):
        raise FuelWorkerError("lon must be numeric")

    source_url = _choose_source_url(seed)

    request_payload = {
        "job_id": f"seed-{seed_id}-{marina_uid}",
        "fuel_source_id": seed_id,
        "name": name,
        "website_url": source_url,
        "phone": None,
        "lat": float(lat),
        "lon": float(lon),
        "max_discovery_depth": 2,
        "max_pages": 8,
        "prefer_pdfs": True,
        "timeout_seconds": 45,
        "skip_if_verified_within_hours": 24,
    }
    return ExtractRequest(**request_payload)


def _try_dockwa_extraction(seed: dict[str, Any], timeout_seconds: int) -> dict[str, Any] | None:
    dockwa_url = seed.get("dockwa_url")
    if not isinstance(dockwa_url, str) or not dockwa_url.strip():
        return None

    try:
        snapshot = fetch_dockwa_fuel_snapshot(dockwa_url.strip(), timeout_seconds)
    except Exception:
        return None

    if not isinstance(snapshot, dict):
        return None

    has_price = snapshot.get("diesel_price") is not None or snapshot.get("gasoline_price") is not None
    if not has_price:
        return None

    return {
        "diesel_price": snapshot.get("diesel_price"),
        "gasoline_price": snapshot.get("gasoline_price"),
        "fuel_dock": True,
        "is_non_ethanol": snapshot.get("is_non_ethanol"),
        "last_updated": snapshot.get("last_updated"),
        "source_text": snapshot.get("source_text"),
        "source_url": dockwa_url.strip(),
        "confidence": 1.0,
    }


def _build_output_from_dockwa(seed: dict[str, Any], dockwa_result: dict[str, Any]) -> dict[str, Any]:
    marina_uid = _as_non_empty_string(seed.get("marina_uid"), "marina_uid")
    fetched_at_utc = _utc_now_iso()

    diesel_price = dockwa_result.get("diesel_price")
    gasoline_price = dockwa_result.get("gasoline_price")
    source_url = dockwa_result.get("source_url")
    source_text = dockwa_result.get("source_text")

    provenance: dict[str, Any] = {}
    if diesel_price is not None:
        provenance["diesel_price"] = {"source": "dockwa_json", "seen_at": fetched_at_utc}
    if gasoline_price is not None:
        provenance["gasoline_price"] = {"source": "dockwa_json", "seen_at": fetched_at_utc}
    provenance["fuel_dock"] = {"source": "dockwa_json", "seen_at": fetched_at_utc}

    output_payload: dict[str, Any] = {
        "marina_uid": marina_uid,
        "outcome_state": "has_public_price",
        "reason_tag": "dockwa_price_observed",
        "diesel_price": diesel_price,
        "gasoline_price": gasoline_price,
        "fuel_dock": dockwa_result.get("fuel_dock"),
        "last_updated": dockwa_result.get("last_updated"),
        "source_url": source_url,
        "source_text": source_text,
        "provenance": provenance,
        "fetched_at_utc": fetched_at_utc,
        "blocked_reason": None,
    }

    validate_extractor_output(output_payload)
    return output_payload


def _map_blocked_reason(response: ExtractResponse) -> str | None:
    error_code = response.error_code
    reason = response.reason

    lowered_reason = ""
    if isinstance(reason, str):
        lowered_reason = reason.lower()

    if error_code == "DISCOVERY_ERROR":
        if "403" in lowered_reason:
            return "access_denied_403"
        if "401" in lowered_reason:
            return "access_denied_401"
        if "429" in lowered_reason:
            return "rate_limited_429"
        if "cloudflare" in lowered_reason:
            return "cloudflare_challenge"
        if "dns" in lowered_reason:
            return "dns_failure"
        if "ssl" in lowered_reason or "certificate" in lowered_reason:
            return "ssl_failure"
        if "timeout" in lowered_reason:
            return "timeout"

    if error_code == "CONVERSION_ERROR":
        if "timeout" in lowered_reason:
            return "timeout"
        if "ssl" in lowered_reason or "certificate" in lowered_reason:
            return "ssl_failure"
        if "dns" in lowered_reason:
            return "dns_failure"

    return None


def _derive_outcome(response: ExtractResponse) -> tuple[str, str, str | None]:
    diesel_price = response.extraction.diesel_price
    gasoline_price = response.extraction.gasoline_price
    fuel_dock = response.extraction.fuel_dock

    has_price = diesel_price is not None or gasoline_price is not None
    has_fuel_dock = fuel_dock is True

    if response.status == "error":
        blocked_reason = _map_blocked_reason(response)
        if blocked_reason is not None:
            return "fetch_blocked", "marina_site_blocked", blocked_reason
        return "fuel_unknown", "schema_validation_failed", None

    if has_price:
        source_url = response.extraction.source_url
        if isinstance(source_url, str) and "dockwa.com" in source_url:
            return "has_public_price", "dockwa_price_observed", None
        return "has_public_price", "price_observed_publicly", None

    if has_fuel_dock:
        return "fuel_available_price_hidden", "price_not_published_publicly", None

    reason = response.reason
    if isinstance(reason, str) and reason.strip():
        lowered_reason = reason.lower()
        if "candidate" in lowered_reason and "link" in lowered_reason:
            return "fuel_unknown", "no_dockwa_link", None

    return "fuel_unknown", "fuel_not_detected", None


def _price_source(outcome_state: str, source_url: str | None) -> str:
    if isinstance(source_url, str) and source_url.strip():
        lowered = source_url.lower()
        if "dockwa.com" in lowered:
            return "dockwa_json"
        if "marinas.com" in lowered:
            return "marinas_web"
        return "website_text"

    if outcome_state == "fuel_available_price_hidden":
        return "not_published_online"

    return "none"


def _normalize_confidence(value: Any) -> float:
    if not isinstance(value, (int, float)):
        return 0.0
    confidence = float(value)
    if confidence < 0.0:
        return 0.0
    if confidence > 1.0:
        return 1.0
    return confidence


def _build_provenance_payload(
    response: ExtractResponse,
    fetched_at_utc: str,
    price_source: str,
) -> dict[str, Any]:
    provenance: dict[str, Any] = {}

    if response.extraction.diesel_price is not None:
        provenance["diesel_price"] = {"source": price_source, "seen_at": fetched_at_utc}
    if response.extraction.gasoline_price is not None:
        provenance["gasoline_price"] = {"source": price_source, "seen_at": fetched_at_utc}
    if response.extraction.fuel_dock is not None:
        provenance["fuel_dock"] = {"source": price_source, "seen_at": fetched_at_utc}

    response_reason = response.reason
    if isinstance(response_reason, str) and response_reason.strip():
        provenance["reason"] = {"text": response_reason.strip(), "seen_at": fetched_at_utc}

    return provenance


def _extraction_hash(payload: dict[str, Any]) -> str:
    digest_input = {
        "marina_uid": payload.get("marina_uid"),
        "outcome_state": payload.get("outcome_state"),
        "reason_tag": payload.get("reason_tag"),
        "blocked_reason": payload.get("blocked_reason"),
        "diesel_price": payload.get("diesel_price"),
        "gasoline_price": payload.get("gasoline_price"),
        "fuel_dock": payload.get("fuel_dock"),
        "last_updated": payload.get("last_updated"),
        "source_url": payload.get("source_url"),
        "source_text": payload.get("source_text"),
    }
    serialized = json.dumps(digest_input, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(serialized.encode("utf-8")).hexdigest()


def _build_output_payload(seed: dict[str, Any], response: ExtractResponse) -> dict[str, Any]:
    marina_uid = _as_non_empty_string(seed.get("marina_uid"), "marina_uid")
    fetched_at_utc = _utc_now_iso()

    outcome_state, reason_tag, blocked_reason = _derive_outcome(response)

    source_url = response.extraction.source_url
    source_text = response.extraction.source_text

    if not isinstance(source_url, str) or not source_url.strip():
        source_url = response.evidence.source_url

    if not isinstance(source_url, str) or not source_url.strip():
        source_url = _choose_source_url(seed)

    if not isinstance(source_text, str) or not source_text.strip():
        source_text = None

    price_source = _price_source(outcome_state, source_url)
    provenance = _build_provenance_payload(response, fetched_at_utc, price_source)

    output_payload: dict[str, Any] = {
        "marina_uid": marina_uid,
        "outcome_state": outcome_state,
        "reason_tag": reason_tag,
        "diesel_price": response.extraction.diesel_price,
        "gasoline_price": response.extraction.gasoline_price,
        "fuel_dock": response.extraction.fuel_dock,
        "last_updated": response.extraction.last_updated,
        "source_url": source_url,
        "source_text": source_text,
        "provenance": provenance,
        "fetched_at_utc": fetched_at_utc,
        "blocked_reason": blocked_reason,
    }

    validate_extractor_output(output_payload)
    return output_payload


def _write_fuel_log(connection: sqlite3.Connection, output_payload: dict[str, Any], response: ExtractResponse | None) -> int:
    if connection is None:
        raise FuelWorkerError("connection is required")

    extraction_hash = _extraction_hash(output_payload)
    created_at_utc = output_payload["fetched_at_utc"]

    if response is not None:
        confidence = _normalize_confidence(response.extraction.confidence)
    else:
        confidence = _normalize_confidence(output_payload.get("confidence"))

    fuel_dock = output_payload.get("fuel_dock")
    fuel_dock_int = None
    if fuel_dock is True:
        fuel_dock_int = 1
    elif fuel_dock is False:
        fuel_dock_int = 0

    cursor = connection.cursor()
    cursor.execute(
        """
        INSERT INTO fuel_logs (
            marina_uid,
            fetched_at_utc,
            outcome_state,
            reason_tag,
            blocked_reason,
            diesel_price,
            gasoline_price,
            fuel_dock,
            last_updated,
            source_url,
            source_text,
            provenance_json,
            price_source,
            confidence,
            extraction_hash,
            created_at_utc
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            output_payload["marina_uid"],
            output_payload["fetched_at_utc"],
            output_payload["outcome_state"],
            output_payload["reason_tag"],
            output_payload.get("blocked_reason"),
            output_payload.get("diesel_price"),
            output_payload.get("gasoline_price"),
            fuel_dock_int,
            output_payload.get("last_updated"),
            output_payload.get("source_url"),
            output_payload.get("source_text"),
            json.dumps(output_payload.get("provenance"), sort_keys=True),
            _price_source(output_payload["outcome_state"], output_payload.get("source_url")),
            confidence,
            extraction_hash,
            created_at_utc,
        ),
    )
    connection.commit()

    fuel_log_id = cursor.lastrowid
    if not isinstance(fuel_log_id, int):
        raise FuelWorkerError("Failed to persist fuel_log")
    return fuel_log_id


def _get_previous_fuel_log(
    connection: sqlite3.Connection, marina_uid: str
) -> dict[str, Any] | None:
    """Get the most recent fuel log for a marina to detect price changes."""
    if connection is None:
        return None

    connection.row_factory = sqlite3.Row
    cursor = connection.cursor()
    cursor.execute(
        """
        SELECT fuel_log_id, diesel_price, gasoline_price, outcome_state
        FROM fuel_logs
        WHERE marina_uid = ?
        ORDER BY fetched_at_utc DESC
        LIMIT 1
        """,
        (marina_uid,),
    )
    row = cursor.fetchone()
    if row is None:
        return None
    return dict(row)


def _write_fuel_price_event(
    connection: sqlite3.Connection,
    marina_uid: str,
    source_marinas_id: str,
    output_payload: dict[str, Any],
    fuel_log_id: int,
) -> None:
    """Write sync event if fuel prices changed from previous log."""
    try:
        previous = _get_previous_fuel_log(connection, marina_uid)
        current_diesel = output_payload.get("diesel_price")
        current_gas = output_payload.get("gasoline_price")

        # Always write event for first-time price discovery
        if previous is None and (current_diesel is not None or current_gas is not None):
            write_sync_event(
                connection,
                marina_uid=marina_uid,
                entity_type="fuel_log",
                entity_ref=str(fuel_log_id),
                event_type="fuel_price_changed",
                reason_tag="first_price_discovery",
                after_data={
                    "diesel_price": current_diesel,
                    "gasoline_price": current_gas,
                    "source_url": output_payload.get("source_url"),
                },
                sync_dirty_before=True,
                sync_dirty_after=True,
            )
            return

        # Check if prices changed
        if previous is not None:
            prev_diesel = previous.get("diesel_price")
            prev_gas = previous.get("gasoline_price")

            diesel_changed = (current_diesel != prev_diesel) and (
                current_diesel is not None or prev_diesel is not None
            )
            gas_changed = (current_gas != prev_gas) and (
                current_gas is not None or prev_gas is not None
            )

            if diesel_changed or gas_changed:
                write_sync_event(
                    connection,
                    marina_uid=marina_uid,
                    entity_type="fuel_log",
                    entity_ref=str(fuel_log_id),
                    event_type="fuel_price_changed",
                    reason_tag="price_update_detected",
                    before_data={
                        "diesel_price": prev_diesel,
                        "gasoline_price": prev_gas,
                    },
                    after_data={
                        "diesel_price": current_diesel,
                        "gasoline_price": current_gas,
                        "source_url": output_payload.get("source_url"),
                    },
                    sync_dirty_before=True,
                    sync_dirty_after=True,
                )
    except Exception:
        # Don't fail extraction if sync event fails
        pass


def _write_fetch_blocked_event(
    connection: sqlite3.Connection,
    marina_uid: str,
    source_marinas_id: str,
    error_message: str,
) -> None:
    """Write sync event when extraction fails."""
    try:
        write_sync_event(
            connection,
            marina_uid=marina_uid,
            entity_type="marina",
            entity_ref=source_marinas_id or marina_uid,
            event_type="fetch_blocked",
            reason_tag="extraction_failed",
            after_data={"error": error_message[:200]},  # Truncate long errors
            sync_dirty_before=True,
            sync_dirty_after=True,
        )
    except Exception:
        pass


def process_pending_seeds(connection: sqlite3.Connection, batch_size: int) -> dict[str, Any]:
    if connection is None:
        raise FuelWorkerError("connection is required")
    if not isinstance(batch_size, int):
        raise FuelWorkerError("batch_size must be an int")
    if batch_size < 1:
        raise FuelWorkerError("batch_size must be >= 1")

    pending_seeds = read_pending_seeds(connection, batch_size)

    processed_count = 0
    success_count = 0
    failed_count = 0
    fuel_log_ids: list[int] = []
    failed_seed_ids: list[int] = []

    for seed in pending_seeds:
        validate_seed_payload(seed)

        seed_id = seed.get("seed_id")
        if not isinstance(seed_id, int):
            raise FuelWorkerError("seed_id must be present and int")

        mark_seed_status(connection, seed_id, "processing")
        processed_count += 1

        marina_uid = _as_non_empty_string(seed.get("marina_uid"), "marina_uid")
        source_marinas_id = seed.get("source_marinas_id") or ""

        try:
            dockwa_result = _try_dockwa_extraction(seed, 45)
            if dockwa_result is not None:
                output_payload = _build_output_from_dockwa(seed, dockwa_result)
                fuel_log_id = _write_fuel_log(connection, output_payload, None)
                _write_fuel_price_event(connection, marina_uid, source_marinas_id, output_payload, fuel_log_id)
                mark_seed_status(connection, seed_id, "done")
                success_count += 1
                fuel_log_ids.append(fuel_log_id)
                continue

            request = _to_extract_request(seed)
            response = extract_fuel(request)
            output_payload = _build_output_payload(seed, response)
            fuel_log_id = _write_fuel_log(connection, output_payload, response)
            _write_fuel_price_event(connection, marina_uid, source_marinas_id, output_payload, fuel_log_id)
            mark_seed_status(connection, seed_id, "done")
            success_count += 1
            fuel_log_ids.append(fuel_log_id)
        except Exception as exc:
            mark_seed_status(connection, seed_id, "failed")
            failed_count += 1
            failed_seed_ids.append(seed_id)
            _write_fetch_blocked_event(connection, marina_uid, source_marinas_id, str(exc))

    return {
        "pending_count": len(pending_seeds),
        "processed_count": processed_count,
        "success_count": success_count,
        "failed_count": failed_count,
        "fuel_log_ids": fuel_log_ids,
        "failed_seed_ids": failed_seed_ids,
    }


def process_pending_seeds_in_db(db_path: str, batch_size: int) -> dict[str, Any]:
    if not isinstance(db_path, str) or not db_path.strip():
        raise FuelWorkerError("db_path must be a non-empty string")
    if not isinstance(batch_size, int):
        raise FuelWorkerError("batch_size must be an int")
    if batch_size < 1:
        raise FuelWorkerError("batch_size must be >= 1")

    db_path_obj = Path(db_path)
    if not db_path_obj.exists():
        raise FuelWorkerError(f"Database file not found: {db_path_obj}")

    connection = sqlite3.connect(str(db_path_obj))
    try:
        return process_pending_seeds(connection, batch_size)
    finally:
        connection.close()
