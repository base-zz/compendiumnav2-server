from __future__ import annotations

from typing import Any, Optional
from .pricing_schema import VesselProfile, CompatibilityReport


def calculate_monthly_cost(
    vessel: VesselProfile,
    pricing_data: dict[str, Any],
) -> Optional[float]:
    """
    Calculate estimated monthly cost based on vessel profile and pricing data.
    """
    monthly_base = pricing_data.get("monthly_base")
    is_per_ft = pricing_data.get("is_per_ft")
    catamaran_multiplier = pricing_data.get("catamaran_multiplier")
    liveaboard_fee = pricing_data.get("liveaboard_fee")

    if monthly_base is None:
        return None

    # Calculate base cost
    if is_per_ft:
        base_cost = monthly_base * vessel.length_ft
    else:
        base_cost = monthly_base

    # Apply catamaran multiplier if applicable
    if vessel.is_multihull and catamaran_multiplier:
        base_cost *= catamaran_multiplier

    # Add liveaboard fee
    if liveaboard_fee:
        base_cost += liveaboard_fee

    return base_cost


def validate_vessel_compatibility(
    vessel: VesselProfile,
    pricing_data: dict[str, Any],
) -> CompatibilityReport:
    """
    Validate vessel compatibility with marina based on pricing and facility data.
    Returns a compatibility report with safety checks, cost estimate, and violations.
    """
    violations: list[str] = []
    warnings: list[str] = []
    is_safe = True

    # Safety Check: Air Draft (Bridge clearance)
    min_air_draft = pricing_data.get("min_air_draft_ft")
    if min_air_draft is not None:
        if vessel.air_draft_ft >= min_air_draft:
            violations.append(
                f"Air draft violation: vessel air draft ({vessel.air_draft_ft}ft) "
                f">= marina bridge clearance ({min_air_draft}ft)"
            )
            is_safe = False
        elif vessel.air_draft_ft >= min_air_draft * 0.95:
            warnings.append(
                f"Air draft warning: vessel air draft ({vessel.air_draft_ft}ft) "
                f"close to bridge clearance ({min_air_draft}ft)"
            )

    # Safety Check: Water Depth
    min_depth = pricing_data.get("min_depth_ft")
    if min_depth is not None:
        # Add 1.0ft safety margin for keel clearance
        required_depth = vessel.draft_ft + 1.0
        if required_depth >= min_depth:
            violations.append(
                f"Depth violation: vessel draft + margin ({required_depth}ft) "
                f">= marina depth ({min_depth}ft)"
            )
            is_safe = False
        elif required_depth >= min_depth * 0.95:
            warnings.append(
                f"Depth warning: vessel draft + margin ({required_depth}ft) "
                f"close to marina depth ({min_depth}ft)"
            )

    # Maintenance Check: Haul-out compatibility
    if vessel.needs_haulout:
        lift_max_beam = pricing_data.get("lift_max_beam_ft")
        has_travel_lift = pricing_data.get("has_travel_lift") or lift_max_beam is not None

        if not has_travel_lift:
            violations.append(
                "Haul-out required but marina has no travel lift"
            )
            is_safe = False
        elif lift_max_beam is not None:
            if vessel.beam_ft >= lift_max_beam:
                violations.append(
                    f"Beam violation: vessel beam ({vessel.beam_ft}ft) "
                    f">= travel lift max beam ({lift_max_beam}ft)"
                )
                is_safe = False
            elif vessel.beam_ft >= lift_max_beam * 0.95:
                warnings.append(
                    f"Beam warning: vessel beam ({vessel.beam_ft}ft) "
                    f"close to travel lift max beam ({lift_max_beam}ft)"
                )

    # Calculate cost
    total_cost = calculate_monthly_cost(vessel, pricing_data)

    # Build cost breakdown
    cost_breakdown: dict[str, Any] = {}
    if total_cost is not None:
        cost_breakdown["monthly_base"] = pricing_data.get("monthly_base")
        cost_breakdown["is_per_ft"] = pricing_data.get("is_per_ft")
        cost_breakdown["vessel_length_ft"] = vessel.length_ft
        cost_breakdown["catamaran_multiplier"] = pricing_data.get("catamaran_multiplier")
        cost_breakdown["liveaboard_fee"] = pricing_data.get("liveaboard_fee")
        cost_breakdown["is_multihull"] = vessel.is_multihull
        cost_breakdown["total_monthly_cost"] = total_cost

    return CompatibilityReport(
        is_safe=is_safe,
        total_estimated_cost=total_cost,
        constraint_violations=violations,
        warnings=warnings,
        cost_breakdown=cost_breakdown,
    )


def rank_marinas_by_compatibility(
    vessel: VesselProfile,
    marinas_data: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """
    Rank multiple marinas by compatibility with a vessel profile.
    Returns sorted list with compatibility reports.
    """
    results = []

    for marina in marinas_data:
        pricing_data = marina.get("pricing_data", {})
        report = validate_vessel_compatibility(vessel, pricing_data)

        results.append({
            "marina_uid": marina.get("marina_uid"),
            "marina_name": marina.get("marina_name"),
            "is_safe": report.is_safe,
            "estimated_monthly_cost": report.total_estimated_cost,
            "violations_count": len(report.constraint_violations),
            "warnings_count": len(report.warnings),
            "compatibility_report": report.model_dump(),
        })

    # Sort: safe first, then by cost (ascending), then by violations count (ascending)
    results.sort(
        key=lambda x: (
            not x["is_safe"],
            x["estimated_monthly_cost"] if x["estimated_monthly_cost"] else float("inf"),
            x["violations_count"],
        )
    )

    return results
