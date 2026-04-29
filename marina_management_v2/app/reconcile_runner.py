from __future__ import annotations

import json
import sqlite3
import uuid
from datetime import datetime, timezone
from typing import Any

from fuel_extractor_v2.app.sync_event_writer import write_sync_event


class ReconcileRunnerError(Exception):
    pass


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _get_marinas_columns(connection: sqlite3.Connection) -> set[str]:
    if connection is None:
        raise ReconcileRunnerError("connection is required")

    rows = connection.execute("PRAGMA table_info(marinas)").fetchall()
    columns: set[str] = set()
    for row in rows:
        if len(row) < 2:
            continue
        column_name = row[1]
        if isinstance(column_name, str) and column_name.strip():
            columns.add(column_name.strip())

    if not columns:
        raise ReconcileRunnerError("marinas table has no readable columns")

    return columns


def _required_columns_exist(columns: set[str], required_columns: tuple[str, ...]) -> None:
    for column_name in required_columns:
        if column_name not in columns:
            raise ReconcileRunnerError(f"marinas column is required but missing: {column_name}")


def _name_column(columns: set[str]) -> str:
    if "primary_name" in columns:
        return "primary_name"
    if "name" in columns:
        return "name"
    raise ReconcileRunnerError("marinas must include either primary_name or name")


def _is_non_empty_string(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())


