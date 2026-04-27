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

IRRELEVANT_PATH_TOKENS = (
    "/boat-rentals",
    "/faq",
    "#boat-rentals",
)


class DiscoveryError(Exception):
    pass


DEFAULT_HEADERS = {
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}


def _variant_urls(base_url: str) -> list[str]:
    parsed = urlparse(base_url)
    if not parsed.scheme or not parsed.netloc:
        return [base_url]

    urls = [base_url]
    host = parsed.netloc

    if host.startswith("www."):
        alt_host = host[4:]
    else:
        alt_host = f"www.{host}"

    alt_url = parsed._replace(netloc=alt_host).geturl()
    if alt_url not in urls:
        urls.append(alt_url)

    return urls


def _fetch_html_with_fallback(base_url: str, timeout_seconds: int) -> tuple[str, str]:
    errors: list[str] = []

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
            except Exception as exc:
                errors.append(f"{candidate_url} (http2={use_http2}): {exc}")

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

    href_lower = href.lower()
    for token in FUEL_PATH_TOKENS:
        if token in href_lower:
            score += 10

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
