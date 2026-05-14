import { calculateBearing, calculateDistance, projectPoint } from './geoUtils.js';

// Anchor state helper utilities
// These functions recompute derived anchor fields based on current
// boat position, anchor configuration, and AIS targets.

// Fence distance history constants
const FENCE_HISTORY_WINDOW_MS = 2 * 60 * 60 * 1000; // 2 hours
const FENCE_HISTORY_INTERVAL_MS = 30 * 1000; // 30 seconds - consistent time-series

/**
 * Convert distance to fence units (m or ft)
 * @param {number} distanceMeters - Distance in meters
 * @param {string} targetUnits - Target units ('m' or 'ft')
 * @returns {number} distance in target units
 */
function convertDistanceToFenceUnits(distanceMeters, targetUnits) {
  if (targetUnits === 'ft') {
    return distanceMeters * 3.28084; // meters to feet
  }
  return distanceMeters; // default to meters
}

function convertDistanceToMeters(value, units) {
  if (!Number.isFinite(value)) return null;

  if (units === 'ft') return value * 0.3048;
  if (units === 'nm') return value * 1852;
  return value;
}

/**
 * Normalize speed measurements to knots for anchor filtering decisions.
 * Returns null when units are unknown so callers can explicitly keep
 * default behavior rather than guessing conversions.
 */
function convertSpeedToKnots(value, units) {
  if (!Number.isFinite(value)) return null;
  if (typeof units !== 'string') return null;

  const normalizedUnits = units.trim().toLowerCase();

  if (normalizedUnits === 'kts' || normalizedUnits === 'kt' || normalizedUnits === 'knot' || normalizedUnits === 'knots') {
    return value;
  }

  if (normalizedUnits === 'm/s' || normalizedUnits === 'ms' || normalizedUnits === 'mps') {
    return value * 1.94384;
  }

  if (normalizedUnits === 'mph') {
    return value * 0.868976;
  }

  if (normalizedUnits === 'km/h' || normalizedUnits === 'kph' || normalizedUnits === 'kmh') {
    return value * 0.539957;
  }

  return null;
}

/**
 * Append distance to fence history with 15-second sampling logic
 * @param {Object} fence - Fence object to update
 * @param {number} distance - Distance value in fence units
 * @param {number} nowMs - Current timestamp in milliseconds
 */
function appendDistanceHistory(fence, distance, nowMs) {
  if (!Array.isArray(fence.distanceHistory)) {
    fence.distanceHistory = [];
  }
  
  // Prune old entries outside the 2-hour window
  const cutoff = nowMs - FENCE_HISTORY_WINDOW_MS;
  fence.distanceHistory = fence.distanceHistory.filter(entry => entry.t >= cutoff);
  
  const lastEntry = fence.distanceHistory[fence.distanceHistory.length - 1];
  
  const shouldAppend = !lastEntry || (nowMs - lastEntry.t) >= FENCE_HISTORY_INTERVAL_MS;
  
  if (shouldAppend) {
    fence.distanceHistory.push({ t: nowMs, v: distance });
  }
  
  return shouldAppend;
}

/**
 * Update minimum distance tracking for a fence
 * @param {Object} fence - Fence object to update
 * @param {number} distance - Current distance in fence units
 * @param {number} nowMs - Current timestamp in milliseconds
 */
function updateMinimumDistance(fence, distance, nowMs) {
  if (fence.minimumDistance == null || distance < fence.minimumDistance) {
    fence.minimumDistance = distance;
    fence.minimumDistanceUnits = fence.units;
    fence.minimumDistanceUpdatedAt = nowMs;
  }
}

/**
 * Update fence distance and related fields
 * Called every navigation position update (max 1Hz)
 * @param {Object} fence - Fence object to update
 * @param {Object} boatPosition - Boat position {latitude, longitude}
 * @param {Object} anchorDropLocation - Anchor drop position {latitude, longitude}
 * @param {Object} anchorLocation - Current anchor position {latitude, longitude}
 * @returns {boolean} true if fence was modified
 */
