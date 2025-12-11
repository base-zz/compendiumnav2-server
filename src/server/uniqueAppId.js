import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { v4: uuidv4, v4: randomUUID } = require('uuid');
import fs from 'fs';
import path from 'path';

const UUID_FILE = path.resolve(process.cwd(), '.app-uuid');

/**
 * Gets or creates a unique application UUID
 * @returns {string} The application UUID
 */
export function getOrCreateAppUuid() {
  if (fs.existsSync(UUID_FILE)) {
    return fs.readFileSync(UUID_FILE, 'utf8').trim();
  }
  const newUuid = randomUUID();
  fs.writeFileSync(UUID_FILE, newUuid, 'utf8');
  return newUuid;
}

/**
 * Gets boat information including UUID and vessel details from SignalK state
 * @param {Object} stateService - The state service instance
 * @returns {Object} Boat information object
 */
/**
 * Gets boat information including UUID and vessel details from SignalK state
 * @param {Object} [stateService] - Optional state service instance
 * @returns {Object} Boat information object
 */
export function getBoatInfo(stateService) {
  const boatUuid = getOrCreateAppUuid();
  
  // Initialize with default values
  const boatInfo = {
    boatId: boatUuid,
    name: 'Unnamed Vessel',
    mmsi: null,
    callsign: null,
    dimensions: {
      length: null,
      beam: null,
      draft: null,
    },
    position: null,
    lastUpdated: new Date().toISOString(),
    status: 'offline',
    signalK: {
      connected: false,
      error: 'SignalK server not connected'
    }
  };

  try {
    // Only try to get state if stateService is available
    if (stateService && typeof stateService.getState === 'function') {
      const state = stateService.getState() || {};

      // Vessel info is stored under vessel.info in the canonical state model
      const vesselInfo = state?.vessel?.info;

      boatInfo.name = vesselInfo?.name ?? boatInfo.name;
      boatInfo.mmsi = vesselInfo?.mmsi ?? boatInfo.mmsi;
      boatInfo.callsign = vesselInfo?.callsign ?? boatInfo.callsign;

      if (vesselInfo?.dimensions) {
        boatInfo.dimensions = {
          length: vesselInfo.dimensions.length?.value ?? boatInfo.dimensions.length,
          beam: vesselInfo.dimensions.beam?.value ?? boatInfo.dimensions.beam,
          draft: vesselInfo.dimensions.draft?.value ?? boatInfo.dimensions.draft,
        };
      }

      boatInfo.position = state?.navigation?.position || boatInfo.position;
      boatInfo.status = 'online';
      boatInfo.signalK = {
        connected: true,
        lastUpdate: state?.navigation?.position?.timestamp || null,
      };
    }
  } catch (error) {
    console.error('Error getting boat info from SignalK:', error);
    boatInfo.signalK.error = error.message;
  }
  
  return boatInfo;
}