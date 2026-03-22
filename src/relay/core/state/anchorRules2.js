/**
 * Anchor-related rules for the optimized rule engine
 * These rules handle anchor deployment, retrieval, and monitoring
 */

const ANCHOR_ALERT_DEBOUNCE_MS = 10000;
if (!Number.isFinite(ANCHOR_ALERT_DEBOUNCE_MS) || ANCHOR_ALERT_DEBOUNCE_MS < 0) {
  throw new Error(
    `ANCHOR_ALERT_DEBOUNCE_MS must be a non-negative integer (got: ${ANCHOR_ALERT_DEBOUNCE_MS})`
  );
}

const anchorAlertDebounceState = {
  criticalRangeCandidateSince: null,
  draggingCandidateSince: null,
  aisProximityCandidateSince: null,
  aisProximityClearCandidateSince: null,
};

function isAnchorMonitoringEnabled(anchorState) {
  if (!anchorState || typeof anchorState !== 'object') return false;
  if (anchorState.anchorDeployed !== true) return false;
  if (anchorState.alertsSuppressed === true) return false;
  if (anchorState.anchorSet === false) return false;
  return true;
}

function normalizeMmsi(mmsi) {
  if (mmsi == null) return null;
  const normalized = String(mmsi).replace(/\D/g, '');
  return normalized.length > 0 ? normalized : null;
}

function convertDistanceToMeters(value, units) {
  if (!Number.isFinite(value)) return null;

  if (units === 'ft') return value * 0.3048;
  if (units === 'nm') return value * 1852;
  return value;
}

function convertDistanceFromMeters(valueMeters, units) {
  if (!Number.isFinite(valueMeters)) return null;

  if (units === 'ft') return valueMeters / 0.3048;
  if (units === 'nm') return valueMeters / 1852;
  return valueMeters;
}

