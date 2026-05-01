from __future__ import annotations

import json
import math
import re
from typing import Any, Optional
from urllib.error import HTTPError, URLError
from urllib.parse import quote_plus, urljoin, urlparse
from urllib.request import Request, urlopen


class MarinaDiscoveryError(Exception):
    pass


MAPBOX_TILESET = "dockwa.marinascom"


def _to_absolute_marinas_url(href: str) -> str:
    if not isinstance(href, str) or not href.strip():
        return ""

    absolute = urljoin("https://marinas.com", href.strip())
    absolute = absolute.split("?", 1)[0].split("#", 1)[0]
    return absolute.rstrip("/")


def harvest_marinas_token(timeout_seconds: int) -> Optional[str]:
    if not isinstance(timeout_seconds, int):
        raise MarinaDiscoveryError("timeout_seconds must be an int")
    if timeout_seconds < 5:
        raise MarinaDiscoveryError("timeout_seconds must be >= 5")

    try:
        from playwright.sync_api import sync_playwright
    except Exception as exc:
        raise MarinaDiscoveryError(
            "Playwright is required for token harvesting. "
            "Install with `pip install playwright` and run `playwright install chromium`."
        ) from exc

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
        )
        # Mask navigator.webdriver to avoid detection
        context.add_init_script("Object.defineProperty(navigator, 'webdriver', {get: () => undefined})")
        page = context.new_page()

        page.route("**/*.{png,jpg,jpeg,css,svg,woff}", lambda route: route.abort())

        try:
            page.goto("https://marinas.com/map", wait_until="domcontentloaded", timeout=timeout_seconds * 1000)

            token = page.evaluate("() => window.mapboxgl ? mapboxgl.accessToken : null")
            if isinstance(token, str) and token.strip():
                return token.strip()

            content = page.content()
            match = re.search(r"accessToken\s*:\s*[\"'](pk\.[^\"']+)[\"']", content)
            if match is None:
                return None

            token_value = match.group(1)
            if isinstance(token_value, str) and token_value.strip():
                return token_value.strip()
            return None
        except Exception as exc:
            raise MarinaDiscoveryError(f"Token harvest failed: {exc}") from exc
        finally:
            browser.close()


def _extract_id_from_url(url: str) -> Optional[str]:
    if not isinstance(url, str) or not url.strip():
        return None

    path = (urlparse(url).path or "").strip("/")
    if not path:
        return None

    parts = path.split("/")
    if not parts:
        return None

    if parts[0] == "marinas" and len(parts) > 1:
        marina_id = parts[1].split("-")[0].strip()
        if marina_id:
            return marina_id

    if "view" in parts and "marina" in parts and len(parts) >= 3:
        marina_id = parts[-1].strip()
        if marina_id:
            return marina_id

    return None


