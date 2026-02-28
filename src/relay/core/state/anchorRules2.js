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
};

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
      if (!anchorState.anchorDeployed) {
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

      const boatLat = navLat != null ? navLat : boatPositionFromPosition?.latitude;
      const boatLon = navLon != null ? navLon : boatPositionFromPosition?.longitude;

      const criticalRange = anchorState.criticalRange?.r;
      const dropPosition = anchorState.anchorDropLocation?.position;

      if (!criticalRange || !dropPosition || boatLat == null || boatLon == null) {
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

      const hasActiveAlert = state.alerts?.active?.some(
        (alert) => alert.trigger === 'critical_range' && !alert.acknowledged
      );

      const isOutsideCriticalRange = distance > criticalRange;

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

      const boatLat = navLat != null ? navLat : boatPositionFromPosition?.latitude;
      const boatLon = navLon != null ? navLon : boatPositionFromPosition?.longitude;

      const dropPosition = anchorState.anchorDropLocation?.position;
      const criticalRange = anchorState.criticalRange?.r;
      const isMetric = state.units?.distance === 'meters';
      const unitLabel = isMetric ? 'm' : 'ft';

      const dropLat = typeof dropPosition.latitude === 'object' ? dropPosition.latitude?.value : dropPosition.latitude;
      const dropLon = typeof dropPosition.longitude === 'object' ? dropPosition.longitude?.value : dropPosition.longitude;

      const distance = calculateDistance(
        boatLat,
        boatLon,
        dropLat,
        dropLon
      );

      return {
        type: 'CREATE_ALERT',
        data: {
          type: 'system',
          category: 'anchor',
          source: 'anchor_monitor',
          level: 'critical',
          label: 'Critical Range Exceeded',
          message: `Boat has exceeded critical range! Distance from drop (${Math.round(
            distance
          )} ${unitLabel}) is beyond critical range (${criticalRange} ${unitLabel}).`,
          trigger: 'critical_range',
          data: {
            distance: Math.round(distance),
            criticalRange,
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
      if (!anchorState.anchorDeployed) {
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

      const boatLat = navLat != null ? navLat : boatPositionFromPosition?.latitude;
      const boatLon = navLon != null ? navLon : boatPositionFromPosition?.longitude;

      const dropPosition = anchorState.anchorDropLocation?.position;
      const anchorPosition = anchorState.anchorLocation?.position;
      const criticalRange = anchorState.criticalRange?.r;

      if (!criticalRange || !dropPosition || !anchorPosition || boatLat == null || boatLon == null) {
        return false;
      }

      const dropLat = typeof dropPosition.latitude === 'object' ? dropPosition.latitude?.value : dropPosition.latitude;
      const dropLon = typeof dropPosition.longitude === 'object' ? dropPosition.longitude?.value : dropPosition.longitude;
      const anchorLat = typeof anchorPosition.latitude === 'object' ? anchorPosition.latitude?.value : anchorPosition.latitude;
      const anchorLon = typeof anchorPosition.longitude === 'object' ? anchorPosition.longitude?.value : anchorPosition.longitude;

      if (dropLat == null || dropLon == null || anchorLat == null || anchorLon == null) {
        return false;
      }

      const distanceBoatFromDrop = calculateDistance(
        boatLat,
        boatLon,
        dropLat,
        dropLon
      );

      const drift = calculateDistance(
        dropLat,
        dropLon,
        anchorLat,
        anchorLon
      );

      const ANCHOR_MOVED_THRESHOLD_METERS = 5;
      const anchorHasMoved = drift > ANCHOR_MOVED_THRESHOLD_METERS;
      const isOutsideCriticalRange = distanceBoatFromDrop > criticalRange;

      const hasActiveAlert = state.alerts?.active?.some(
        (alert) => alert.trigger === 'anchor_dragging' && !alert.acknowledged
      );

      const draggingCondition = isOutsideCriticalRange && anchorHasMoved;

      if (!draggingCondition || hasActiveAlert) {
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

      const boatLat = navLat != null ? navLat : boatPositionFromPosition?.latitude;
      const boatLon = navLon != null ? navLon : boatPositionFromPosition?.longitude;

      const dropPosition = anchorState.anchorDropLocation?.position;
      const anchorPosition = anchorState.anchorLocation?.position;
      const criticalRange = anchorState.criticalRange?.r;
      const isMetric = state.units?.distance === 'meters';
      const unitLabel = isMetric ? 'm' : 'ft';

      const dropLat = typeof dropPosition.latitude === 'object' ? dropPosition.latitude?.value : dropPosition.latitude;
      const dropLon = typeof dropPosition.longitude === 'object' ? dropPosition.longitude?.value : dropPosition.longitude;
      const anchorLat = typeof anchorPosition.latitude === 'object' ? anchorPosition.latitude?.value : anchorPosition.latitude;
      const anchorLon = typeof anchorPosition.longitude === 'object' ? anchorPosition.longitude?.value : anchorPosition.longitude;

      const distanceBoatFromDrop = calculateDistance(
        boatLat,
        boatLon,
        dropLat,
        dropLon
      );

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
            distanceBoatFromDrop
          )} ${unitLabel}) exceeds critical range (${criticalRange} ${unitLabel}).`,
          trigger: 'anchor_dragging',
          data: {
            distance: Math.round(distanceBoatFromDrop),
            criticalRange,
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
      console.log('[AIS Proximity] Rule evaluation - anchorDeployed:', anchorState.anchorDeployed);
      
      if (!anchorState.anchorDeployed) {
        console.log('[AIS Proximity] Rule skipped - anchor not deployed');
        return false;
      }

      const aisTargetsObj = state.aisTargets || {};
      const aisTargetsArray = Array.isArray(state.ais?.targets)
        ? state.ais.targets
        : Object.values(aisTargetsObj);
      const warningRadius = anchorState.warningRange?.r || 15;
      
      console.log('[AIS Proximity] AIS data:', {
        aisTargetsCount: aisTargetsArray.length,
        warningRadius,
        hasAisTargets: !!state.ais?.targets,
        hasAisTargetsObj: !!state.aisTargets,
        aisTargetsSample: aisTargetsArray.slice(0, 2)
      });

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

      const boatLat = navLat != null ? navLat : boatPositionFromPosition?.latitude;
      const boatLon = navLon != null ? navLon : boatPositionFromPosition?.longitude;

      console.log('[AIS Proximity] Position data:', {
        navLat, navLon,
        boatLat, boatLon,
        hasNavPosition: !!state.navigation?.position,
        hasPosition: !!state.position
      });

      if (!warningRadius || boatLat == null || boatLon == null || !aisTargetsArray.length) {
        console.log('[AIS Proximity] Rule failed - missing data:', {
          hasWarningRadius: !!warningRadius,
          hasBoatLat: boatLat != null,
          hasBoatLon: boatLon != null,
          hasTargets: aisTargetsArray.length > 0
        });
        return false;
      }

      const targetsInRange = aisTargetsArray.filter((target) => {
        if (!target.position) return false;

        const distance = calculateDistance(
          target.position.latitude,
          target.position.longitude,
          boatLat,
          boatLon
        );

        console.log('[AIS Proximity] Target distance check:', {
          target: target.name || target.mmsi || 'unknown',
          distance,
          withinRange: distance <= warningRadius,
          targetPos: target.position,
          boatPos: { lat: boatLat, lon: boatLon }
        });

        return distance <= warningRadius;
      });

      console.log('[AIS Proximity] Targets in range:', targetsInRange.length);

      const hasActiveAlert = state.alerts?.active?.some(
        (alert) => alert.trigger === 'ais_proximity' && !alert.acknowledged
      );

      const shouldTrigger = targetsInRange.length > 0 && !hasActiveAlert;
      console.log('[AIS Proximity] Rule result:', {
        targetsInRange: targetsInRange.length,
        hasActiveAlert,
        shouldTrigger
      });

      return shouldTrigger;
    },
    action: (state) => {
      const anchorState = state.anchor || {};
      const aisTargetsArray = Array.isArray(state.ais?.targets)
        ? state.ais.targets
        : Object.values(state.aisTargets || {});
      const warningRadius = anchorState.warningRange?.r || 15;

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

      const boatLat = navLat != null ? navLat : boatPositionFromPosition?.latitude;
      const boatLon = navLon != null ? navLon : boatPositionFromPosition?.longitude;

      const isMetric = state.units?.distance === 'meters';
      const unitLabel = isMetric ? 'm' : 'ft';

      const targetsInRange = aisTargetsArray.filter((target) => {
        if (!target.position) return false;

        const distance = calculateDistance(
          target.position.latitude,
          target.position.longitude,
          boatLat,
          boatLon
        );

        return distance <= warningRadius;
      }).length;

      return {
        type: 'CREATE_ALERT',
        data: {
          type: 'system',
          category: 'anchor',
          source: 'ais_monitor',
          level: 'warning',
          label: 'AIS Proximity Warning',
          message: `${targetsInRange} vessel(s) detected within warning radius of ${warningRadius} ${unitLabel}.`,
          trigger: 'ais_proximity',
          data: {
            targetCount: targetsInRange,
            warningRadius,
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
      const aisTargetsArray = Array.isArray(state.ais?.targets)
        ? state.ais.targets
        : Object.values(state.aisTargets || {});
      const warningRadius = anchorState.warningRange?.r;

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

      const boatLat = navLat != null ? navLat : boatPositionFromPosition?.latitude;
      const boatLon = navLon != null ? navLon : boatPositionFromPosition?.longitude;

      if (!hasActiveAlerts || !warningRadius || boatLat == null || boatLon == null || !aisTargetsArray.length) {
        return false;
      }

      const targetsInRange = aisTargetsArray.filter((target) => {
        const distance = calculateDistance(
          target.position.latitude,
          target.position.longitude,
          boatLat,
          boatLon
        );

        return distance <= warningRadius;
      });

      return targetsInRange.length === 0;
    },
    action: (state) => {
      const anchorState = state.anchor || {};
      const warningRadius = anchorState.warningRange?.r;
      const isMetric = state.units?.distance === 'meters';

      return {
        type: 'RESOLVE_ALERT',
        trigger: 'ais_proximity',
        data: {
          warningRadius,
          units: isMetric ? 'm' : 'ft',
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
