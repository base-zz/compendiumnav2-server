// Anchor state helper utilities
// These functions recompute derived anchor fields based on current
// boat position, anchor configuration, and AIS targets.

/**
 * Calculate distance between two points in meters (Haversine formula)
 * @param {number} lat1
 * @param {number} lon1
 * @param {number} lat2
 * @param {number} lon2
 * @returns {number} distance in meters
 */
function calculateDistance(lat1, lon1, lat2, lon2) {
  if (
    lat1 == null || lon1 == null ||
    lat2 == null || lon2 == null
  ) {
    return 0;
  }

  const toRad = (value) => (value * Math.PI) / 180;
  const R = 6371e3; // Earth radius in meters
  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const Δφ = toRad(lat2 - lat1);
  const Δλ = toRad(lon2 - lon1);

  const a =
    Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c;
}

/**
 * Calculate bearing in degrees from point 1 to point 2
 * @param {number} lat1
 * @param {number} lon1
 * @param {number} lat2
 * @param {number} lon2
 * @returns {number} bearing in degrees (0-360)
 */
function calculateBearing(lat1, lon1, lat2, lon2) {
  if (
    lat1 == null || lon1 == null ||
    lat2 == null || lon2 == null
  ) {
    return 0;
  }

  const toRad = (value) => (value * Math.PI) / 180;
  const toDeg = (value) => (value * 180) / Math.PI;

  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const λ1 = toRad(lon1);
  const λ2 = toRad(lon2);
  const Δλ = λ2 - λ1;

  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x =
    Math.cos(φ1) * Math.sin(φ2) -
    Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);

  let θ = Math.atan2(y, x);
  let bearing = toDeg(θ);

  if (!Number.isFinite(bearing)) {
    return 0;
  }

  // Normalize to 0-360
  bearing = (bearing + 360) % 360;
  return bearing;
}

/**
 * Recompute derived anchor fields based on the current application state.
 *
 * This function is pure: it does not mutate the input state. It returns
 * a new anchor object when it can compute derived fields, or null if
 * there is not enough data to do meaningful work.
 *
 * Expected structures (based on current server rules and state model):
 * - appState.position: { latitude: number, longitude: number, ... }
 * - appState.anchor.anchorDropLocation.position: { latitude: number, longitude: number }
 * - appState.anchor.anchorLocation.position: { latitude: number, longitude: number }
 * - appState.anchor.criticalRange.r: number
 * - appState.anchor.warningRange.r: number
 * - appState.ais.targets: [ { position: { latitude, longitude } } ]
 *
 * @param {Object} appState - Full application state from StateManager
 * @returns {Object|null} updated anchor object or null if unchanged
 */
