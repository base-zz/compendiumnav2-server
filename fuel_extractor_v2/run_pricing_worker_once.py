#!/usr/bin/env python3
"""
Pricing Extraction Runner

This script runs a single pricing extraction for a marina using DeepSeek v4 via Fireworks.
It is called from the Node.js fuel pipeline API.

Usage:
  python run_pricing_worker_once.py \
    --db-path /path/to/nav_data.db \
    --marina-uid <uuid> \
    --website-url <url> \
    [--timeout 45] \
    [--max-pages 20]
"""

import argparse
import json
import sqlite3
import sys
from pathlib import Path

# Add project to Python path
project_root = Path(__file__).parent.parent
sys.path.insert(0, str(project_root))

from app.pricing_worker import extract_pricing_with_deepseek, PricingWorkerError


def main():
    parser = argparse.ArgumentParser(description="Extract pricing data from marina website")
    parser.add_argument("--db-path", required=True, help="Path to SQLite database")
    parser.add_argument("--marina-uid", required=True, help="Marina UUID")
    parser.add_argument("--website-url", required=True, help="Marina website URL")
    parser.add_argument("--timeout", type=int, default=45, help="Timeout in seconds")
    parser.add_argument("--max-pages", type=int, default=20, help="Max pages to crawl")

    args = parser.parse_args()

    try:
        # Upgrade HTTP to HTTPS
        website_url = args.website_url
        if website_url.startswith("http://"):
            website_url = "https://" + website_url[7:]
        
        # Extract pricing data
        pricing_data = extract_pricing_with_deepseek(
            base_url=website_url,
            timeout_seconds=args.timeout,
            max_pages=args.max_pages,
        )

        # Add marina_uid
        pricing_data["marina_uid"] = args.marina_uid

        # Write to database
        db_path = Path(args.db_path)
        if not db_path.exists():
            print(json.dumps({"error": f"Database not found: {db_path}"}))
            sys.exit(1)

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

        conn.commit()
        pricing_log_id = cursor.lastrowid
        conn.close()

        result = {
            "success": True,
            "pricing_log_id": pricing_log_id,
            "marina_uid": args.marina_uid,
            "fetched_at_utc": pricing_data.get("fetched_at_utc"),
        }

        print(json.dumps(result, indent=2))
        sys.exit(0)

    except PricingWorkerError as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)
    except sqlite3.Error as e:
        print(json.dumps({"error": f"Database error: {str(e)}"}))
        sys.exit(1)
    except Exception as e:
        print(json.dumps({"error": f"Unexpected error: {str(e)}"}))
        sys.exit(1)


if __name__ == "__main__":
    main()
