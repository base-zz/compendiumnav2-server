from __future__ import annotations

import hashlib
import json
import re
import tempfile
from pathlib import Path
from typing import Any, Optional
from urllib.parse import urlparse

import httpx
from bs4 import BeautifulSoup
from markdownify import markdownify

try:
    import dns.resolver
    import dns.exception
except Exception:
    dns = None


class ConversionError(Exception):
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


def _resolve_hostname_with_fallback(hostname: str) -> Optional[str]:
    if dns is None:
        return None

    resolvers = ["1.1.1.1", "8.8.8.8"]
    for resolver_ip in resolvers:
        try:
            resolver = dns.resolver.Resolver()
            resolver.nameservers = [resolver_ip]
            answers = resolver.resolve(hostname, "A")
            if answers:
                return str(answers[0])
        except (dns.exception.DNSException, Exception):
            continue
    return None


def _variant_urls(parsed: urlparse.ParseResult) -> list[str]:
    urls = [parsed.geturl()]

    host = parsed.hostname
    if host and not host.startswith("www."):
        alt_host = f"www.{host}"
        alt_url = parsed._replace(netloc=alt_host).geturl()
        if alt_url not in urls:
            urls.append(alt_url)
    elif host and host.startswith("www."):
        alt_host = host[4:]
        alt_url = parsed._replace(netloc=alt_host).geturl()
        if alt_url not in urls:
            urls.append(alt_url)

    if parsed.scheme == "https":
        http_url = parsed._replace(scheme="http").geturl()
        if http_url not in urls:
            urls.append(http_url)

    return urls


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


def _is_dockwa_destination_url(url: str) -> bool:
    parsed = urlparse(url)
    host = parsed.netloc.lower()
    path = (parsed.path or "").lower()
    return "dockwa.com" in host and path.startswith("/explore/destination/")


def _fetch_html_source(url: str, timeout_seconds: int) -> tuple[str, str]:
    response = _fetch_url_with_fallback(url, timeout_seconds)
    resolved_url = str(response.url)
    html = response.text

    if _is_cloudflare_challenge_html(html):
        if _is_dockwa_destination_url(resolved_url) or _is_dockwa_destination_url(url):
            rendered_url, rendered_html = _fetch_html_with_playwright(resolved_url, timeout_seconds)
            return rendered_url, rendered_html
        raise ConversionError("Cloudflare challenge blocked HTML fetch")

    return resolved_url, html


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

        fuel_items = payload.get("fuel")
        if not isinstance(fuel_items, list):
            continue

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
            continue

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

    return None


def fetch_dockwa_fuel_snapshot(url: str, timeout_seconds: int) -> Optional[dict[str, Any]]:
    if not _is_dockwa_destination_url(url):
        return None

    _resolved_url, html = _fetch_html_source(url, timeout_seconds)
    return _extract_dockwa_fuel_from_html(html)


def _fetch_html_with_playwright(url: str, timeout_seconds: int) -> tuple[str, str]:
    try:
        from playwright.sync_api import sync_playwright
        from playwright_stealth import stealth_sync
    except Exception as exc:
        raise ConversionError(
            "Playwright fallback is required for challenge-blocked pages. "
            "Install with `pip install playwright playwright-stealth` and run `playwright install chromium`."
        ) from exc

    import random
    timeout_ms = max(timeout_seconds, 5) * 1000

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            context = browser.new_context(
                user_agent=DEFAULT_HEADERS["User-Agent"],
                viewport={"width": 1920, "height": 1080},
                timezone_id="America/New_York"
            )
            page = context.new_page()
            # Apply stealth to avoid WAF detection
            stealth_sync(page)
            # Random delay to simulate human behavior
            page.goto(url, wait_until="domcontentloaded", timeout=timeout_ms)
            page.wait_for_timeout(random.randint(2000, 5000))

            html = page.content()
            resolved_url = page.url

            if _is_cloudflare_challenge_html(html):
                raise ConversionError("Playwright fetch still returned Cloudflare challenge page")

            return resolved_url, html
        finally:
            browser.close()


def _fetch_url_with_fallback(url: str, timeout_seconds: int) -> httpx.Response:
    parsed = urlparse(url)
    variants = _variant_urls(parsed)
    errors: list[Exception] = []

    for variant in variants:
        for http2 in (True, False):
            try:
                with httpx.Client(
                    http2=http2,
                    timeout=timeout_seconds,
                    headers=DEFAULT_HEADERS,
                ) as client:
                    return client.get(variant)
            except Exception as exc:
                errors.append(exc)
                if "nodename nor servname provided" in str(exc) and parsed.hostname:
                    resolved_ip = _resolve_hostname_with_fallback(parsed.hostname)
                    if resolved_ip:
                        ip_variant = variant.replace(parsed.hostname, resolved_ip, 1)
                        try:
                            with httpx.Client(
                                http2=http2,
                                timeout=timeout_seconds,
                                headers=DEFAULT_HEADERS,
                            ) as client:
                                return client.get(ip_variant)
                        except Exception as ip_exc:
                            errors.append(ip_exc)
                            continue
                continue

    raise ConversionError(f"All fetch attempts failed: {errors}")


