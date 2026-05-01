from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from fuel_extractor.app.marinas_discovery import discover_marinas_by_bounds, discover_marinas_by_query


class DiscoveryRunnerError(Exception):
    pass


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _normalize_discovery_record(record: dict[str, Any], discovered_at_utc: str) -> dict[str, Any]:
    if not isinstance(record, dict):
        raise DiscoveryRunnerError("discovery record must be a dict")

    source_marinas_id = record.get("marina_id")
    if not isinstance(source_marinas_id, str) or not source_marinas_id.strip():
        raise DiscoveryRunnerError("discovery record missing marina_id")

    name = record.get("name")
    if not isinstance(name, str) or not name.strip():
        raise DiscoveryRunnerError("discovery record missing name")

    marinas_url = record.get("marinas_url")
    website = record.get("website")

    normalized: dict[str, Any] = {
        "source_marinas_id": source_marinas_id.strip(),
        "name": name.strip(),
        "discovered_at_utc": discovered_at_utc,
    }

    if isinstance(marinas_url, str) and marinas_url.strip():
        normalized["marinas_url"] = marinas_url.strip()

    if isinstance(website, str) and website.strip():
        normalized["website"] = website.strip()

    lat = record.get("lat")
    lon = record.get("lon")
    if isinstance(lat, (float, int)) and isinstance(lon, (float, int)):
        normalized["lat"] = float(lat)
        normalized["lon"] = float(lon)

    diesel_amenity = record.get("diesel_amenity")
    if isinstance(diesel_amenity, bool):
        normalized["diesel_amenity"] = diesel_amenity

    gas_amenity = record.get("gas_amenity")
    if isinstance(gas_amenity, bool):
        normalized["gas_amenity"] = gas_amenity

    diesel_price = record.get("diesel_price")
    if isinstance(diesel_price, (float, int)):
        normalized["diesel_price"] = float(diesel_price)

    gas_reg_price = record.get("gas_reg_price")
    if isinstance(gas_reg_price, (float, int)):
        normalized["gas_reg_price"] = float(gas_reg_price)

    return normalized


def discover_by_query(
    location_query: str,
    timeout_seconds: int,
    scroll_cycles: int,
    discovered_at_utc: str,
) -> list[dict[str, Any]]:
    if not isinstance(location_query, str) or not location_query.strip():
        raise DiscoveryRunnerError("location_query is required")
    if not isinstance(discovered_at_utc, str) or not discovered_at_utc.strip():
        raise DiscoveryRunnerError("discovered_at_utc is required")

    raw_records = discover_marinas_by_query(location_query.strip(), timeout_seconds, scroll_cycles)
    normalized_records: list[dict[str, Any]] = []
    for raw_record in raw_records:
        normalized_records.append(_normalize_discovery_record(raw_record, discovered_at_utc.strip()))
    return normalized_records


def discover_by_bounds(
    min_lat: float,
    max_lat: float,
    min_lon: float,
    max_lon: float,
    timeout_seconds: int,
    scroll_cycles: int,
    discovered_at_utc: str,
) -> list[dict[str, Any]]:
    if not isinstance(discovered_at_utc, str) or not discovered_at_utc.strip():
        raise DiscoveryRunnerError("discovered_at_utc is required")

    raw_records = discover_marinas_by_bounds(
        min_lat=min_lat,
        max_lat=max_lat,
        min_lon=min_lon,
        max_lon=max_lon,
        timeout_seconds=timeout_seconds,
        scroll_cycles=scroll_cycles,
    )

    normalized_records: list[dict[str, Any]] = []
    for raw_record in raw_records:
        normalized_records.append(_normalize_discovery_record(raw_record, discovered_at_utc.strip()))
    return normalized_records


def discover_query_now(location_query: str, timeout_seconds: int, scroll_cycles: int) -> list[dict[str, Any]]:
    return discover_by_query(
        location_query=location_query,
        timeout_seconds=timeout_seconds,
        scroll_cycles=scroll_cycles,
        discovered_at_utc=_utc_now_iso(),
    )


def discover_bounds_now(
    min_lat: float,
    max_lat: float,
    min_lon: float,
    max_lon: float,
    timeout_seconds: int,
    scroll_cycles: int,
) -> list[dict[str, Any]]:
    return discover_by_bounds(
        min_lat=min_lat,
        max_lat=max_lat,
        min_lon=min_lon,
        max_lon=max_lon,
        timeout_seconds=timeout_seconds,
        scroll_cycles=scroll_cycles,
        discovered_at_utc=_utc_now_iso(),
    )
