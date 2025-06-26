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
  // Anchor Deployed Rule
  {
    type: 'anchor',
    name: 'Anchor Deployed Notification',
    condition: (currentState, previousState, env) => {
      // For backward compatibility, handle case where only state is passed
      if (!previousState && currentState && currentState.anchor) {
        previousState = { anchor: {} };
      } else if (!previousState) {
        previousState = {};
      }
      try {
        console.log('\n[ANCHOR RULES] ===== Evaluating anchor deployed rule =====');
        console.log('[ANCHOR RULES] Current state:', {
          anchorDeployed: currentState?.anchor?.anchorDeployed,
          hasAnchorLocation: !!currentState?.anchor?.anchorLocation,
          hasDropLocation: !!currentState?.anchor?.anchorDropLocation
        });
        console.log('[ANCHOR RULES] Previous state:', {
          anchorDeployed: previousState?.anchor?.anchorDeployed,
          hasAnchorLocation: !!previousState?.anchor?.anchorLocation,
          hasDropLocation: !!previousState?.anchor?.anchorDropLocation
        });
        
        // Check if anchor was just deployed
        const anchorState = currentState?.anchor || {};
        const prevAnchorState = previousState?.anchor || {};

        // Check if anchor was just deployed
        const wasDeployed = prevAnchorState.anchorDeployed === true;
        const isDeployed = anchorState.anchorDeployed === true;
        const justDeployed = !wasDeployed && isDeployed;

        // Check if we have valid position data
        const hasPosition = anchorState.anchorLocation?.position?.latitude && 
                          anchorState.anchorLocation?.position?.longitude;
        
        // Check if we have valid drop position data (optional for deployment)
        const hasDropPosition = anchorState.anchorDropLocation?.position?.latitude &&
                              anchorState.anchorDropLocation?.position?.longitude;

        console.log(`[ANCHOR RULES] Deployment check - was: ${wasDeployed}, is: ${isDeployed}, just deployed: ${justDeployed}`);
        console.log(`[ANCHOR RULES] Position data - current: ${hasPosition} (${JSON.stringify(anchorState.anchorLocation?.position)})`);
        console.log(`[ANCHOR RULES] Drop position - current: ${hasDropPosition} (${JSON.stringify(anchorState.anchorDropLocation?.position)})`);

        // Log the full evaluation
        const ruleTriggered = justDeployed && hasPosition;
        
        if (ruleTriggered) {
          console.log('[ANCHOR RULES] ✅ Anchor deployed condition MET:', {
            current: { 
              deployed: anchorState.anchorDeployed, 
              timestamp: anchorState.timestamp,
              position: anchorState.anchorLocation?.position
            },
            previous: { 
              deployed: prevAnchorState.anchorDeployed, 
              timestamp: prevAnchorState.timestamp 
            },
            hasPosition,
            justDeployed
          });
        } else {
          console.log('[ANCHOR RULES] ❌ Anchor deployed condition NOT met:', {
            reason: !anchorState.anchorDeployed ? 'anchor not deployed' : 
                   !hasPosition ? 'missing position data' :
                   !justDeployed ? 'anchor was already deployed' : 'unknown reason',
            currentDeployed: anchorState.anchorDeployed,
            previousDeployed: prevAnchorState.anchorDeployed,
            hasPosition,
            justDeployed,
            timestampsMatch: anchorState.timestamp === prevAnchorState.timestamp,
            currentPosition: anchorState.anchorLocation?.position,
            previousPosition: prevAnchorState.anchorLocation?.position
          });
        }

        // Trigger if anchor was just deployed and we have position data
        return ruleTriggered;
      } catch (error) {
        console.error('[ANCHOR RULES] Error in anchor deployed condition:', error);
        return false;
      }
    },
    action: {
      type: 'CREATE_ALERT',
      alertData: (state) => {
        const anchorState = state.anchor || {};
        const isMetric = state.units?.distance === 'meters';
        const unitLabel = isMetric ? 'm' : 'ft';
        const position = anchorState.anchorLocation?.position;
        const positionStr = position ? 
          `(${position.latitude.toFixed(6)}, ${position.longitude.toFixed(6)})` : 'unknown position';
        
        return {
          type: 'system',
          category: 'navigation',
          source: 'anchor_monitor',
          level: 'info',
          label: 'Anchor Deployed',
          message: `Anchor deployed at ${positionStr} with ${anchorState.rode?.amount || 'unknown'} ${unitLabel} of rode`,
          trigger: 'anchor_deployed',
          data: {
            position: anchorState.anchorLocation?.position,
            rodeLength: anchorState.rode?.amount,
            timestamp: anchorState.timestamp || new Date().toISOString()
          },
          phoneNotification: true,
          sticky: false,
          autoResolvable: true
        };
      }
    }
  },
  
  // Anchor Retrieved Rule
  {
    type: 'anchor',
    name: 'Anchor Retrieved Notification',
    condition: (state, prevState) => {
      // Check if anchor was just retrieved
      const anchorState = state.anchor || {};
      const prevAnchorState = prevState?.anchor || {};
      
      return !anchorState.anchorDeployed && 
             prevAnchorState.anchorDeployed;
    },
    action: {
      type: 'CREATE_ALERT',
      alertData: (state) => {
        const anchorState = state.anchor || {};
        const prevAnchorState = state.prevState?.anchor || {};
        const position = prevAnchorState.anchorLocation?.position;
        const positionStr = position ? 
          `(${position.latitude.toFixed(6)}, ${position.longitude.toFixed(6)})` : 'unknown position';
        
        return {
          type: 'system',
          category: 'navigation',
          source: 'anchor_monitor',
          level: 'info',
          label: 'Anchor Retrieved',
          message: `Anchor retrieved from ${positionStr}`,
          trigger: 'anchor_retrieved',
          data: {
            position: position,
            timestamp: anchorState.timestamp || new Date().toISOString()
          },
          phoneNotification: true,
          sticky: false,
          autoResolvable: true
        };
      }
    }
  },
  
  // Critical Range Detection Rule
  {
    type: 'anchor',
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
    type: 'anchor',
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
    type: 'anchor',
    name: 'Anchor Dragging Detection',
    condition: (state) => {
      // Check if anchor is deployed
      const anchorState = state.anchor || {};
      if (!anchorState.anchorDeployed || !anchorState.anchorLocation?.position) {
        return false;
      }
      
      // Get current position and anchor position
      const boatPosition = state.position || {};
      const anchorPosition = anchorState.anchorLocation.position;
      const rodeLength = anchorState.rode?.amount || 0;
      const maxExpectedRadius = rodeLength * 1.5; // 50% more than rode length
      
      // If missing data, rule doesn't apply
      if (!boatPosition.latitude || !boatPosition.longitude || rodeLength <= 0) {
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
      
      // Rule triggers when distance exceeds max expected radius and no active alert exists
      return distance > maxExpectedRadius && !hasActiveAlert;
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
        
        // Calculate bearing from anchor to current position
        const toRad = (value) => (value * Math.PI) / 180;
        const lat1 = toRad(anchorPosition.latitude);
        const lon1 = toRad(anchorPosition.longitude);
        const lat2 = toRad(boatPosition.latitude);
        const lon2 = toRad(boatPosition.longitude);
        
        const y = Math.sin(lon2 - lon1) * Math.cos(lat2);
        const x = Math.cos(lat1) * Math.sin(lat2) - 
                 Math.sin(lat1) * Math.cos(lat2) * Math.cos(lon2 - lon1);
        const bearing = ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
        
        return {
          type: 'system',
          category: 'safety',
          source: 'anchor_monitor',
          level: 'critical',
          label: 'Anchor Dragging!',
          message: `Anchor has moved ${Math.round(distance)}${unitLabel} from set position (${rodeLength}${unitLabel} rode)`,
          trigger: 'anchor_dragging',
          data: {
            distance: Math.round(distance),
            rodeLength: rodeLength,
            bearingFromSet: Math.round(bearing),
            position: { 
              lat: boatPosition.latitude, 
              lng: boatPosition.longitude 
            },
            anchorPosition: {
              lat: anchorPosition.latitude,
              lng: anchorPosition.longitude
            },
            timestamp: new Date().toISOString(),
            units: unitLabel
          },
          phoneNotification: true,
          sticky: true,
          autoResolvable: true,
          repeatInterval: 60000 // Repeat every minute if still dragging
        };
      }
    }
  },
  
  // Anchor Dragging Resolution Rule
  {
    type: 'anchor',
    name: 'Anchor Dragging Resolved',
    condition: (state, prevState) => {
      // Check if we have an active anchor dragging alert
      const hasActiveAlert = state.alerts?.active?.some(
        alert => alert.trigger === 'anchor_dragging' && !alert.acknowledged
      );
      
      // If no active alert, nothing to resolve
      if (!hasActiveAlert) {
        return false;
      }
      
      // Get current state
      const anchorState = state.anchor || {};
      const boatPosition = state.position || {};
      const anchorPosition = anchorState.anchorLocation?.position;
      const rodeLength = anchorState.rode?.amount || 0;
      const maxExpectedRadius = rodeLength * 1.2; // 20% more than rode length
      
      // If missing data, can't determine if resolved
      if (!anchorState.anchorDeployed || !anchorPosition || !boatPosition.latitude || rodeLength <= 0) {
        return false;
      }
      
      // Calculate current distance
      const distance = calculateDistance(
        boatPosition.latitude,
        boatPosition.longitude,
        anchorPosition.latitude,
        anchorPosition.longitude
      );
      
      // Consider resolved if back within expected radius
      return distance <= maxExpectedRadius;
    },
    action: {
      type: 'RESOLVE_ALERTS',
      trigger: 'anchor_dragging',
      resolutionData: (state) => ({
        message: 'Anchor is no longer dragging',
        timestamp: new Date().toISOString()
      })
    }
  },
  
  // Original Anchor Dragging Detection Rule
  {
    type: 'anchor',
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
    type: 'anchor',
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
    type: 'anchor',
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
