/**
 * Navigation-related rules for the optimized rule engine
 * These rules handle position, speed, and navigation-related conditions
 */

export const navigationRules = [
  // High Speed Navigation
  {
    name: 'High Speed Navigation',
    description: 'Triggered when vessel is moving at high speed',
    priority: 'normal',
    dependsOn: ['navigation.speedOverGround'],
    condition: (state) => {
      const sog = state.navigation?.speedOverGround;
      return sog && sog > 10; // Knots
    },
    action: (state) => ({
      type: 'NAVIGATION_STATE',
      state: 'underway',
      subState: 'motoring',
      speed: state.navigation.speedOverGround,
      timestamp: new Date().toISOString()
    })
  },
  
  // Drifting Detection
  {
    name: 'Drifting Detection',
    description: 'Detects when vessel is drifting',
    priority: 'normal',
    dependsOn: [
      'navigation.speedOverGround',
      'navigation.courseOverGroundTrue',
      'environment.wind.speedApparent',
      'environment.current'
    ],
    condition: (state) => {
      const sog = state.navigation?.speedOverGround;
      const windSpeed = state.environment?.wind?.speedApparent;
      
      // Considered drifting if speed is low but there's significant wind/current
      return sog > 0.5 && sog < 2 && windSpeed > 10;
    },
    action: (state) => ({
      type: 'NAVIGATION_STATE',
      state: 'drifting',
      speed: state.navigation.speedOverGround,
      windSpeed: state.environment.wind.speedApparent,
      timestamp: new Date().toISOString()
    })
  },
  
  // Proximity Alert
  {
    name: 'Proximity Alert',
    description: 'Warns when approaching a waypoint or hazard',
    priority: 'high',
    dependsOn: [
      'navigation.position',
      'navigation.courseOverGroundTrue',
      'navigation.waypoints.next'
    ],
    condition: (state) => {
      const position = state.navigation?.position;
      const waypoint = state.navigation?.waypoints?.next;
      
      if (!position || !waypoint) return false;
      
      const distance = calculateDistance(
        position.latitude, position.longitude,
        waypoint.latitude, waypoint.longitude
      );
      
      // Alert when within 0.5nm of waypoint
      return distance < 926; // 0.5nm in meters
    },
    action: (state, context) => ({
      type: 'PROXIMITY_ALERT',
      target: 'waypoint',
      distance: calculateDistance(
        state.navigation.position.latitude,
        state.navigation.position.longitude,
        state.navigation.waypoints.next.latitude,
        state.navigation.waypoints.next.longitude
      ),
      bearing: calculateBearing(
        state.navigation.position.latitude,
        state.navigation.position.longitude,
        state.navigation.waypoints.next.latitude,
        state.navigation.waypoints.next.longitude
      ),
      timestamp: new Date().toISOString()
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

// Helper function to calculate bearing between two points
function calculateBearing(lat1, lon1, lat2, lon2) {
  const φ1 = lat1 * Math.PI/180;
  const φ2 = lat2 * Math.PI/180;
  const λ1 = lon1 * Math.PI/180;
  const λ2 = lon2 * Math.PI/180;

  const y = Math.sin(λ2-λ1) * Math.cos(φ2);
  const x = Math.cos(φ1)*Math.sin(φ2) -
            Math.sin(φ1)*Math.cos(φ2)*Math.cos(λ2-λ1);
  const θ = Math.atan2(y, x);
  
  return ((θ * 180/Math.PI) + 360) % 360; // Convert to degrees and normalize
}