def _strip_non_content_html(html: str) -> str:
    soup = BeautifulSoup(html, "html.parser")
    for tag in soup(["script", "style", "noscript"]):
        tag.decompose()

    body = soup.find("body")

    if body is not None:
        return str(body)

    return str(soup)


def _hash_content(content: str) -> str:
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


def _convert_html_to_markdown(html: str) -> str:
    cleaned = _strip_non_content_html(html)
    markdown = markdownify(cleaned, heading_style="ATX")
    return _cleanup_markdown(markdown)


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


def fetch_and_convert_to_markdown(url: str, timeout_seconds: int) -> tuple[str, str]:
    try:
        response = _fetch_url_with_fallback(url, timeout_seconds)

        content_type = response.headers.get("content-type", "").lower()
        resolved_url = str(response.url)
        if "pdf" in content_type or resolved_url.lower().endswith(".pdf"):
            markdown = _convert_pdf_to_markdown(response.content)
        else:
            _resolved_url, html = _fetch_html_source(resolved_url, timeout_seconds)
            markdown = _convert_html_to_markdown(html)

        content_hash = _hash_content(markdown)
        return markdown, content_hash
    except ConversionError:
        raise
    except Exception as exc:
        raise ConversionError(str(exc)) from exc


def prune_marina_markdown(markdown: str) -> str:
    """
    Reduce token count and noise in stitched markdown before LLM processing.

    1. Keyword-Based Semantic Filter: Keep sections with data-dense keywords
    2. Regex Fluff Removal: Remove footers, navigation, empty structure
    3. Whitespace & Link Compression
    """
    import re

    # Data-dense keywords that indicate valuable content
    DATA_DENSE_KEYWORDS = [
        "slip", "rate", "ft", "beam", "lift", "haul", "launch",
        "bridge", "draft", "depth", "fee", "$", "metered",
        "catamaran", "multihull", "surcharge", "diy"
    ]

    # Step 1: Split into sections by ## headers
    sections = re.split(r'\n## ', markdown)
    filtered_sections = []

    # First section (before any ##) - always include if it has keywords
    first_section = sections[0] if sections else ""
    if any(keyword in first_section.lower() for keyword in DATA_DENSE_KEYWORDS):
        filtered_sections.append(first_section)

    # Process remaining sections
    for section in sections[1:]:
        # Check if section contains data-dense keywords
        section_lower = section.lower()
        if any(keyword in section_lower for keyword in DATA_DENSE_KEYWORDS):
            filtered_sections.append("## " + section)

    # Rejoin filtered sections
    markdown = "\n## ".join(filtered_sections)

    # Step 2: Regex Fluff Removal

    # Remove social/footer lines
    markdown = re.sub(
        r'^.*(follow us|copyright|all rights reserved|privacy policy|terms of use).*$',
        '',
        markdown,
        flags=re.MULTILINE | re.IGNORECASE
    )

    # Remove repetitive navigation links (simplified - removes common nav patterns)
    markdown = re.sub(
        r'^\s*[\*\-\+]\s*\[(?:home|about|contact|news|blog|photos|directions|local info)\]\(.*\)\s*$',
        '',
        markdown,
        flags=re.MULTILINE | re.IGNORECASE
    )

    # Remove empty table structure lines
    markdown = re.sub(r'^[\s\|\-]*$', '', markdown, flags=re.MULTILINE)

    # Remove empty lines
    markdown = re.sub(r'\n\s*\n\s*\n', '\n\n', markdown)

    # Step 3: Whitespace & Link Compression

    # Collapse multiple spaces
    markdown = re.sub(r' +', ' ', markdown)

    return markdown.strip()


def fetch_full_site_markdown(base_url: str, timeout_seconds: int, max_pages: int = 20) -> str:
    """
    Convert entire small marina website to markdown by crawling all pages.
    Returns stitched markdown from all discovered pages.
    """
    from .discovery import discover_candidate_urls

    try:
        # Crawl all pages from base URL
        visited, candidates = discover_candidate_urls(
            base_url=base_url,
            timeout_seconds=timeout_seconds,
            max_pages=max_pages
        )
    except Exception as exc:
        raise ConversionError(f"Discovery failed: {exc}") from exc

    # Combine visited and candidates (visited is just homepage, candidates are the discovered links)
    all_urls = visited + candidates
    # Deduplicate while preserving order
    seen = set()
    unique_urls = []
    for url in all_urls:
        if url not in seen:
            seen.add(url)
            unique_urls.append(url)

    # Convert every page to markdown
    markdown_sections = []
    for url in unique_urls:
        try:
            markdown, _ = fetch_and_convert_to_markdown(url, timeout_seconds)
            markdown_sections.append(f"\n\n## SOURCE: {url}\n\n{markdown}")
        except Exception:
            # Skip pages that fail to convert
            continue

    if not markdown_sections:
        raise ConversionError("No pages could be converted to markdown")

    # Stitch all pages together
    full_markdown = "\n\n".join(markdown_sections)
    return full_markdown
