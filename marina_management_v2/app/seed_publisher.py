from __future__ import annotations

import sqlite3
from typing import Any


class SeedPublisherError(Exception):
    pass


def _validate_seed_row(seed_row: dict[str, Any]) -> None:
    if not isinstance(seed_row, dict):
        raise SeedPublisherError("seed_row must be a dict")

    required_fields = (
        "marina_uid",
        "name",
        "lat",
        "lon",
        "fuel_candidate",
        "seed_reason",
        "seeded_at_utc",
        "queue_status",
    )

    for field in required_fields:
        if field not in seed_row:
            raise SeedPublisherError(f"Missing required field: {field}")

    marina_uid = seed_row.get("marina_uid")
    if not isinstance(marina_uid, str) or not marina_uid.strip():
        raise SeedPublisherError("marina_uid must be a non-empty string")

    name = seed_row.get("name")
    if not isinstance(name, str) or not name.strip():
        raise SeedPublisherError("name must be a non-empty string")

    lat = seed_row.get("lat")
    lon = seed_row.get("lon")
    if not isinstance(lat, (float, int)):
        raise SeedPublisherError("lat must be numeric")
    if not isinstance(lon, (float, int)):
        raise SeedPublisherError("lon must be numeric")

    fuel_candidate = seed_row.get("fuel_candidate")
    if fuel_candidate not in (0, 1):
        raise SeedPublisherError("fuel_candidate must be 0 or 1")

    seed_reason = seed_row.get("seed_reason")
    if not isinstance(seed_reason, str) or not seed_reason.strip():
        raise SeedPublisherError("seed_reason must be a non-empty string")

    seeded_at_utc = seed_row.get("seeded_at_utc")
    if not isinstance(seeded_at_utc, str) or not seeded_at_utc.strip():
        raise SeedPublisherError("seeded_at_utc must be a non-empty string")

    queue_status = seed_row.get("queue_status")
    if queue_status not in ("pending", "processing", "done", "failed"):
        raise SeedPublisherError("queue_status must be one of pending|processing|done|failed")

    dockwa_url = seed_row.get("dockwa_url")
    marinas_url = seed_row.get("marinas_url")
    website_url = seed_row.get("website_url")

    has_dockwa = isinstance(dockwa_url, str) and bool(dockwa_url.strip())
    has_marinas = isinstance(marinas_url, str) and bool(marinas_url.strip())
    has_website = isinstance(website_url, str) and bool(website_url.strip())

    if not has_dockwa and not has_marinas and not has_website:
        raise SeedPublisherError("At least one source URL is required: dockwa_url, marinas_url, or website_url")


def publish_seed_row(connection: sqlite3.Connection, seed_row: dict[str, Any]) -> int:
    if connection is None:
        raise SeedPublisherError("connection is required")

    _validate_seed_row(seed_row)

    cursor = connection.cursor()
    cursor.execute(
        """
        INSERT INTO fuel_seed_queue (
            marina_uid,
            name,
            lat,
            lon,
            website_url,
            marinas_url,
            dockwa_url,
            fuel_candidate,
            seed_reason,
            seeded_at_utc,
            source_marinas_id,
            dockwa_destination_id,
            last_fuel_checked_at_utc,
            priority_hint,
            queue_status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            seed_row.get("marina_uid"),
            seed_row.get("name"),
            float(seed_row.get("lat")),
            float(seed_row.get("lon")),
            seed_row.get("website_url"),
            seed_row.get("marinas_url"),
            seed_row.get("dockwa_url"),
            seed_row.get("fuel_candidate"),
            seed_row.get("seed_reason"),
            seed_row.get("seeded_at_utc"),
            seed_row.get("source_marinas_id"),
            seed_row.get("dockwa_destination_id"),
            seed_row.get("last_fuel_checked_at_utc"),
            seed_row.get("priority_hint"),
            seed_row.get("queue_status"),
        ),
    )
    connection.commit()

    seed_id = cursor.lastrowid
    if not isinstance(seed_id, int):
        raise SeedPublisherError("Failed to persist seed row")

    return seed_id