export function recomputeAnchorDerivedState(appState) {
  if (!appState || typeof appState !== "object") {
    return null;
  }

  const anchor = appState.anchor;
  const boatPosition = appState.position;

  if (!anchor || typeof anchor !== "object") {
    return null;
  }

  // We only recompute when anchor is deployed and we have a boat position
  if (!anchor.anchorDeployed || !boatPosition) {
    return null;
  }

  const boatLat = boatPosition.latitude;
  const boatLon = boatPosition.longitude;

  if (boatLat == null || boatLon == null) {
    return null;
  }

  const dropPos = anchor.anchorDropLocation?.position || null;
  const anchorPos = anchor.anchorLocation?.position || null;

  const dropLat = dropPos?.latitude ?? null;
  const dropLon = dropPos?.longitude ?? null;
  const anchorLat = anchorPos?.latitude ?? null;
  const anchorLon = anchorPos?.longitude ?? null;

  const criticalRange = anchor.criticalRange?.r ?? null;
  const warningRadius = anchor.warningRange?.r ?? null;

  let updatedAnchor = { ...anchor };
  let changed = false;

  // --- Distances and bearings relative to DROP location ---
  if (dropLat != null && dropLon != null) {
    const distanceBoatFromDrop = calculateDistance(boatLat, boatLon, dropLat, dropLon);
    const bearingDropToBoat = calculateBearing(dropLat, dropLon, boatLat, boatLon);

    const updatedDropLocation = {
      ...(anchor.anchorDropLocation || {}),
      position: dropPos,
      distancesFromCurrent: {
        ...(anchor.anchorDropLocation?.distancesFromCurrent || {}),
        value: distanceBoatFromDrop,
      },
      // distancesFromDrop is defined in the model but its exact semantics
      // depend on how drop vs anchor are interpreted. For now we leave any
      // existing value unchanged to avoid unintended side effects.
      bearing: {
        ...(anchor.anchorDropLocation?.bearing || {}),
        value: bearingDropToBoat,
      },
    };

    updatedAnchor = {
      ...updatedAnchor,
      anchorDropLocation: updatedDropLocation,
    };
    changed = true;

    // Update dragging flag based on same semantics as Anchor Dragging Detection rule
    if (criticalRange != null && Number.isFinite(criticalRange)) {
      const anchorDragTriggerDistance = 5; // meters, matches rule buffer
      const isDragging =
        distanceBoatFromDrop > criticalRange + anchorDragTriggerDistance;

      if (updatedAnchor.dragging !== isDragging) {
        updatedAnchor.dragging = isDragging;
        changed = true;
      }
    }
  }

  // --- Distances and bearings relative to ANCHOR location ---
  if (anchorLat != null && anchorLon != null) {
    const distanceBoatFromAnchor = calculateDistance(
      boatLat,
      boatLon,
      anchorLat,
      anchorLon
    );
    const bearingAnchorToBoat = calculateBearing(
      anchorLat,
      anchorLon,
      boatLat,
      boatLon
    );

    let distancesFromDrop = anchor.anchorLocation?.distancesFromDrop;

    // If we have both positions, we can recompute how far the anchor has
    // moved from the drop point.
    if (dropLat != null && dropLon != null) {
      const distanceAnchorFromDrop = calculateDistance(
        dropLat,
        dropLon,
        anchorLat,
        anchorLon
      );

      distancesFromDrop = {
        ...(distancesFromDrop || {}),
        value: distanceAnchorFromDrop,
      };
    }

    const updatedAnchorLocation = {
      ...(anchor.anchorLocation || {}),
      position: anchorPos,
      distancesFromCurrent: {
        ...(anchor.anchorLocation?.distancesFromCurrent || {}),
        value: distanceBoatFromAnchor,
      },
      distancesFromDrop,
      bearing: {
        ...(anchor.anchorLocation?.bearing || {}),
        value: bearingAnchorToBoat,
      },
    };

    updatedAnchor = {
      ...updatedAnchor,
      anchorLocation: updatedAnchorLocation,
    };
    changed = true;
  }

  // --- History (breadcrumbs) ---
  const historyEntry = {
    position: {
      latitude: boatLat,
      longitude: boatLon,
    },
    time: Date.now(),
  };

  const existingHistory = Array.isArray(updatedAnchor.history)
    ? updatedAnchor.history
    : [];

  const newHistory = existingHistory.concat(historyEntry);

  // Enforce maximum of 50 entries, dropping oldest first
  const MAX_HISTORY_ENTRIES = 50;
  const trimmedHistory =
    newHistory.length > MAX_HISTORY_ENTRIES
      ? newHistory.slice(newHistory.length - MAX_HISTORY_ENTRIES)
      : newHistory;

  if (trimmedHistory !== existingHistory) {
    updatedAnchor.history = trimmedHistory;
    changed = true;
  }

  // --- AIS proximity status (aisWarning) ---
  const aisTargetsArray = Array.isArray(appState.ais?.targets)
    ? appState.ais.targets
    : Object.values(appState.aisTargets || {});

  if (warningRadius != null && Array.isArray(aisTargetsArray) && aisTargetsArray.length > 0) {
    // Use boat position as the reference for AIS proximity checks
    const refLat = boatLat;
    const refLon = boatLon;

    if (refLat != null && refLon != null) {
      const targetsInRange = aisTargetsArray.filter((target) => {
        const tPos = target?.position;
        if (!tPos) return false;

        const tLat = tPos.latitude;
        const tLon = tPos.longitude;
        if (tLat == null || tLon == null) return false;

        const distance = calculateDistance(refLat, refLon, tLat, tLon);
        return distance <= warningRadius;
      });

      const hasWarning = targetsInRange.length > 0;

      if (updatedAnchor.aisWarning !== hasWarning) {
        updatedAnchor.aisWarning = hasWarning;
        changed = true;
      }
    }
  }

  return changed ? updatedAnchor : null;
}
