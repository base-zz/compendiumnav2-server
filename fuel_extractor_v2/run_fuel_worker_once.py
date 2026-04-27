from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
if not REPO_ROOT.exists():
    raise RuntimeError(f"Repo root not found: {REPO_ROOT}")

repo_root_str = str(REPO_ROOT)
if repo_root_str not in sys.path:
    sys.path.insert(0, repo_root_str)

from fuel_extractor_v2.app.fuel_worker import process_pending_seeds_in_db


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run fuel_extractor_v2 worker once")
    parser.add_argument("--db-path", required=True, help="Path to SQLite DB")
    parser.add_argument("--batch-size", type=int, required=True, help="Max pending seeds to process")
    return parser.parse_args()


def main() -> None:
    args = _parse_args()

    db_path = args.db_path
    batch_size = args.batch_size

    if not isinstance(db_path, str) or not db_path.strip():
        raise RuntimeError("--db-path is required")
    if not isinstance(batch_size, int) or batch_size < 1:
        raise RuntimeError("--batch-size must be >= 1")

    result = process_pending_seeds_in_db(db_path=db_path.strip(), batch_size=batch_size)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