export const anchorRules = [
  // Legacy navigation-based notifications (kept for compatibility)
  {
    name: 'Anchor Deployed Notification',
    description: 'Triggered when anchor is deployed (navigation domain)',
    priority: 'high',
    dependsOn: ['navigation.anchor.anchorDeployed', 'navigation.anchor.timestamp'],
    condition: (state) => {
      const { anchorDeployed, timestamp } = state.navigation?.anchor || {};
      return anchorDeployed === true && !!timestamp;
    },
    action: (state) => ({
      type: 'NOTIFICATION',
      category: 'anchor',
      severity: 'info',
      message: 'Anchor deployed',
      timestamp: state.navigation.anchor.timestamp,
      data: {
        position: state.navigation.anchor.anchorLocation?.position,
        rode: state.navigation.anchor.rode
      }
    })
  },

  {
    name: 'Anchor Retrieved Notification',
    description: 'Triggered when anchor is retrieved (navigation domain)',
    priority: 'high',
    dependsOn: ['navigation.anchor.anchorDeployed', 'navigation.anchor.timestamp'],
    condition: (state, context) => {
      const prevDeployed = context.previousState?.navigation?.anchor?.anchorDeployed;
      const currDeployed = state.navigation?.anchor?.anchorDeployed;
      return prevDeployed === true && currDeployed === false;
    },
    action: () => ({
      type: 'NOTIFICATION',
      category: 'anchor',
      severity: 'info',
      message: 'Anchor retrieved',
      timestamp: new Date().toISOString()
    })
  },

  {
    name: 'Anchor Dragging Detection (navigation)',
    description: 'Detects when the anchor is dragging based on navigation domain',
    priority: 'high',
    dependsOn: [
      'navigation.anchor.anchorDeployed',
      'navigation.anchor.anchorLocation.position',
      'navigation.position'
    ],
    condition: (state) => {
      const anchor = state.navigation?.anchor;
      if (!anchor?.anchorDeployed) return false;

      const position = state.navigation?.position;
      const anchorPos = anchor.anchorLocation?.position;

      if (!position || !anchorPos) return false;

      const distance = calculateDistance(
        position.latitude,
        position.longitude,
        anchorPos.latitude,
        anchorPos.longitude
      );

      return distance > 50;
    },
    action: (state) => ({
      type: 'ALERT',
      category: 'anchor',
      code: 'ANCHOR_DRAGGING',
      severity: 'warning',
      message: 'Anchor may be dragging',
      timestamp: new Date().toISOString(),
      data: {
        position: state.navigation.position,
        anchorPosition: state.navigation.anchor.anchorLocation?.position
      }
    })
  },

  // --- Anchor rules based on unified appState (anchor, position, aisTargets, alerts) ---

  // Critical Range Detection (server-side alert via AlertService)
  {
    name: 'Critical Range Detection',
    description: 'Creates a critical alert when boat exceeds critical anchor range',
    priority: 'high',
    condition: (state) => {
      const anchorState = state.anchor || {};
      if (!isAnchorMonitoringEnabled(anchorState)) {
        return false;
      }

      const navLat = state.navigation?.position?.latitude?.value;
      const navLon = state.navigation?.position?.longitude?.value;

      const positionRoot =
        state.position && typeof state.position === 'object'
          ? state.position
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

      const boatLat = navLat != null ? navLat : fallbackBoatLat;
      const boatLon = navLon != null ? navLon : fallbackBoatLon;

      const criticalRangeValue = anchorState.criticalRange?.r;
      const criticalRangeUnits = anchorState.criticalRange?.units;
      const criticalRangeMeters = convertDistanceToMeters(criticalRangeValue, criticalRangeUnits);
      const dropPosition = anchorState.anchorDropLocation?.position;

      if (!Number.isFinite(criticalRangeMeters) || !dropPosition || boatLat == null || boatLon == null) {
        return false;
      }

      // dropPosition.latitude/longitude may be objects with .value or plain numbers
      const dropLat = typeof dropPosition.latitude === 'object' ? dropPosition.latitude?.value : dropPosition.latitude;
      const dropLon = typeof dropPosition.longitude === 'object' ? dropPosition.longitude?.value : dropPosition.longitude;

      if (dropLat == null || dropLon == null) {
        return false;
      }

      const distance = calculateDistance(
        boatLat,
        boatLon,
        dropLat,
        dropLon
      );

      const distanceInRangeUnits = convertDistanceFromMeters(distance, criticalRangeUnits);

      const hasActiveAlert = state.alerts?.active?.some(
        (alert) => alert.trigger === 'critical_range' && !alert.acknowledged
      );

      const isOutsideCriticalRange = distance > criticalRangeMeters;

      if (!isOutsideCriticalRange || hasActiveAlert) {
        anchorAlertDebounceState.criticalRangeCandidateSince = null;
        return false;
      }

      const now = Date.now();
      if (anchorAlertDebounceState.criticalRangeCandidateSince == null) {
        anchorAlertDebounceState.criticalRangeCandidateSince = now;
        return false;
      }

      return (now - anchorAlertDebounceState.criticalRangeCandidateSince) >= ANCHOR_ALERT_DEBOUNCE_MS;
    },
    action: (state) => {
      const anchorState = state.anchor || {};

      const navLat = state.navigation?.position?.latitude?.value;
      const navLon = state.navigation?.position?.longitude?.value;

      const positionRoot =
        state.position && typeof state.position === 'object'
          ? state.position
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

      const boatLat = navLat != null ? navLat : fallbackBoatLat;
      const boatLon = navLon != null ? navLon : fallbackBoatLon;

      const dropPosition = anchorState.anchorDropLocation?.position;
      const criticalRangeValue = anchorState.criticalRange?.r;
      const criticalRangeUnits = anchorState.criticalRange?.units;
      const criticalRangeMeters = convertDistanceToMeters(criticalRangeValue, criticalRangeUnits);
      const unitLabel = criticalRangeUnits;

      const dropLat = typeof dropPosition.latitude === 'object' ? dropPosition.latitude?.value : dropPosition.latitude;
      const dropLon = typeof dropPosition.longitude === 'object' ? dropPosition.longitude?.value : dropPosition.longitude;

      const distance = calculateDistance(
        boatLat,
        boatLon,
        dropLat,
        dropLon
      );

      const distanceInRangeUnits = convertDistanceFromMeters(distance, criticalRangeUnits);

      return {
        type: 'CREATE_ALERT',
        data: {
          type: 'system',
          category: 'anchor',
          source: 'anchor_monitor',
          level: 'critical',
          label: 'Critical Range Exceeded',
          message: `Boat has exceeded critical range! Distance from drop (${Math.round(
            distanceInRangeUnits
          )} ${unitLabel}) is beyond critical range (${criticalRangeValue} ${unitLabel}).`,
          trigger: 'critical_range',
          data: {
            distance: Math.round(distanceInRangeUnits),
            criticalRange: criticalRangeValue,
            criticalRangeMeters,
            units: unitLabel,
          },
          autoResolvable: true,
        },
      };
    },
  },

  // Anchor Dragging Detection (server-side alert via AlertService)
  {
    name: 'Anchor Dragging Detection',
    description: 'Creates a critical alert when distance from drop exceeds critical range + buffer',
    priority: 'high',
    condition: (state) => {
      const anchorState = state.anchor || {};
      if (!isAnchorMonitoringEnabled(anchorState)) {
        return false;
      }

      const isDragging = anchorState.dragging === true;

      const hasActiveAlert = state.alerts?.active?.some(
        (alert) => alert.trigger === 'anchor_dragging' && !alert.acknowledged
      );

      if (!isDragging || hasActiveAlert) {
        anchorAlertDebounceState.draggingCandidateSince = null;
        return false;
      }

      const now = Date.now();
      if (anchorAlertDebounceState.draggingCandidateSince == null) {
        anchorAlertDebounceState.draggingCandidateSince = now;
        return false;
      }

      return (now - anchorAlertDebounceState.draggingCandidateSince) >= ANCHOR_ALERT_DEBOUNCE_MS;
    },
    action: (state) => {
      const anchorState = state.anchor || {};

      const filteredBoatPosition = anchorState.filteredBoatPosition?.position;
      const boatLat = typeof filteredBoatPosition?.latitude === 'object'
        ? filteredBoatPosition.latitude?.value
        : filteredBoatPosition?.latitude;
      const boatLon = typeof filteredBoatPosition?.longitude === 'object'
        ? filteredBoatPosition.longitude?.value
        : filteredBoatPosition?.longitude;

      const dropPosition = anchorState.anchorDropLocation?.position;
      const anchorPosition = anchorState.anchorLocation?.position;
      const criticalRangeValue = anchorState.criticalRange?.r;
      const criticalRangeUnits = anchorState.criticalRange?.units;
      const criticalRangeMeters = convertDistanceToMeters(criticalRangeValue, criticalRangeUnits);
      const unitLabel = criticalRangeUnits;

      const dropLat = typeof dropPosition.latitude === 'object' ? dropPosition.latitude?.value : dropPosition.latitude;
      const dropLon = typeof dropPosition.longitude === 'object' ? dropPosition.longitude?.value : dropPosition.longitude;
      const anchorLat = typeof anchorPosition.latitude === 'object' ? anchorPosition.latitude?.value : anchorPosition.latitude;
      const anchorLon = typeof anchorPosition.longitude === 'object' ? anchorPosition.longitude?.value : anchorPosition.longitude;

      if (boatLat == null || boatLon == null || dropLat == null || dropLon == null || anchorLat == null || anchorLon == null) {
        return null;
      }

      const distanceBoatFromDrop = calculateDistance(
        boatLat,
        boatLon,
        dropLat,
        dropLon
      );

      const distanceInRangeUnits = convertDistanceFromMeters(distanceBoatFromDrop, criticalRangeUnits);

      const drift = calculateDistance(
        dropLat,
        dropLon,
        anchorLat,
        anchorLon
      );

      anchorAlertDebounceState.draggingCandidateSince = null;

      return {
        type: 'CREATE_ALERT',
        data: {
          type: 'system',
          category: 'anchor',
          source: 'anchor_monitor',
          level: 'critical',
          label: 'Anchor Dragging',
          message: `Anchor is dragging! Distance from drop (${Math.round(
            distanceInRangeUnits
          )} ${unitLabel}) exceeds critical range (${criticalRangeValue} ${unitLabel}).`,
          trigger: 'anchor_dragging',
          data: {
            distance: Math.round(distanceInRangeUnits),
            criticalRange: criticalRangeValue,
            criticalRangeMeters,
            drift: Math.round(drift),
            units: unitLabel,
          },
          autoResolvable: false,
        },
      };
    },
  },

  // AIS Proximity Detection (server-side AIS proximity alert)
  {
    name: 'AIS Proximity Detection',
    description: 'Creates an alert when AIS targets are within warning radius of the boat',
    priority: 'high',
    condition: (state) => {
      const anchorState = state.anchor || {};
      
      if (!isAnchorMonitoringEnabled(anchorState)) {
        return false;
      }

      const selfMmsi = normalizeMmsi(state?.vessel?.info?.mmsi);

      const aisTargetsObj = state.aisTargets || {};
      const aisTargetsArray = Array.isArray(state.ais?.targets)
        ? state.ais.targets
        : Object.values(aisTargetsObj);
      const warningRadiusValue = anchorState.warningRange?.r;
      const warningRadiusUnits = anchorState.warningRange?.units;
      const warningRadiusMeters = convertDistanceToMeters(warningRadiusValue, warningRadiusUnits);

      const navLat = state.navigation?.position?.latitude?.value;
      const navLon = state.navigation?.position?.longitude?.value;

      const positionRoot =
        state.position && typeof state.position === 'object'
          ? state.position
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

      const boatLat = navLat != null ? navLat : fallbackBoatLat;
      const boatLon = navLon != null ? navLon : fallbackBoatLon;

      if (!Number.isFinite(warningRadiusMeters) || boatLat == null || boatLon == null || !aisTargetsArray.length) {
        return false;
      }

      // Filter out targets with invalid positions
      const validTargets = aisTargetsArray.filter((target) => {
        if (!target.position) return false;
        const targetMmsi = normalizeMmsi(target?.mmsi);
        if (selfMmsi != null && targetMmsi != null && targetMmsi === selfMmsi) return false;
        if (target.position.latitude == null || target.position.longitude == null ||
            isNaN(target.position.latitude) || isNaN(target.position.longitude) ||
            Math.abs(target.position.latitude) > 90 || Math.abs(target.position.longitude) > 180) {
            return false;
        }
        return true;
      });


      const targetDiagnostics = validTargets.map((target) => {
        const distanceMeters = calculateDistance(
          target.position.latitude,
          target.position.longitude,
          boatLat,
          boatLon
        );
        const targetMmsi = normalizeMmsi(target?.mmsi) ?? target?.mmsi ?? null;

        return {
          mmsi: targetMmsi,
          latitude: target.position.latitude,
          longitude: target.position.longitude,
          distanceMeters,
          inRange: Number.isFinite(distanceMeters) && distanceMeters <= warningRadiusMeters,
        };
      });

      const targetsInRange = targetDiagnostics.filter((target) => target.inRange);

      // Get MMSI numbers of vessels currently in range
      const inRangeMMSIs = targetsInRange.map((target) => target.mmsi).filter(Boolean);

      // Check for existing alerts for these specific vessels
      const activeAlerts = state.alerts?.active || [];
      const existingAlertMMSIs = activeAlerts
        .filter(alert => alert.trigger === 'ais_proximity' && !alert.acknowledged && alert.data?.targetMMSIs)
        .flatMap(alert => alert.data.targetMMSIs);
      

      // Find vessels that need new alerts (in range but don't have alerts yet)
      const newVesselsNeedingAlerts = inRangeMMSIs.filter(mmsi => !existingAlertMMSIs.includes(mmsi));

      const shouldTrigger = newVesselsNeedingAlerts.length > 0;
      if (!shouldTrigger) {
        if (anchorAlertDebounceState.aisProximityCandidateSince != null) {
          console.log('[AIS Proximity Detection][diagnostics] candidate reset: no new vessels in range', {
            selfMmsi,
            boatLat,
            boatLon,
            warningRadiusValue,
            warningRadiusUnits,
            warningRadiusMeters,
            inRangeMMSIs,
            existingAlertMMSIs,
            targetDiagnostics,
          });
        }
        anchorAlertDebounceState.aisProximityCandidateSince = null;
        return false;
      }

      const now = Date.now();
      if (anchorAlertDebounceState.aisProximityCandidateSince == null) {
        anchorAlertDebounceState.aisProximityCandidateSince = now;
        console.log('[AIS Proximity Detection][diagnostics] trigger candidate started', {
          selfMmsi,
          boatLat,
          boatLon,
          warningRadiusValue,
          warningRadiusUnits,
          warningRadiusMeters,
          inRangeMMSIs,
          existingAlertMMSIs,
          newVesselsNeedingAlerts,
          targetDiagnostics,
        });
        return false;
      }

      console.log('[AIS Proximity Detection][diagnostics] trigger confirmed', {
        selfMmsi,
        boatLat,
        boatLon,
        warningRadiusValue,
        warningRadiusUnits,
        warningRadiusMeters,
        inRangeMMSIs,
        existingAlertMMSIs,
        newVesselsNeedingAlerts,
        targetDiagnostics,
        debounceMs: now - anchorAlertDebounceState.aisProximityCandidateSince,
      });

      return (now - anchorAlertDebounceState.aisProximityCandidateSince) >= ANCHOR_ALERT_DEBOUNCE_MS;
    },
    action: (state) => {
      const anchorState = state.anchor || {};
      const selfMmsi = normalizeMmsi(state?.vessel?.info?.mmsi);
      const aisTargetsArray = Array.isArray(state.ais?.targets)
        ? state.ais.targets
        : Object.values(state.aisTargets || {});
      const warningRadiusValue = anchorState.warningRange?.r;
      const warningRadiusUnits = anchorState.warningRange?.units;
      const warningRadiusMeters = convertDistanceToMeters(warningRadiusValue, warningRadiusUnits);

      const navLat = state.navigation?.position?.latitude?.value;
      const navLon = state.navigation?.position?.longitude?.value;

      const positionRoot =
        state.position && typeof state.position === "object"
          ? state.position
          : {};
      const boatPositionFromPosition =
        positionRoot.signalk && typeof positionRoot.signalk === "object"
          ? positionRoot.signalk
          : positionRoot;

      const fallbackBoatLat = typeof boatPositionFromPosition?.latitude === 'object'
        ? boatPositionFromPosition.latitude?.value
        : boatPositionFromPosition?.latitude;
      const fallbackBoatLon = typeof boatPositionFromPosition?.longitude === 'object'
        ? boatPositionFromPosition.longitude?.value
        : boatPositionFromPosition?.longitude;

      const boatLat = navLat != null ? navLat : fallbackBoatLat;
      const boatLon = navLon != null ? navLon : fallbackBoatLon;

      if (!Number.isFinite(warningRadiusMeters) || boatLat == null || boatLon == null) {
        return null;
      }

      const unitLabel = warningRadiusUnits;

      // Get detailed info for vessels in range
      const targetsInRange = aisTargetsArray.filter((target) => {
        if (!target.position) return false;
        const targetMmsi = normalizeMmsi(target?.mmsi);
        if (selfMmsi != null && targetMmsi != null && targetMmsi === selfMmsi) return false;

        const distance = calculateDistance(
          target.position.latitude,
          target.position.longitude,
          boatLat,
          boatLon
        );

        return distance <= warningRadiusMeters;
      });

      // Get existing alert MMSIs to find vessels that need new alerts
      const activeAlerts = state.alerts?.active || [];
      const existingAlertMMSIs = activeAlerts
        .filter(alert => alert.trigger === 'ais_proximity' && !alert.acknowledged && alert.data?.targetMMSIs)
        .flatMap(alert => alert.data.targetMMSIs);

      // Find vessels that need new alerts (in range but don't have alerts yet)
      const newVesselsNeedingAlerts = targetsInRange.filter(target => 
        target.mmsi && !existingAlertMMSIs.includes(target.mmsi)
      );

      if (newVesselsNeedingAlerts.length === 0) {
        return null;
      }

      anchorAlertDebounceState.aisProximityCandidateSince = null;

      const newVesselMMSIs = newVesselsNeedingAlerts.map(v => v.mmsi);

      return {
        type: 'CREATE_ALERT',
        data: {
          type: 'system',
          category: 'anchor',
          source: 'ais_monitor',
          level: 'warning',
          label: 'AIS Proximity Warning',
          message: `${newVesselsNeedingAlerts.length} new vessel(s) detected within warning radius of ${warningRadiusValue} ${unitLabel}.`,
          trigger: 'ais_proximity',
          data: {
            targetCount: targetsInRange.length,
            newVesselCount: newVesselsNeedingAlerts.length,
            targetMMSIs: newVesselMMSIs,
            warningRadius: warningRadiusValue,
            warningRadiusUnits,
            warningRadiusMeters,
            units: unitLabel,
          },
          autoResolvable: true,
        },
      };
    },
  },

  // AIS Proximity Resolution
  {
    name: 'AIS Proximity Resolution',
    description: 'Resolves AIS proximity alert when no targets are within warning radius',
    priority: 'high',
    condition: (state) => {
      const hasActiveAlerts = state.alerts?.active?.some(
        (alert) =>
          alert.trigger === 'ais_proximity' &&
          alert.autoResolvable === true &&
          !alert.acknowledged
      );

      const anchorState = state.anchor || {};
      const selfMmsi = normalizeMmsi(state?.vessel?.info?.mmsi);
      if (!isAnchorMonitoringEnabled(anchorState)) {
        return false;
      }

      const aisTargetsArray = Array.isArray(state.ais?.targets)
        ? state.ais.targets
        : Object.values(state.aisTargets || {});
      const warningRadiusValue = anchorState.warningRange?.r;
      const warningRadiusUnits = anchorState.warningRange?.units;
      const warningRadiusMeters = convertDistanceToMeters(warningRadiusValue, warningRadiusUnits);

      const navLat = state.navigation?.position?.latitude?.value;
      const navLon = state.navigation?.position?.longitude?.value;

      const positionRoot =
        state.position && typeof state.position === 'object'
          ? state.position
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

      const boatLat = navLat != null ? navLat : fallbackBoatLat;
      const boatLon = navLon != null ? navLon : fallbackBoatLon;

      if (!hasActiveAlerts || !Number.isFinite(warningRadiusMeters) || boatLat == null || boatLon == null || !aisTargetsArray.length) {
        if (anchorAlertDebounceState.aisProximityClearCandidateSince != null) {
          console.log('[AIS Proximity Resolution][diagnostics] clear candidate reset: prerequisites missing', {
            selfMmsi,
            hasActiveAlerts,
            warningRadiusValue,
            warningRadiusUnits,
            warningRadiusMeters,
            boatLat,
            boatLon,
            aisTargetsCount: aisTargetsArray.length,
          });
        }
        anchorAlertDebounceState.aisProximityClearCandidateSince = null;
        return false;
      }

      const resolveTargetDiagnostics = aisTargetsArray.map((target) => {
        const targetMmsi = normalizeMmsi(target?.mmsi);
        if (selfMmsi != null && targetMmsi != null && targetMmsi === selfMmsi) {
          return {
            mmsi: targetMmsi,
            ignoredReason: 'self_target',
            inRange: false,
          };
        }

        if (!target?.position) {
          return {
            mmsi: targetMmsi,
            ignoredReason: 'missing_position',
            inRange: false,
          };
        }
        if (target.position.latitude == null || target.position.longitude == null ||
            isNaN(target.position.latitude) || isNaN(target.position.longitude) ||
            Math.abs(target.position.latitude) > 90 || Math.abs(target.position.longitude) > 180) {
          return {
            mmsi: targetMmsi,
            latitude: target.position.latitude,
            longitude: target.position.longitude,
            ignoredReason: 'invalid_position',
            inRange: false,
          };
        }

        const distanceMeters = calculateDistance(
          target.position.latitude,
          target.position.longitude,
          boatLat,
          boatLon
        );

        return {
          mmsi: targetMmsi,
          latitude: target.position.latitude,
          longitude: target.position.longitude,
          distanceMeters,
          inRange: Number.isFinite(distanceMeters) && distanceMeters <= warningRadiusMeters,
        };
      });

      const targetsInRange = resolveTargetDiagnostics.filter((target) => target.inRange);

      if (targetsInRange.length > 0) {
        if (anchorAlertDebounceState.aisProximityClearCandidateSince != null) {
          console.log('[AIS Proximity Resolution][diagnostics] clear candidate reset: targets still in range', {
            selfMmsi,
            boatLat,
            boatLon,
            warningRadiusValue,
            warningRadiusUnits,
            warningRadiusMeters,
            targetsInRange,
            resolveTargetDiagnostics,
          });
        }
        anchorAlertDebounceState.aisProximityClearCandidateSince = null;
        return false;
      }

      const now = Date.now();
      if (anchorAlertDebounceState.aisProximityClearCandidateSince == null) {
        anchorAlertDebounceState.aisProximityClearCandidateSince = now;
        console.log('[AIS Proximity Resolution][diagnostics] clear candidate started', {
          selfMmsi,
          boatLat,
          boatLon,
          warningRadiusValue,
          warningRadiusUnits,
          warningRadiusMeters,
          resolveTargetDiagnostics,
        });
        return false;
      }

      console.log('[AIS Proximity Resolution][diagnostics] clear confirmed', {
        selfMmsi,
        boatLat,
        boatLon,
        warningRadiusValue,
        warningRadiusUnits,
        warningRadiusMeters,
        resolveTargetDiagnostics,
        debounceMs: now - anchorAlertDebounceState.aisProximityClearCandidateSince,
      });

      return (now - anchorAlertDebounceState.aisProximityClearCandidateSince) >= ANCHOR_ALERT_DEBOUNCE_MS;
    },
    action: (state) => {
      const anchorState = state.anchor || {};
      const warningRadiusValue = anchorState.warningRange?.r;
      const warningRadiusUnits = anchorState.warningRange?.units;

      anchorAlertDebounceState.aisProximityClearCandidateSince = null;

      return {
        type: 'RESOLVE_ALERT',
        trigger: 'ais_proximity',
        data: {
          warningRadius: warningRadiusValue,
          units: warningRadiusUnits,
        },
      };
    },
  },
];

// Helper function to calculate distance between two coordinates (Haversine formula)
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371e3; // Earth's radius in meters
  const φ1 = lat1 * Math.PI/180;
  const φ2 = lat2 * Math.PI/180;
  const Δφ = (lat2-lat1) * Math.PI/180;
  const Δλ = (lon2-lon1) * Math.PI/180;

  const a = Math.sin(Δφ/2) * Math.sin(Δφ/2) +
            Math.cos(φ1) * Math.cos(φ2) *
            Math.sin(Δλ/2) * Math.sin(Δλ/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));

  return R * c; // Distance in meters
}
