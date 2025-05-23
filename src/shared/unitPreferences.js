/**
 * Unit Preferences Module
 * 
 * This module provides utilities for managing user unit preferences
 * and standardizing unit conversions across the application.
 */
import { Preferences } from '@capacitor/preferences';

// Unit types
export const UNIT_TYPES = {
  LENGTH: 'length',
  SPEED: 'speed',
  TEMPERATURE: 'temperature',
  PRESSURE: 'pressure',
  VOLUME: 'volume',
  ANGLE: 'angle'
};

// Available units per type
export const AVAILABLE_UNITS = {
  [UNIT_TYPES.LENGTH]: ['m', 'ft', 'nm'],
  [UNIT_TYPES.SPEED]: ['kts', 'm/s', 'km/h', 'mph'],
  [UNIT_TYPES.TEMPERATURE]: ['°C', '°F'],
  [UNIT_TYPES.PRESSURE]: ['hPa', 'inHg', 'mb'],
  [UNIT_TYPES.VOLUME]: ['L', 'gal'],
  [UNIT_TYPES.ANGLE]: ['deg'] // Only degrees, no radians option for user
};

// Default unit presets
export const UNIT_PRESETS = {
  METRIC: {
    [UNIT_TYPES.LENGTH]: 'm',
    [UNIT_TYPES.SPEED]: 'kts', // Using knots for both systems as requested
    [UNIT_TYPES.TEMPERATURE]: '°C',
    [UNIT_TYPES.PRESSURE]: 'hPa',
    [UNIT_TYPES.VOLUME]: 'L',
    [UNIT_TYPES.ANGLE]: 'deg'
  },
  IMPERIAL: {
    [UNIT_TYPES.LENGTH]: 'ft',
    [UNIT_TYPES.SPEED]: 'kts',
    [UNIT_TYPES.TEMPERATURE]: '°F',
    [UNIT_TYPES.PRESSURE]: 'inHg',
    [UNIT_TYPES.VOLUME]: 'gal',
    [UNIT_TYPES.ANGLE]: 'deg'
  },
  CUSTOM: 'custom' // For when user selects a mix
};

// Human-readable labels for units
export const UNIT_LABELS = {
  'm': 'Meters (m)',
  'ft': 'Feet (ft)',
  'nm': 'Nautical Miles (nm)',
  'kts': 'Knots (kts)',
  'm/s': 'Meters per Second (m/s)',
  'km/h': 'Kilometers per Hour (km/h)',
  'mph': 'Miles per Hour (mph)',
  '°C': 'Celsius (°C)',
  '°F': 'Fahrenheit (°F)',
  'hPa': 'Hectopascals (hPa)',
  'inHg': 'Inches of Mercury (inHg)',
  'mb': 'Millibars (mb)',
  'L': 'Liters (L)',
  'gal': 'Gallons (gal)',
  'deg': 'Degrees (°)',
  'rad': 'Radians (rad)' // Internal use only
};

// Get all user preferences
export async function getUserUnitPreferences() {
  try {
    const { value } = await Preferences.get({ key: 'unit_preferences' });
    if (!value) {
      // Default to imperial preset
      return { ...UNIT_PRESETS.IMPERIAL, preset: 'IMPERIAL' };
    }
    return JSON.parse(value);
  } catch (error) {
    console.error('Error getting unit preferences:', error);
    return { ...UNIT_PRESETS.IMPERIAL, preset: 'IMPERIAL' };
  }
}

// Set a specific unit preference
export async function setUnitPreference(unitType, unit) {
  if (!Object.values(UNIT_TYPES).includes(unitType)) {
    throw new Error(`Invalid unit type: ${unitType}`);
  }
  
  if (!AVAILABLE_UNITS[unitType].includes(unit)) {
    throw new Error(`Invalid unit for ${unitType}: ${unit}`);
  }
  
  try {
    // Get current preferences
    const currentPrefs = await getUserUnitPreferences();
    
    // Update the specific unit
    currentPrefs[unitType] = unit;
    
    // Determine if this matches a preset or is custom
    const isMetric = Object.entries(UNIT_PRESETS.METRIC)
      .every(([type, value]) => currentPrefs[type] === value);
    
    const isImperial = Object.entries(UNIT_PRESETS.IMPERIAL)
      .every(([type, value]) => currentPrefs[type] === value);
    
    currentPrefs.preset = isMetric ? 'METRIC' : 
                          isImperial ? 'IMPERIAL' : 'CUSTOM';
    
    // Save updated preferences
    await Preferences.set({
      key: 'unit_preferences',
      value: JSON.stringify(currentPrefs)
    });
    
    return currentPrefs;
  } catch (error) {
    console.error('Error setting unit preference:', error);
    throw error;
  }
}

// Set all unit preferences using a preset
export async function setUnitPreset(preset) {
  if (preset !== 'CUSTOM' && !UNIT_PRESETS[preset]) {
    throw new Error(`Invalid preset: ${preset}`);
  }
  
  try {
    const newPrefs = {
      ...(preset === 'CUSTOM' ? await getUserUnitPreferences() : UNIT_PRESETS[preset]),
      preset
    };
    
    await Preferences.set({
      key: 'unit_preferences',
      value: JSON.stringify(newPrefs)
    });
    
    return newPrefs;
  } catch (error) {
    console.error('Error setting unit preset:', error);
    throw error;
  }
}
