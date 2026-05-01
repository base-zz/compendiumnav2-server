from __future__ import annotations

from urllib.parse import urljoin, urlparse

import httpx
from bs4 import BeautifulSoup

KEYWORDS = (
    "fuel",
    "marina",
    "rates",
    "dockage",
    "amenities",
    "about",
    "price",
    "prices",
)

PDF_BONUS_KEYWORDS = (
    "rates",
    "price",
    "prices",
    "fuel",
)

FUEL_INTENT_KEYWORDS = (
    "diesel",
    "gasoline",
    "gas",
    "fuel dock",
    "fuel prices",
    "valvtect",
    "non-ethanol",
    "fuel"
)

SLIP_INTENT_KEYWORDS = (
    "slip",
    "slips",
    "berth",
    "mooring",
    "transient",
    "monthly",
    "annual",
    "long-term",
    "catamaran",
    "multihull"
)

GENERIC_PAGE_TOKENS = (
    "/about",
    "/careers",
    "/news",
    "/privacy",
    "/terms",
    "/sustainability",
)

FUEL_PATH_TOKENS = (
    "/fuel",
    "/rates",
    "/pricing",
    "/service",
    "/amenities",
    "/marina",
    "/marinas",
    "/p32marinas",
    "fuel",
    "rates",
    "pricing",
)

FACILITY_PATH_TOKENS = (
    "/facilities",
    "/amenities",
    "/services",
    "/boat-yard",
    "/haul-out",
    "/travel-lift",
    "/storage",
    "/yard",
    "/lift"
)

IRRELEVANT_PATH_TOKENS = (
    "/boat-rentals",
    "/faq",
    "#boat-rentals",
)


class DiscoveryError(Exception):
    pass


DEFAULT_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Sec-Ch-Ua": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": '"Windows"',
    "Upgrade-Insecure-Requests": "1",
}


def _variant_urls(base_url: str) -> list[str]:
    parsed = urlparse(base_url)
    if not parsed.scheme or not parsed.netloc:
        return [base_url]

    host = parsed.netloc
    
    # Prioritize apex domain to avoid SSL hostname mismatches
    if host.startswith("www."):
        apex_host = host[4:]
        apex_url = parsed._replace(netloc=apex_host).geturl()
        www_url = base_url
    else:
        apex_url = base_url
        www_host = f"www.{host}"
        www_url = parsed._replace(netloc=www_host).geturl()
    
    urls = [apex_url]
    if www_url != apex_url:
        urls.append(www_url)

    return urls


def _fetch_html_with_fallback(base_url: str, timeout_seconds: int) -> tuple[str, str]:
    errors: list[str] = []
    got_403 = False

    for candidate_url in _variant_urls(base_url):
        for use_http2 in (True, False):
            try:
                with httpx.Client(
                    follow_redirects=True,
                    timeout=timeout_seconds,
                    headers=DEFAULT_HEADERS,
                    http2=use_http2,
                ) as client:
                    response = client.get(candidate_url)
                    response.raise_for_status()
                    return str(response.url), response.text
            except httpx.HTTPStatusError as exc:
                if exc.response.status_code in (403, 409):
                    got_403 = True
                    errors.append(f"{candidate_url} (http2={use_http2}): {exc.response.status_code} - will try Playwright")
                else:
                    errors.append(f"{candidate_url} (http2={use_http2}): {exc}")
            except httpx.HTTPError as exc:
                # Try with SSL verification disabled on SSL errors
                if "SSL" in str(exc) or "certificate" in str(exc).lower():
                    try:
                        with httpx.Client(
                            follow_redirects=True,
                            timeout=timeout_seconds,
                            headers=DEFAULT_HEADERS,
                            http2=use_http2,
                            verify=False
                        ) as client:
                            response = client.get(candidate_url)
                            response.raise_for_status()
                            return str(response.url), response.text
                    except Exception as ssl_exc:
                        errors.append(f"{candidate_url} (http2={use_http2}): SSL bypass failed - {ssl_exc}")
                else:
                    errors.append(f"{candidate_url} (http2={use_http2}): {exc}")
            except Exception as exc:
                errors.append(f"{candidate_url} (http2={use_http2}): {exc}")

    # If we got 403 errors, try Playwright fallback
    if got_403:
        try:
            from .markdown_convert import _fetch_html_with_playwright
            resolved_url, html = _fetch_html_with_playwright(base_url, timeout_seconds)
            return resolved_url, html
        except Exception as exc:
            errors.append(f"Playwright fallback failed: {exc}")

    raise DiscoveryError("; ".join(errors))


def _same_host(base_url: str, candidate_url: str) -> bool:
    return urlparse(base_url).netloc == urlparse(candidate_url).netloc


def _is_dockwa_destination_url(url: str) -> bool:
    parsed = urlparse(url)
    host = parsed.netloc.lower()
    path = (parsed.path or "").lower()
    return "dockwa.com" in host and path.startswith("/explore/destination/")


