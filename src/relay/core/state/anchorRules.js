/**
 * Anchor Rules for the state manager
 * These rules define when anchor-related alerts should be triggered and resolved
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
  
  // Convert to radians
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
      // Check if anchor is deployed
      const anchorState = state.anchor || {};
      if (!anchorState.anchorDeployed) {
        return false;
      }
      
      // Get boat position and anchor position
      const boatPosition = state.position || {};
      const criticalRange = anchorState.criticalRange?.r;
      const anchorPosition = anchorState.anchorLocation?.position;
      
      // If missing data, rule doesn't apply
      if (!criticalRange || !anchorPosition || !boatPosition) {
        return false;
      }
      
      // Calculate distance between boat and anchor
      const distance = calculateDistance(
        boatPosition.latitude,
        boatPosition.longitude,
        anchorPosition.latitude,
        anchorPosition.longitude
      );
      
      // Check if there's already an active alert for this condition
      const hasActiveAlert = state.alerts?.active?.some(
        alert => alert.trigger === 'critical_range' && !alert.acknowledged
      );
      
      // Rule triggers when boat exceeds critical range and no active alert exists
      return distance > criticalRange && !hasActiveAlert;
    },
    action: {
      type: 'CREATE_ALERT',
      alertData: (state) => {
        const anchorState = state.anchor || {};
        const boatPosition = state.position || {};
        const anchorPosition = anchorState.anchorLocation?.position;
        const criticalRange = anchorState.criticalRange?.r;
        const isMetric = state.units?.distance === 'meters';
        const unitLabel = isMetric ? 'm' : 'ft';
        
        // Calculate current distance
        const distance = calculateDistance(
          boatPosition.latitude,
          boatPosition.longitude,
          anchorPosition.latitude,
          anchorPosition.longitude
        );
        
        return {
          type: 'system',
          category: 'anchor',
          source: 'anchor_monitor',
          level: 'critical',
          label: 'Critical Range Exceeded',
          message: `Boat has exceeded critical range! Distance from anchor (${Math.round(distance)} ${unitLabel}) is beyond critical range (${criticalRange} ${unitLabel}).`,
          trigger: 'critical_range',
          data: {
            distance: Math.round(distance),
            criticalRange,
            units: unitLabel
          },
          autoResolvable: true
        };
      }
    }
  },
  
  // Critical Range Resolution Rule
  {
    name: 'Critical Range Resolution',
    condition: (state) => {
      // Check if we have active critical range alerts
      const hasActiveAlerts = state.alerts?.active?.some(
        alert => alert.trigger === 'critical_range' && 
                alert.autoResolvable === true && 
                !alert.acknowledged
      );
      
      // Check if the boat is back within critical range
      const anchorState = state.anchor || {};
      const boatPosition = state.position || {};
      const criticalRange = anchorState.criticalRange?.r;
      const anchorPosition = anchorState.anchorLocation?.position;
      
      // If no active alerts or missing data, rule doesn't apply
      if (!hasActiveAlerts || !criticalRange || !anchorPosition || !boatPosition) {
        return false;
      }
      
      // Calculate distance between boat and anchor
      const distance = calculateDistance(
        boatPosition.latitude,
        boatPosition.longitude,
        anchorPosition.latitude,
        anchorPosition.longitude
      );
      
      // Rule triggers when boat is back within critical range
      return distance <= criticalRange;
    },
    action: {
      type: 'RESOLVE_ALERTS',
      trigger: 'critical_range',
      resolutionData: (state) => {
        const anchorState = state.anchor || {};
        const boatPosition = state.position || {};
        const anchorPosition = anchorState.anchorLocation?.position;
        const isMetric = state.units?.distance === 'meters';
        
        // Calculate current distance
        const distance = calculateDistance(
          boatPosition.latitude,
          boatPosition.longitude,
          anchorPosition.latitude,
          anchorPosition.longitude
        );
        
        return {
          distance: Math.round(distance),
          units: isMetric ? 'm' : 'ft'
        };
      }
    }
  },
  
  // Anchor Dragging Detection Rule
  {
    name: 'Anchor Dragging Detection',
    condition: (state) => {
      // Check if anchor is deployed
      const anchorState = state.anchor || {};
      if (!anchorState.anchorDeployed) {
        return false;
      }
      
      // Get boat position and anchor position
      const boatPosition = state.position || {};
      const rodeLength = anchorState.rode?.amount || 0;
      const anchorPosition = anchorState.anchorLocation?.position;
      const anchorDragTriggerDistance = 5; // Additional buffer distance
      
      // If missing data, rule doesn't apply
      if (!rodeLength || !anchorPosition || !boatPosition) {
        return false;
      }
      
      // Calculate distance between boat and anchor
      const distance = calculateDistance(
        boatPosition.latitude,
        boatPosition.longitude,
        anchorPosition.latitude,
        anchorPosition.longitude
      );
      
      // Check if there's already an active alert for this condition
      const hasActiveAlert = state.alerts?.active?.some(
        alert => alert.trigger === 'anchor_dragging' && !alert.acknowledged
      );
      
      // Rule triggers when distance exceeds rode length plus buffer and no active alert exists
      return distance > (rodeLength + anchorDragTriggerDistance) && !hasActiveAlert;
    },
    action: {
      type: 'CREATE_ALERT',
      alertData: (state) => {
        const anchorState = state.anchor || {};
        const boatPosition = state.position || {};
        const anchorPosition = anchorState.anchorLocation?.position;
        const rodeLength = anchorState.rode?.amount || 0;
        const isMetric = state.units?.distance === 'meters';
        const unitLabel = isMetric ? 'm' : 'ft';
        
        // Calculate current distance
        const distance = calculateDistance(
          boatPosition.latitude,
          boatPosition.longitude,
          anchorPosition.latitude,
          anchorPosition.longitude
        );
        
        return {
          type: 'system',
          category: 'anchor',
          source: 'anchor_monitor',
          level: 'critical',
          label: 'Anchor Dragging',
          message: `Anchor is dragging! Distance to anchor (${Math.round(distance)} ${unitLabel}) exceeds rode length (${rodeLength} ${unitLabel}).`,
          trigger: 'anchor_dragging',
          data: {
            distance: Math.round(distance),
            rodeLength,
            units: unitLabel
          },
          autoResolvable: false // Anchor dragging requires manual acknowledgment
        };
      }
    }
  },
  
  // AIS Proximity Detection Rule
  {
    name: 'AIS Proximity Detection',
    condition: (state) => {
      // Check if anchor is deployed
      const anchorState = state.anchor || {};
      if (!anchorState.anchorDeployed) {
        return false;
      }
      
      // Get AIS targets and warning radius
      const aisTargets = state.ais?.targets || [];
      const warningRadius = anchorState.warningRange?.r || 15;
      const anchorPosition = anchorState.anchorLocation?.position;
      
      // If missing data, rule doesn't apply
      if (!warningRadius || !anchorPosition || !aisTargets.length) {
        return false;
      }
      
      // Count targets in warning range
      const targetsInRange = aisTargets.filter(target => {
        if (!target.position) return false;
        
        // Calculate distance between target and anchor
        const distance = calculateDistance(
          target.position.latitude,
          target.position.longitude,
          anchorPosition.latitude,
          anchorPosition.longitude
        );
        
        return distance <= warningRadius;
      });
      
      // Check if there's already an active alert for this condition
      const hasActiveAlert = state.alerts?.active?.some(
        alert => alert.trigger === 'ais_proximity' && !alert.acknowledged
      );
      
      // Rule triggers when there are targets in range and no active alert exists
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
        
        // Count targets in warning range
        const targetsInRange = aisTargets.filter(target => {
          if (!target.position) return false;
          
          // Calculate distance between target and anchor
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
            units: unitLabel
          },
          autoResolvable: true
        };
      }
    }
  },
  
  // AIS Proximity Resolution Rule
  {
    name: 'AIS Proximity Resolution',
    condition: (state) => {
      // Check if we have active AIS proximity alerts
      const hasActiveAlerts = state.alerts?.active?.some(
        alert => alert.trigger === 'ais_proximity' && 
                alert.autoResolvable === true && 
                !alert.acknowledged
      );
      
      // If no active alerts, rule doesn't apply
      if (!hasActiveAlerts) {
        return false;
      }
      
      // Get AIS targets and warning radius
      const aisTargets = state.ais?.targets || [];
      const anchorState = state.anchor || {};
      const warningRadius = anchorState.warningRange?.r || 15;
      const anchorPosition = anchorState.anchorLocation?.position;
      
      // If missing data, rule doesn't apply
      if (!warningRadius || !anchorPosition) {
        return false;
      }
      
      // Check if there are no targets in warning range
      const targetsInRange = aisTargets.filter(target => {
        if (!target.position) return false;
        
        // Calculate distance between target and anchor
        const distance = calculateDistance(
          target.position.latitude,
          target.position.longitude,
          anchorPosition.latitude,
          anchorPosition.longitude
        );
        
        return distance <= warningRadius;
      });
      
      // Rule triggers when there are no targets in range
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
          units: isMetric ? 'm' : 'ft'
        };
      }
    }
  }
];
