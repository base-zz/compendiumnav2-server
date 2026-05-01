from __future__ import annotations

from typing import Any, Optional
from pydantic import BaseModel, Field, field_validator


class RateInfo(BaseModel):
    value: Optional[float] = None
    unit: Optional[str] = None
    is_per_foot: bool = False


class Surcharges(BaseModel):
    catamaran_multiplier: Optional[float] = Field(None, ge=1.0)
    liveaboard_fee: Optional[float] = Field(None, ge=0.0)
    liveaboard_unit: Optional[str] = None


class NavigationalLimits(BaseModel):
    min_air_draft_ft: Optional[float] = Field(None, ge=0.0)
    air_draft_source: Optional[str] = None
    min_depth_ft: Optional[float] = Field(None, ge=0.0)
    depth_source: Optional[str] = None


class HauloutSpecs(BaseModel):
    has_travel_lift: Optional[bool] = None
    max_beam_ft: Optional[float] = Field(None, ge=0.0)
    max_tons: Optional[float] = Field(None, ge=0.0)
    diy_allowed: Optional[bool] = None


class UtilityPolicies(BaseModel):
    electricity_metered: Optional[bool] = None
    water_metered: Optional[bool] = None
    liveaboard_permitted: Optional[bool] = None


class PricingExtraction(BaseModel):
    marina_name: Optional[str] = None
    rates: dict[str, RateInfo] = Field(default_factory=dict)
    surcharges: Surcharges = Field(default_factory=Surcharges)
    navigational_limits: NavigationalLimits = Field(default_factory=NavigationalLimits)
    haulout_specs: HauloutSpecs = Field(default_factory=HauloutSpecs)
    utility_policies: UtilityPolicies = Field(default_factory=UtilityPolicies)
    source_quotes: list[str] = Field(default_factory=list)

    @field_validator("rates")
    @classmethod
    def validate_rates(cls, v: dict[str, Any]) -> dict[str, RateInfo]:
        valid_rates = {}
        for key, value in v.items():
            if key in ("daily", "monthly", "annual"):
                if isinstance(value, dict):
                    valid_rates[key] = RateInfo(**value)
                elif isinstance(value, RateInfo):
                    valid_rates[key] = value
        return valid_rates


class VesselProfile(BaseModel):
    name: str = Field(..., min_length=1)
    length_ft: float = Field(..., gt=0.0)
    beam_ft: float = Field(..., gt=0.0)
    draft_ft: float = Field(..., gt=0.0)
    air_draft_ft: float = Field(..., gt=0.0)
    is_multihull: bool = False
    needs_haulout: bool = False


class CompatibilityReport(BaseModel):
    is_safe: bool
    total_estimated_cost: Optional[float] = None
    constraint_violations: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    cost_breakdown: dict[str, Any] = Field(default_factory=dict)


class PricingLog(BaseModel):
    marina_uid: str
    fetched_at_utc: str
    monthly_base: Optional[float] = None
    is_per_ft: Optional[bool] = None
    catamaran_multiplier: Optional[float] = None
    liveaboard_fee: Optional[float] = None
    min_air_draft_ft: Optional[float] = None
    air_draft_source: Optional[str] = None
    min_depth_ft: Optional[float] = None
    depth_source: Optional[str] = None
    lift_max_beam_ft: Optional[float] = None
    lift_max_tons: Optional[float] = None
    diy_allowed: Optional[bool] = None
    electricity_metered: Optional[bool] = None
    water_metered: Optional[bool] = None
    liveaboard_permitted: Optional[bool] = None
    source_quotes: list[str] = Field(default_factory=list)
    extraction_hash: Optional[str] = None
    sync_dirty: bool = True