def _dedupe_records(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen_ids: set[str] = set()
    deduped: list[dict[str, Any]] = []

    for record in records:
        marina_id = record.get("marina_id")
        if not isinstance(marina_id, str) or not marina_id:
            continue
        if marina_id in seen_ids:
            continue
        seen_ids.add(marina_id)
        deduped.append(record)

    return deduped


def _discover_marinas_by_tilequery(center_lat: float, center_lon: float, radius_miles: float, timeout_seconds: int) -> list[dict[str, Any]]:
    if not isinstance(center_lat, (int, float)):
        raise MarinaDiscoveryError("center_lat must be a number")
    if not isinstance(center_lon, (int, float)):
        raise MarinaDiscoveryError("center_lon must be a number")
    if not isinstance(radius_miles, (int, float)):
        raise MarinaDiscoveryError("radius_miles must be a number")
    if radius_miles <= 0:
        raise MarinaDiscoveryError("radius_miles must be > 0")
    if not isinstance(timeout_seconds, int):
        raise MarinaDiscoveryError("timeout_seconds must be an int")
    if timeout_seconds < 5:
        raise MarinaDiscoveryError("timeout_seconds must be >= 5")

    token = harvest_marinas_token(timeout_seconds)
    if not isinstance(token, str) or not token.strip():
        raise MarinaDiscoveryError("Token harvest failed: mapbox token not found")

    radius_meters = int(radius_miles * 1609.34)
    url = (
        f"https://api.mapbox.com/v4/{MAPBOX_TILESET}/tilequery/{center_lon},{center_lat}.json"
        f"?radius={radius_meters}&limit=50&dedupe=true&access_token={token}"
    )

    request = Request(
        url,
        headers={
            "User-Agent": "Nexus-Discovery-Bot/2.0",
            "Accept": "application/json",
        },
    )

    try:
        with urlopen(request, timeout=timeout_seconds) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        raise MarinaDiscoveryError(f"Tilequery HTTP error: {exc.code}") from exc
    except URLError as exc:
        raise MarinaDiscoveryError(f"Tilequery URL error: {exc}") from exc
    except json.JSONDecodeError as exc:
        raise MarinaDiscoveryError("Tilequery returned invalid JSON") from exc
    except Exception as exc:
        raise MarinaDiscoveryError(f"Tilequery failure: {exc}") from exc

    features = payload.get("features")
    if not isinstance(features, list):
        return []

    records: list[dict[str, Any]] = []
    for feature in features:
        if not isinstance(feature, dict):
            continue

        properties = feature.get("properties")
        if not isinstance(properties, dict):
            continue

        kind = properties.get("kind")
        if isinstance(kind, str) and kind != "marina":
            continue

        marina_id = properties.get("object_id")
        if not isinstance(marina_id, str) or not marina_id.strip():
            continue

        name = properties.get("name")
        if not isinstance(name, str) or not name.strip():
            continue

        geometry = feature.get("geometry")
        if not isinstance(geometry, dict):
            continue

        coordinates = geometry.get("coordinates")
        if not isinstance(coordinates, list) or len(coordinates) < 2:
            continue

        lon = coordinates[0]
        lat = coordinates[1]
        if not isinstance(lat, (int, float)):
            continue
        if not isinstance(lon, (int, float)):
            continue

        records.append(
            {
                "marina_id": str(marina_id).strip(),
                "name": name.strip(),
                "lat": float(lat),
                "lon": float(lon),
                "marinas_url": f"https://marinas.com/view/marina/{str(marina_id).strip()}",
                "website": properties.get("website"),
                "source": "mapbox_tilequery",
                "diesel_amenity": properties.get("diesel_amenity"),
                "gas_amenity": properties.get("gas_amenity"),
                "diesel_price": properties.get("diesel_price"),
                "gas_reg_price": properties.get("gas_reg_price"),
            }
        )

    return _dedupe_records(records)


def _discover_from_search_url(search_url: str, timeout_seconds: int, scroll_cycles: int) -> list[dict[str, Any]]:
    if not isinstance(search_url, str) or not search_url.strip():
        raise MarinaDiscoveryError("search_url is required")
    if not isinstance(timeout_seconds, int):
        raise MarinaDiscoveryError("timeout_seconds must be an int")
    if timeout_seconds < 5:
        raise MarinaDiscoveryError("timeout_seconds must be >= 5")
    if not isinstance(scroll_cycles, int):
        raise MarinaDiscoveryError("scroll_cycles must be an int")
    if scroll_cycles < 1:
        raise MarinaDiscoveryError("scroll_cycles must be >= 1")

    try:
        from playwright.sync_api import sync_playwright
    except Exception as exc:
        raise MarinaDiscoveryError(
            "Playwright is required for marinas discovery. "
            "Install with `pip install playwright` and run `playwright install chromium`."
        ) from exc

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
        )
        # Mask navigator.webdriver to avoid detection
        context.add_init_script("Object.defineProperty(navigator, 'webdriver', {get: () => undefined})")
        page = context.new_page()

        try:
            page.route("**/*.{png,jpg,jpeg,css,svg,woff}", lambda route: route.abort())
            page.goto(search_url, wait_until="domcontentloaded", timeout=timeout_seconds * 1000)

            for _ in range(scroll_cycles):
                page.mouse.wheel(0, 2000)
                page.wait_for_timeout(500)

            anchors = page.locator("a[href*='/marinas/'], a[href*='/view/marina/']").all()

            records: list[dict[str, Any]] = []
            for anchor in anchors:
                href = anchor.get_attribute("href")
                full_url = _to_absolute_marinas_url(href)
                marina_id = _extract_id_from_url(full_url)
                if not isinstance(marina_id, str) or not marina_id.strip():
                    continue
                records.append(
                    {
                        "marina_id": marina_id.strip(),
                        "marinas_url": full_url,
                        "source": "scraper_search",
                    }
                )

            return _dedupe_records(records)
        except Exception as exc:
            raise MarinaDiscoveryError(str(exc)) from exc
        finally:
            try:
                page.unroute("**/*.{png,jpg,jpeg,css,svg,woff}")
            except Exception:
                pass
            context.close()
            browser.close()


def discover_marinas_by_query(location_query: str, timeout_seconds: int, scroll_cycles: int) -> list[dict[str, Any]]:
    if not isinstance(location_query, str) or not location_query.strip():
        raise MarinaDiscoveryError("location_query is required")

    encoded_query = quote_plus(location_query.strip())
    search_url = f"https://marinas.com/search?q={encoded_query}"
    return _discover_from_search_url(search_url, timeout_seconds, scroll_cycles)


def discover_marinas_by_bounds(
    min_lat: float,
    max_lat: float,
    min_lon: float,
    max_lon: float,
    timeout_seconds: int,
    scroll_cycles: int,
) -> list[dict[str, Any]]:
    if not isinstance(min_lat, (int, float)):
        raise MarinaDiscoveryError("min_lat must be a number")
    if not isinstance(max_lat, (int, float)):
        raise MarinaDiscoveryError("max_lat must be a number")
    if not isinstance(min_lon, (int, float)):
        raise MarinaDiscoveryError("min_lon must be a number")
    if not isinstance(max_lon, (int, float)):
        raise MarinaDiscoveryError("max_lon must be a number")
    if min_lat >= max_lat:
        raise MarinaDiscoveryError("min_lat must be < max_lat")
    if min_lon >= max_lon:
        raise MarinaDiscoveryError("min_lon must be < max_lon")

    center_lat = (float(min_lat) + float(max_lat)) / 2.0
    center_lon = (float(min_lon) + float(max_lon)) / 2.0

    lat_dist = (float(max_lat) - float(min_lat)) * 69.0
    lon_dist = (float(max_lon) - float(min_lon)) * 69.0 * math.cos(math.radians(center_lat))
    radius_miles = max(lat_dist, lon_dist) / 2.0
    if radius_miles <= 0:
        raise MarinaDiscoveryError("computed radius_miles must be > 0")

    return _discover_marinas_by_tilequery(
        center_lat=center_lat,
        center_lon=center_lon,
        radius_miles=radius_miles,
        timeout_seconds=timeout_seconds,
    )
