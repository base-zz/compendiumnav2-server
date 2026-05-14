#!/usr/bin/env python3
"""
Process local HTML marina files to extract pricing/haulout data
"""
import argparse
import hashlib
import json
import os
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# Add project to Python path
project_root = Path(__file__).parent
sys.path.insert(0, str(project_root))

from fuel_extractor_v2.app.pricing_worker import extract_pricing_with_deepseek, PricingWorkerError


def load_env_file(env_path: Path) -> None:
    if not env_path.exists():
        return

    with env_path.open("r", encoding="utf-8") as env_file:
        for line in env_file:
            stripped = line.strip()
            if not stripped or stripped.startswith("#") or "=" not in stripped:
                continue

            key, value = stripped.split("=", 1)
            key = key.strip()
            value = value.strip().strip('"').strip("'")

            if key and key not in os.environ:
                os.environ[key] = value


def main():
    load_env_file(project_root / ".env")

    parser = argparse.ArgumentParser(description="Process local HTML marina files")
    parser.add_argument("--db-path", required=True, help="Path to SQLite database")
    parser.add_argument("--marina-dir", default="data/marina", help="Directory containing HTML files")
    parser.add_argument("--limit", type=int, help="Limit number of files to process")

    args = parser.parse_args()

    marina_dir = Path(args.marina_dir)
    if not marina_dir.exists():
        print(json.dumps({"error": f"Marina directory not found: {marina_dir}"}))
        sys.exit(1)

    # Get all HTML files
    html_files = list(marina_dir.glob("*.html"))
    if args.limit:
        html_files = html_files[:args.limit]

    print(f"Processing {len(html_files)} HTML files...")

    # Connect to database
    db_path = Path(args.db_path)
    conn = sqlite3.connect(str(db_path))
    cursor = conn.cursor()

    # Check if pricing_logs table exists
    cursor.execute("""
        SELECT name FROM sqlite_master
        WHERE type='table' AND name='pricing_logs'
    """)
    if cursor.fetchone() is None:
        print(json.dumps({"error": "pricing_logs table does not exist in database"}))
        sys.exit(1)

    success_count = 0
    error_count = 0

    for html_file in html_files:
        # Extract marina UID from filename (e.g., 1-11073.html -> 1-11073)
        marina_uid = html_file.stem

        try:
            # Read HTML content
            with open(html_file, 'r', encoding='utf-8') as f:
                html_content = f.read()

            # Extract pricing data using HTML content directly
            pricing_data = extract_pricing_with_deepseek(
                base_url=f"file://{html_file}",  # Dummy URL for API compatibility
                html_content=html_content,
            )

            # Add marina_uid
            pricing_data["marina_uid"] = marina_uid

            # Insert pricing log
            cursor.execute(
                """
                INSERT INTO pricing_logs (
                    marina_uid, fetched_at_utc, monthly_base, is_per_ft, catamaran_multiplier,
                    liveaboard_fee, min_air_draft_ft, air_draft_source, min_depth_ft, depth_source,
                    lift_max_beam_ft, lift_max_tons, diy_allowed, electricity_metered, water_metered,
                    liveaboard_permitted, source_quotes, extraction_hash, sync_dirty, created_at_utc
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
                """,
                (
                    pricing_data.get("marina_uid"),
                    pricing_data.get("fetched_at_utc"),
                    pricing_data.get("monthly_base"),
                    pricing_data.get("is_per_ft"),
                    pricing_data.get("catamaran_multiplier"),
                    pricing_data.get("liveaboard_fee"),
                    pricing_data.get("min_air_draft_ft"),
                    pricing_data.get("air_draft_source"),
                    pricing_data.get("min_depth_ft"),
                    pricing_data.get("depth_source"),
                    pricing_data.get("lift_max_beam_ft"),
                    pricing_data.get("lift_max_tons"),
                    pricing_data.get("diy_allowed"),
                    pricing_data.get("electricity_metered"),
                    pricing_data.get("water_metered"),
                    pricing_data.get("liveaboard_permitted"),
                    json.dumps(pricing_data.get("source_quotes", [])),
                    pricing_data.get("extraction_hash"),
                    pricing_data.get("fetched_at_utc"),
                ),
            )

            success_count += 1
            print(f"[{success_count}/{len(html_files)}] Processed {marina_uid}: lift_max_beam_ft={pricing_data.get('lift_max_beam_ft')}")

        except PricingWorkerError as e:
            error_count += 1
            print(f"[ERROR] {marina_uid}: {e}")
        except sqlite3.Error as e:
            error_count += 1
            print(f"[DB ERROR] {marina_uid}: {e}")
        except Exception as e:
            error_count += 1
            print(f"[ERROR] {marina_uid}: {e}")

    conn.commit()
    conn.close()

    result = {
        "success": True,
        "total_files": len(html_files),
        "success_count": success_count,
        "error_count": error_count,
    }

    print(json.dumps(result, indent=2))
    sys.exit(0)


if __name__ == "__main__":
    main()
