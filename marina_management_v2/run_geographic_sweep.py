#!/usr/bin/env python3
"""CLI orchestrator for geographic sweep-based marina discovery.

Usage:
    python run_geographic_sweep.py \
        --db-path data/nav_data.db \
        --center-lat 37.2425 \
        --center-lon -76.5069 \
        --sweep-radius 50 \
        --discovery-radius 5 \
        --grid-spacing 10 \
        --timeout 45 \
        --scroll-cycles 10
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

# Add project root to path
sys.path.insert(0, str(Path(__file__).parent.parent))

from marina_management_v2.app.geographic_orchestrator import sweep_region


def main() -> int:
    parser = argparse.ArgumentParser(description="Geographic sweep-based marina discovery")
    parser.add_argument("--db-path", required=True, help="Path to SQLite database")
    parser.add_argument("--center-lat", type=float, required=True, help="Center latitude")
    parser.add_argument("--center-lon", type=float, required=True, help="Center longitude")
    parser.add_argument(
        "--sweep-radius",
        type=float,
        default=50.0,
        help="Total sweep radius in miles (default: 50)",
    )
    parser.add_argument(
        "--discovery-radius",
        type=float,
        default=5.0,
        help="Discovery radius per point in miles (default: 5)",
    )
    parser.add_argument(
        "--grid-spacing",
        type=float,
        default=10.0,
        help="Distance between grid points in miles (default: 10)",
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=45,
        help="Discovery timeout per point in seconds (default: 45)",
    )
    parser.add_argument(
        "--scroll-cycles",
        type=int,
        default=10,
        help="Number of scroll cycles for discovery (default: 10)",
    )

    args = parser.parse_args()

    result = sweep_region(
        db_path=args.db_path,
        center_lat=args.center_lat,
        center_lon=args.center_lon,
        sweep_radius_miles=args.sweep_radius,
        discovery_radius_miles=args.discovery_radius,
        grid_spacing_miles=args.grid_spacing,
        timeout_seconds=args.timeout,
        scroll_cycles=args.scroll_cycles,
    )

    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
