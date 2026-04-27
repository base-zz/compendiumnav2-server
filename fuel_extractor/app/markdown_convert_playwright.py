from __future__ import annotations

import atexit
import hashlib
import json
import re
import tempfile
from pathlib import Path
from threading import Lock
from typing import Any, Optional

import httpx
from bs4 import BeautifulSoup
from markdownify import markdownify


class ConversionError(Exception):
    pass


DEFAULT_HEADERS = {
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}

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


class _PlaywrightRuntime:
    def __init__(self) -> None:
        self._lock = Lock()
        self._playwright = None
        self._browser = None

    def get_browser(self):
        with self._lock:
            if self._browser is not None:
                return self._browser

            try:
                from playwright.sync_api import sync_playwright
            except Exception as exc:
                raise ConversionError(
                    "Playwright is required for markdown_convert_playwright. "
                    "Install with `pip install playwright` and run `playwright install chromium`."
                ) from exc

            self._playwright = sync_playwright().start()
            self._browser = self._playwright.chromium.launch(headless=True)
            return self._browser

    def close(self) -> None:
        with self._lock:
            if self._browser is not None:
                try:
                    self._browser.close()
                except Exception:
                    pass
            self._browser = None

            if self._playwright is not None:
                try:
                    self._playwright.stop()
                except Exception:
                    pass
            self._playwright = None


_RUNTIME = _PlaywrightRuntime()
atexit.register(_RUNTIME.close)


def close_playwright_runtime() -> None:
    _RUNTIME.close()


def _is_dockwa_destination_url(url: str) -> bool:
    parsed = httpx.URL(url)
    host = parsed.host or ""
    path = parsed.path or ""
    return "dockwa.com" in host.lower() and path.lower().startswith("/explore/destination/")


def _is_cloudflare_challenge_html(html: str) -> bool:
    if not isinstance(html, str) or not html:
        return False

    lowered = html.lower()
    indicators = (
        "just a moment",
        "enable javascript and cookies to continue",
        "challenges.cloudflare.com",
        "_cf_chl_opt",
    )
    return any(indicator in lowered for indicator in indicators)


def _parse_price_dollars(value: Any) -> Optional[float]:
    if value is None:
        return None

    text = str(value).strip()
    match = re.search(r"\d{1,2}\.\d{2,3}", text)
    if not match:
        return None

    try:
        return float(match.group(0))
    except ValueError:
        return None


def _extract_dockwa_fuel_from_payload(payload: dict[str, Any]) -> Optional[dict[str, Any]]:
    fuel_items = payload.get("fuel")
    if not isinstance(fuel_items, list):
        return None

    diesel_price: Optional[float] = None
    gasoline_price: Optional[float] = None
    is_non_ethanol: Optional[bool] = None
    price_fragments: list[str] = []

    for item in fuel_items:
        if not isinstance(item, dict):
            continue

        name = item.get("name")
        if not isinstance(name, str):
            continue

        lowered = name.lower()
        price_value = _parse_price_dollars(item.get("effectivePriceDollars"))
        if price_value is None:
            price_value = _parse_price_dollars(item.get("priceDollars"))
        if price_value is None:
            continue

        price_fragments.append(f"{name}: ${price_value:.2f}/gal")

        if "diesel" in lowered:
            diesel_price = price_value
        if "gas" in lowered:
            gasoline_price = price_value
        if "non-ethanol" in lowered or "rec 90" in lowered or "rec90" in lowered:
            is_non_ethanol = True

    if diesel_price is None and gasoline_price is None:
        return None

    last_updated = payload.get("lastUpdatedAt")
    if not isinstance(last_updated, str) or not last_updated.strip():
        last_updated = None

    source_text = "; ".join(price_fragments) if price_fragments else None

    return {
        "diesel_price": diesel_price,
        "gasoline_price": gasoline_price,
        "is_non_ethanol": is_non_ethanol,
        "last_updated": last_updated,
        "source_text": source_text,
    }


def _extract_dockwa_fuel_from_html(html: str) -> Optional[dict[str, Any]]:
    if not isinstance(html, str) or not html:
        return None

    soup = BeautifulSoup(html, "html.parser")
    scripts = soup.find_all("script")

    for script in scripts:
        script_text = script.string
        if not isinstance(script_text, str):
            continue

        text = script_text.strip()
        if not text.startswith("{"):
            continue
        if '"fuel"' not in text:
            continue

        try:
            payload = json.loads(text)
        except json.JSONDecodeError:
            continue

        extracted = _extract_dockwa_fuel_from_payload(payload)
        if extracted is not None:
            return extracted

    return None


def _extract_dockwa_fuel_from_responses(response_payloads: list[dict[str, Any]]) -> Optional[dict[str, Any]]:
    for payload in response_payloads:
        extracted = _extract_dockwa_fuel_from_payload(payload)
        if extracted is not None:
            return extracted
    return None


def _hash_content(content: str) -> str:
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


