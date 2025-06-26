/**
 * Anchor-related rules for the optimized rule engine
 * These rules handle anchor deployment, retrieval, and monitoring
 */

export const anchorRules = [
  // Anchor Deployed Notification
  {
    name: 'Anchor Deployed Notification',
    description: 'Triggered when anchor is deployed',
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
  
  // Anchor Retrieved Notification
  {
    name: 'Anchor Retrieved Notification',
    description: 'Triggered when anchor is retrieved',
    priority: 'high',
    dependsOn: ['navigation.anchor.anchorDeployed', 'navigation.anchor.timestamp'],
    condition: (state, context) => {
      const prevDeployed = context.previousState?.navigation?.anchor?.anchorDeployed;
      const currDeployed = state.navigation?.anchor?.anchorDeployed;
      return prevDeployed === true && currDeployed === false;
    },
    action: (state) => ({
      type: 'NOTIFICATION',
      category: 'anchor',
      severity: 'info',
      message: 'Anchor retrieved',
      timestamp: new Date().toISOString()
    })
  },
  
  // Anchor Dragging Detection
  {
    name: 'Anchor Dragging Detection',
    description: 'Detects when the anchor is dragging',
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
      
      // Simple distance calculation (in meters)
      const distance = calculateDistance(
        position.latitude, position.longitude,
        anchorPos.latitude, anchorPos.longitude
      );
      
      // If we've moved more than 50m from the anchor position
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
  }
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
