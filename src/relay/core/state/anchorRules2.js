/**
 * Anchor-related rules for the optimized rule engine
 * These rules handle anchor deployment, retrieval, and monitoring
 */

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
        console.log('[Rule][Critical Range Detection] guard failed', {
          criticalRange,
          hasDropPosition: !!dropPosition,
          boatLat,
          boatLon,
        });
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

      console.log('[Rule][Critical Range Detection] evaluating', {
        distance,
        criticalRange,
      });

      const hasActiveAlert = state.alerts?.active?.some(
        (alert) => alert.trigger === 'critical_range' && !alert.acknowledged
      );

      return distance > criticalRange && !hasActiveAlert;
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
          message: `Boat has exceeded critical range! Distance from anchor (${Math.round(
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
      const criticalRange = anchorState.criticalRange?.r || 0;
      const anchorDragTriggerDistance = 5;

      if (!criticalRange || !dropPosition || boatLat == null || boatLon == null) {
        return false;
      }

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
        (alert) => alert.trigger === 'anchor_dragging' && !alert.acknowledged
      );

      return distance > criticalRange + anchorDragTriggerDistance && !hasActiveAlert;
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
      const criticalRange = anchorState.criticalRange?.r || 0;
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
          label: 'Anchor Dragging',
          message: `Anchor is dragging! Distance from drop point (${Math.round(
            distance
          )} ${unitLabel}) exceeds critical range (${criticalRange} ${unitLabel}).`,
          trigger: 'anchor_dragging',
          data: {
            distance: Math.round(distance),
            criticalRange,
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
      if (!anchorState.anchorDeployed) {
        return false;
      }

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

      if (!warningRadius || boatLat == null || boatLon == null || !aisTargetsArray.length) {
        console.log('[Rule][AIS Proximity Detection] guard failed', {
          warningRadius,
          boatLat,
          boatLon,
          aisTargetCount: Array.isArray(aisTargetsArray) ? aisTargetsArray.length : 0,
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

        return distance <= warningRadius;
      });

      console.log('[Rule][AIS Proximity Detection] evaluating', {
        targetsInRange: targetsInRange.length,
        warningRadius,
      });

      const hasActiveAlert = state.alerts?.active?.some(
        (alert) => alert.trigger === 'ais_proximity' && !alert.acknowledged
      );

      return targetsInRange.length > 0 && !hasActiveAlert;
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
        console.log('[Rule][AIS Proximity Resolution] guard failed', {
          hasActiveAlerts,
          warningRadius,
          boatLat,
          boatLon,
          aisTargetCount: Array.isArray(aisTargetsArray) ? aisTargetsArray.length : 0,
        });
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

      console.log('[Rule][AIS Proximity Resolution] evaluating', {
        targetsInRange: targetsInRange.length,
        warningRadius,
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
