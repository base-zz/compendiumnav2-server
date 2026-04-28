from __future__ import annotations

import math
import sqlite3
from dataclasses import dataclass
from typing import Any

from .discovery_runner import discover_bounds_now
from .reconcile_runner import reconcile_discovered_records
from .seed_publish_runner import publish_candidates_now


class GeographicOrchestratorError(Exception):
    pass


@dataclass
class GridPoint:
    lat: float
    lon: float


def _miles_to_lat_delta(miles: float) -> float:
    """Convert miles to approximate latitude degrees."""
    return miles / 69.0


def _miles_to_lon_delta(miles: float, lat: float) -> float:
    """Convert miles to approximate longitude degrees at given latitude."""
    return miles / (69.0 * math.cos(math.radians(lat)))


def generate_grid_points(
    center_lat: float,
    center_lon: float,
    sweep_radius_miles: float,
    grid_spacing_miles: float,
) -> list[GridPoint]:
    """Generate grid points for geographic sweep.

    Args:
        center_lat: Center latitude
        center_lon: Center longitude
        sweep_radius_miles: Total radius to sweep from center
        grid_spacing_miles: Distance between grid points

    Returns:
        List of GridPoint tuples (lat, lon)
    """
    if sweep_radius_miles <= 0:
        raise GeographicOrchestratorError("sweep_radius_miles must be > 0")
    if grid_spacing_miles <= 0:
        raise GeographicOrchestratorError("grid_spacing_miles must be > 0")

    points: list[GridPoint] = []

    # Generate grid in a square pattern around center
    lat_span = _miles_to_lat_delta(sweep_radius_miles)
    lon_span = _miles_to_lon_delta(sweep_radius_miles, center_lat)

    lat_spacing = _miles_to_lat_delta(grid_spacing_miles)
    lon_spacing = _miles_to_lon_delta(grid_spacing_miles, center_lat)

    # Number of steps in each direction (ensure we cover the radius)
    lat_steps = int(lat_span / lat_spacing) + 1
    lon_steps = int(lon_span / lon_spacing) + 1

    for i in range(-lat_steps, lat_steps + 1):
        for j in range(-lon_steps, lon_steps + 1):
            lat = center_lat + (i * lat_spacing)
            lon = center_lon + (j * lon_spacing)

            # Skip if outside circular sweep radius
            distance_miles = haversine_distance(center_lat, center_lon, lat, lon)
            if distance_miles > sweep_radius_miles:
                continue

            points.append(GridPoint(lat=lat, lon=lon))

    return points


def haversine_distance(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Calculate distance between two lat/lon points in miles."""
    R = 3959.0  # Earth radius in miles

    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    delta_phi = math.radians(lat2 - lat1)
    delta_lambda = math.radians(lon2 - lon1)

    a = (
        math.sin(delta_phi / 2) ** 2
        + math.cos(phi1) * math.cos(phi2) * math.sin(delta_lambda / 2) ** 2
    )
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))

    return R * c


def run_discovery_at_point(
    connection: sqlite3.Connection,
    point: GridPoint,
    discovery_radius_miles: float,
    timeout_seconds: int,
    scroll_cycles: int,
) -> dict[str, Any]:
    """Run full discovery->reconcile->seed pipeline at a grid point.

    Args:
        connection: SQLite database connection
        point: Grid point to discover at
        discovery_radius_miles: Radius for discovery bounds (default 5)
        timeout_seconds: Discovery timeout
        scroll_cycles: Number of scroll cycles for discovery

    Returns:
        Summary dict with discovery results
    """
    if connection is None:
        raise GeographicOrchestratorError("connection is required")

    lat_delta = _miles_to_lat_delta(discovery_radius_miles)
    lon_delta = _miles_to_lon_delta(discovery_radius_miles, point.lat)

    min_lat = point.lat - lat_delta
    max_lat = point.lat + lat_delta
    min_lon = point.lon - lon_delta
    max_lon = point.lon + lon_delta

    # Discovery
    discovered = discover_bounds_now(
        min_lat=min_lat,
        max_lat=max_lat,
        min_lon=min_lon,
        max_lon=max_lon,
        timeout_seconds=timeout_seconds,
        scroll_cycles=scroll_cycles,
    )

    # Reconcile
    reconcile_result = reconcile_discovered_records(
        connection=connection,
        discovered_records=discovered,
    )

    # Publish seeds
    seed_result = publish_candidates_now(
        connection=connection,
        max_rows=100,
    )

    return {
        "point": {"lat": point.lat, "lon": point.lon},
        "bounds": {
            "min_lat": min_lat,
            "max_lat": max_lat,
            "min_lon": min_lon,
            "max_lon": max_lon,
        },
        "discovered_count": len(discovered),
        "reconcile": reconcile_result,
        "seed_publish": seed_result,
    }


def sweep_region(
    db_path: str,
    center_lat: float,
    center_lon: float,
    sweep_radius_miles: float = 50.0,
    discovery_radius_miles: float = 5.0,
    grid_spacing_miles: float = 10.0,
    timeout_seconds: int = 45,
    scroll_cycles: int = 10,
) -> dict[str, Any]:
    """Sweep a geographic region with grid-based discovery.

    Args:
        db_path: Path to SQLite database
        center_lat: Center latitude of sweep area
        center_lon: Center longitude of sweep area
        sweep_radius_miles: Total radius to sweep from center (default 50)
        discovery_radius_miles: Radius for each discovery call (default 5)
        grid_spacing_miles: Distance between grid points (default 10)
        timeout_seconds: Discovery timeout per point
        scroll_cycles: Number of scroll cycles for discovery

    Returns:
        Summary of sweep results
    """
    if not isinstance(db_path, str) or not db_path.strip():
        raise GeographicOrchestratorError("db_path is required")

    grid_points = generate_grid_points(
        center_lat=center_lat,
        center_lon=center_lon,
        sweep_radius_miles=sweep_radius_miles,
        grid_spacing_miles=grid_spacing_miles,
    )

    connection = sqlite3.connect(db_path)
    try:
        results: list[dict[str, Any]] = []
        total_discovered = 0
        total_new_marinas = 0
        total_seeds_published = 0

        for i, point in enumerate(grid_points):
            point_result = run_discovery_at_point(
                connection=connection,
                point=point,
                discovery_radius_miles=discovery_radius_miles,
                timeout_seconds=timeout_seconds,
                scroll_cycles=scroll_cycles,
            )
            results.append(point_result)

            total_discovered += point_result["discovered_count"]
            total_new_marinas += point_result["reconcile"].get("inserted", 0)
            total_seeds_published += point_result["seed_publish"].get("published_count", 0)

        return {
            "center": {"lat": center_lat, "lon": center_lon},
            "sweep_radius_miles": sweep_radius_miles,
            "discovery_radius_miles": discovery_radius_miles,
            "grid_spacing_miles": grid_spacing_miles,
            "grid_points_count": len(grid_points),
            "total_discovered": total_discovered,
            "total_new_marinas": total_new_marinas,
            "total_seeds_published": total_seeds_published,
            "point_results": results,
        }
    finally:
        connection.close()
