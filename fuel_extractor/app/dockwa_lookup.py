from __future__ import annotations

import re
from typing import Optional
from urllib.parse import quote_plus, urljoin, urlparse


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


def _extract_search_term(marina_url: str) -> Optional[str]:
    if not isinstance(marina_url, str) or not marina_url.strip():
        return None

    parsed = urlparse(marina_url)
    netloc = parsed.netloc.lower()
    if not netloc:
        return None

    host = netloc.replace("www.", "")
    first_label = host.split(".")[0]
    if not first_label:
        return None

    term = re.sub(r"([a-z])([A-Z])", r"\1 \2", first_label)
    term = re.sub(r"[^a-z0-9\-\s]", " ", term, flags=re.IGNORECASE)
    term = re.sub(r"\s+", " ", term).strip()
    return term if term else None


def _is_dockwa_destination_url(url: str) -> bool:
    if not isinstance(url, str) or not url:
        return False

    parsed = urlparse(url)
    host = (parsed.netloc or "").lower()
    path = (parsed.path or "").lower()
    return "dockwa.com" in host and path.startswith("/explore/destination/")


def _to_absolute_marinas_url(href: str) -> str:
    return urljoin("https://marinas.com", href)


def find_dockwa_link_for_marina(marina_url: str, timeout_seconds: int) -> Optional[str]:
    search_term = _extract_search_term(marina_url)
    if search_term is None:
        return None

    try:
        from playwright.sync_api import sync_playwright
    except Exception:
        return None

    search_url = f"https://marinas.com/search?q={quote_plus(search_term)}"
    timeout_ms = max(timeout_seconds, 5) * 1000

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context(user_agent="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
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

        try:
            page.route("**/*", intercept_route)
            page.goto(search_url, wait_until="domcontentloaded", timeout=timeout_ms)
            page.wait_for_timeout(700)

            marina_href: Optional[str] = None
            selectors = (
                ".marina-card a[href]",
                "a[href*='/marinas/']",
                "a[href*='/marina/']",
            )
            for selector in selectors:
                first = page.locator(selector).first
                if first.count() < 1:
                    continue
                href = first.get_attribute("href")
                if not isinstance(href, str) or not href.strip():
                    continue
                marina_href = href
                break

            if marina_href is None:
                return None

            marina_page_url = _to_absolute_marinas_url(marina_href)
            page.goto(marina_page_url, wait_until="domcontentloaded", timeout=timeout_ms)
            page.wait_for_timeout(700)

            dockwa_links = page.locator("a[href*='dockwa.com']")
            count = dockwa_links.count()
            for idx in range(count):
                href = dockwa_links.nth(idx).get_attribute("href")
                if not isinstance(href, str) or not href.strip():
                    continue
                absolute = urljoin(marina_page_url, href)
                if _is_dockwa_destination_url(absolute):
                    return absolute

            return None
        except Exception:
            return None
        finally:
            try:
                page.unroute("**/*")
            except Exception:
                pass
            context.close()
            browser.close()
