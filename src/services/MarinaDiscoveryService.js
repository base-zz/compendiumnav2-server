import ContinuousService from './ContinuousService.js';
import Database from 'better-sqlite3';
import path from 'path';

console.log('[SERVICE] MarinaDiscoveryService module loaded');

/**
 * @class MarinaDiscoveryService
 * @description Monitors boat position changes and triggers marina discovery when
 * the boat has moved more than a threshold distance (default 10 miles) from the
 * last discovery location. This ensures fresh marina data without excessive scraping.
 * @extends ContinuousService
 */
export class MarinaDiscoveryService extends ContinuousService {
  constructor(options = {}) {
    super('marina-discovery-service');

    const { 
      dbPath = path.resolve(process.cwd(), 'data/nav_data.db'),
      thresholdMiles = 10,
      minIntervalHours = 1,
      debug = false 
    } = options;

    this.dbPath = dbPath;
    this.thresholdMiles = thresholdMiles;
    this.minIntervalHours = minIntervalHours;
    this.debug = debug;

    // Initialize discovery_state table with default row if needed
    this._initializeDiscoveryState();

    // Add dependency on position service
    this.setServiceDependency('position');

    this._onPositionAvailable = this._onPositionAvailable.bind(this);

    this.log('Marina discovery service initialized');
  }

  _initializeDiscoveryState() {
    const db = new Database(this.dbPath);
    try {
      // Check if discovery_state table exists and has a row
      const tableCheck = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='discovery_state'").get();
      if (!tableCheck) {
        this.log('discovery_state table does not exist, will be created by schema migration');
        return;
      }

      const row = db.prepare("SELECT COUNT(*) as count FROM discovery_state").get();
      if (row.count === 0) {
        db.prepare(`
          INSERT INTO discovery_state (id, last_discovery_lat, last_discovery_lon, last_discovery_time, discovery_count, discovery_threshold_miles, min_discovery_interval_hours)
          VALUES (1, NULL, NULL, NULL, 0, 10, 1)
        `).run();
        this.log('Initialized discovery_state with default row');
      }
    } finally {
      db.close();
    }
  }

  async start() {
    await super.start();
    this.log('Marina discovery service starting...');

    // Set up listener for position:available events from position service
    if (this.dependencies.position) {
      this.log('Setting up position:available event listener from position service');
      this.dependencies.position.on('position:available', this._onPositionAvailable);
    } else {
      this.log('Position service dependency not available', 'warn');
    }

    this.log('Marina discovery service started');
  }

  async stop() {
    if (this.dependencies.position) {
      this.dependencies.position.off('position:available', this._onPositionAvailable);
    }
    await super.stop();
    this.log('Marina discovery service stopped');
  }

  /**
   * Handle position:available events from PositionService
   */
  async _onPositionAvailable(position) {
    if (!position || !position.latitude || !position.longitude) {
      return;
    }

    try {
      const shouldTrigger = await this._shouldTriggerDiscovery(position.latitude, position.longitude);
      
      if (shouldTrigger) {
        this.log(`Triggering marina discovery at ${position.latitude.toFixed(4)}, ${position.longitude.toFixed(4)}`);
        await this._triggerDiscovery(position.latitude, position.longitude);
      }
    } catch (error) {
      this.log(`Error checking discovery trigger: ${error.message}`, 'error');
    }
  }

  /**
   * Check if discovery should be triggered based on distance and time
   */
  async _shouldTriggerDiscovery(lat, lon) {
    const db = new Database(this.dbPath);
    
    try {
      const state = db.prepare('SELECT * FROM discovery_state WHERE id = 1').get();
      
      if (!state) {
        this.log('No discovery state found, triggering initial discovery');
        return true;
      }

      // Check minimum interval
      if (state.last_discovery_time) {
        const lastTime = new Date(state.last_discovery_time);
        const now = new Date();
        const hoursSinceLast = (now.getTime() - lastTime.getTime()) / (1000 * 60 * 60);
        
        if (hoursSinceLast < state.min_discovery_interval_hours) {
          if (this.debug) {
            this.log(`Skipping discovery: only ${hoursSinceLast.toFixed(2)} hours since last discovery (min: ${state.min_discovery_interval_hours}h)`);
          }
          return false;
        }
      }

      // Check distance threshold
      if (state.last_discovery_lat && state.last_discovery_lon) {
        const distance = this._calculateDistance(
          lat, lon,
          state.last_discovery_lat, state.last_discovery_lon
        );
        
        if (distance < state.discovery_threshold_miles) {
          if (this.debug) {
            this.log(`Skipping discovery: only ${distance.toFixed(2)} miles from last discovery (threshold: ${state.discovery_threshold_miles} miles)`);
          }
          return false;
        }
      }

      return true;
    } finally {
      db.close();
    }
  }

  /**
   * Calculate distance between two points in miles using Haversine formula
   */
  _calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 3959; // Earth's radius in miles
    const dLat = this._toRadians(lat2 - lat1);
    const dLon = this._toRadians(lon2 - lon1);
    
    const a = 
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(this._toRadians(lat1)) * Math.cos(this._toRadians(lat2)) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  _toRadians(degrees) {
    return degrees * (Math.PI / 180);
  }

  /**
   * Trigger marina discovery at the specified location
   */
  async _triggerDiscovery(lat, lon) {
    // Update discovery state
    const db = new Database(this.dbPath);
    
    try {
      const now = new Date().toISOString();
      db.prepare(`
        UPDATE discovery_state
        SET last_discovery_lat = ?,
            last_discovery_lon = ?,
            last_discovery_time = ?,
            discovery_count = discovery_count + 1
        WHERE id = 1
      `).run(lat, lon, now);

      this.log(`Updated discovery state: ${lat.toFixed(4)}, ${lon.toFixed(4)}, count incremented`);
    } finally {
      db.close();
    }

    // Emit event to trigger discovery
    this.emit('marina:discovery:trigger', {
      lat,
      lon,
      thresholdMiles: this.thresholdMiles,
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Manually reset discovery state (for testing or forcing re-discovery)
   */
  async resetDiscoveryState() {
    const db = new Database(this.dbPath);
    
    try {
      db.prepare(`
        UPDATE discovery_state
        SET last_discovery_lat = NULL,
            last_discovery_lon = NULL,
            last_discovery_time = NULL,
            discovery_count = 0
        WHERE id = 1
      `).run();

      this.log('Discovery state reset');
    } finally {
      db.close();
    }
  }

  /**
   * Get current discovery state
   */
  getDiscoveryState() {
    const db = new Database(this.dbPath);
    
    try {
      const state = db.prepare('SELECT * FROM discovery_state WHERE id = 1').get();
      return state;
    } finally {
      db.close();
    }
  }
}
