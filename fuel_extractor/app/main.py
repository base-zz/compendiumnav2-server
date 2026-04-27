from __future__ import annotations

import os
import re
import time
from typing import Optional
from urllib.parse import urlparse

from fastapi import FastAPI

from .discovery import DiscoveryError, discover_candidate_urls, pick_best_candidate
from .dockwa_lookup import find_dockwa_link_for_marina
from .marina_fuel_merge import MarinaFuelMergeError, merge_marina_fuel_data
from .markdown_convert import ConversionError, fetch_and_convert_to_markdown, fetch_dockwa_fuel_snapshot
from .ollama_client import ExtractionError, OllamaClient
from .schemas import ExtractRequest, ExtractResponse

app = FastAPI(title="Nexus Fuel Extractor", version="0.1.0")

FUEL_DOCK_POSITIVE_PATTERNS = (
    r"\bfuel\s*dock\b",
    r"\bon[-\s]?site\s*fuel\b",
    r"\bfuel\s*station\b",
    r"\bmarine\s*fuel\b",
    r"\bfuel\s+available\b",
)

FUEL_DOCK_NEGATIVE_PATTERNS = (
    r"\bno\s+fuel\b",
    r"\bwithout\s+fuel\b",
    r"\bfuel\s+not\s+available\b",
)

FUEL_PRICE_TERMS = (
    "diesel",
    "gas",
    "gasoline",
    "fuel",
    "rec90",
    "non-ethanol",
)


def _is_dockwa_destination_url(url: str) -> bool:
    if not isinstance(url, str) or not url:
        return False
    parsed = urlparse(url)
    host = parsed.netloc.lower()
    path = (parsed.path or "").lower()
    return "dockwa.com" in host and path.startswith("/explore/destination/")


def _has_explicit_fuel_price_evidence(source_text: Optional[str]) -> bool:
    if not isinstance(source_text, str) or not source_text.strip():
        return False

    lowered = source_text.lower()
    has_fuel_context = any(term in lowered for term in FUEL_PRICE_TERMS)
    if not has_fuel_context:
        return False

    return bool(re.search(r"\$\s*\d{1,2}\.\d{2,3}|\d{1,2}\.\d{2,3}\s*/\s*(gal|gallon)", lowered))


def _price_has_fuel_context_in_text(price_value: float, text: Optional[str]) -> bool:
    if price_value is None:
        return False
    if not isinstance(text, str) or not text.strip():
        return False

    lowered = text.lower()
    price_tokens = {
        str(price_value),
        f"{price_value:.2f}",
        f"{price_value:.3f}",
        f"${price_value:.2f}",
        f"${price_value:.3f}",
    }

    for token in price_tokens:
        token_escaped = re.escape(token.lower())
        if re.search(rf"(diesel|gas|gasoline|fuel|rec90|non-ethanol).{{0,120}}{token_escaped}", lowered):
            return True
        if re.search(rf"{token_escaped}.{{0,120}}(diesel|gas|gasoline|fuel|rec90|non-ethanol)", lowered):
            return True

    return False


def _has_fuel_dock_evidence(text: Optional[str]) -> bool:
    if not isinstance(text, str) or not text.strip():
        return False

    lowered = text.lower()
    if any(re.search(pattern, lowered) for pattern in FUEL_DOCK_NEGATIVE_PATTERNS):
        return False

    return any(re.search(pattern, lowered) for pattern in FUEL_DOCK_POSITIVE_PATTERNS)


def _extract_fuel_dock_source_text(text: Optional[str]) -> Optional[str]:
    if not isinstance(text, str) or not text.strip():
        return None

    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        lowered = line.lower()
        if any(re.search(pattern, lowered) for pattern in FUEL_DOCK_NEGATIVE_PATTERNS):
            continue
        if any(re.search(pattern, lowered) for pattern in FUEL_DOCK_POSITIVE_PATTERNS):
            return line

    return None