function updateFenceDistance(fence, boatPosition, anchorDropLocation, anchorLocation) {
  if (!fence.enabled) return false;
  const boatLat = typeof boatPosition?.latitude === 'object'
    ? boatPosition.latitude?.value
    : boatPosition?.latitude;
  const boatLon = typeof boatPosition?.longitude === 'object'
    ? boatPosition.longitude?.value
    : boatPosition?.longitude;
  if (boatLat == null || boatLon == null) return false;
  
  // Determine reference position based on fence type
  let referenceLat, referenceLon;
  
  if (fence.referenceType === 'anchor_drop') {
    const dropLat = typeof anchorDropLocation?.latitude === 'object'
      ? anchorDropLocation.latitude?.value
      : anchorDropLocation?.latitude;
    const dropLon = typeof anchorDropLocation?.longitude === 'object'
      ? anchorDropLocation.longitude?.value
      : anchorDropLocation?.longitude;
    if (dropLat == null || dropLon == null) return false;
    referenceLat = dropLat;
    referenceLon = dropLon;
  } else if (fence.referenceType === 'anchor_location') {
    const anchorLat = typeof anchorLocation?.latitude === 'object'
      ? anchorLocation.latitude?.value
      : anchorLocation?.latitude;
    const anchorLon = typeof anchorLocation?.longitude === 'object'
      ? anchorLocation.longitude?.value
      : anchorLocation?.longitude;
    if (anchorLat == null || anchorLon == null) return false;
    referenceLat = anchorLat;
    referenceLon = anchorLon;
  } else {
    // Default to boat position as reference
    referenceLat = boatLat;
    referenceLon = boatLon;
  }
  
  // Calculate distance from reference to target
  let targetLat, targetLon;
  
  const targetMmsi = fence.targetMmsi ?? fence.targetRef?.mmsi;

  const targetPosition = fence.targetPosition || (fence.targetType === 'point' ? fence.targetRef : null);

  if (targetPosition) {
    targetLat = typeof targetPosition.latitude === 'object'
      ? targetPosition.latitude?.value
      : targetPosition.latitude;
    targetLon = typeof targetPosition.longitude === 'object'
      ? targetPosition.longitude?.value
      : targetPosition.longitude;
  } else if (fence.targetType === 'ais' && targetMmsi) {
    // AIS target exists but its live position has not been injected yet.
    return false;
  } else {
    return false;
  }
  
  if (!Number.isFinite(targetLat) || !Number.isFinite(targetLon)) return false;
  
  // Calculate distance in meters
  const distanceMeters = calculateDistance(referenceLat, referenceLon, targetLat, targetLon);
  if (!Number.isFinite(distanceMeters)) return false;
  
  // Convert to fence units
  const distanceInUnits = convertDistanceToFenceUnits(distanceMeters, fence.units);
  if (!Number.isFinite(distanceInUnits)) return false;
  
  const nowMs = Date.now();
  let modified = false;
  
  // Update current distance
  if (fence.currentDistance !== distanceInUnits) {
    fence.currentDistance = distanceInUnits;
    fence.currentDistanceUnits = fence.units;
    modified = true;
  }
  
  // Append to history
  const historyLengthBefore = fence.distanceHistory?.length || 0;
  appendDistanceHistory(fence, distanceInUnits, nowMs);
  const historyLengthAfter = fence.distanceHistory?.length || 0;
  if (historyLengthAfter !== historyLengthBefore) {
    modified = true;
  }
  
  // Update minimum distance
  const prevMin = fence.minimumDistance;
  updateMinimumDistance(fence, distanceInUnits, nowMs);
  if (fence.minimumDistance !== prevMin) {
    modified = true;
  }
  
  // Check alert condition
  const alertRange = fence.alertRange ?? 0;
  const inAlert = distanceInUnits <= alertRange;
  if (fence.inAlert !== inAlert) {
    fence.inAlert = inAlert;
    modified = true;
    if (inAlert) {
      console.log(`[Fence] Alert triggered: ${fence.id || 'unknown'} at ${distanceInUnits.toFixed(1)}${fence.units} (limit: ${alertRange}${fence.units})`);
    }
  }
  
  return modified;
}

/**
 * Update all fences for anchor state
 * @param {Array} fences - Array of fence objects
 * @param {Object} boatPosition - Current boat position
 * @param {Object} anchorDropLocation - Anchor drop location
 * @param {Object} anchorLocation - Current anchor location
 * @param {Object} aisTargets - AIS targets object (mmsi -> target)
 * @returns {Array|null} Updated fences array or null if unchanged
 */
