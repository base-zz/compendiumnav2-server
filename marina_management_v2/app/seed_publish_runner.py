from __future__ import annotations

import sqlite3
from datetime import datetime, timezone
from typing import Any

from .seed_publisher import publish_seed_row


class SeedPublishRunnerError(Exception):
    pass


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _get_marinas_columns(connection: sqlite3.Connection) -> set[str]:
    if connection is None:
        raise SeedPublishRunnerError("connection is required")

    rows = connection.execute("PRAGMA table_info(marinas)").fetchall()
    columns: set[str] = set()
    for row in rows:
        if len(row) < 2:
            continue
        column_name = row[1]
        if isinstance(column_name, str) and column_name.strip():
            columns.add(column_name.strip())

    if not columns:
        raise SeedPublishRunnerError("marinas table has no readable columns")

    return columns


def _name_column(columns: set[str]) -> str:
    if "primary_name" in columns:
        return "primary_name"
    if "name" in columns:
        return "name"
    raise SeedPublishRunnerError("marinas must include either primary_name or name")


def _list_candidate_rows(connection: sqlite3.Connection, max_rows: int) -> list[dict[str, Any]]:
    if not isinstance(max_rows, int):
        raise SeedPublishRunnerError("max_rows must be an int")
    if max_rows < 1:
        raise SeedPublishRunnerError("max_rows must be >= 1")

    columns = _get_marinas_columns(connection)
    required_columns = (
        "marina_uid",
        "lat",
        "lon",
        "fuel_candidate",
        "seed_reason",
        "last_fuel_checked_at_utc",
    )
    for required_column in required_columns:
        if required_column not in columns:
            raise SeedPublishRunnerError(f"marinas column is required but missing: {required_column}")

    name_column_name = _name_column(columns)

    connection.row_factory = sqlite3.Row
    cursor = connection.cursor()
    cursor.execute(
        f"""
        SELECT
            m.marina_uid,
            m.{name_column_name} AS name,
            m.lat,
            m.lon,
            m.website_url,
            m.marinas_url,
            m.dockwa_url,
            m.fuel_candidate,
            m.seed_reason,
            m.source_marinas_id,
            m.dockwa_destination_id,
            m.last_fuel_checked_at_utc
        FROM marinas m
        WHERE
            m.fuel_candidate = 1
            AND (
                (m.dockwa_url IS NOT NULL AND TRIM(m.dockwa_url) != '')
                OR (
                    m.marinas_url IS NOT NULL
                    AND TRIM(m.marinas_url) != ''
                    AND LOWER(m.marinas_url) NOT LIKE 'https://marinas.com/map/%'
                )
                OR (m.website_url IS NOT NULL AND TRIM(m.website_url) != '')
            )
            AND NOT EXISTS (
                SELECT 1
                FROM fuel_seed_queue q
                WHERE q.marina_uid = m.marina_uid
                  AND q.queue_status IN ('pending', 'processing')
            )
        ORDER BY m.updated_at_utc DESC
        LIMIT ?
        """,
        (max_rows,),
    )

    rows = cursor.fetchall()
    candidates: list[dict[str, Any]] = []
    for row in rows:
        candidates.append(dict(row))
    return candidates


def publish_candidates_to_seed_queue(
    connection: sqlite3.Connection,
    max_rows: int,
    seeded_at_utc: str,
) -> dict[str, Any]:
    if connection is None:
        raise SeedPublishRunnerError("connection is required")
    if not isinstance(seeded_at_utc, str) or not seeded_at_utc.strip():
        raise SeedPublishRunnerError("seeded_at_utc is required")

    candidates = _list_candidate_rows(connection, max_rows)

    published_seed_ids: list[int] = []
    for candidate in candidates:
        marina_uid = candidate.get("marina_uid")
        name = candidate.get("name")
        lat = candidate.get("lat")
        lon = candidate.get("lon")
        fuel_candidate = candidate.get("fuel_candidate")

        if not isinstance(marina_uid, str) or not marina_uid.strip():
            raise SeedPublishRunnerError("candidate marina_uid is missing")
        if not isinstance(name, str) or not name.strip():
            raise SeedPublishRunnerError(f"candidate name is missing for marina_uid={marina_uid}")
        if not isinstance(lat, (float, int)):
            raise SeedPublishRunnerError(f"candidate lat is missing for marina_uid={marina_uid}")
        if not isinstance(lon, (float, int)):
            raise SeedPublishRunnerError(f"candidate lon is missing for marina_uid={marina_uid}")
        if fuel_candidate not in (0, 1):
            raise SeedPublishRunnerError(f"candidate fuel_candidate invalid for marina_uid={marina_uid}")

        seed_reason = candidate.get("seed_reason")
        if not isinstance(seed_reason, str) or not seed_reason.strip():
            raise SeedPublishRunnerError(f"candidate seed_reason is missing for marina_uid={marina_uid}")

        seed_row = {
            "marina_uid": marina_uid,
            "name": name,
            "lat": float(lat),
            "lon": float(lon),
            "website_url": candidate.get("website_url"),
            "marinas_url": candidate.get("marinas_url"),
            "dockwa_url": candidate.get("dockwa_url"),
            "fuel_candidate": fuel_candidate,
            "seed_reason": seed_reason,
            "seeded_at_utc": seeded_at_utc,
            "source_marinas_id": candidate.get("source_marinas_id"),
            "dockwa_destination_id": candidate.get("dockwa_destination_id"),
            "last_fuel_checked_at_utc": candidate.get("last_fuel_checked_at_utc"),
            "priority_hint": "normal",
            "queue_status": "pending",
        }

        seed_id = publish_seed_row(connection, seed_row)
        published_seed_ids.append(seed_id)

    return {
        "candidate_count": len(candidates),
        "published_count": len(published_seed_ids),
        "seed_ids": published_seed_ids,
    }


def publish_candidates_now(connection: sqlite3.Connection, max_rows: int) -> dict[str, Any]:
    return publish_candidates_to_seed_queue(
        connection=connection,
        max_rows=max_rows,
        seeded_at_utc=_utc_now_iso(),
    )
