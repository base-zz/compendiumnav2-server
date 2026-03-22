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
  
  // Append every 30 seconds for consistent time-series data
  const FENCE_HISTORY_INTERVAL_MS = 30 * 1000; // 30 seconds
  
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

function projectPoint(latDeg, lonDeg, bearingDeg, distanceMeters) {
  if (
    latDeg == null ||
    lonDeg == null ||
    bearingDeg == null ||
    distanceMeters == null
  ) {
    return null;
  }

  if (
    !Number.isFinite(latDeg) ||
    !Number.isFinite(lonDeg) ||
    !Number.isFinite(bearingDeg) ||
    !Number.isFinite(distanceMeters)
  ) {
    return null;
  }

  const toRad = (value) => (value * Math.PI) / 180;
  const toDeg = (value) => (value * 180) / Math.PI;
  const R = 6371e3;
  const angularDistance = distanceMeters / R;
  const bearingRad = toRad(bearingDeg);
  const lat1 = toRad(latDeg);
  const lon1 = toRad(lonDeg);

  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angularDistance) +
      Math.cos(lat1) * Math.sin(angularDistance) * Math.cos(bearingRad)
  );
  const lon2 = lon1 + Math.atan2(
    Math.sin(bearingRad) * Math.sin(angularDistance) * Math.cos(lat1),
    Math.cos(angularDistance) - Math.sin(lat1) * Math.sin(lat2)
  );

  const next = {
    latitude: toDeg(lat2),
    longitude: toDeg(lon2),
  };

  if (!Number.isFinite(next.latitude) || !Number.isFinite(next.longitude)) {
    return null;
  }

  return next;
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
  const historyAppended = appendDistanceHistory(fence, distanceInUnits, nowMs);
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

function extractDropDepthMeters(anchor) {
  const depthObj = anchor?.anchorDropLocation?.depth;
  const depthSource = anchor?.anchorDropLocation?.depthSource;
  const amount = depthObj?.value;
  const units = depthObj?.units;

  if (depthSource == null) return null;
  if (amount == null || units == null) return null;

  if (!Number.isFinite(amount)) return null;
  if (typeof units !== 'string') return null;

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
 * Project new anchor position using direct projection method
 * Places anchor at rodeLength distance from boat along bearing from anchor to boat
 * @param {Object} boatPos - Boat position {latitude, longitude}
 * @param {Object} currentAnchorPos - Current anchor position {latitude, longitude}
 * @param {number} rodeLengthMeters - Rode length in meters
 * @returns {Object} new anchor position {latitude, longitude}
 */
function projectNewAnchorPosition(boatPos, currentAnchorPos, rodeLengthMeters) {
  // Calculate bearing from anchor to boat
  const bearing = calculateBearing(
    currentAnchorPos.latitude,
    currentAnchorPos.longitude,
    boatPos.latitude,
    boatPos.longitude
  );
  
  // Project new anchor position rodeLength meters from boat in opposite direction
  const oppositeBearing = (bearing + 180) % 360;
  
  const toRad = (value) => (value * Math.PI) / 180;
  const toDeg = (value) => (value * 180) / Math.PI;
  const R = 6371e3; // Earth radius in meters
  
  const lat1 = toRad(boatPos.latitude);
  const lon1 = toRad(boatPos.longitude);
  const angularDistance = rodeLengthMeters / R;
  const bearingRad = toRad(oppositeBearing);
  
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angularDistance) +
    Math.cos(lat1) * Math.sin(angularDistance) * Math.cos(bearingRad)
  );
  
  const lon2 = lon1 + Math.atan2(
    Math.sin(bearingRad) * Math.sin(angularDistance) * Math.cos(lat1),
    Math.cos(angularDistance) - Math.sin(lat1) * Math.sin(lat2)
  );
  
  const newAnchorPos = {
    latitude: toDeg(lat2),
    longitude: toDeg(lon2)
  };
  
  console.log(`[Anchor] Projected new anchor position:`, {
    from: currentAnchorPos,
    to: newAnchorPos,
    bearing: bearing.toFixed(1),
    rodeLength: rodeLengthMeters
  });
  
  return newAnchorPos;
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

  const criticalRange = anchor.criticalRange?.r ?? null;
  const warningRadius = anchor.warningRange?.r ?? null;
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
  const FILTER_ALPHA = 0.2;
  const FILTER_DEADBAND_METERS = 3;

  let filteredBoatLat = rawBoatLat;
  let filteredBoatLon = rawBoatLon;

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

    if (
      Number.isFinite(deltaFromPreviousFilteredMeters) &&
      deltaFromPreviousFilteredMeters <= FILTER_DEADBAND_METERS
    ) {
      filteredBoatLat = previousFilteredBoatLat;
      filteredBoatLon = previousFilteredBoatLon;
    } else {
      filteredBoatLat = previousFilteredBoatLat + ((rawBoatLat - previousFilteredBoatLat) * FILTER_ALPHA);
      filteredBoatLon = previousFilteredBoatLon + ((rawBoatLon - previousFilteredBoatLon) * FILTER_ALPHA);
    }
  }

  const filteredBoatPositionTime = appState.navigation?.position?.timestamp ?? new Date().toISOString();
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
      const criticalRange = anchor.criticalRange?.r;

      if (criticalRange != null && !isMonitoringSuppressed) {
        const distanceBoatFromDrop = calculateDistance(
          filteredBoatLat,
          filteredBoatLon,
          dropLat,
          dropLon
        );

        const isDragging = distanceBoatFromDrop > criticalRange;

        if (updatedAnchor.dragging !== isDragging) {
          updatedAnchor.dragging = isDragging;
          trackChange("/anchor/dragging", isDragging);
          if (isDragging) {
            console.log(`[Anchor] Dragging detected: distance from drop=${distanceBoatFromDrop.toFixed(1)}m, criticalRange=${criticalRange.toFixed(1)}m`);
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
      
      // Only add breadcrumb if at least 30 seconds have passed since last one
      const MIN_BREADCRUMB_INTERVAL_MS = 30000; // 30 seconds
      
      const lastEntry = existingHistory.length > 0
        ? existingHistory[existingHistory.length - 1]
        : null;
      
      if (lastEntry && (now - lastEntry.time) < MIN_BREADCRUMB_INTERVAL_MS) {
        // Skip adding breadcrumb - not enough time has passed
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

  if (!isMonitoringSuppressed && warningRadius != null && Array.isArray(aisTargetsArray) && aisTargetsArray.length > 0) {
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
        return distance <= warningRadius;
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
