export function transformAnchorData(raw) {
  return {
    anchorDropLocation: raw.anchorDropLocation,
    anchorLocation: raw.anchorLocation,
    rode: raw.rode,
    dragging: raw.dragging,
    anchorDeployed: raw.anchorDeployed,
    criticalRange: raw.criticalRange,
  };
}