function updateAllFences(fences, boatPosition, anchorDropLocation, anchorLocation, aisTargets) {
  if (!Array.isArray(fences) || fences.length === 0) return null;
  const boatLat = typeof boatPosition?.latitude === 'object'
    ? boatPosition.latitude?.value
    : boatPosition?.latitude;
  const boatLon = typeof boatPosition?.longitude === 'object'
    ? boatPosition.longitude?.value
    : boatPosition?.longitude;
  if (boatLat == null || boatLon == null) return null;
  
  let anyModified = false;
  const updatedFences = fences.map(fence => {
    // For AIS targets, inject target position from aisTargets
    let fenceWithTarget = fence;
    const targetMmsi = fence.targetMmsi ?? fence.targetRef?.mmsi;

    if (fence.targetType === 'ais' && targetMmsi && aisTargets?.[targetMmsi]) {
      const aisTarget = aisTargets[targetMmsi];
      if (aisTarget?.position) {
        fenceWithTarget = {
          ...fence,
          targetPosition: aisTarget.position
        };
      }
    }
    
    const modified = updateFenceDistance(fenceWithTarget, boatPosition, anchorDropLocation, anchorLocation);
    if (modified) anyModified = true;
    return fenceWithTarget;
  });
  
  return anyModified ? updatedFences : null;
}

/**
 * Extract rode length in meters from anchor rode field
 * Handles both amount/units and value/unit shapes
 * @param {Object} anchor - Anchor state object
 * @returns {number} rode length in meters, or null if not available
 */
function extractRodeLengthMeters(anchor) {
  if (!anchor?.rode) return null;
  
  const rode = anchor.rode;
  const amount = rode.amount ?? rode.value;
  const units = rode.units ?? rode.unit;
  
  if (amount == null || units == null) return null;
  
  // Convert to meters based on unit
  switch (units.toLowerCase()) {
    case 'm':
    case 'meters':
    case 'meter':
      return amount;
    case 'ft':
    case 'feet':
    case 'foot':
      return amount * 0.3048;
    default:
      return null;
  }
}

