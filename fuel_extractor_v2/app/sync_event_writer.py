from __future__ import annotations

import hashlib
import json
import sqlite3
from datetime import datetime, timezone
from typing import Any


class SyncEventWriterError(Exception):
    pass


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _compute_hash(data: dict[str, Any]) -> str:
    """Compute SHA256 hash of canonical JSON representation."""
    canonical = json.dumps(data, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def write_sync_event(
    connection: sqlite3.Connection,
    *,
    marina_uid: str,
    entity_type: str,
    entity_ref: str,
    event_type: str,
    reason_tag: str,
    before_data: dict[str, Any] | None = None,
    after_data: dict[str, Any] | None = None,
    sync_dirty_before: bool = False,
    sync_dirty_after: bool = True,
    master_status_code: int | None = None,
    master_acknowledged: bool = False,
) -> int:
    """Write a sync event to the audit log.

    Args:
        connection: SQLite connection
        marina_uid: UUID of the marina
        entity_type: 'marina' or 'fuel_log'
        entity_ref: Reference ID (e.g., fuel_log_id or source_marinas_id)
        event_type: One of the valid event types
        reason_tag: Human-readable reason
        before_data: Optional state before change (for hashing)
        after_data: Optional state after change (for hashing)
        sync_dirty_before: Sync state before this event
        sync_dirty_after: Sync state after this event
        master_status_code: HTTP response from Master API if acknowledged
        master_acknowledged: Whether Master API confirmed receipt

    Returns:
        sync_event_id of the inserted row
    """
    if connection is None:
        raise SyncEventWriterError("connection is required")

    valid_event_types = {
        "new_discovery",
        "rebrand_detected",
        "marked_unverified",
        "dockwa_link_added",
        "fuel_price_changed",
        "fetch_blocked",
    }
    if event_type not in valid_event_types:
        raise SyncEventWriterError(f"Invalid event_type: {event_type}")

    if entity_type not in ("marina", "fuel_log"):
        raise SyncEventWriterError(f"Invalid entity_type: {entity_type}")

    before_hash = _compute_hash(before_data) if before_data else None
    after_hash = _compute_hash(after_data) if after_data else None

    cursor = connection.cursor()
    cursor.execute(
        """
        INSERT INTO sync_events (
            marina_uid,
            entity_type,
            entity_ref,
            event_type,
            reason_tag,
            before_hash,
            after_hash,
            sync_dirty_before,
            sync_dirty_after,
            master_status_code,
            master_acknowledged,
            occurred_at_utc,
            processed_at_utc
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            marina_uid,
            entity_type,
            entity_ref,
            event_type,
            reason_tag,
            before_hash,
            after_hash,
            1 if sync_dirty_before else 0,
            1 if sync_dirty_after else 0,
            master_status_code,
            1 if master_acknowledged else 0,
            _utc_now_iso(),
            None,
        ),
    )

    sync_event_id = cursor.lastrowid
    if not isinstance(sync_event_id, int):
        raise SyncEventWriterError("Failed to get sync_event_id")

    connection.commit()
    return sync_event_id


def mark_sync_event_acknowledged(
    connection: sqlite3.Connection,
    sync_event_id: int,
    status_code: int,
) -> None:
    """Mark a sync event as acknowledged by Master API."""
    if connection is None:
        raise SyncEventWriterError("connection is required")

    cursor = connection.cursor()
    cursor.execute(
        """
        UPDATE sync_events
        SET master_acknowledged = 1,
            master_status_code = ?,
            processed_at_utc = ?
        WHERE sync_event_id = ?
        """,
        (status_code, _utc_now_iso(), sync_event_id),
    )

    if cursor.rowcount != 1:
        connection.rollback()
        raise SyncEventWriterError(f"Expected to update 1 row for sync_event_id={sync_event_id}")

    connection.commit()
