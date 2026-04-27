from __future__ import annotations

import sqlite3
from typing import Any


class SeedConsumerError(Exception):
    pass


def read_pending_seeds(connection: sqlite3.Connection, batch_size: int) -> list[dict[str, Any]]:
    if connection is None:
        raise SeedConsumerError("connection is required")
    if not isinstance(batch_size, int):
        raise SeedConsumerError("batch_size must be an int")
    if batch_size < 1:
        raise SeedConsumerError("batch_size must be >= 1")

    connection.row_factory = sqlite3.Row
    cursor = connection.cursor()
    cursor.execute(
        """
        SELECT
            seed_id,
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
        FROM fuel_seed_queue
        WHERE queue_status = 'pending'
        ORDER BY seeded_at_utc
        LIMIT ?
        """,
        (batch_size,),
    )

    rows = cursor.fetchall()
    result: list[dict[str, Any]] = []
    for row in rows:
        result.append(dict(row))
    return result


def mark_seed_status(connection: sqlite3.Connection, seed_id: int, queue_status: str) -> None:
    if connection is None:
        raise SeedConsumerError("connection is required")
    if not isinstance(seed_id, int):
        raise SeedConsumerError("seed_id must be an int")
    if queue_status not in ("pending", "processing", "done", "failed"):
        raise SeedConsumerError("queue_status must be one of pending|processing|done|failed")

    cursor = connection.cursor()
    cursor.execute(
        "UPDATE fuel_seed_queue SET queue_status = ? WHERE seed_id = ?",
        (queue_status, seed_id),
    )

    if cursor.rowcount != 1:
        connection.rollback()
        raise SeedConsumerError(f"Expected to update 1 row for seed_id={seed_id}, updated {cursor.rowcount}")

    connection.commit()