def _is_numeric_value(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _row_value(existing_row: sqlite3.Row | None, column_name: str) -> Any:
    if existing_row is None:
        return None
    if not isinstance(column_name, str) or not column_name.strip():
        return None

    row_keys = existing_row.keys()
    if not isinstance(row_keys, list):
        return None
    if column_name not in row_keys:
        return None

    return existing_row[column_name]


def _derive_fuel_candidacy(discovered_record: dict[str, Any], existing_row: sqlite3.Row | None) -> tuple[int, str]:
    if existing_row is not None:
        existing_fuel_candidate = _row_value(existing_row, "fuel_candidate")
        if existing_fuel_candidate == 1:
            existing_seed_reason = _row_value(existing_row, "seed_reason")
            if _is_non_empty_string(existing_seed_reason):
                return 1, str(existing_seed_reason).strip()
            return 1, "existing_fuel_candidate"

    diesel_amenity = discovered_record.get("diesel_amenity")
    gas_amenity = discovered_record.get("gas_amenity")
    diesel_price = discovered_record.get("diesel_price")
    gas_reg_price = discovered_record.get("gas_reg_price")
    dockwa_url = discovered_record.get("dockwa_url")

    has_diesel_amenity = diesel_amenity is True
    has_gas_amenity = gas_amenity is True
    has_price_signal = _is_numeric_value(diesel_price) or _is_numeric_value(gas_reg_price)

    existing_has_dockwa = False
    if existing_row is not None:
        existing_dockwa_url = _row_value(existing_row, "dockwa_url")
        existing_has_dockwa = _is_non_empty_string(existing_dockwa_url)

    discovered_has_dockwa = _is_non_empty_string(dockwa_url)
    has_dockwa_link = existing_has_dockwa or discovered_has_dockwa

    if has_price_signal:
        return 1, "tilequery_price_signal"
    if has_diesel_amenity or has_gas_amenity:
        return 1, "tilequery_fuel_amenity"
    if has_dockwa_link:
        return 1, "known_dockwa_link"

    return 0, "discovery_scan"


def _existing_row_by_source_marinas_id(connection: sqlite3.Connection, source_marinas_id: str) -> sqlite3.Row | None:
    connection.row_factory = sqlite3.Row
    cursor = connection.cursor()
    cursor.execute(
        "SELECT rowid, * FROM marinas WHERE source_marinas_id = ? LIMIT 1",
        (source_marinas_id,),
    )
    return cursor.fetchone()


def _existing_row_by_name_and_coordinates(
    connection: sqlite3.Connection,
    name_column_name: str,
    name: str,
    lat: float,
    lon: float,
) -> sqlite3.Row | None:
    connection.row_factory = sqlite3.Row
    cursor = connection.cursor()
    cursor.execute(
        f"""
        SELECT rowid, *
        FROM marinas
        WHERE {name_column_name} = ?
          AND ABS(lat - ?) <= 0.0001
          AND ABS(lon - ?) <= 0.0001
        LIMIT 1
        """,
        (name, lat, lon),
    )
    return cursor.fetchone()


def _existing_row_by_marinas_url(connection: sqlite3.Connection, marinas_url: str) -> sqlite3.Row | None:
    connection.row_factory = sqlite3.Row
    cursor = connection.cursor()
    cursor.execute(
        "SELECT rowid, * FROM marinas WHERE marinas_url = ? LIMIT 1",
        (marinas_url,),
    )
    return cursor.fetchone()


def _build_update_fields(
    columns: set[str],
    discovered_record: dict[str, Any],
    discovered_at_utc: str,
    name_column_name: str,
    existing_row: sqlite3.Row,
) -> dict[str, Any]:
    update_fields: dict[str, Any] = {}

    source_marinas_id = discovered_record.get("source_marinas_id")
    name = discovered_record.get("name")
    marinas_url = discovered_record.get("marinas_url")

    if not isinstance(source_marinas_id, str) or not source_marinas_id.strip():
        raise ReconcileRunnerError("source_marinas_id is required")
    if not isinstance(name, str) or not name.strip():
        raise ReconcileRunnerError("name is required")
    has_marinas_url = isinstance(marinas_url, str) and bool(marinas_url.strip())

    if "source_marinas_id" in columns:
        update_fields["source_marinas_id"] = source_marinas_id.strip()
    if name_column_name in columns:
        update_fields[name_column_name] = name.strip()
    if "marinas_url" in columns and has_marinas_url:
        update_fields["marinas_url"] = marinas_url.strip()
    if "last_seen_on_web_utc" in columns:
        update_fields["last_seen_on_web_utc"] = discovered_at_utc
    if "verification_state" in columns:
        update_fields["verification_state"] = "pending_review"
    if "missing_from_web_count" in columns:
        update_fields["missing_from_web_count"] = 0
    if "updated_at_utc" in columns:
        update_fields["updated_at_utc"] = discovered_at_utc
    if "sync_dirty" in columns:
        update_fields["sync_dirty"] = 1

    fuel_candidate_value, seed_reason_value = _derive_fuel_candidacy(discovered_record, existing_row)
    if "fuel_candidate" in columns:
        update_fields["fuel_candidate"] = fuel_candidate_value
    if "seed_reason" in columns:
        update_fields["seed_reason"] = seed_reason_value

    if "lat" in columns and "lat" in discovered_record:
        update_fields["lat"] = discovered_record["lat"]
    if "lon" in columns and "lon" in discovered_record:
        update_fields["lon"] = discovered_record["lon"]

    return update_fields


def _insert_new_marina(
    connection: sqlite3.Connection,
    columns: set[str],
    discovered_record: dict[str, Any],
    discovered_at_utc: str,
    name_column_name: str,
) -> str:
    marina_uid_value = str(uuid.uuid4())

    source_marinas_id = discovered_record.get("source_marinas_id")
    name = discovered_record.get("name")
    marinas_url = discovered_record.get("marinas_url")
    has_marinas_url = isinstance(marinas_url, str) and bool(marinas_url.strip())
    lat = discovered_record.get("lat")
    lon = discovered_record.get("lon")

    if not isinstance(source_marinas_id, str) or not source_marinas_id.strip():
        raise ReconcileRunnerError("source_marinas_id is required")
    if not isinstance(name, str) or not name.strip():
        raise ReconcileRunnerError("name is required")
    if not isinstance(lat, (float, int)):
        raise ReconcileRunnerError("lat is required for new marina inserts")
    if not isinstance(lon, (float, int)):
        raise ReconcileRunnerError("lon is required for new marina inserts")

    insert_fields: dict[str, Any] = {
        "marina_uid": marina_uid_value,
        name_column_name: name.strip(),
        "lat": float(lat),
        "lon": float(lon),
        "source_marinas_id": source_marinas_id.strip(),
        "created_at_utc": discovered_at_utc,
        "updated_at_utc": discovered_at_utc,
    }

    if has_marinas_url:
        insert_fields["marinas_url"] = marinas_url.strip()

    fuel_candidate_value, seed_reason_value = _derive_fuel_candidacy(discovered_record, None)

    optional_values: dict[str, Any] = {
        "aliases_json": json.dumps([]),
        "verification_state": "pending_review",
        "missing_from_web_count": 0,
        "fuel_candidate": fuel_candidate_value,
        "seed_reason": seed_reason_value,
        "last_seen_on_web_utc": discovered_at_utc,
        "sync_dirty": 1,
    }

    for optional_column, optional_value in optional_values.items():
        if optional_column in columns:
            insert_fields[optional_column] = optional_value

    insert_column_names = list(insert_fields.keys())
    placeholders = ", ".join(["?" for _ in insert_column_names])
    insert_sql = f"INSERT INTO marinas ({', '.join(insert_column_names)}) VALUES ({placeholders})"
    insert_values = [insert_fields[column_name] for column_name in insert_column_names]

    connection.execute(insert_sql, insert_values)

    # Write sync event for new discovery
    try:
        write_sync_event(
            connection,
            marina_uid=marina_uid_value,
            entity_type="marina",
            entity_ref=source_marinas_id.strip(),
            event_type="new_discovery",
            reason_tag=seed_reason_value if seed_reason_value else "discovery_scan",
            after_data={"name": name.strip(), "lat": float(lat), "lon": float(lon), "marinas_url": marinas_url},
            sync_dirty_before=False,
            sync_dirty_after=True,
        )
    except Exception:
        # Don't fail the insert if sync event fails
        pass

    return marina_uid_value


def _can_insert_new_marina(discovered_record: dict[str, Any]) -> bool:
    lat = discovered_record.get("lat")
    lon = discovered_record.get("lon")
    return isinstance(lat, (float, int)) and isinstance(lon, (float, int))


def _update_existing_marina(
    connection: sqlite3.Connection,
    rowid_value: int,
    update_fields: dict[str, Any],
) -> None:
    if not update_fields:
        return

    set_clause_parts: list[str] = []
    set_values: list[Any] = []
    for field_name, field_value in update_fields.items():
        set_clause_parts.append(f"{field_name} = ?")
        set_values.append(field_value)

    # Always set sync_dirty = 1 on update to trigger VPS sync
    set_clause_parts.append("sync_dirty = ?")
    set_values.append(1)

    set_values.append(rowid_value)
    sql = f"UPDATE marinas SET {', '.join(set_clause_parts)} WHERE rowid = ?"
    cursor = connection.execute(sql, set_values)
    if cursor.rowcount != 1:
        raise ReconcileRunnerError(f"expected to update 1 row for rowid={rowid_value}, updated {cursor.rowcount}")


def reconcile_discovered_records(
    connection: sqlite3.Connection,
    discovered_records: list[dict[str, Any]],
    reconciled_at_utc: str,
) -> dict[str, int]:
    if connection is None:
        raise ReconcileRunnerError("connection is required")
    if not isinstance(discovered_records, list):
        raise ReconcileRunnerError("discovered_records must be a list")
    if not isinstance(reconciled_at_utc, str) or not reconciled_at_utc.strip():
        raise ReconcileRunnerError("reconciled_at_utc is required")

    columns = _get_marinas_columns(connection)
    _required_columns_exist(columns, ("marina_uid", "lat", "lon", "created_at_utc", "updated_at_utc"))
    name_column_name = _name_column(columns)

    inserted_count = 0
    updated_count = 0
    skipped_missing_coordinates_count = 0

    for discovered_record in discovered_records:
        if not isinstance(discovered_record, dict):
            raise ReconcileRunnerError("each discovered record must be a dict")

        source_marinas_id = discovered_record.get("source_marinas_id")
        marinas_url = discovered_record.get("marinas_url")
        name = discovered_record.get("name")
        lat = discovered_record.get("lat")
        lon = discovered_record.get("lon")

        if not isinstance(source_marinas_id, str) or not source_marinas_id.strip():
            raise ReconcileRunnerError("source_marinas_id is required")
        has_marinas_url = isinstance(marinas_url, str) and bool(marinas_url.strip())

        existing_row = None
        if "source_marinas_id" in columns:
            existing_row = _existing_row_by_source_marinas_id(connection, source_marinas_id.strip())

        if existing_row is None and "marinas_url" in columns and has_marinas_url:
            existing_row = _existing_row_by_marinas_url(connection, marinas_url.strip())

        if existing_row is None:
            can_match_by_name_coordinates = (
                isinstance(name, str)
                and bool(name.strip())
                and isinstance(lat, (int, float))
                and isinstance(lon, (int, float))
            )
            if can_match_by_name_coordinates:
                existing_row = _existing_row_by_name_and_coordinates(
                    connection=connection,
                    name_column_name=name_column_name,
                    name=name.strip(),
                    lat=float(lat),
                    lon=float(lon),
                )

        if existing_row is None:
            if not _can_insert_new_marina(discovered_record):
                skipped_missing_coordinates_count += 1
                continue

            _insert_new_marina(
                connection=connection,
                columns=columns,
                discovered_record=discovered_record,
                discovered_at_utc=reconciled_at_utc,
                name_column_name=name_column_name,
            )
            inserted_count += 1
            continue

        rowid_value = existing_row["rowid"]
        if not isinstance(rowid_value, int):
            raise ReconcileRunnerError("existing rowid is invalid")

        update_fields = _build_update_fields(
            columns=columns,
            discovered_record=discovered_record,
            discovered_at_utc=reconciled_at_utc,
            name_column_name=name_column_name,
            existing_row=existing_row,
        )
        _update_existing_marina(connection, rowid_value, update_fields)
        updated_count += 1

    connection.commit()
    return {
        "inserted": inserted_count,
        "updated": updated_count,
        "skipped_missing_coordinates": skipped_missing_coordinates_count,
        "total": len(discovered_records),
    }


def reconcile_now(connection: sqlite3.Connection, discovered_records: list[dict[str, Any]]) -> dict[str, int]:
    return reconcile_discovered_records(
        connection=connection,
        discovered_records=discovered_records,
        reconciled_at_utc=_utc_now_iso(),
    )