function convertMetersToRequestedLengthUnits(meters, units) {
  if (!Number.isFinite(meters)) return null;
  if (typeof units !== 'string') return null;

  switch (units.toLowerCase()) {
    case 'm':
    case 'meters':
    case 'meter':
      return meters;
    case 'ft':
    case 'feet':
    case 'foot':
      return meters / 0.3048;
    default:
      return null;
  }
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
export function recomputeAnchorDerivedState(appState, options = {}) {
  const skipHistory = options.skipHistory === true;
  if (!appState || typeof appState !== "object") {
    return null;
  }

  const anchor = appState.anchor;
  
  if (!anchor || typeof anchor !== "object") {
    return null;
  }
  
  // Extract boat position using the same logic as anchorRules2.js
  const navLat = appState.navigation?.position?.latitude?.value;
  const navLon = appState.navigation?.position?.longitude?.value;

  const positionRoot =
    appState.position && typeof appState.position === 'object'
      ? appState.position
      : {};
  const boatPositionFromPosition =
    positionRoot.signalk && typeof positionRoot.signalk === 'object'
      ? positionRoot.signalk
      : positionRoot;

  const fallbackBoatLat = typeof boatPositionFromPosition?.latitude === 'object'
    ? boatPositionFromPosition.latitude?.value
    : boatPositionFromPosition?.latitude;
  const fallbackBoatLon = typeof boatPositionFromPosition?.longitude === 'object'
    ? boatPositionFromPosition.longitude?.value
    : boatPositionFromPosition?.longitude;

  const rawBoatLat = navLat != null ? navLat : fallbackBoatLat;
  const rawBoatLon = navLon != null ? navLon : fallbackBoatLon;

  // We only recompute when anchor is deployed and we have a boat position
  if (!anchor.anchorDeployed || rawBoatLat == null || rawBoatLon == null) {
    return null;
  }

  const dropPos = anchor.anchorDropLocation?.position || null;
  const anchorPos = anchor.anchorLocation?.position || null;

  const dropLat = typeof dropPos?.latitude === 'object' ? dropPos.latitude?.value : dropPos?.latitude;
  const dropLon = typeof dropPos?.longitude === 'object' ? dropPos.longitude?.value : dropPos?.longitude;
  const anchorLat = typeof anchorPos?.latitude === 'object' ? anchorPos.latitude?.value : anchorPos?.latitude;
  const anchorLon = typeof anchorPos?.longitude === 'object' ? anchorPos.longitude?.value : anchorPos?.longitude;

  let resolvedAnchorLat = anchorLat;
  let resolvedAnchorLon = anchorLon;
  let resolvedAnchorPosition = anchorPos;
  let resolvedAnchorTime = anchor.anchorLocation?.time;

  const criticalRangeValue = anchor.criticalRange?.r ?? null;
  const criticalRangeUnits = anchor.criticalRange?.units ?? null;
  const criticalRangeMeters = convertDistanceToMeters(criticalRangeValue, criticalRangeUnits);
  const warningRadiusValue = anchor.warningRange?.r ?? null;
  const warningRadiusUnits = anchor.warningRange?.units ?? null;
  const warningRadiusMeters = convertDistanceToMeters(warningRadiusValue, warningRadiusUnits);
  const isDeploying = anchor.deploymentPhase === 'deploying';
  const isMonitoringSuppressed = anchor.alertsSuppressed === true || anchor.anchorSet === false;

  let updatedAnchor = { ...anchor };
  const changedPaths = [];

  // Helper to track changes
  const trackChange = (path, value) => {
    changedPaths.push({ path, value });
  };

  const previousFilteredBoatLat = anchor.filteredBoatPosition?.position?.latitude?.value;
  const previousFilteredBoatLon = anchor.filteredBoatPosition?.position?.longitude?.value;
  // Adaptive defaults for stable anchor display without client changes.
  // These tune smoothing from observed position stability and vessel speed.
  const DEFAULT_DEADBAND_METERS = 3;
  const STATIONARY_DEADBAND_FLOOR_METERS = 6;
  const MAX_DEADBAND_METERS = 12;
  const ACCURACY_DEADBAND_MULTIPLIER = 0.75;
  const DEFAULT_FILTER_ALPHA = 0.35;
  const STATIONARY_FILTER_ALPHA = 0.25;
  const UNDERWAY_FILTER_ALPHA = 0.6;
  const STATIONARY_SOG_THRESHOLD_KNOTS = 0.2;
  const UNDERWAY_SOG_THRESHOLD_KNOTS = 2;
  const MOVEMENT_PERSIST_MS = 5000;
  const JUMP_REJECTION_METERS = 40;

  const stability = appState.position?.stability;
  const stabilityWindowSize = stability?.windowSize;
  const stabilityFilteredRadius95Meters = stability?.filteredRadius95Meters;
  const stabilityRadius95Meters = stability?.radius95Meters;

  // Use PositionService jitter diagnostics as an empirical accuracy estimate.
  // Prefer filteredRadius95 when present; fall back to radius95.
  let accuracyMeters = null;
  if (
    Number.isFinite(stabilityWindowSize) &&
    stabilityWindowSize > 0 &&
    Number.isFinite(stabilityFilteredRadius95Meters)
  ) {
    accuracyMeters = stabilityFilteredRadius95Meters;
  } else if (
    Number.isFinite(stabilityWindowSize) &&
    stabilityWindowSize > 0 &&
    Number.isFinite(stabilityRadius95Meters)
  ) {
    accuracyMeters = stabilityRadius95Meters;
  }

  const sogValue = appState.navigation?.speed?.sog?.value;
  const sogUnits = appState.navigation?.speed?.sog?.units;
  const sogKnots = convertSpeedToKnots(sogValue, sogUnits);

  // Deadband expands with reported jitter, but is capped so rejected/quarantined
  // outliers cannot inflate it enough to freeze real movement.
  let filterDeadbandMeters;
  if (Number.isFinite(accuracyMeters)) {
    filterDeadbandMeters = Math.max(
      DEFAULT_DEADBAND_METERS,
      accuracyMeters * ACCURACY_DEADBAND_MULTIPLIER
    );
  } else {
    filterDeadbandMeters = DEFAULT_DEADBAND_METERS;
  }
  filterDeadbandMeters = Math.min(filterDeadbandMeters, MAX_DEADBAND_METERS);

  // Alpha adapts with vessel speed:
  // - stationary: stronger smoothing
  // - underway: more responsiveness
  let filterAlpha = DEFAULT_FILTER_ALPHA;
  if (Number.isFinite(sogKnots)) {
    if (sogKnots < STATIONARY_SOG_THRESHOLD_KNOTS) {
      filterDeadbandMeters = Math.max(filterDeadbandMeters, STATIONARY_DEADBAND_FLOOR_METERS);
      filterAlpha = STATIONARY_FILTER_ALPHA;
    } else if (sogKnots > UNDERWAY_SOG_THRESHOLD_KNOTS) {
      filterAlpha = UNDERWAY_FILTER_ALPHA;
    }
  }

  let filteredBoatLat = rawBoatLat;
  let filteredBoatLon = rawBoatLon;
  const previousFilteredBoatTime = anchor.filteredBoatPosition?.time;
  const sourcePositionTime = appState.navigation?.position?.timestamp ?? new Date().toISOString();
  let nextFilteredBoatTime = sourcePositionTime;

  if (
    Number.isFinite(previousFilteredBoatLat) &&
    Number.isFinite(previousFilteredBoatLon)
  ) {
    const deltaFromPreviousFilteredMeters = calculateDistance(
      previousFilteredBoatLat,
      previousFilteredBoatLon,
      rawBoatLat,
      rawBoatLon
    );

    if (Number.isFinite(deltaFromPreviousFilteredMeters)) {
      // Dampen abrupt jumps instead of rejecting forever. This avoids filter lock
      // when real movement accumulates beyond the stale filtered position.
      if (deltaFromPreviousFilteredMeters > JUMP_REJECTION_METERS) {
        filteredBoatLat = previousFilteredBoatLat + ((rawBoatLat - previousFilteredBoatLat) * STATIONARY_FILTER_ALPHA);
        filteredBoatLon = previousFilteredBoatLon + ((rawBoatLon - previousFilteredBoatLon) * STATIONARY_FILTER_ALPHA);
      // Hold within deadband to remove normal anchor jitter.
      } else if (deltaFromPreviousFilteredMeters <= filterDeadbandMeters) {
        filteredBoatLat = previousFilteredBoatLat;
        filteredBoatLon = previousFilteredBoatLon;
      } else {
        const previousFilteredBoatTimeMs = Date.parse(previousFilteredBoatTime);
        const sourcePositionTimeMs = Date.parse(sourcePositionTime);

        if (
          Number.isFinite(previousFilteredBoatTimeMs) &&
          Number.isFinite(sourcePositionTimeMs) &&
          (sourcePositionTimeMs - previousFilteredBoatTimeMs) < MOVEMENT_PERSIST_MS
        ) {
          // Time hysteresis: movement must persist before accepting drift.
          filteredBoatLat = previousFilteredBoatLat;
          filteredBoatLon = previousFilteredBoatLon;
        } else {
          filteredBoatLat = previousFilteredBoatLat + ((rawBoatLat - previousFilteredBoatLat) * filterAlpha);
          filteredBoatLon = previousFilteredBoatLon + ((rawBoatLon - previousFilteredBoatLon) * filterAlpha);
        }
      }
    }
  }

  const filteredPositionChanged =
    !Number.isFinite(previousFilteredBoatLat) ||
    !Number.isFinite(previousFilteredBoatLon) ||
    previousFilteredBoatLat !== filteredBoatLat ||
    previousFilteredBoatLon !== filteredBoatLon;

  if (!filteredPositionChanged && typeof previousFilteredBoatTime === 'string') {
    nextFilteredBoatTime = previousFilteredBoatTime;
  }

  const filteredBoatPositionTime = nextFilteredBoatTime;
  const nextFilteredBoatPosition = {
    ...(updatedAnchor.filteredBoatPosition || {}),
    position: {
      ...(updatedAnchor.filteredBoatPosition?.position || {}),
      latitude: {
        ...(updatedAnchor.filteredBoatPosition?.position?.latitude || {}),
        value: filteredBoatLat,
        units: 'deg',
      },
      longitude: {
        ...(updatedAnchor.filteredBoatPosition?.position?.longitude || {}),
        value: filteredBoatLon,
        units: 'deg',
      },
    },
    time: filteredBoatPositionTime,
  };

  if (
    updatedAnchor.filteredBoatPosition?.position?.latitude?.value !== nextFilteredBoatPosition.position.latitude.value ||
    updatedAnchor.filteredBoatPosition?.position?.longitude?.value !== nextFilteredBoatPosition.position.longitude.value ||
    updatedAnchor.filteredBoatPosition?.time !== nextFilteredBoatPosition.time
  ) {
    updatedAnchor = {
      ...updatedAnchor,
      filteredBoatPosition: nextFilteredBoatPosition,
    };
    trackChange('/anchor/filteredBoatPosition', nextFilteredBoatPosition);
  }

  // Infer anchor movement independently from critical-range alerting.
  // If boat is farther from drop than rode length, infer anchor slip.
  const rodeLengthMeters = extractRodeLengthMeters(anchor);
  if (
    !isMonitoringSuppressed &&
    dropLat != null &&
    dropLon != null &&
    Number.isFinite(rodeLengthMeters) &&
    rodeLengthMeters > 0
  ) {
    const distanceBoatFromDrop = calculateDistance(
      filteredBoatLat,
      filteredBoatLon,
      dropLat,
      dropLon
    );

    if (
      Number.isFinite(distanceBoatFromDrop) &&
      distanceBoatFromDrop > rodeLengthMeters
    ) {
      const inferredAnchorDriftMeters = distanceBoatFromDrop - rodeLengthMeters;
      const bearingDropToBoat = calculateBearing(
        dropLat,
        dropLon,
        filteredBoatLat,
        filteredBoatLon
      );
      const inferredAnchorPosition = projectPoint(
        dropLat,
        dropLon,
        bearingDropToBoat,
        inferredAnchorDriftMeters
      );

      if (inferredAnchorPosition) {
        resolvedAnchorLat = inferredAnchorPosition.latitude;
        resolvedAnchorLon = inferredAnchorPosition.longitude;
        resolvedAnchorTime = filteredBoatPositionTime;
        resolvedAnchorPosition = {
          ...(anchorPos || {}),
          latitude: {
            ...(anchorPos?.latitude || {}),
            value: resolvedAnchorLat,
            units: 'deg',
          },
          longitude: {
            ...(anchorPos?.longitude || {}),
            value: resolvedAnchorLon,
            units: 'deg',
          },
        };
      }
    }
  }

  // --- Distances and bearings relative to DROP location ---
  if (dropLat != null && dropLon != null) {
    const distanceBoatFromDrop = calculateDistance(filteredBoatLat, filteredBoatLon, dropLat, dropLon);
    const bearingBoatToDrop = calculateBearing(filteredBoatLat, filteredBoatLon, dropLat, dropLon);

    if (isDeploying) {
      const previousMaxDistance = anchor.dropSession?.measured?.maxDistanceFromDrop;
      const nextMaxDistance =
        Number.isFinite(previousMaxDistance)
          ? Math.max(previousMaxDistance, distanceBoatFromDrop)
          : distanceBoatFromDrop;

      const nextDropSession = {
        ...(updatedAnchor.dropSession || {}),
        measured: {
          ...(updatedAnchor.dropSession?.measured || {}),
          currentDistanceFromDrop: distanceBoatFromDrop,
          maxDistanceFromDrop: nextMaxDistance,
          currentBearingFromDropDeg: bearingBoatToDrop,
          lastSampleAt: Date.now(),
        },
      };

      const rodeUnits = updatedAnchor?.rode?.units;
      const convertedRodeAmount = convertMetersToRequestedLengthUnits(nextMaxDistance, rodeUnits);

      if (
        updatedAnchor.dropSession?.measured?.currentDistanceFromDrop !== nextDropSession.measured.currentDistanceFromDrop ||
        updatedAnchor.dropSession?.measured?.maxDistanceFromDrop !== nextDropSession.measured.maxDistanceFromDrop ||
        updatedAnchor.dropSession?.measured?.currentBearingFromDropDeg !== nextDropSession.measured.currentBearingFromDropDeg
      ) {
        updatedAnchor.dropSession = nextDropSession;
        trackChange('/anchor/dropSession', nextDropSession);
      }

      if (convertedRodeAmount != null && updatedAnchor?.rode?.amount !== convertedRodeAmount) {
        updatedAnchor = {
          ...updatedAnchor,
          rode: {
            ...(updatedAnchor.rode || {}),
            amount: convertedRodeAmount,
            units: rodeUnits,
          },
        };
        trackChange('/anchor/rode', updatedAnchor.rode);
      }
    }

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
        value: bearingBoatToDrop,
      },
    };

    updatedAnchor = {
      ...updatedAnchor,
      anchorDropLocation: updatedDropLocation,
    };
    trackChange("/anchor/anchorDropLocation", updatedDropLocation);

    if (dropLat != null && dropLon != null) {
      if (Number.isFinite(criticalRangeMeters) && !isMonitoringSuppressed) {
        // Dragging detection is intentionally evaluated from raw position
        // to stay responsive even when display filtering is stronger.
        const distanceBoatFromDrop = calculateDistance(
          rawBoatLat,
          rawBoatLon,
          dropLat,
          dropLon
        );

        const isDragging = distanceBoatFromDrop > criticalRangeMeters;

        if (updatedAnchor.dragging !== isDragging) {
          updatedAnchor.dragging = isDragging;
          trackChange("/anchor/dragging", isDragging);
          if (isDragging) {
            console.log(`[Anchor] Dragging detected: distance from drop=${distanceBoatFromDrop.toFixed(1)}m, criticalRange=${criticalRangeMeters.toFixed(1)}m`);
          } else {
            console.log('[Anchor] Dragging cleared - boat back inside critical range');
          }
        }

        // No rode mismatch test: keep this flag false to avoid stale state.
        if (updatedAnchor.rodeCircleViolation !== false) {
          updatedAnchor.rodeCircleViolation = false;
          trackChange("/anchor/rodeCircleViolation", false);
        }
      }
    }

    if (isMonitoringSuppressed) {
      if (updatedAnchor.dragging !== false) {
        updatedAnchor.dragging = false;
        trackChange('/anchor/dragging', false);
      }
    }
  }

  // --- Distances and bearings relative to ANCHOR location ---
  if (resolvedAnchorLat != null && resolvedAnchorLon != null) {
    const distanceBoatFromAnchor = calculateDistance(
      filteredBoatLat,
      filteredBoatLon,
      resolvedAnchorLat,
      resolvedAnchorLon
    );
    const bearingBoatToAnchor = calculateBearing(
      filteredBoatLat,
      filteredBoatLon,
      resolvedAnchorLat,
      resolvedAnchorLon
    );

    let distancesFromDrop = anchor.anchorLocation?.distancesFromDrop;

    // If we have both positions, we can recompute how far the anchor has
    // moved from the drop point.
    if (dropLat != null && dropLon != null) {
      const distanceAnchorFromDrop = calculateDistance(
        dropLat,
        dropLon,
        resolvedAnchorLat,
        resolvedAnchorLon
      );

      distancesFromDrop = {
        ...(distancesFromDrop || {}),
        value: distanceAnchorFromDrop,
      };
    }

    const updatedAnchorLocation = {
      ...(anchor.anchorLocation || {}),
      position: resolvedAnchorPosition,
      time: resolvedAnchorTime,
      distancesFromCurrent: {
        ...(anchor.anchorLocation?.distancesFromCurrent || {}),
        value: distanceBoatFromAnchor,
      },
      distancesFromDrop,
      bearing: {
        ...(anchor.anchorLocation?.bearing || {}),
        value: bearingBoatToAnchor,
      },
    };

    updatedAnchor = {
      ...updatedAnchor,
      anchorLocation: updatedAnchorLocation,
    };
    trackChange("/anchor/anchorLocation", updatedAnchorLocation);

    // --- History (breadcrumbs) ---
    if (!skipHistory) {
      const now = Date.now();
      const existingHistory = Array.isArray(updatedAnchor.history)
        ? updatedAnchor.history
        : [];
      
      const MIN_BREADCRUMB_INTERVAL_MS = 30000; // 30 seconds
      const MIN_BREADCRUMB_DISTANCE_METERS = 3;
      
      const lastEntry = existingHistory.length > 0
        ? existingHistory[existingHistory.length - 1]
        : null;
      
      const lastHistoryLat = lastEntry?.position?.latitude;
      const lastHistoryLon = lastEntry?.position?.longitude;
      const distanceFromLastHistoryMeters =
        Number.isFinite(lastHistoryLat) && Number.isFinite(lastHistoryLon)
          ? calculateDistance(lastHistoryLat, lastHistoryLon, filteredBoatLat, filteredBoatLon)
          : null;

      if (lastEntry && (now - lastEntry.time) < MIN_BREADCRUMB_INTERVAL_MS) {
        // Skip adding breadcrumb - not enough time has passed
      } else if (
        lastEntry &&
        Number.isFinite(distanceFromLastHistoryMeters) &&
        distanceFromLastHistoryMeters < MIN_BREADCRUMB_DISTANCE_METERS
      ) {
        // Skip adding breadcrumb - filtered position has not moved enough
      } else {
        const historyEntry = {
          position: {
            latitude: filteredBoatLat,
            longitude: filteredBoatLon,
          },
          time: now,
        };

        const newHistory = existingHistory.concat(historyEntry);

        // Enforce maximum of 1000 entries, dropping oldest first
        // At 30-second intervals = ~8.33 hours of history
        const MAX_HISTORY_ENTRIES = 1000;
        const trimmedHistory =
          newHistory.length > MAX_HISTORY_ENTRIES
            ? newHistory.slice(newHistory.length - MAX_HISTORY_ENTRIES)
            : newHistory;

        if (trimmedHistory !== existingHistory) {
          updatedAnchor.history = trimmedHistory;
          trackChange("/anchor/history", trimmedHistory);
        }
      }
    }
  }

  // --- AIS proximity status (aisWarning) ---
  const aisTargetsArray = Array.isArray(appState.ais?.targets)
    ? appState.ais.targets
    : Object.values(appState.aisTargets || {});

  if (!isMonitoringSuppressed && Number.isFinite(warningRadiusMeters) && Array.isArray(aisTargetsArray) && aisTargetsArray.length > 0) {
    // Use boat position as the reference for AIS proximity checks
    const refLat = filteredBoatLat;
    const refLon = filteredBoatLon;

    if (refLat != null && refLon != null) {
      const targetsInRange = aisTargetsArray.filter((target) => {
        const tPos = target?.position;
        if (!tPos) return false;

        const tLat = tPos.latitude;
        const tLon = tPos.longitude;
        if (tLat == null || tLon == null) return false;

        const distance = calculateDistance(refLat, refLon, tLat, tLon);
        return distance <= warningRadiusMeters;
      });

      const hasWarning = targetsInRange.length > 0;

      if (updatedAnchor.aisWarning !== hasWarning) {
        updatedAnchor.aisWarning = hasWarning;
        trackChange("/anchor/aisWarning", hasWarning);
      }
    }
  } else if (isMonitoringSuppressed && updatedAnchor.aisWarning !== false) {
    updatedAnchor.aisWarning = false;
    trackChange('/anchor/aisWarning', false);
  }

  // --- Fence distance updates ---
  if (!skipHistory && filteredBoatLat != null && filteredBoatLon != null && updatedAnchor.fences?.length > 0) {
    // Build AIS targets map for fence lookups
    const aisTargetsMap = {};
    const aisTargetsArray = Array.isArray(appState.ais?.targets)
      ? appState.ais.targets
      : Object.values(appState.aisTargets || {});
    
    for (const target of aisTargetsArray) {
      if (target?.mmsi) {
        aisTargetsMap[target.mmsi] = target;
      }
    }
    
    const boatPosition = { latitude: filteredBoatLat, longitude: filteredBoatLon };
    const dropLocation = updatedAnchor.anchorDropLocation?.position;
    const currentAnchorLocation = updatedAnchor.anchorLocation?.position;
    
    const updatedFences = updateAllFences(
      updatedAnchor.fences,
      boatPosition,
      dropLocation,
      currentAnchorLocation,
      aisTargetsMap
    );
    
    if (updatedFences) {
      updatedAnchor.fences = updatedFences;
      trackChange("/anchor/fences", updatedFences);
    }
  }

  return changedPaths.length > 0 ? { anchor: updatedAnchor, changedPaths } : null;
}

export { calculateDistance };
