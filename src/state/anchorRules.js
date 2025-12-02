/**
 * Anchor-related rules for the state manager
 * These rules define when anchor alerts should be triggered and resolved
 */

/**
 * Calculate distance between two points in meters
 * @param {number} lat1 - Latitude of point 1
 * @param {number} lon1 - Longitude of point 1
 * @param {number} lat2 - Latitude of point 2
 * @param {number} lon2 - Longitude of point 2
 * @returns {number} Distance in meters
 */
function calculateDistance(lat1, lon1, lat2, lon2) {
  if (!lat1 || !lon1 || !lat2 || !lon2) return 0;

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
  const distance = R * c;

  return distance;
}

export const AnchorRules = [
  // Critical Range Detection Rule
  {
    name: 'Critical Range Detection',
    condition: (state) => {
      const anchorState = state.anchor || {};
      if (!anchorState.anchorDeployed) {
        return false;
      }

      const boatPosition = state.position || {};
      const criticalRange = anchorState.criticalRange?.r;
      const dropPosition = anchorState.anchorDropLocation?.position;

      if (!criticalRange || !dropPosition || !boatPosition) {
        return false;
      }

      const distance = calculateDistance(
        boatPosition.latitude,
        boatPosition.longitude,
        dropPosition.latitude,
        dropPosition.longitude
      );

      const hasActiveAlert = state.alerts?.active?.some(
        (alert) => alert.trigger === 'critical_range' && !alert.acknowledged
      );

      return distance > criticalRange && !hasActiveAlert;
    },
    action: {
      type: 'CREATE_ALERT',
      alertData: (state) => {
        const anchorState = state.anchor || {};
        const boatPosition = state.position || {};
        const dropPosition = anchorState.anchorDropLocation?.position;
        const criticalRange = anchorState.criticalRange?.r;
        const isMetric = state.units?.distance === 'meters';
        const unitLabel = isMetric ? 'm' : 'ft';

        const distance = calculateDistance(
          boatPosition.latitude,
          boatPosition.longitude,
          dropPosition.latitude,
          dropPosition.longitude
        );

        return {
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
        };
      },
    },
  },

  // Anchor Dragging Detection Rule
  {
    name: 'Anchor Dragging Detection',
    condition: (state) => {
      const anchorState = state.anchor || {};
      if (!anchorState.anchorDeployed) {
        return false;
      }

      const boatPosition = state.position || {};
      const dropPosition = anchorState.anchorDropLocation?.position;
      const criticalRange = anchorState.criticalRange?.r || 0;
      const anchorDragTriggerDistance = 5;

      if (!criticalRange || !dropPosition || !boatPosition) {
        return false;
      }

      const distance = calculateDistance(
        boatPosition.latitude,
        boatPosition.longitude,
        dropPosition.latitude,
        dropPosition.longitude
      );

      const hasActiveAlert = state.alerts?.active?.some(
        (alert) => alert.trigger === 'anchor_dragging' && !alert.acknowledged
      );

      return distance > criticalRange + anchorDragTriggerDistance && !hasActiveAlert;
    },
    action: {
      type: 'CREATE_ALERT',
      alertData: (state) => {
        const anchorState = state.anchor || {};
        const boatPosition = state.position || {};
        const dropPosition = anchorState.anchorDropLocation?.position;
        const criticalRange = anchorState.criticalRange?.r || 0;
        const isMetric = state.units?.distance === 'meters';
        const unitLabel = isMetric ? 'm' : 'ft';

        const distance = calculateDistance(
          boatPosition.latitude,
          boatPosition.longitude,
          dropPosition.latitude,
          dropPosition.longitude
        );

        return {
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
        };
      },
    },
  },

  // AIS Proximity Detection Rule
  {
    name: 'AIS Proximity Detection',
    condition: (state) => {
      const anchorState = state.anchor || {};
      if (!anchorState.anchorDeployed) {
        return false;
      }

      const aisTargets = state.ais?.targets || [];
      const warningRadius = anchorState.warningRange?.r || 15;
      const anchorPosition = anchorState.anchorLocation?.position;

      if (!warningRadius || !anchorPosition || !aisTargets.length) {
        return false;
      }

      const targetsInRange = aisTargets.filter((target) => {
        if (!target.position) return false;

        const distance = calculateDistance(
          target.position.latitude,
          target.position.longitude,
          anchorPosition.latitude,
          anchorPosition.longitude
        );

        return distance <= warningRadius;
      });

      const hasActiveAlert = state.alerts?.active?.some(
        (alert) => alert.trigger === 'ais_proximity' && !alert.acknowledged
      );

      return targetsInRange.length > 0 && !hasActiveAlert;
    },
    action: {
      type: 'CREATE_ALERT',
      alertData: (state) => {
        const anchorState = state.anchor || {};
        const aisTargets = state.ais?.targets || [];
        const warningRadius = anchorState.warningRange?.r || 15;
        const anchorPosition = anchorState.anchorLocation?.position;
        const isMetric = state.units?.distance === 'meters';
        const unitLabel = isMetric ? 'm' : 'ft';

        const targetsInRange = aisTargets.filter((target) => {
          if (!target.position) return false;

          const distance = calculateDistance(
            target.position.latitude,
            target.position.longitude,
            anchorPosition.latitude,
            anchorPosition.longitude
          );

          return distance <= warningRadius;
        }).length;

        return {
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
        };
      },
    },
  },

  // Critical Range Resolution Rule
  {
    name: 'Critical Range Resolution',
    condition: (state) => {
      const hasActiveAlerts = state.alerts?.active?.some(
        (alert) =>
          alert.trigger === 'critical_range' &&
          alert.autoResolvable === true &&
          !alert.acknowledged
      );

      const anchorState = state.anchor || {};
      const boatPosition = state.position || {};
      const anchorPosition = anchorState.anchorLocation?.position;
      const criticalRange = anchorState.criticalRange?.r;

      if (!hasActiveAlerts || !criticalRange || !anchorPosition || !boatPosition) {
        return false;
      }

      const distance = calculateDistance(
        boatPosition.latitude,
        boatPosition.longitude,
        anchorPosition.latitude,
        anchorPosition.longitude
      );

      return distance <= criticalRange;
    },
    action: {
      type: 'RESOLVE_ALERTS',
      trigger: 'critical_range',
      resolutionData: (state) => {
        const anchorState = state.anchor || {};
        const boatPosition = state.position || {};
        const anchorPosition = anchorState.anchorLocation?.position;
        const criticalRange = anchorState.criticalRange?.r;
        const isMetric = state.units?.distance === 'meters';

        const distance = calculateDistance(
          boatPosition.latitude,
          boatPosition.longitude,
          anchorPosition.latitude,
          anchorPosition.longitude
        );

        return {
          distance: Math.round(distance),
          criticalRange,
          units: isMetric ? 'm' : 'ft',
        };
      },
    },
  },

  // AIS Proximity Resolution Rule
  {
    name: 'AIS Proximity Resolution',
    condition: (state) => {
      const hasActiveAlerts = state.alerts?.active?.some(
        (alert) =>
          alert.trigger === 'ais_proximity' &&
          alert.autoResolvable === true &&
          !alert.acknowledged
      );

      const anchorState = state.anchor || {};
      const aisTargets = state.ais?.targets || [];
      const warningRadius = anchorState.warningRange?.r;
      const anchorPosition = anchorState.anchorLocation?.position;

      if (!hasActiveAlerts || !warningRadius || !anchorPosition || !aisTargets.length) {
        return false;
      }

      const targetsInRange = aisTargets.filter((target) => {
        const distance = calculateDistance(
          target.position.latitude,
          target.position.longitude,
          anchorPosition.latitude,
          anchorPosition.longitude
        );

        return distance <= warningRadius;
      });

      return targetsInRange.length === 0;
    },
    action: {
      type: 'RESOLVE_ALERTS',
      trigger: 'ais_proximity',
      resolutionData: (state) => {
        const anchorState = state.anchor || {};
        const warningRadius = anchorState.warningRange?.r;
        const isMetric = state.units?.distance === 'meters';

        return {
          warningRadius,
          units: isMetric ? 'm' : 'ft',
        };
      },
    },
  },
];
