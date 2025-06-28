import path from 'path';
import os from 'os';
import { createAlertStorageService } from './AlertStorageService.js';
import { createAlertManager as createAlertManagerFn } from './AlertManager.js';
import { fileURLToPath } from 'url';

// Get directory name in ES module
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Alert service instance
let alertManagerInstance = null;

/**
 * Initialize the alert system
 * @param {string} [dataPath] - Optional custom data path for alert storage
 * @returns {Promise<{alertStorage: Object, alertManager: Object}>}
 */
async function initializeAlertSystem(dataPath) {
  if (!alertManagerInstance) {
    try {
      // Use provided path, environment variable, or default path
      const storagePath = dataPath || 
                        process.env.ALERT_DATA_PATH || 
                        path.join(os.homedir(), '.boat-monitor', 'alerts');
      
      // Initialize storage and manager
      const alertStorage = await createAlertStorageService(storagePath);
      alertManagerInstance = createAlertManagerFn(alertStorage);
      
      console.log('Alert system initialized');
    } catch (error) {
      console.error('Failed to initialize alert system:', error);
      throw error;
    }
  }
  
  return {
    alertStorage: alertManagerInstance.storage,
    alertManager: alertManagerInstance
  };
}

// For backward compatibility
let initialized = false;
let alertStorage = null;

// Initialize with default settings if not already done
async function ensureInitialized() {
  if (!initialized) {
    const { alertStorage: storage } = await initializeAlertSystem();
    alertStorage = storage;
    initialized = true;
  }
  return { alertStorage, alertManager: alertManagerInstance };
}

// Export the initialization function and manager
export { initializeAlertSystem };

// For backward compatibility
export async function getAlertManager() {
  if (!alertManagerInstance) {
    await ensureInitialized();
  }
  return alertManagerInstance;
}

export async function getAlertStorage() {
  if (!alertStorage) {
    await ensureInitialized();
  }
  return alertStorage;
}

// Export the classes and factory functions
const alertStorageServiceModule = await import('./AlertStorageService.js');
const alertManagerModule = await import('./AlertManager.js');

export const AlertStorageService = alertStorageServiceModule.AlertStorageService;
export { createAlertManager } from './AlertManager.js';

// Auto-initialize with default settings if this is the main module
if (import.meta.url === `file://${__filename}`) {
  initializeAlertSystem().catch(console.error);
}

// For backward compatibility
export const alertManager = await getAlertManager();
export const AlertStorage = await getAlertStorage();
