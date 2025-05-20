/**
 * Weather Rules for the state manager
 * These rules define when weather-related alerts should be triggered and resolved
 */

// Enable detailed logging for wind conditions
const ENABLE_WIND_LOGGING = true;

/**
 * Log wind conditions if logging is enabled
 * @param {string} message - Log message
 * @param {Object} data - Additional data to log
 */
function logWindCondition(message, data = {}) {
  if (ENABLE_WIND_LOGGING) {
    // console.log(`[WEATHER] ${message}`, data);
  }
}

/**
 * High Wind Speed Detection Rules
 * Triggers alerts when wind speed exceeds the threshold (25 knots)
 * Separate rules for true and apparent wind
 */

// Wind speed threshold in knots
const HIGH_WIND_THRESHOLD = 25;

export const WeatherRules = [
  // High Apparent Wind Speed Detection Rule
  {
    name: 'High Apparent Wind Speed Detection',
    condition(state) {
      // Check if wind data exists
      if (!state.navigation || 
          !state.navigation.wind || 
          !state.navigation.wind.apparent || 
          !state.navigation.wind.apparent.speed || 
          state.navigation.wind.apparent.speed.value === null) {
        logWindCondition('Apparent wind data missing or incomplete');
        return false;
      }
      
      // Get apparent wind speed in the units from state
      const apparentWindSpeed = state.navigation.wind.apparent.speed.value;
      const units = state.navigation.wind.apparent.speed.units;
      
      // Convert to knots if necessary
      let speedInKnots = apparentWindSpeed;
      if (units === 'mph') {
        speedInKnots = apparentWindSpeed * 0.868976;
      } else if (units === 'm/s') {
        speedInKnots = apparentWindSpeed * 1.94384;
      } else if (units === 'km/h') {
        speedInKnots = apparentWindSpeed * 0.539957;
      }
      
      // Log current wind conditions
      logWindCondition('Apparent wind speed check', {
        rawSpeed: apparentWindSpeed,
        units: units,
        speedInKnots: speedInKnots,
        threshold: HIGH_WIND_THRESHOLD,
        exceeds: speedInKnots >= HIGH_WIND_THRESHOLD
      });
      
      // Check if speed exceeds threshold
      return speedInKnots >= HIGH_WIND_THRESHOLD;
    },
    action: {
      type: 'CREATE_ALERT',
      data(state) {
        const apparentWindSpeed = state.navigation.wind.apparent.speed.value;
        const units = state.navigation.wind.apparent.speed.units;
        
        // Convert to knots for logging
        let speedInKnots = apparentWindSpeed;
        if (units === 'mph') {
          speedInKnots = apparentWindSpeed * 0.868976;
        } else if (units === 'm/s') {
          speedInKnots = apparentWindSpeed * 1.94384;
        } else if (units === 'km/h') {
          speedInKnots = apparentWindSpeed * 0.539957;
        }
        
        logWindCondition('⚠️ CREATING HIGH APPARENT WIND ALERT', {
          speed: apparentWindSpeed,
          units: units,
          speedInKnots: speedInKnots,
          threshold: HIGH_WIND_THRESHOLD
        });
        
        return {
          type: 'weather',
          category: 'wind',
          source: 'weather_monitor',
          level: 'warning',
          label: 'High Apparent Wind',
          message: `Apparent wind speed of ${apparentWindSpeed} ${units} exceeds the threshold of ${HIGH_WIND_THRESHOLD} knots`,
          trigger: 'high_apparent_wind',
          data: {
            currentSpeed: apparentWindSpeed,
            units: units,
            threshold: HIGH_WIND_THRESHOLD,
            thresholdUnits: 'knots'
          },
          phoneNotification: true,
          sticky: false,
          autoResolvable: true
        };
      }
    }
  },
  
  // High Apparent Wind Speed Resolution Rule
  {
    name: 'High Apparent Wind Speed Resolution',
    condition(state) {
      // Check if wind data exists
      if (!state.navigation || 
          !state.navigation.wind || 
          !state.navigation.wind.apparent || 
          !state.navigation.wind.apparent.speed || 
          state.navigation.wind.apparent.speed.value === null) {
        logWindCondition('Apparent wind data missing or incomplete for resolution check');
        return false;
      }
      
      // Get apparent wind speed in the units from state
      const apparentWindSpeed = state.navigation.wind.apparent.speed.value;
      const units = state.navigation.wind.apparent.speed.units;
      
      // Convert to knots if necessary
      let speedInKnots = apparentWindSpeed;
      if (units === 'mph') {
        speedInKnots = apparentWindSpeed * 0.868976;
      } else if (units === 'm/s') {
        speedInKnots = apparentWindSpeed * 1.94384;
      } else if (units === 'km/h') {
        speedInKnots = apparentWindSpeed * 0.539957;
      }
      
      // Log current wind conditions for resolution
      logWindCondition('Apparent wind speed resolution check', {
        rawSpeed: apparentWindSpeed,
        units: units,
        speedInKnots: speedInKnots,
        threshold: HIGH_WIND_THRESHOLD,
        belowThreshold: speedInKnots < HIGH_WIND_THRESHOLD
      });
      
      // Check if speed is below threshold
      return speedInKnots < HIGH_WIND_THRESHOLD;
    },
    action: {
      type: 'RESOLVE_ALERT',
      trigger: 'high_apparent_wind',
      data(state) {
        const apparentWindSpeed = state.navigation.wind.apparent.speed.value;
        const units = state.navigation.wind.apparent.speed.units;
        
        // Convert to knots for logging
        let speedInKnots = apparentWindSpeed;
        if (units === 'mph') {
          speedInKnots = apparentWindSpeed * 0.868976;
        } else if (units === 'm/s') {
          speedInKnots = apparentWindSpeed * 1.94384;
        } else if (units === 'km/h') {
          speedInKnots = apparentWindSpeed * 0.539957;
        }
        
        logWindCondition('✓ RESOLVING HIGH APPARENT WIND ALERT', {
          speed: apparentWindSpeed,
          units: units,
          speedInKnots: speedInKnots,
          threshold: HIGH_WIND_THRESHOLD
        });
        
        return {
          resolutionMessage: `Apparent wind speed has decreased below the threshold of ${HIGH_WIND_THRESHOLD} knots`,
          currentSpeed: apparentWindSpeed,
          units: units
        };
      }
    }
  },
  
  // High True Wind Speed Detection Rule
  {
    name: 'High True Wind Speed Detection',
    condition(state) {
      // Check if wind data exists
      if (!state.navigation || 
          !state.navigation.wind || 
          !state.navigation.wind.true || 
          !state.navigation.wind.true.speed || 
          state.navigation.wind.true.speed.value === null) {
        logWindCondition('True wind data missing or incomplete');
        return false;
      }
      
      // Get true wind speed in the units from state
      const trueWindSpeed = state.navigation.wind.true.speed.value;
      const units = state.navigation.wind.true.speed.units;
      
      // Convert to knots if necessary
      let speedInKnots = trueWindSpeed;
      if (units === 'mph') {
        speedInKnots = trueWindSpeed * 0.868976;
      } else if (units === 'm/s') {
        speedInKnots = trueWindSpeed * 1.94384;
      } else if (units === 'km/h') {
        speedInKnots = trueWindSpeed * 0.539957;
      }
      
      // Log current wind conditions
      logWindCondition('True wind speed check', {
        rawSpeed: trueWindSpeed,
        units: units,
        speedInKnots: speedInKnots,
        threshold: HIGH_WIND_THRESHOLD,
        exceeds: speedInKnots >= HIGH_WIND_THRESHOLD
      });
      
      // Check if speed exceeds threshold
      return speedInKnots >= HIGH_WIND_THRESHOLD;
    },
    action: {
      type: 'CREATE_ALERT',
      data(state) {
        const trueWindSpeed = state.navigation.wind.true.speed.value;
        const units = state.navigation.wind.true.speed.units;
        
        // Convert to knots for logging
        let speedInKnots = trueWindSpeed;
        if (units === 'mph') {
          speedInKnots = trueWindSpeed * 0.868976;
        } else if (units === 'm/s') {
          speedInKnots = trueWindSpeed * 1.94384;
        } else if (units === 'km/h') {
          speedInKnots = trueWindSpeed * 0.539957;
        }
        
        logWindCondition('⚠️ CREATING HIGH TRUE WIND ALERT', {
          speed: trueWindSpeed,
          units: units,
          speedInKnots: speedInKnots,
          threshold: HIGH_WIND_THRESHOLD
        });
        
        return {
          type: 'weather',
          category: 'wind',
          source: 'weather_monitor',
          level: 'warning',
          label: 'High True Wind',
          message: `True wind speed of ${trueWindSpeed} ${units} exceeds the threshold of ${HIGH_WIND_THRESHOLD} knots`,
          trigger: 'high_true_wind',
          data: {
            currentSpeed: trueWindSpeed,
            units: units,
            threshold: HIGH_WIND_THRESHOLD,
            thresholdUnits: 'knots'
          },
          phoneNotification: true,
          sticky: false,
          autoResolvable: true
        };
      }
    }
  },
  
  // High True Wind Speed Resolution Rule
  {
    name: 'High True Wind Speed Resolution',
    condition(state) {
      // Check if wind data exists
      if (!state.navigation || 
          !state.navigation.wind || 
          !state.navigation.wind.true || 
          !state.navigation.wind.true.speed || 
          state.navigation.wind.true.speed.value === null) {
        logWindCondition('True wind data missing or incomplete for resolution check');
        return false;
      }
      
      // Get true wind speed in the units from state
      const trueWindSpeed = state.navigation.wind.true.speed.value;
      const units = state.navigation.wind.true.speed.units;
      
      // Convert to knots if necessary
      let speedInKnots = trueWindSpeed;
      if (units === 'mph') {
        speedInKnots = trueWindSpeed * 0.868976;
      } else if (units === 'm/s') {
        speedInKnots = trueWindSpeed * 1.94384;
      } else if (units === 'km/h') {
        speedInKnots = trueWindSpeed * 0.539957;
      }
      
      // Log current wind conditions for resolution
      logWindCondition('True wind speed resolution check', {
        rawSpeed: trueWindSpeed,
        units: units,
        speedInKnots: speedInKnots,
        threshold: HIGH_WIND_THRESHOLD,
        belowThreshold: speedInKnots < HIGH_WIND_THRESHOLD
      });
      
      // Check if speed is below threshold
      return speedInKnots < HIGH_WIND_THRESHOLD;
    },
    action: {
      type: 'RESOLVE_ALERT',
      trigger: 'high_true_wind',
      data(state) {
        const trueWindSpeed = state.navigation.wind.true.speed.value;
        const units = state.navigation.wind.true.speed.units;
        
        // Convert to knots for logging
        let speedInKnots = trueWindSpeed;
        if (units === 'mph') {
          speedInKnots = trueWindSpeed * 0.868976;
        } else if (units === 'm/s') {
          speedInKnots = trueWindSpeed * 1.94384;
        } else if (units === 'km/h') {
          speedInKnots = trueWindSpeed * 0.539957;
        }
        
        logWindCondition('✓ RESOLVING HIGH TRUE WIND ALERT', {
          speed: trueWindSpeed,
          units: units,
          speedInKnots: speedInKnots,
          threshold: HIGH_WIND_THRESHOLD
        });
        
        return {
          resolutionMessage: `True wind speed has decreased below the threshold of ${HIGH_WIND_THRESHOLD} knots`,
          currentSpeed: trueWindSpeed,
          units: units
        };
      }
    }
  }
];
