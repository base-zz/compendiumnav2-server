from __future__ import annotations

import json
import sqlite3
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
if not REPO_ROOT.exists():
    raise RuntimeError(f"Repo root not found: {REPO_ROOT}")

repo_root_str = str(REPO_ROOT)
if repo_root_str not in sys.path:
    sys.path.insert(0, repo_root_str)

from fuel_extractor_v2.app.contracts import validate_seed_payload
from fuel_extractor_v2.app.seed_consumer import mark_seed_status, read_pending_seeds
from marina_management_v2.app.seed_publisher import publish_seed_row


def run_smoke_handoff() -> dict[str, object]:
    schema_path = REPO_ROOT / "fuel_extractor_v2" / "PHASE_1_SCHEMA.sql"

    if not schema_path.exists():
        raise RuntimeError(f"Schema file not found: {schema_path}")

    connection = sqlite3.connect(":memory:")

    try:
        schema_sql = schema_path.read_text(encoding="utf-8")
        connection.executescript(schema_sql)

        marina_uid = "8d3f8b8c-5b17-4f9d-9f7a-1f6f1f7782aa"
        created_at_utc = "2026-04-28T00:00:00Z"

        connection.execute(
            """
            INSERT INTO marinas (
                marina_uid,
                primary_name,
                lat,
                lon,
                website_url,
                marinas_url,
                dockwa_url,
                source_marinas_id,
                dockwa_destination_id,
                aliases_json,
                verification_state,
                missing_from_web_count,
                fuel_candidate,
                seed_reason,
                last_seen_on_web_utc,
                features_last_checked_at_utc,
                last_fuel_checked_at_utc,
                sync_dirty,
                created_at_utc,
                updated_at_utc
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                marina_uid,
                "Port LaBelle Marina",
                26.7606,
                -81.4376,
                "https://www.portlabellemarina.com",
                "https://marinas.com/marinas/d9cj3j-port-labelle-marina",
                "https://dockwa.com/explore/destination/d9cj3j-port-labelle-marina",
                "d9cj3j",
                "d9cj3j",
                json.dumps([]),
                "verified",
                0,
                1,
                "known_dockwa",
                created_at_utc,
                created_at_utc,
                created_at_utc,
                0,
                created_at_utc,
                created_at_utc,
            ),
        )
        connection.commit()

        seed_row = {
            "marina_uid": marina_uid,
            "name": "Port LaBelle Marina",
            "lat": 26.7606,
            "lon": -81.4376,
            "website_url": "https://www.portlabellemarina.com",
            "marinas_url": "https://marinas.com/marinas/d9cj3j-port-labelle-marina",
            "dockwa_url": "https://dockwa.com/explore/destination/d9cj3j-port-labelle-marina",
            "fuel_candidate": 1,
            "seed_reason": "known_dockwa",
            "seeded_at_utc": "2026-04-28T00:05:00Z",
            "source_marinas_id": "d9cj3j",
            "dockwa_destination_id": "d9cj3j",
            "last_fuel_checked_at_utc": "2026-04-27T23:00:00Z",
            "priority_hint": "high",
            "queue_status": "pending",
        }

        seed_id = publish_seed_row(connection, seed_row)

        pending = read_pending_seeds(connection, 10)
        if len(pending) != 1:
            raise RuntimeError(f"Expected exactly 1 pending seed row, got {len(pending)}")

        pending_seed = pending[0]
        validate_seed_payload(pending_seed)

        if pending_seed.get("seed_id") != seed_id:
            raise RuntimeError("Seed id mismatch between publisher and consumer")

        mark_seed_status(connection, seed_id, "processing")
        rows = connection.execute(
            "SELECT queue_status FROM fuel_seed_queue WHERE seed_id = ?",
            (seed_id,),
        ).fetchall()
        if len(rows) != 1:
            raise RuntimeError(f"Expected one row for seed_id={seed_id}, got {len(rows)}")

        queue_status = rows[0][0]
        if queue_status != "processing":
            raise RuntimeError(f"Expected queue_status='processing', got {queue_status}")

        return {
            "ok": True,
            "seed_id": seed_id,
            "marina_uid": marina_uid,
            "queue_status": queue_status,
            "pending_count": len(pending),
        }
    finally:
        connection.close()


if __name__ == "__main__":
    result = run_smoke_handoff()
    print(json.dumps(result, indent=2))
