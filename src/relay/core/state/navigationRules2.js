/**
 * Navigation-related rules for the optimized rule engine
 * These rules handle position, speed, and navigation-related conditions
 */

import { calculateBearing, calculateDistance } from './geoUtils.js';

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
      if (!Number.isFinite(distance)) return false;
      
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
