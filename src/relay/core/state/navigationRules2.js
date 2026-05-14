/**
 * Navigation-related rules for the optimized rule engine
 * These rules handle position, speed, and navigation-related conditions
 */

import { calculateBearing, calculateDistance } from './geoUtils.js';

function convertSpeedToKnots(value, units) {
  if (!Number.isFinite(value)) return null;
  if (units === 'ms' || units === 'm/s' || units === 'mps') return value * 1.94384; // m/s to knots
  if (units === 'km/h' || units === 'kmh') return value / 1.852; // km/h to knots
  return value; // assume knots
}

function getNormalizedSpeedOverGround(state) {
  const speedValue = state.navigation?.speedOverGround?.value ?? state.navigation?.speedOverGround;
  const speedUnits = state.navigation?.speedOverGround?.units ?? 'knots';
  return convertSpeedToKnots(speedValue, speedUnits);
}

function getNormalizedWindSpeedApparent(state) {
  const windSpeedValue = state.environment?.wind?.speedApparent?.value ?? state.environment?.wind?.speedApparent;
  const windSpeedUnits = state.environment?.wind?.speedApparent?.units ?? 'knots';
  return convertSpeedToKnots(windSpeedValue, windSpeedUnits);
}

export const navigationRules = [
  // High Speed Navigation
  {
    name: 'High Speed Navigation',
    description: 'Triggered when vessel is moving at high speed',
    priority: 'normal',
    dependsOn: ['navigation.speedOverGround'],
    condition: (state) => {
      const sogKnots = getNormalizedSpeedOverGround(state);
      return sogKnots && sogKnots > 10;
    },
    action: (state) => ({
      type: 'NAVIGATION_STATE',
      state: 'underway',
      subState: 'motoring',
      speed: getNormalizedSpeedOverGround(state),
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
      const sogKnots = getNormalizedSpeedOverGround(state);
      const windSpeedKnots = getNormalizedWindSpeedApparent(state);

      // Considered drifting if speed is low but there's significant wind/current
      return sogKnots > 0.5 && sogKnots < 2 && windSpeedKnots > 10;
    },
    action: (state) => ({
      type: 'NAVIGATION_STATE',
      state: 'drifting',
      speed: getNormalizedSpeedOverGround(state),
      windSpeed: getNormalizedWindSpeedApparent(state),
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