def _cleanup_markdown(markdown: str) -> str:
    if not isinstance(markdown, str):
        return ""

    lines = markdown.splitlines()
    cleaned_lines: list[str] = []

    image_only_line = re.compile(r"^\s*!\[[^\]]*\]\([^\)]*\)\s*$")
    linked_image_only_line = re.compile(r"^\s*\[\s*!\[[^\]]*\]\([^\)]*\)\s*\]\([^\)]*\)\s*$")

    for line in lines:
        stripped = line.strip()

        if image_only_line.match(stripped):
            continue
        if linked_image_only_line.match(stripped):
            continue
        if "![" in stripped and "](javascript:" in stripped.lower():
            continue

        normalized = re.sub(r"\[([^\]]+)\]\(javascript:[^\)]*\)", r"\1", line, flags=re.IGNORECASE)
        cleaned_lines.append(normalized)

    cleaned = "\n".join(cleaned_lines)
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned)
    return cleaned.strip()


def _strip_non_content_html(html: str) -> str:
    soup = BeautifulSoup(html, "html.parser")
    for tag in soup(["script", "style", "noscript"]):
        tag.decompose()

    body = soup.find("body")
    if body is not None:
        return str(body)

    return str(soup)


def _convert_html_to_markdown(html: str) -> str:
    cleaned = _strip_non_content_html(html)
    markdown = markdownify(cleaned, heading_style="ATX")
    return _cleanup_markdown(markdown)


def _convert_pdf_to_markdown(pdf_bytes: bytes) -> str:
    try:
        import pymupdf4llm
    except Exception as exc:
        raise ConversionError("pymupdf4llm is required for PDF conversion") from exc

    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp:
        tmp.write(pdf_bytes)
        tmp_path = Path(tmp.name)

    try:
        markdown = pymupdf4llm.to_markdown(str(tmp_path))
        if not isinstance(markdown, str):
            raise ConversionError("PDF markdown conversion returned invalid output")
        markdown = _cleanup_markdown(markdown)
        if not markdown:
            raise ConversionError("PDF markdown conversion produced empty output")
        return markdown
    finally:
        tmp_path.unlink(missing_ok=True)


def _fetch_pdf_bytes(url: str, timeout_seconds: int) -> tuple[str, bytes]:
    try:
        with httpx.Client(timeout=timeout_seconds, headers=DEFAULT_HEADERS, follow_redirects=True) as client:
            response = client.get(url)
            response.raise_for_status()
            return str(response.url), response.content
    except Exception as exc:
        raise ConversionError(str(exc)) from exc


def _fetch_html_with_playwright(url: str, timeout_seconds: int) -> tuple[str, str, list[dict[str, Any]]]:
    browser = _RUNTIME.get_browser()
    timeout_ms = max(timeout_seconds, 5) * 1000
    response_payloads: list[dict[str, Any]] = []

    context = browser.new_context(user_agent=DEFAULT_HEADERS["User-Agent"])
    page = context.new_page()

    def intercept_route(route):
        req = route.request
        req_url = req.url.lower()
        if req.resource_type in BLOCKED_RESOURCE_TYPES:
            route.abort()
            return
        if any(token in req_url for token in BLOCKED_URL_KEYWORDS):
            route.abort()
            return
        route.continue_()

    def on_response(response):
        try:
            headers = response.headers
            content_type = headers.get("content-type", "")
            if "application/json" not in content_type:
                return
            payload = response.json()
            if isinstance(payload, dict):
                response_payloads.append(payload)
        except Exception:
            return

    try:
        page.route("**/*", intercept_route)
        page.on("response", on_response)
        page.goto(url, wait_until="domcontentloaded", timeout=timeout_ms)
        page.wait_for_timeout(1200)

        html = page.content()
        resolved_url = page.url

        if _is_cloudflare_challenge_html(html):
            raise ConversionError("Playwright fetch returned Cloudflare challenge page")

        return resolved_url, html, response_payloads
    except ConversionError:
        raise
    except Exception as exc:
        raise ConversionError(str(exc)) from exc
    finally:
        try:
            page.unroute("**/*")
        except Exception:
            pass
        context.close()


def fetch_dockwa_fuel_snapshot(url: str, timeout_seconds: int) -> Optional[dict[str, Any]]:
    if not _is_dockwa_destination_url(url):
        return None

    _resolved_url, html, response_payloads = _fetch_html_with_playwright(url, timeout_seconds)

    extracted = _extract_dockwa_fuel_from_responses(response_payloads)
    if extracted is not None:
        return extracted

    return _extract_dockwa_fuel_from_html(html)


def fetch_and_convert_to_markdown(url: str, timeout_seconds: int) -> tuple[str, str]:
    try:
        if url.lower().endswith(".pdf"):
            _resolved_url, pdf_bytes = _fetch_pdf_bytes(url, timeout_seconds)
            markdown = _convert_pdf_to_markdown(pdf_bytes)
        else:
            _resolved_url, html, _response_payloads = _fetch_html_with_playwright(url, timeout_seconds)
            markdown = _convert_html_to_markdown(html)

        content_hash = _hash_content(markdown)
        return markdown, content_hash
    except ConversionError:
        raise
    except Exception as exc:
        raise ConversionError(str(exc)) from exc
