from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, Field, HttpUrl


class ExtractRequest(BaseModel):
    job_id: str = Field(min_length=1)
    fuel_source_id: int
    name: str = Field(min_length=1)
    website_url: HttpUrl
    phone: Optional[str] = None
    lat: float
    lon: float
    max_discovery_depth: int = Field(default=2, ge=1, le=2)
    max_pages: int = Field(default=8, ge=1, le=20)
    prefer_pdfs: bool = True
    timeout_seconds: int = Field(default=45, ge=5, le=120)
    skip_if_verified_within_hours: int = Field(default=24, ge=1, le=168)


class DiscoveryResult(BaseModel):
    visited_urls: list[str] = Field(default_factory=list)
    candidate_urls: list[str] = Field(default_factory=list)
    selected_url: Optional[str] = None
    selected_content_type: Literal["html", "pdf", "unknown"] = "unknown"


class ExtractionResult(BaseModel):
    diesel_price: Optional[float] = None
    is_valvtect: Optional[bool] = None
    gasoline_price: Optional[float] = None
    fuel_dock: Optional[bool] = None
    is_non_ethanol: Optional[bool] = None
    last_updated: Optional[str] = None
    source_text: Optional[str] = None
    source_text_date: Optional[str] = None
    source_url: Optional[str] = None
    fuel_source_id: Optional[int] = None
    confidence: float = Field(default=0.0, ge=0.0, le=1.0)


class EvidenceResult(BaseModel):
    source_url: Optional[str] = None
    content_sha256: Optional[str] = None
    markdown_excerpt: Optional[str] = None


class ExtractResponse(BaseModel):
    job_id: str
    fuel_source_id: int
    status: Literal["success", "no_data", "error"]
    reason: Optional[str] = None
    discovery: DiscoveryResult = Field(default_factory=DiscoveryResult)
    extraction: ExtractionResult = Field(default_factory=ExtractionResult)
    evidence: EvidenceResult = Field(default_factory=EvidenceResult)
    timing_ms: int = 0
    error_code: Optional[str] = None
