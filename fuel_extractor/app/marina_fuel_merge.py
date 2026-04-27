from __future__ import annotations

from typing import Any, Optional
from urllib.parse import urlparse

from .dockwa_lookup import find_dockwa_link_for_marina
from .markdown_convert import fetch_dockwa_fuel_snapshot


BLOCKED_RESOURCE_TYPES = {
    "image",
    "stylesheet",
    "font",
    "media",
}

BLOCKED_URL_KEYWORDS = (
    "google-analytics",
    "googletagmanager",
    "doubleclick",
    "facebook.net",
    "facebook.com/tr",
    "segment.io",
    "hotjar",
)


class MarinaFuelMergeError(Exception):
    pass


def _is_dockwa_destination_url(url: str) -> bool:
    if not isinstance(url, str) or not url:
        return False

    parsed = urlparse(url)
    host = (parsed.netloc or "").lower()
    path = (parsed.path or "").lower()
    return "dockwa.com" in host and path.startswith("/explore/destination/")


def _is_marinas_detail_url(url: str) -> bool:
    if not isinstance(url, str) or not url:
        return False

    parsed = urlparse(url)
    host = (parsed.netloc or "").lower()
    path = (parsed.path or "").lower()
    return "marinas.com" in host and path.startswith("/marinas/")


def _extract_fuel_dock_from_amenities(amenities: dict[str, str]) -> tuple[Optional[bool], Optional[str]]:
    if not isinstance(amenities, dict) or not amenities:
        return None, None

    for key, value in amenities.items():
        if not isinstance(key, str) or not key.strip():
            continue
        if not isinstance(value, str) or not value.strip():
            continue

        key_lower = key.lower()
        value_lower = value.lower()
        if "fuel" not in key_lower:
            continue

        if value_lower in {"yes", "available", "true", "y"}:
            return True, f"{key}: {value}"
        if value_lower in {"no", "not available", "false", "n"}:
            return False, f"{key}: {value}"

    return None, None


def scrape_marinas_amenities(marinas_url: str, timeout_seconds: int) -> dict[str, str]:
    if not _is_marinas_detail_url(marinas_url):
        return {}
    if not isinstance(timeout_seconds, int):
        raise MarinaFuelMergeError("timeout_seconds must be an int")
    if timeout_seconds < 5:
        raise MarinaFuelMergeError("timeout_seconds must be >= 5")

    try:
        from playwright.sync_api import sync_playwright
    except Exception as exc:
        raise MarinaFuelMergeError(
            "Playwright is required for marinas amenities scraping. "
            "Install with `pip install playwright` and run `playwright install chromium`."
        ) from exc

    timeout_ms = timeout_seconds * 1000

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context(
            user_agent="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
        )
        page = context.new_page()

        def intercept_route(route):
            request = route.request
            request_url = request.url.lower()
            if request.resource_type in BLOCKED_RESOURCE_TYPES:
                route.abort()
                return
            if any(token in request_url for token in BLOCKED_URL_KEYWORDS):
                route.abort()
                return
            route.continue_()

        try:
            page.route("**/*", intercept_route)
            page.goto(marinas_url, wait_until="domcontentloaded", timeout=timeout_ms)
            page.wait_for_timeout(900)

            amenities: dict[str, str] = {}
            rows = page.locator(".service-amenity-row, dl div, .spec-item")
            row_count = rows.count()

            for idx in range(row_count):
                text = rows.nth(idx).inner_text().strip()
                if ":" not in text:
                    continue

                key, value = text.split(":", 1)
                cleaned_key = key.strip()
                cleaned_value = value.strip()
                if not cleaned_key or not cleaned_value:
                    continue

                amenities[cleaned_key] = cleaned_value

            return amenities
        except Exception as exc:
            raise MarinaFuelMergeError(str(exc)) from exc
        finally:
            try:
                page.unroute("**/*")
            except Exception:
                pass
            context.close()
            browser.close()


def merge_marina_fuel_data(marina_url: str, timeout_seconds: int) -> dict[str, Any]:
    if not isinstance(marina_url, str) or not marina_url.strip():
        raise MarinaFuelMergeError("marina_url is required")
    if not isinstance(timeout_seconds, int):
        raise MarinaFuelMergeError("timeout_seconds must be an int")
    if timeout_seconds < 5:
        raise MarinaFuelMergeError("timeout_seconds must be >= 5")

    marinas_url: Optional[str] = None
    amenities: dict[str, str] = {}
    fuel_dock: Optional[bool] = None
    amenities_source_text: Optional[str] = None

    if _is_marinas_detail_url(marina_url):
        marinas_url = marina_url
        amenities = scrape_marinas_amenities(marina_url, timeout_seconds)
        fuel_dock, amenities_source_text = _extract_fuel_dock_from_amenities(amenities)

    dockwa_url: Optional[str]
    if _is_dockwa_destination_url(marina_url):
        dockwa_url = marina_url
    else:
        dockwa_url = find_dockwa_link_for_marina(marina_url, timeout_seconds)

    dockwa_snapshot: Optional[dict[str, Any]] = None
    if isinstance(dockwa_url, str) and dockwa_url.strip() and _is_dockwa_destination_url(dockwa_url):
        dockwa_snapshot = fetch_dockwa_fuel_snapshot(dockwa_url, timeout_seconds)

    diesel_price: Optional[float] = None
    gasoline_price: Optional[float] = None
    is_non_ethanol: Optional[bool] = None
    last_updated: Optional[str] = None
    source_text: Optional[str] = amenities_source_text
    source_url: Optional[str] = marinas_url

    if isinstance(dockwa_snapshot, dict):
        diesel_price = dockwa_snapshot.get("diesel_price")
        gasoline_price = dockwa_snapshot.get("gasoline_price")
        is_non_ethanol = dockwa_snapshot.get("is_non_ethanol")
        last_updated = dockwa_snapshot.get("last_updated")

        dockwa_source_text = dockwa_snapshot.get("source_text")
        if isinstance(dockwa_source_text, str) and dockwa_source_text.strip():
            source_text = dockwa_source_text
            source_url = dockwa_url

        if diesel_price is not None or gasoline_price is not None:
            if fuel_dock is None:
                fuel_dock = True

    reason_tag: Optional[str] = None
    has_price = diesel_price is not None or gasoline_price is not None
    if fuel_dock is True and not has_price:
        reason_tag = "price_not_published_publicly"

    confidence: float = 0.0
    if has_price:
        confidence = 1.0
    elif fuel_dock is True:
        confidence = 0.65

    return {
        "diesel_price": diesel_price,
        "gasoline_price": gasoline_price,
        "fuel_dock": fuel_dock,
        "is_non_ethanol": is_non_ethanol,
        "last_updated": last_updated,
        "source_text": source_text,
        "source_url": source_url,
        "dockwa_url": dockwa_url,
        "marinas_url": marinas_url,
        "amenities": amenities,
        "reason_tag": reason_tag,
        "confidence": confidence,
        "provenance": {
            "diesel_price": "dockwa" if diesel_price is not None else None,
            "gasoline_price": "dockwa" if gasoline_price is not None else None,
            "fuel_dock": "dockwa_or_marinas" if fuel_dock is not None else None,
            "is_non_ethanol": "dockwa" if is_non_ethanol is not None else None,
            "last_updated": "dockwa" if last_updated is not None else None,
        },
    }
