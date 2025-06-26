/**
 * Weather-related rules for the optimized rule engine
 * These rules handle weather conditions and alerts
 */

export const weatherRules = [
  // High Wind Speed Alert
  {
    name: 'High Wind Speed Alert',
    description: 'Triggers when apparent wind speed exceeds threshold',
    priority: 'high',
    dependsOn: ['environment.wind.speedApparent'],
    condition: (state) => {
      const windSpeed = state.environment?.wind?.speedApparent;
      return windSpeed && windSpeed > 25; // Knots
    },
    action: (state) => ({
      type: 'WEATHER_ALERT',
      severity: 'warning',
      code: 'HIGH_WIND',
      message: 'High wind conditions detected',
      windSpeed: state.environment.wind.speedApparent,
      windDirection: state.environment.wind.direction,
      timestamp: new Date().toISOString()
    })
  },
  
  // Storm Warning
  {
    name: 'Storm Warning',
    description: 'Triggers when wind speed indicates storm conditions',
    priority: 'high',
    dependsOn: ['environment.wind.speedTrue'],
    condition: (state) => {
      const windSpeed = state.environment?.wind?.speedTrue;
      return windSpeed && windSpeed > 34; // >34 knots = gale force 8+
    },
    action: (state) => ({
      type: 'WEATHER_ALERT',
      severity: 'danger',
      code: 'STORM_WARNING',
      message: 'Storm conditions detected',
      windSpeed: state.environment.wind.speedTrue,
      timestamp: new Date().toISOString()
    })
  },
  
  // Temperature Alert
  {
    name: 'Temperature Alert',
    description: 'Alerts for extreme outside temperatures',
    priority: 'normal',
    dependsOn: ['environment.outside.temperature'],
    condition: (state) => {
      const temp = state.environment?.outside?.temperature;
      if (temp === undefined || temp === null) return false;
      return temp < 5 || temp > 35; // Celsius
    },
    action: (state) => ({
      type: 'WEATHER_ALERT',
      severity: state.environment.outside.temperature > 35 ? 'warning' : 'info',
      code: 'EXTREME_TEMPERATURE',
      message: state.environment.outside.temperature > 35 
        ? 'High temperature warning' 
        : 'Low temperature warning',
      temperature: state.environment.outside.temperature,
      timestamp: new Date().toISOString()
    })
  },
  
  // Barometric Pressure Drop
  {
    name: 'Pressure Drop Alert',
    description: 'Warns of rapid barometric pressure drops',
    priority: 'high',
    dependsOn: [
      'environment.outside.pressure',
      'environment.outside.pressureTrend'
    ],
    condition: (state, context) => {
      const currentPressure = state.environment?.outside?.pressure;
      const pressureTrend = state.environment?.outside?.pressureTrend;
      
      // Check for rapid pressure drop (>3mb in 3 hours)
      return pressureTrend && pressureTrend.rate < -1; // mb/hour
    },
    action: (state) => ({
      type: 'WEATHER_ALERT',
      severity: 'warning',
      code: 'PRESSURE_DROP',
      message: 'Rapid pressure drop detected',
      pressure: state.environment.outside.pressure,
      trend: state.environment.outside.pressureTrend,
      timestamp: new Date().toISOString()
    })
  }
];
