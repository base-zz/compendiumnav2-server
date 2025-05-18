/**
 * Server-side Unit Preferences Module
 * 
 * This module provides a server-specific implementation of unit preferences
 * that doesn't rely on browser-based APIs like Capacitor.
 */
import { UNIT_PRESETS } from '../../shared/unitPreferences.js';
import fs from 'fs/promises';
import path from 'path';

// Path to the server-side preferences file
const PREFS_FILE_PATH = path.join(process.cwd(), 'data', 'unitPreferences.json');

/**
 * Get user unit preferences from server-side storage
 * Falls back to imperial units if not found
 */
export async function getServerUnitPreferences() {
  try {
    // Check if the preferences file exists
    try {
      await fs.access(PREFS_FILE_PATH);
    } catch (err) {
      // File doesn't exist, create directory if needed
      try {
        await fs.mkdir(path.dirname(PREFS_FILE_PATH), { recursive: true });
      } catch (mkdirErr) {
        // Ignore if directory already exists
      }
      
      // Create default preferences file with imperial units
      const defaultPrefs = { 
        ...UNIT_PRESETS.IMPERIAL, 
        preset: 'IMPERIAL' 
      };
      
      await fs.writeFile(
        PREFS_FILE_PATH, 
        JSON.stringify(defaultPrefs, null, 2)
      );
      
      return defaultPrefs;
    }
    
    // Read preferences from file
    const data = await fs.readFile(PREFS_FILE_PATH, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Error reading server unit preferences:', error);
    // Default to imperial units on error
    return { 
      ...UNIT_PRESETS.IMPERIAL, 
      preset: 'IMPERIAL' 
    };
  }
}

/**
 * Set server-side unit preferences
 */
export async function setServerUnitPreferences(preferences) {
  try {
    // Ensure directory exists
    try {
      await fs.mkdir(path.dirname(PREFS_FILE_PATH), { recursive: true });
    } catch (err) {
      // Ignore if directory already exists
    }
    
    // Write preferences to file
    await fs.writeFile(
      PREFS_FILE_PATH, 
      JSON.stringify(preferences, null, 2)
    );
    
    return preferences;
  } catch (error) {
    console.error('Error saving server unit preferences:', error);
    throw error;
  }
}