def _enforce_price_evidence_guard(response: ExtractResponse) -> None:
    if response.extraction is None:
        return

    has_any_price = (
        response.extraction.diesel_price is not None
        or response.extraction.gasoline_price is not None
    )
    if not has_any_price:
        return

    source_text = response.extraction.source_text
    evidence_text = response.evidence.markdown_excerpt if response.evidence else None

    if response.extraction.diesel_price is not None:
        diesel_supported = (
            _has_explicit_fuel_price_evidence(source_text)
            or _price_has_fuel_context_in_text(response.extraction.diesel_price, source_text)
            or _price_has_fuel_context_in_text(response.extraction.diesel_price, evidence_text)
        )
        if not diesel_supported:
            response.extraction.diesel_price = None

    if response.extraction.gasoline_price is not None:
        gasoline_supported = (
            _has_explicit_fuel_price_evidence(source_text)
            or _price_has_fuel_context_in_text(response.extraction.gasoline_price, source_text)
            or _price_has_fuel_context_in_text(response.extraction.gasoline_price, evidence_text)
        )
        if not gasoline_supported:
            response.extraction.gasoline_price = None

    if response.extraction.diesel_price is not None or response.extraction.gasoline_price is not None:
        return

    response.extraction.confidence = 0.0
    response.reason = "Price evidence missing in source quote"


def _enforce_fuel_dock_evidence_guard(response: ExtractResponse) -> None:
    if response.extraction is None:
        return

    if response.extraction.fuel_dock is not True:
        return

    source_text = response.extraction.source_text
    evidence_text = response.evidence.markdown_excerpt if response.evidence else None
    has_evidence = _has_fuel_dock_evidence(source_text) or _has_fuel_dock_evidence(evidence_text)
    if has_evidence:
        return

    response.extraction.fuel_dock = None


FUEL_SECTION_TERMS = (
    "fuel dock",
    "fuel",
    "diesel",
    "gasoline",
    "valvtect",
    "non-ethanol",
    "pump-outs",
    "pump outs",
)


def _sanitize_markdown_for_llm(markdown: str) -> str:
    if not isinstance(markdown, str):
        return ""

    text = markdown

    # Remove markdown images entirely
    text = re.sub(r"!\[[^\]]*\]\([^\)]*\)", "", text)

    # Convert markdown links to plain link text
    text = re.sub(r"\[([^\]]+)\]\([^\)]*\)", r"\1", text)

    # Remove leftover markdown anchor-only fragments
    text = re.sub(r"\]\(#.*?\)", "", text)
    text = re.sub(r"\(#.*?\)", "", text)
    text = re.sub(r"\[[\s\]]*", "", text)

    # Remove bare URLs
    text = re.sub(r"https?://\S+", "", text)

    social_icon_tokens = {
        "facebook",
        "instagram",
        "linkedin",
        "youtube",
        "twitter",
        "pinterest",
        "rss",
    }

    lines = text.splitlines()
    cleaned_lines: list[str] = []
    for line in lines:
        stripped = line.strip()
        if not stripped:
            cleaned_lines.append("")
            continue

        # Drop obvious javascript/link artifacts
        if "javascript:" in stripped.lower():
            continue

        # Drop bullets that become empty after cleanup
        if stripped in ("*", "-", "|", "\\|"):
            continue

        lowered = stripped.lower()
        if lowered in social_icon_tokens:
            continue

        if lowered.startswith("xml version"):
            continue

        cleaned_lines.append(line)

    cleaned = "\n".join(cleaned_lines)
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned)
    return cleaned.strip()


def _split_markdown_sections(markdown: str) -> list[str]:
    if not isinstance(markdown, str) or not markdown.strip():
        return []

    sections = re.split(r"\n\s*\n", markdown)
    cleaned: list[str] = []
    for section in sections:
        text = section.strip()
        if text:
            cleaned.append(text)
    return cleaned


