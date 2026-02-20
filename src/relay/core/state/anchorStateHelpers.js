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
  const beforePrune = fence.distanceHistory.length;
  fence.distanceHistory = fence.distanceHistory.filter(entry => entry.t >= cutoff);
  if (fence.distanceHistory.length !== beforePrune) {
    console.log(`[Fence][${fence.id || 'unknown'}] Pruned ${beforePrune - fence.distanceHistory.length} old entries`);
  }
  
  const lastEntry = fence.distanceHistory[fence.distanceHistory.length - 1];
  
  // Append every 30 seconds for consistent time-series data
  const FENCE_HISTORY_INTERVAL_MS = 30 * 1000; // 30 seconds
  
  const shouldAppend = !lastEntry || (nowMs - lastEntry.t) >= FENCE_HISTORY_INTERVAL_MS;
  
  console.log(`[Fence][${fence.id || 'unknown'}] appendDistanceHistory: lastEntry=${lastEntry ? new Date(lastEntry.t).toISOString() : 'none'}, now=${new Date(nowMs).toISOString()}, shouldAppend=${shouldAppend}, currentHistoryLength=${fence.distanceHistory.length}`);
    
  if (shouldAppend) {
    fence.distanceHistory.push({ t: nowMs, v: distance });
    console.log(`[Fence][${fence.id || 'unknown'}] Appended history entry: t=${nowMs}, v=${distance}, newLength=${fence.distanceHistory.length}`);
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
 * @returns {boolean} true if fence was modified
 */
function updateFenceDistance(fence, boatPosition, anchorDropLocation) {
  console.log(`[Fence][${fence.id || 'unknown'}] updateFenceDistance called: enabled=${fence.enabled}, targetType=${fence.targetType}, hasTargetPos=${!!fence.targetPosition}, hasTargetMmsi=${!!fence.targetMmsi}`);
  
  if (!fence.enabled) {
    console.log(`[Fence][${fence.id || 'unknown'}] Returning false: fence not enabled`);
    return false;
  }
  if (!boatPosition?.latitude || !boatPosition?.longitude) {
    console.log(`[Fence][${fence.id || 'unknown'}] Returning false: no boat position`);
    return false;
  }
  
  // Determine reference position based on fence type
  let referenceLat, referenceLon;
  
  if (fence.referenceType === 'anchor_drop') {
    if (!anchorDropLocation?.latitude || !anchorDropLocation?.longitude) return false;
    referenceLat = anchorDropLocation.latitude;
    referenceLon = anchorDropLocation.longitude;
  } else {
    // Default to boat position as reference
    referenceLat = boatPosition.latitude;
    referenceLon = boatPosition.longitude;
  }
  
  // Calculate distance from reference to target
  let targetLat, targetLon;
  
  if (fence.targetType === 'ais' && fence.targetMmsi) {
    // For AIS targets, we'd need to look up the target position from AIS data
    // This would require passing AIS state - handled by caller
    console.log(`[Fence][${fence.id || 'unknown'}] Returning false: AIS target not implemented in this function`);
    return false; // Not implemented in this function
  } else if (fence.targetPosition) {
    targetLat = fence.targetPosition.latitude;
    targetLon = fence.targetPosition.longitude;
  } else {
    console.log(`[Fence][${fence.id || 'unknown'}] Returning false: no targetPosition`);
    return false;
  }
  
  if (targetLat == null || targetLon == null) {
    console.log(`[Fence][${fence.id || 'unknown'}] Returning false: targetLat or targetLon is null`);
    return false;
  }
  
  // Calculate distance in meters
  const distanceMeters = calculateDistance(referenceLat, referenceLon, targetLat, targetLon);
  
  // Convert to fence units
  const distanceInUnits = convertDistanceToFenceUnits(distanceMeters, fence.units);
  
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
    console.log(`[Fence][${fence.id || 'unknown'}] History updated: ${historyLengthBefore} -> ${historyLengthAfter} entries, appended=${historyAppended}`);
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
 * @param {Object} aisTargets - AIS targets object (mmsi -> target)
 * @returns {Array|null} Updated fences array or null if unchanged
 */
function updateAllFences(fences, boatPosition, anchorDropLocation, aisTargets) {
  if (!Array.isArray(fences) || fences.length === 0) return null;
  if (!boatPosition?.latitude || !boatPosition?.longitude) return null;
  
  let anyModified = false;
  const updatedFences = fences.map(fence => {
    // For AIS targets, inject target position from aisTargets
    let fenceWithTarget = fence;
    if (fence.targetType === 'ais' && fence.targetMmsi && aisTargets?.[fence.targetMmsi]) {
      const aisTarget = aisTargets[fence.targetMmsi];
      if (aisTarget?.position) {
        fenceWithTarget = {
          ...fence,
          targetPosition: aisTarget.position
        };
      }
    }
    
    const modified = updateFenceDistance(fenceWithTarget, boatPosition, anchorDropLocation);
    console.log(`[Fence][${fenceWithTarget.id || 'unknown'}] updateFenceDistance returned modified=${modified}`);
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
      console.warn(`[Anchor] Unknown rode unit: ${units}, assuming meters`);
      return amount;
  }
}

/**
 * Calculate GPS error margin based on HDOP
 * @param {Object} position - Navigation position object
 * @returns {number} margin in meters
 */
function calculateHDOPMargin(position) {
  const hdop = position?.gnss?.hdop?.value;
  
  if (hdop == null || !Number.isFinite(hdop)) {
    return 5; // Default 5m margin when HDOP unavailable
  }
  
  const margin = (hdop * 5) + 1; // 5x HDOP + 1m base
  return margin;
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
export function recomputeAnchorDerivedState(appState) {
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

  const boatLat = navLat != null ? navLat : boatPositionFromPosition?.latitude;
  const boatLon = navLon != null ? navLon : boatPositionFromPosition?.longitude;

  // We only recompute when anchor is deployed and we have a boat position
  if (!anchor.anchorDeployed || boatLat == null || boatLon == null) {
    return null;
  }

  const dropPos = anchor.anchorDropLocation?.position || null;
  const anchorPos = anchor.anchorLocation?.position || null;

  const dropLat = typeof dropPos?.latitude === 'object' ? dropPos.latitude?.value : dropPos?.latitude;
  const dropLon = typeof dropPos?.longitude === 'object' ? dropPos.longitude?.value : dropPos?.longitude;
  const anchorLat = typeof anchorPos?.latitude === 'object' ? anchorPos.latitude?.value : anchorPos?.latitude;
  const anchorLon = typeof anchorPos?.longitude === 'object' ? anchorPos.longitude?.value : anchorPos?.longitude;

  const criticalRange = anchor.criticalRange?.r ?? null;
  const warningRadius = anchor.warningRange?.r ?? null;

  let updatedAnchor = { ...anchor };
  const changedPaths = [];

  // Helper to track changes
  const trackChange = (path, value) => {
    changedPaths.push({ path, value });
  };

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
    trackChange("/anchor/anchorDropLocation", updatedDropLocation);

    // --- Anchor dragging detection: simple circle check against DROP location ---
    // If boat center is outside rode-length circle from where anchor was dropped, check if anchor moved
    if (dropLat != null && dropLon != null) {
      const rodeLengthMeters = extractRodeLengthMeters(anchor);
      
      if (rodeLengthMeters != null) {
        const distanceBoatFromDrop = calculateDistance(
          boatLat,
          boatLon,
          dropLat,
          dropLon
        );
        
        // Check how far anchor has moved from drop point (if anchor position known)
        let distanceAnchorFromDrop = 0;
        if (anchorLat != null && anchorLon != null) {
          distanceAnchorFromDrop = calculateDistance(
            dropLat,
            dropLon,
            anchorLat,
            anchorLon
          );
        }
        
        const ANCHOR_MOVED_THRESHOLD = 5; // meters - anchor considered "moved" if >5m from drop
        const rodeCircleViolated = distanceBoatFromDrop > rodeLengthMeters;
        const anchorHasMoved = distanceAnchorFromDrop > ANCHOR_MOVED_THRESHOLD;
        
        // Dragging only if rode circle violated AND anchor has moved significantly
        const isDragging = rodeCircleViolated && anchorHasMoved;
        
        // Configuration mismatch: rode circle violated but anchor hasn't moved
        // This suggests rode length in app doesn't match deployed rode
        const isRodeMismatch = rodeCircleViolated && !anchorHasMoved;
        
        if (updatedAnchor.dragging !== isDragging) {
          updatedAnchor.dragging = isDragging;
          trackChange("/anchor/dragging", isDragging);
          if (isDragging) {
            console.log(`[Anchor] Dragging detected: distance from drop=${distanceBoatFromDrop.toFixed(1)}m, rode=${rodeLengthMeters.toFixed(1)}m, anchor moved=${distanceAnchorFromDrop.toFixed(1)}m`);
          } else {
            console.log('[Anchor] Dragging cleared - boat back inside rode circle');
          }
        }
        
        if (updatedAnchor.rodeCircleViolation !== isRodeMismatch) {
          updatedAnchor.rodeCircleViolation = isRodeMismatch;
          trackChange("/anchor/rodeCircleViolation", isRodeMismatch);
          if (isRodeMismatch) {
            console.log(`[Anchor] Rode circle violated but anchor hasn't moved - check rode length config: distance=${distanceBoatFromDrop.toFixed(1)}m, rode=${rodeLengthMeters.toFixed(1)}m`);
          }
        }
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
    trackChange("/anchor/anchorLocation", updatedAnchorLocation);

    // --- History (breadcrumbs) ---
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
          latitude: boatLat,
          longitude: boatLon,
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
        trackChange("/anchor/aisWarning", hasWarning);
      }
    }
  }

  // --- Fence distance updates ---
  if (boatLat != null && boatLon != null && updatedAnchor.fences?.length > 0) {
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
    
    const boatPosition = { latitude: boatLat, longitude: boatLon };
    const dropLocation = updatedAnchor.anchorDropLocation?.position;
    
    const updatedFences = updateAllFences(
      updatedAnchor.fences,
      boatPosition,
      dropLocation,
      aisTargetsMap
    );
    
    if (updatedFences) {
      updatedAnchor.fences = updatedFences;
      trackChange("/anchor/fences", updatedFences);
      // Diagnostic: Log fence history sizes
      updatedFences.forEach(fence => {
        const historyLen = fence.distanceHistory?.length || 0;
        console.log(`[Fence][${fence.id || 'unknown'}] distanceHistory has ${historyLen} entries, currentDistance=${fence.currentDistance?.toFixed(1) || 'N/A'}${fence.units || 'm'}`);
      });
    }
  }

  return changedPaths.length > 0 ? { anchor: updatedAnchor, changedPaths } : null;
}
