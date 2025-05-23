/**
 * Utility functions for working with state data paths
 */

/**
 * A mapping of data paths to human-readable labels and units
 */
export const DATA_PATH_MAPPINGS = {
  // Navigation
  'navigation.depth.belowKeel': { label: 'Depth Below Keel', unit: 'm' },
  'navigation.position.speed': { label: 'Speed Over Ground', unit: 'kts' },
  'navigation.speedThroughWater': { label: 'Speed Through Water', unit: 'kts' },
  'navigation.course.value': { label: 'Course', unit: '°' },
  'navigation.heading.value': { label: 'Heading', unit: '°' },
  
  // Environment
  'environment.wind.speedApparent': { label: 'Apparent Wind Speed', unit: 'kts' },
  'environment.wind.speedTrue': { label: 'True Wind Speed', unit: 'kts' },
  'environment.wind.angleApparent': { label: 'Apparent Wind Angle', unit: '°' },
  'environment.wind.angleTrue': { label: 'True Wind Angle', unit: '°' },
  'environment.outside.temperature': { label: 'Outside Temperature', unit: '°C' },
  'environment.water.temperature': { label: 'Water Temperature', unit: '°C' },
  'environment.inside.temperature': { label: 'Inside Temperature', unit: '°C' },
  'environment.pressure': { label: 'Barometric Pressure', unit: 'hPa' },
  
  // Electrical
  'electrical.batteries.voltage': { label: 'Battery Voltage', unit: 'V' },
  'electrical.batteries.capacity': { label: 'Battery Capacity', unit: '%' },
  'electrical.alternator.voltage': { label: 'Alternator Voltage', unit: 'V' },
  'electrical.alternator.current': { label: 'Alternator Current', unit: 'A' },
  
  // Tanks
  'tanks.fuel.level': { label: 'Fuel Tank Level', unit: '%' },
  'tanks.freshWater.level': { label: 'Fresh Water Tank Level', unit: '%' },
  'tanks.wasteWater.level': { label: 'Waste Water Tank Level', unit: '%' },
  
  // Propulsion
  'propulsion.engine.temperature': { label: 'Engine Temperature', unit: '°C' },
  'propulsion.engine.oilPressure': { label: 'Engine Oil Pressure', unit: 'bar' },
  'propulsion.engine.rpm': { label: 'Engine RPM', unit: 'rpm' },
  'propulsion.engine.coolantTemperature': { label: 'Engine Coolant Temperature', unit: '°C' },
  'propulsion.engine.exhaustTemperature': { label: 'Engine Exhaust Temperature', unit: '°C' },
  'propulsion.engine.hours': { label: 'Engine Hours', unit: 'h' },
  
  // System
  'system.cpu.temperature': { label: 'CPU Temperature', unit: '°C' },
  'system.memory.usage': { label: 'Memory Usage', unit: '%' },
  'system.storage.usage': { label: 'Storage Usage', unit: '%' }
};

/**
 * Get a human-readable label for a data path
 * @param {string} path - The data path
 * @returns {string} The human-readable label or the original path if not found
 */
export function getPathLabel(path) {
  return DATA_PATH_MAPPINGS[path]?.label || path;
}

/**
 * Get the unit for a data path
 * @param {string} path - The data path
 * @returns {string} The unit or an empty string if not found
 */
export function getPathUnit(path) {
  return DATA_PATH_MAPPINGS[path]?.unit || '';
}

/**
 * Get all available data paths as an array of objects with value and label properties
 * @returns {Array<{value: string, label: string}>} Array of data path objects
 */
export function getAllDataPaths() {
  return Object.entries(DATA_PATH_MAPPINGS).map(([path, info]) => ({
    value: path,
    label: info.label
  }));
}

/**
 * Extract all data paths from a state object
 * @param {Object} state - The state object to extract paths from
 * @param {string} [prefix=''] - The prefix for the current level of paths
 * @param {Set} [result=new Set()] - The set to store the paths
 * @returns {Set<string>} A set of all data paths
 */
export function extractDataPaths(state, prefix = '', result = new Set()) {
  if (!state || typeof state !== 'object') {
    return result;
  }
  
  Object.entries(state).forEach(([key, value]) => {
    const newPath = prefix ? `${prefix}.${key}` : key;
    
    // If the value has a 'value' property, it's likely a data point
    if (value && typeof value === 'object' && 'value' in value) {
      result.add(newPath);
    }
    
    // Recursively process nested objects
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      extractDataPaths(value, newPath, result);
    }
  });
  
  return result;
}

/**
 * Get all data paths from the state with their labels and units
 * @param {Object} state - The state object to extract paths from
 * @returns {Array<{value: string, label: string, unit: string}>} Array of data path objects
 */
export function getDataPathsFromState(state) {
  const paths = extractDataPaths(state);
  
  return Array.from(paths).map(path => ({
    value: path,
    label: getPathLabel(path),
    unit: getPathUnit(path)
  }));
}