def _build_fuel_markdown_context(markdown: str, max_chars: int = 8000) -> str:
    sections = _split_markdown_sections(markdown)
    if not sections:
        return ""

    matched_sections: list[str] = []
    for section in sections:
        lower = section.lower()
        if any(term in lower for term in FUEL_SECTION_TERMS):
            matched_sections.append(section)

    if not matched_sections:
        return ""

    context = "\n\n".join(matched_sections)
    context = _sanitize_markdown_for_llm(context)
    return context[:max_chars]


def _build_evidence_excerpt(markdown: str, max_chars: int = 4000) -> str:
    if not isinstance(markdown, str) or not markdown:
        return ""

    sanitized = _sanitize_markdown_for_llm(markdown)
    lower = sanitized.lower()
    indices = [lower.find(term) for term in FUEL_SECTION_TERMS if lower.find(term) != -1]
    if not indices:
        return sanitized[:max_chars]

    start = max(0, min(indices) - max_chars // 4)
    end = min(len(sanitized), start + max_chars)
    return sanitized[start:end]


def _pick_html_fallback_candidates(candidate_urls: list[str], current_url: Optional[str]) -> list[str]:
    if not isinstance(candidate_urls, list) or not candidate_urls:
        return []

    fallbacks: list[str] = []

    for candidate in candidate_urls:
        if not isinstance(candidate, str) or not candidate:
            continue
        if candidate == current_url:
            continue
        if candidate.lower().endswith(".pdf"):
            continue
        if not candidate.startswith(("http://", "https://")):
            continue
        fallbacks.append(candidate)

    return fallbacks


def _use_marinas_dockwa_lookup() -> bool:
    configured = os.getenv("FUEL_EXTRACTOR_ENABLE_MARINAS_DOCKWA_LOOKUP")
    return configured == "1"


def _use_marina_fuel_merge() -> bool:
    configured = os.getenv("FUEL_EXTRACTOR_ENABLE_MARINA_FUEL_MERGE")
    return configured == "1"


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/v1/fuel/extract", response_model=ExtractResponse)
def extract_fuel(request: ExtractRequest) -> ExtractResponse:
    start = time.perf_counter()

    response = ExtractResponse(
        job_id=request.job_id,
        fuel_source_id=request.fuel_source_id,
        status="no_data",
        reason="No explicit fuel evidence extracted yet",
    )

    try:
        base_url = str(request.website_url)

        if _is_dockwa_destination_url(base_url):
            visited = [base_url]
            candidates = [base_url]
        else:
            visited, candidates = discover_candidate_urls(
                base_url=base_url,
                timeout_seconds=request.timeout_seconds,
                max_pages=request.max_pages,
            )

        response.discovery.visited_urls = visited
        response.discovery.candidate_urls = candidates

        if _is_dockwa_destination_url(base_url):
            selected_url = base_url
            selected_content_type = "html"
        else:
            selected_url, selected_content_type = pick_best_candidate(
                candidate_urls=candidates,
                prefer_pdfs=request.prefer_pdfs,
            )

        response.discovery.selected_url = selected_url
        response.discovery.selected_content_type = selected_content_type

        if selected_url is None:
            response.status = "no_data"
            response.reason = "No candidate fuel-related links discovered"
            response.timing_ms = int((time.perf_counter() - start) * 1000)
            return response

        def run_extraction_for_url(active_url: str) -> None:
            markdown, content_hash = fetch_and_convert_to_markdown(
                url=active_url,
                timeout_seconds=request.timeout_seconds,
            )

            response.status = "success"
            response.reason = "Discovery and markdown conversion completed"
            response.evidence.source_url = active_url
            response.evidence.content_sha256 = content_hash
            response.evidence.markdown_excerpt = _build_evidence_excerpt(markdown, max_chars=12000)

            response.extraction.diesel_price = None
            response.extraction.is_valvtect = None
            response.extraction.gasoline_price = None
            response.extraction.fuel_dock = None
            response.extraction.is_non_ethanol = None
            response.extraction.last_updated = None
            response.extraction.source_text = None
            response.extraction.source_text_date = None
            response.extraction.source_url = active_url
            response.extraction.fuel_source_id = request.fuel_source_id
            response.extraction.confidence = 0.0

            dockwa_snapshot = None
            if _is_dockwa_destination_url(active_url):
                dockwa_snapshot = fetch_dockwa_fuel_snapshot(active_url, request.timeout_seconds)

            if isinstance(dockwa_snapshot, dict):
                response.extraction.diesel_price = dockwa_snapshot.get("diesel_price")
                response.extraction.gasoline_price = dockwa_snapshot.get("gasoline_price")
                response.extraction.fuel_dock = dockwa_snapshot.get("fuel_dock")
                response.extraction.is_non_ethanol = dockwa_snapshot.get("is_non_ethanol")
                response.extraction.last_updated = dockwa_snapshot.get("last_updated")
                response.extraction.source_text = dockwa_snapshot.get("source_text")
                has_price = response.extraction.diesel_price is not None or response.extraction.gasoline_price is not None
                if has_price and response.extraction.fuel_dock is None:
                    response.extraction.fuel_dock = True
                response.extraction.confidence = 1.0 if has_price else 0.0
                return

            if _use_marina_fuel_merge():
                try:
                    merged = merge_marina_fuel_data(active_url, request.timeout_seconds)
                except MarinaFuelMergeError:
                    merged = None

                if isinstance(merged, dict):
                    response.extraction.diesel_price = merged.get("diesel_price")
                    response.extraction.gasoline_price = merged.get("gasoline_price")
                    response.extraction.fuel_dock = merged.get("fuel_dock")
                    response.extraction.is_non_ethanol = merged.get("is_non_ethanol")
                    response.extraction.last_updated = merged.get("last_updated")
                    response.extraction.source_text = merged.get("source_text")

                    merged_source_url = merged.get("source_url")
                    if isinstance(merged_source_url, str) and merged_source_url.strip():
                        response.extraction.source_url = merged_source_url

                    merged_confidence = merged.get("confidence")
                    if isinstance(merged_confidence, (int, float)):
                        response.extraction.confidence = float(merged_confidence)

                    merged_dockwa_url = merged.get("dockwa_url")
                    if (
                        isinstance(merged_dockwa_url, str)
                        and merged_dockwa_url.strip()
                        and _is_dockwa_destination_url(merged_dockwa_url)
                        and isinstance(response.discovery.candidate_urls, list)
                        and merged_dockwa_url not in response.discovery.candidate_urls
                    ):
                        response.discovery.candidate_urls.append(merged_dockwa_url)

                    has_merged_price = (
                        response.extraction.diesel_price is not None
                        or response.extraction.gasoline_price is not None
                    )
                    if has_merged_price:
                        response.discovery.selected_url = merged_dockwa_url or response.discovery.selected_url
                        response.discovery.selected_content_type = "html"
                        return

            try:
                ollama = OllamaClient()
                extracted = ollama.extract_fuel_data(response.evidence.markdown_excerpt)
                response.extraction.diesel_price = extracted.get("diesel_price")
                response.extraction.is_valvtect = extracted.get("is_valvtect")
                response.extraction.gasoline_price = extracted.get("gasoline_price")
                response.extraction.fuel_dock = extracted.get("fuel_dock")
                response.extraction.is_non_ethanol = extracted.get("is_non_ethanol")
                response.extraction.last_updated = extracted.get("last_updated")
                response.extraction.source_text = extracted.get("source_text")
                response.extraction.source_text_date = extracted.get("source_text_date")
                response.extraction.confidence = extracted.get("confidence", 0.0)
            except ExtractionError as exc:
                response.extraction.confidence = 0.0
                response.reason = f"Extraction failed: {exc}"

        run_extraction_for_url(selected_url)

        _enforce_price_evidence_guard(response)
        _enforce_fuel_dock_evidence_guard(response)

        has_price = response.extraction.diesel_price is not None or response.extraction.gasoline_price is not None
        has_fuel_dock = response.extraction.fuel_dock is True

        evidence_fuel_dock_source = _extract_fuel_dock_source_text(
            response.evidence.markdown_excerpt if response.evidence else None
        )
        if evidence_fuel_dock_source:
            response.extraction.fuel_dock = True
            if not response.extraction.source_text:
                response.extraction.source_text = evidence_fuel_dock_source
            if response.extraction.confidence < 0.6:
                response.extraction.confidence = 0.6
            has_fuel_dock = True

        if (
            not has_price
            and not has_fuel_dock
            and response.discovery.selected_content_type == "pdf"
        ):
            html_fallback_urls = _pick_html_fallback_candidates(
                response.discovery.candidate_urls,
                response.discovery.selected_url,
            )
            for html_fallback_url in html_fallback_urls:
                response.discovery.selected_url = html_fallback_url
                response.discovery.selected_content_type = "html"
                run_extraction_for_url(html_fallback_url)
                _enforce_price_evidence_guard(response)
                _enforce_fuel_dock_evidence_guard(response)
                has_price = response.extraction.diesel_price is not None or response.extraction.gasoline_price is not None
                has_fuel_dock = response.extraction.fuel_dock is True
                evidence_fuel_dock_source = _extract_fuel_dock_source_text(response.evidence.markdown_excerpt)
                if evidence_fuel_dock_source:
                    response.extraction.fuel_dock = True
                    if not response.extraction.source_text:
                        response.extraction.source_text = evidence_fuel_dock_source
                    if response.extraction.confidence < 0.6:
                        response.extraction.confidence = 0.6
                    has_fuel_dock = True
                if has_price or has_fuel_dock:
                    break

        if (
            not has_price
            and not has_fuel_dock
            and _use_marinas_dockwa_lookup()
            and not _is_dockwa_destination_url(base_url)
        ):
            dockwa_url = find_dockwa_link_for_marina(base_url, request.timeout_seconds)
            if isinstance(dockwa_url, str) and dockwa_url.strip() and _is_dockwa_destination_url(dockwa_url):
                response.discovery.selected_url = dockwa_url
                response.discovery.selected_content_type = "html"
                if isinstance(response.discovery.candidate_urls, list) and dockwa_url not in response.discovery.candidate_urls:
                    response.discovery.candidate_urls.append(dockwa_url)

                run_extraction_for_url(dockwa_url)
                _enforce_price_evidence_guard(response)
                _enforce_fuel_dock_evidence_guard(response)

                has_price = response.extraction.diesel_price is not None or response.extraction.gasoline_price is not None
                has_fuel_dock = response.extraction.fuel_dock is True

                evidence_fuel_dock_source = _extract_fuel_dock_source_text(response.evidence.markdown_excerpt)
                if evidence_fuel_dock_source:
                    response.extraction.fuel_dock = True
                    if not response.extraction.source_text:
                        response.extraction.source_text = evidence_fuel_dock_source
                    if response.extraction.confidence < 0.6:
                        response.extraction.confidence = 0.6
                    has_fuel_dock = True

        # Strict no-guess: require source quote and at least one explicit fuel signal.
        if not response.extraction.source_text or (not has_price and not has_fuel_dock):
            response.status = "no_data"
            response.reason = "Missing source quote or explicit fuel signal"
        elif response.extraction.confidence < 0.5 and not has_fuel_dock:
            response.status = "no_data"
            response.reason = "Insufficient confidence or missing source quote"

        # Strict no-guess behavior: extraction values remain null until explicit
        # evidence-based extraction module is added.

    except DiscoveryError as exc:
        response.status = "error"
        response.error_code = "DISCOVERY_ERROR"
        response.reason = str(exc)
    except ConversionError as exc:
        response.status = "error"
        response.error_code = "CONVERSION_ERROR"
        response.reason = str(exc)
    except Exception as exc:
        response.status = "error"
        response.error_code = "UNKNOWN_ERROR"
        response.reason = str(exc)

    response.timing_ms = int((time.perf_counter() - start) * 1000)
    return response
