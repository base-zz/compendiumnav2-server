/**
 * AlertRule Model
 * 
 * This serves as documentation, a template for new alert rules, and a default placeholder.
 */

export const ALERT_RULE_OPERATORS = {
  EQUALS: 'equals',
  NOT_EQUALS: 'notEquals',
  LESS_THAN: 'lessThan',
  LESS_THAN_EQUALS: 'lessThanEquals',
  GREATER_THAN: 'greaterThan',
  GREATER_THAN_EQUALS: 'greaterThanEquals',
  BETWEEN: 'between',
  NOT_BETWEEN: 'notBetween',
  CONTAINS: 'contains',
  NOT_CONTAINS: 'notContains'
};

export const ALERT_RULE_TYPES = {
  INFO: 'info',
  WARNING: 'warning',
  ERROR: 'error',
  CRITICAL: 'critical'
};

export const ALERT_RULE_CATEGORIES = {
  NAVIGATION: 'navigation',
  WEATHER: 'weather',
  SYSTEM: 'system',
  ENGINE: 'engine',
  ELECTRICAL: 'electrical',
  TANK: 'tank',
  SAFETY: 'safety',
  CUSTOM: 'custom'
};

export const ALERT_RULE_LEVELS = {
  INFO: 'info',
  WARNING: 'warning',
  ERROR: 'error',
  CRITICAL: 'critical',
  EMERGENCY: 'emergency'
};

export const DATA_SOURCES = {
  // Navigation
  'navigation.depth.belowKeel': { 
    label: 'Depth Below Keel', 
    units: 'm',
    defaultThreshold: 2.0,
    isHigherBad: false
  },
  'navigation.depth.belowTransducer': { 
    label: 'Depth Below Transducer', 
    units: 'm',
    defaultThreshold: 3.0,
    isHigherBad: false
  },
  'navigation.position.speed': { 
    label: 'Speed Over Ground', 
    units: 'kts',
    defaultThreshold: 15.0,
    isHigherBad: true
  },
  'navigation.speedThroughWater': { 
    label: 'Speed Through Water', 
    units: 'kts',
    defaultThreshold: 15.0,
    isHigherBad: true
  },
  
  // Environment
  'environment.wind.speedApparent': { 
    label: 'Apparent Wind Speed', 
    units: 'kts',
    defaultThreshold: 20.0,
    isHigherBad: true
  },
  'environment.wind.speedTrue': { 
    label: 'True Wind Speed', 
    units: 'kts',
    defaultThreshold: 25.0,
    isHigherBad: true
  },
  'environment.outside.temperature': { 
    label: 'Outside Temperature', 
    units: '°C',
    defaultThreshold: 30.0,
    isHigherBad: true
  },
  
  // Electrical
  'electrical.batteries.voltage': { 
    label: 'Battery Voltage', 
    units: 'V',
    defaultThreshold: 12.0,
    isHigherBad: false
  },
  'electrical.batteries.capacity': { 
    label: 'Battery Capacity', 
    units: '%',
    defaultThreshold: 30.0,
    isHigherBad: false
  },
  
  // Tanks
  'tanks.fuel.level': { 
    label: 'Fuel Tank Level', 
    units: '%',
    defaultThreshold: 20.0,
    isHigherBad: false
  },
  'tanks.freshWater.level': { 
    label: 'Fresh Water Tank Level', 
    units: '%',
    defaultThreshold: 20.0,
    isHigherBad: false
  },
  'tanks.wasteWater.level': { 
    label: 'Waste Water Tank Level', 
    units: '%',
    defaultThreshold: 80.0,
    isHigherBad: true
  },
  
  // Engine
  'propulsion.engine.temperature': { 
    label: 'Engine Temperature', 
    units: '°C',
    defaultThreshold: 90.0,
    isHigherBad: true
  },
  'propulsion.engine.oilPressure': { 
    label: 'Oil Pressure', 
    units: 'bar',
    defaultThreshold: 2.0,
    isHigherBad: false
  }
};

export const BASE_ALERT_RULE = {
  id: '', // Unique string identifier
  name: '', // User-friendly name
  description: '', // Detailed description
  enabled: true, // Whether the rule is active
  
  // Condition
  source: '', // Data source path
  operator: ALERT_RULE_OPERATORS.LESS_THAN, // Comparison operator
  threshold: null, // Primary threshold value
  secondaryThreshold: null, // For operators like BETWEEN
  
  // Alert details
  alertType: ALERT_RULE_TYPES.WARNING, // Type of alert
  alertCategory: ALERT_RULE_CATEGORIES.NAVIGATION, // Category
  alertLevel: ALERT_RULE_LEVELS.WARNING, // Severity level
  message: '', // Message template with {value} placeholder
  
  // Prevention strategies
  strategies: [], // Array of strategy names
  strategyOptions: {
    cooldownMs: 300000, // 5 minutes
    debounceMs: 10000, // 10 seconds
    hysteresisMargin: null, // Auto-calculated based on threshold
    isHigherBad: false // Whether higher values are bad
  },
  
  // Notification options
  notifyOnMobile: true, // Send to mobile devices
  sound: 'alert.mp3', // Alert sound
  
  // Metadata
  createdAt: '', // ISO8601 timestamp
  updatedAt: '', // ISO8601 timestamp
  createdBy: 'user' // Who created this rule
};

// Helper function to create a new rule with defaults
export function createDefaultRule(source) {
  const sourceInfo = DATA_SOURCES[source] || {
    label: 'Unknown Source',
    units: '',
    defaultThreshold: 0,
    isHigherBad: false
  };
  
  const now = new Date().toISOString();
  
  return {
    ...BASE_ALERT_RULE,
    id: crypto.randomUUID(),
    name: `${sourceInfo.label} Alert`,
    description: `Alert when ${sourceInfo.label} is out of safe range`,
    source,
    threshold: sourceInfo.defaultThreshold,
    message: `${sourceInfo.label} is {value} ${sourceInfo.units}`,
    strategies: ['state'], // Default to state tracking
    strategyOptions: {
      ...BASE_ALERT_RULE.strategyOptions,
      isHigherBad: sourceInfo.isHigherBad,
      hysteresisMargin: sourceInfo.defaultThreshold * 0.1 // 10% of threshold
    },
    createdAt: now,
    updatedAt: now
  };
}
