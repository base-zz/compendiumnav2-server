from __future__ import annotations

import argparse
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

from marina_management_v2.app.discovery_runner import discover_bounds_now, discover_query_now
from marina_management_v2.app.reconcile_runner import reconcile_now
from marina_management_v2.app.seed_publish_runner import publish_candidates_now


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run marina_management v2 pipeline: discover -> reconcile -> seed publish"
    )
    parser.add_argument("--db-path", required=True, help="Path to SQLite database")
    parser.add_argument("--max-seeds", type=int, required=True, help="Maximum seeds to publish")
    parser.add_argument("--timeout-seconds", type=int, required=True, help="Discovery timeout seconds")
    parser.add_argument("--scroll-cycles", type=int, required=True, help="Discovery scroll cycles")

    parser.add_argument("--query", help="Marinas.com location query mode")

    parser.add_argument("--min-lat", type=float, help="Bounds mode min latitude")
    parser.add_argument("--max-lat", type=float, help="Bounds mode max latitude")
    parser.add_argument("--min-lon", type=float, help="Bounds mode min longitude")
    parser.add_argument("--max-lon", type=float, help="Bounds mode max longitude")

    return parser.parse_args()


def _discover(args: argparse.Namespace) -> list[dict[str, object]]:
    query = args.query
    min_lat = args.min_lat
    max_lat = args.max_lat
    min_lon = args.min_lon
    max_lon = args.max_lon

    if isinstance(query, str) and query.strip():
        return discover_query_now(
            location_query=query.strip(),
            timeout_seconds=args.timeout_seconds,
            scroll_cycles=args.scroll_cycles,
        )

    has_bounds = (
        isinstance(min_lat, float)
        and isinstance(max_lat, float)
        and isinstance(min_lon, float)
        and isinstance(max_lon, float)
    )
    if has_bounds:
        return discover_bounds_now(
            min_lat=min_lat,
            max_lat=max_lat,
            min_lon=min_lon,
            max_lon=max_lon,
            timeout_seconds=args.timeout_seconds,
            scroll_cycles=args.scroll_cycles,
        )

    raise RuntimeError("Provide either --query or all four bounds: --min-lat --max-lat --min-lon --max-lon")


def main() -> None:
    args = _parse_args()

    db_path = Path(args.db_path)
    if not db_path.exists():
        raise RuntimeError(f"Database file not found: {db_path}")

    if not isinstance(args.max_seeds, int) or args.max_seeds < 1:
        raise RuntimeError("--max-seeds must be >= 1")

    discovered_records = _discover(args)

    connection = sqlite3.connect(str(db_path))
    try:
        reconcile_result = reconcile_now(connection, discovered_records)
        publish_result = publish_candidates_now(connection, args.max_seeds)
    finally:
        connection.close()

    output = {
        "discovered_count": len(discovered_records),
        "reconcile": reconcile_result,
        "seed_publish": publish_result,
    }
    print(json.dumps(output, indent=2))


if __name__ == "__main__":
    main()