def _is_allowed_candidate_link(base_url: str, candidate_url: str) -> bool:
    if _same_host(base_url, candidate_url):
        return True
    if _is_dockwa_destination_url(candidate_url):
        return True
    # Allow sub-domains of the base netloc
    base_netloc = urlparse(base_url).netloc
    candidate_netloc = urlparse(candidate_url).netloc
    if candidate_netloc.endswith(base_netloc) or base_netloc.endswith(candidate_netloc):
        return True
    return False


def _is_top_level_url(url: str) -> bool:
    parsed = urlparse(url)
    path = (parsed.path or "").strip()
    return path in ("", "/")


def _score_link(text: str, href: str) -> int:
    score = 0
    haystack = f"{text} {href}".lower()

    for keyword in KEYWORDS:
        if keyword in haystack:
            score += 8

    for keyword in FUEL_INTENT_KEYWORDS:
        if keyword in haystack:
            score += 25

    # Big Three: Slip rates/pricing pages (high priority)
    for keyword in SLIP_INTENT_KEYWORDS:
        if keyword in haystack:
            score += 30

    href_lower = href.lower()
    for token in FUEL_PATH_TOKENS:
        if token in href_lower:
            score += 10

    # Big Three: Facilities/travel lift pages (high priority)
    for token in FACILITY_PATH_TOKENS:
        if token in href_lower:
            score += 20

    # Explicit high priority for /rates pages
    if "/rates" in href_lower:
        score += 40

    # Big Three: Dockwa pages (highest priority - already handled by _is_allowed_candidate_link)
    if "dockwa.com" in href_lower and "/explore/destination/" in href_lower:
        score += 50

    for token in IRRELEVANT_PATH_TOKENS:
        if token in href_lower:
            score -= 80

    for token in GENERIC_PAGE_TOKENS:
        if token in href_lower:
            score -= 40

    if href.lower().endswith(".pdf"):
        score += 15
        for keyword in PDF_BONUS_KEYWORDS:
            if keyword in haystack:
                score += 10

    return score


def _extract_links(base_url: str, html: str) -> list[tuple[str, int]]:
    soup = BeautifulSoup(html, "html.parser")
    links: list[tuple[str, int]] = []

    for anchor in soup.find_all("a"):
        href = anchor.get("href")
        if not isinstance(href, str) or not href.strip():
            continue

        stripped_href = href.strip()
        if stripped_href.startswith("#"):
            continue

        absolute = urljoin(base_url, stripped_href)
        if not absolute.startswith(("http://", "https://")):
            continue
        if absolute.lower().endswith(".pdf"):
            continue
        if not _is_allowed_candidate_link(base_url, absolute):
            continue
        if _is_top_level_url(absolute):
            continue

        text = anchor.get_text(" ", strip=True)
        score = _score_link(text, absolute)
        if score > 0:
            links.append((absolute, score))

    links.sort(key=lambda item: item[1], reverse=True)

    deduped: list[tuple[str, int]] = []
    seen: set[str] = set()
    for url, score in links:
        if url in seen:
            continue
        seen.add(url)
        deduped.append((url, score))

    return deduped


def discover_candidate_urls(
    base_url: str,
    timeout_seconds: int,
    max_pages: int,
) -> tuple[list[str], list[str]]:
    visited: list[str] = []

    try:
        resolved_url, homepage_html = _fetch_html_with_fallback(
            base_url=base_url,
            timeout_seconds=timeout_seconds,
        )
        visited.append(resolved_url)

        scored_links = _extract_links(resolved_url, homepage_html)

        candidates: list[str] = [resolved_url]
        for url, _score in scored_links:
            if url == resolved_url:
                continue
            if len(candidates) >= max_pages:
                break
            candidates.append(url)

        return visited, candidates
    except Exception as exc:
        raise DiscoveryError(str(exc)) from exc


def pick_best_candidate(candidate_urls: list[str], prefer_pdfs: bool) -> tuple[str | None, str]:
    if not candidate_urls:
        return None, "unknown"

    non_pdf_candidates = [url for url in candidate_urls if isinstance(url, str) and not url.lower().endswith(".pdf")]
    if not non_pdf_candidates:
        return None, "unknown"

    def score_candidate(url: str) -> int:
        url_lower = url.lower()
        score = 0

        if _is_dockwa_destination_url(url):
            score += 120

        if prefer_pdfs and url_lower.endswith(".pdf"):
            score += 100

        for token in FUEL_PATH_TOKENS:
            if token in url_lower:
                score += 20

        for token in IRRELEVANT_PATH_TOKENS:
            if token in url_lower:
                score -= 120

        if "#" in url_lower:
            score -= 40

        if _is_top_level_url(url):
            score -= 10

        return score

    best_url = non_pdf_candidates[0]
    best_score = score_candidate(best_url)

    for candidate in non_pdf_candidates[1:]:
        candidate_score = score_candidate(candidate)
        if candidate_score > best_score:
            best_score = candidate_score
            best_url = candidate

    return best_url, "html"
