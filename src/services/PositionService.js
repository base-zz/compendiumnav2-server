import ContinuousService from './ContinuousService.js';

console.log('[SERVICE] PositionService module loaded');

/**
 * @class PositionService
 * @description A continuous service responsible for acquiring position data from one or
 * more sources and updating the central state manager with the authoritative position.
 * It acts as a "producer" of position data for the rest of the application.
 * @extends ContinuousService
 */
export class PositionService extends ContinuousService {
  dependencies = {};
  // This service is now self-contained and discovers providers. It emits patches
  // but does not directly depend on the state service for writing.
  _dependencies = [];

  constructor(options = {}) {
    super('position-service');

    // Default timeout for position data freshness (1 minute)
    this.defaultTimeout = 60000;
    
    // Get sources configuration from options
    const { sources = {}, debug = false } = options;
    this.sources = sources; // User-provided source configurations
    this.debug = debug; // Enable extra logging for debugging

    // Add dependency on state service
    this.setServiceDependency('state');
 
    this._boundServices = []; // Keep track of services we've bound to for cleanup
    this._positions = {}; // Store the latest position from each source
    
    // Track dynamically discovered sources
    this._discoveredSources = new Set(); 
    this._onPositionUpdate = this._onPositionUpdate.bind(this);

    // Drift & scatter diagnostics for self position when effectively stationary
    this._prevPosition = null; // { latitude, longitude, timestamp }
    this._driftStats = {
      count: 0,
      mean: 0,
      M2: 0,
      min: null,
      max: null,
    };
    this._scatterStats = {
      count: 0,
      mean: 0,
      M2: 0,
      min: null,
      max: null,
    };
    this._centerLat = null;
    this._centerLon = null;
    this._driftLastLogTime = 0;
    this._driftWindow = [];
    this._scatterWindow = [];
    
    this.log('Position service initialized');
  }

  async start() {
    await super.start();
    this.log('Position service starting...');
    this.log(`Initial event listeners for position:update: ${this.listenerCount('position:update')}`);

    // Set up listener for position:update events from state service
    if (this.dependencies.state) {
      this.log('Setting up position:update event listener from state service');
      this.dependencies.state.on('position:update', this._onPositionUpdate);
      
      // Store the service and handler for later cleanup
      this._boundServices.push({ 
        service: this.dependencies.state, 
        handler: this._onPositionUpdate,
        eventName: 'position:update'
      });
    } else {
      this.log('State service dependency not available', 'warn');
    }

    // Dynamically discover and bind to all position providers
    this.log('Searching for position provider services...');
    for (const serviceName in this.dependencies) {
      const service = this.dependencies[serviceName];

      // Check if the service adheres to the Position Provider convention
      if (service && service.providesPosition) {
        this.log(`Found position provider: '${serviceName}'. Binding to its 'position:update' event.`);
        
        // Use the service name as the source name for consistency
        const sourceName = serviceName;
        // const handler = (position) => this._onPositionUpdate(sourceName, position);
        // service.on('position:update', handler);
        service.on('position:update', this._onPositionUpdate);

        // Store the service and handler for later cleanup
        this._boundServices.push({ 
          service, 
          handler: this._onPositionUpdate,
          eventName: 'position:update'
        });
      }
    }

    // Seed initial position from state service if available
    const stateDependency = this.dependencies.state;
    if (stateDependency && typeof stateDependency.getState === 'function') {
      try {
        const currentState = stateDependency.getState();
        const nav = currentState && currentState.navigation;
        const navPosition = nav && nav.position;

        const latitudeValue = navPosition && navPosition.latitude && navPosition.latitude.value;
        const longitudeValue = navPosition && navPosition.longitude && navPosition.longitude.value;

        if (typeof latitudeValue === 'number' && typeof longitudeValue === 'number') {
          const timestampValue = navPosition && navPosition.timestamp;
          const sourceValue = navPosition && navPosition.source;

          this.log('Seeding initial position from state dependency');
          this._onPositionUpdate({
            latitude: latitudeValue,
            longitude: longitudeValue,
            timestamp: timestampValue || new Date().toISOString(),
            source: sourceValue || 'state'
          });
        }
      } catch (error) {
        this.log(`Error seeding initial position: ${error.message}`);
      }
    }

    this.log('Position service started successfully.');
  }
  
  
  async stop() {
    this.log('Stopping position service...');
    // Unbind all event listeners on stop
    this._boundServices.forEach(({ service, handler, eventName }) => {
      const serviceName = service?.name || 'unknown';
      this.log(`Unbinding from ${serviceName} event ${eventName}`);
      service.off(eventName, handler);
    });
    this._boundServices = [];
    await super.stop();
    this.log('Position service stopped.');
  }

  /**
   * Handles incoming position updates from a named source.
   * @param {string} sourceName - The name of the source (e.g., 'signalk', 'mfd').
   * @param {object} position - The position object { latitude, longitude }.
   * @private
   */
  /**
   * Handles position:update events from the state service
   * @param {Object} positionData - Position data from the state service
   * @private
   */
  _onPositionUpdate(positionData) {
    if (!positionData || typeof positionData.latitude !== 'number' || typeof positionData.longitude !== 'number') {
      this.log('Received invalid position data from state service', 'warn');
      return;
    }

    // Use the source from the position data if available, otherwise use a default name
    const sourceName = positionData.source || 'state';
    // this.log(`Received position:update from ${sourceName}: ${positionData.latitude}, ${positionData.longitude}`);
    
    // This allows us to have the data available if needed later
    const timestamp = positionData.timestamp || new Date().toISOString();
    
    // Store the position data internally
    this._positions[sourceName] = {
      latitude: positionData.latitude,
      longitude: positionData.longitude,
      timestamp: timestamp
    };

    // Drift & scatter diagnostics (self position noise over time)
    const lat = positionData.latitude;
    const lon = positionData.longitude;
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      const nowMs = Date.parse(timestamp) || Date.now();

      // Step drift: distance between successive samples
      if (this._prevPosition && Number.isFinite(this._prevPosition.latitude) && Number.isFinite(this._prevPosition.longitude)) {
        const stepDistanceMeters = this._haversineDistanceMeters(
          this._prevPosition.latitude,
          this._prevPosition.longitude,
          lat,
          lon,
        );
        if (Number.isFinite(stepDistanceMeters)) {
          this._updateRunningStats(this._driftStats, stepDistanceMeters);
          this._driftWindow.push(stepDistanceMeters);
          if (this._driftWindow.length > 2000) {
            this._driftWindow.shift();
          }
        }
      }

      // Scatter around centroid: distance from current point to running center
      if (Number.isFinite(this._centerLat) && Number.isFinite(this._centerLon)) {
        const radiusMeters = this._haversineDistanceMeters(
          this._centerLat,
          this._centerLon,
          lat,
          lon,
        );
        if (Number.isFinite(radiusMeters)) {
          this._updateRunningStats(this._scatterStats, radiusMeters);
          this._scatterWindow.push(radiusMeters);
          if (this._scatterWindow.length > 2000) {
            this._scatterWindow.shift();
          }
        }
      }

      // Update centroid (running mean of lat/lon using scatter sample count)
      if (!Number.isFinite(this._centerLat) || !Number.isFinite(this._centerLon)) {
        this._centerLat = lat;
        this._centerLon = lon;
      } else {
        const n = (this._scatterStats && this._scatterStats.count ? this._scatterStats.count : 0) + 1;
        this._centerLat = this._centerLat + (lat - this._centerLat) / n;
        this._centerLon = this._centerLon + (lon - this._centerLon) / n;
      }

      this._prevPosition = { latitude: lat, longitude: lon, timestamp };

      this._maybeLogDriftStats(nowMs);
    }
    
    // Create JSON Patch format (RFC 6902) expected by StateManager
    // Store position data by source in the top-level position object
    const patch = [
      {
        op: 'add',
        path: `/position/${sourceName}`,
        value: {
          latitude: positionData.latitude,
          longitude: positionData.longitude,
          timestamp: timestamp,
          source: sourceName
        }
      }
    ];

    // Emit the patch for the StateManager to consume
    this.emit('state:position', { 
      data: patch,
      source: `${sourceName}`,
      timestamp: timestamp,
      trace: true
    });
    
    // Only log detailed processing when debug mode is enabled
    if (this.debug) {
      this.log(`Processing position data from ${sourceName}`);
    }
    
    // Always emit position:update events for any source
    this.emit('position:update', {
      latitude: positionData.latitude,
      longitude: positionData.longitude,
      timestamp: timestamp,
      source: sourceName,
    });
  }

  _updateRunningStats(stats, x) {
    if (!stats || !Number.isFinite(x)) return;

    const count = stats.count || 0;
    const mean = stats.mean || 0;
    const M2 = stats.M2 || 0;

    const newCount = count + 1;
    const delta = x - mean;
    const newMean = mean + delta / newCount;
    const delta2 = x - newMean;
    const newM2 = M2 + delta * delta2;

    stats.count = newCount;
    stats.mean = newMean;
    stats.M2 = newM2;
    stats.min = stats.min === null ? x : Math.min(stats.min, x);
    stats.max = stats.max === null ? x : Math.max(stats.max, x);
  }

  _getStdDev(stats) {
    if (!stats || !Number.isFinite(stats.count) || stats.count < 2) return null;
    return Math.sqrt(stats.M2 / (stats.count - 1));
  }

  _haversineDistanceMeters(lat1, lon1, lat2, lon2) {
    if (
      !Number.isFinite(lat1) ||
      !Number.isFinite(lon1) ||
      !Number.isFinite(lat2) ||
      !Number.isFinite(lon2)
    ) {
      return null;
    }

    const R = 6371000; // meters
    const toRad = (deg) => (deg * Math.PI) / 180;

    const phi1 = toRad(lat1);
    const phi2 = toRad(lat2);
    const dPhi = toRad(lat2 - lat1);
    const dLambda = toRad(lon2 - lon1);

    const a =
      Math.sin(dPhi / 2) * Math.sin(dPhi / 2) +
      Math.cos(phi1) * Math.cos(phi2) *
        Math.sin(dLambda / 2) * Math.sin(dLambda / 2);

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c;
  }

  _maybeLogDriftStats(nowTsMs) {
    const LOG_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

    if (!Number.isFinite(nowTsMs)) return;

    if (
      this._driftLastLogTime &&
      nowTsMs - this._driftLastLogTime < LOG_INTERVAL_MS
    ) {
      return;
    }

    this._driftLastLogTime = nowTsMs;

    // Compute window-based stats for the last N samples
    const windowDrift = this._computeWindowStats(this._driftWindow);
    const windowScatter = this._computeWindowStats(this._scatterWindow);

    // Derive a simple teleport threshold from the drift window (e.g. 99th percentile)
    let teleportThresholdMeters = null;
    let filteredDrift = null;
    if (this._driftWindow.length > 0) {
      const sorted = [...this._driftWindow].sort((a, b) => a - b);
      const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99));
      teleportThresholdMeters = sorted[idx];
      filteredDrift = this._driftWindow.filter((d) => d <= teleportThresholdMeters);
    }

    const filteredDriftStats = filteredDrift && filteredDrift.length
      ? this._computeWindowStats(filteredDrift)
      : null;

    console.log('[PositionService] drift diagnostics', {
      windowSize: this._driftWindow.length,
      driftWindow: windowDrift,
      driftWindowFiltered: filteredDriftStats,
      teleportThresholdMeters,
      teleportCount:
        teleportThresholdMeters == null
          ? 0
          : this._driftWindow.length - (filteredDrift ? filteredDrift.length : 0),
      scatterWindow: windowScatter,
      center: {
        latitude: this._centerLat,
        longitude: this._centerLon,
      },
    });

    // Emit a state patch with a high-level positionStability object (read-only diagnostics)
    if (windowScatter && Number.isFinite(windowScatter.mean)) {
      const radius95Meters =
        Number.isFinite(windowScatter.std)
          ? windowScatter.mean + 2 * windowScatter.std
          : windowScatter.mean;

      const timestamp = new Date(nowTsMs).toISOString();

      const patch = [
        {
          op: 'add',
          path: '/positionStability',
          value: {
            radius95Meters,
            meanRadiusMeters: windowScatter.mean,
            stdRadiusMeters: windowScatter.std,
            windowSize: this._driftWindow.length,
            teleportThresholdMeters,
            teleportCount:
              teleportThresholdMeters == null
                ? 0
                : this._driftWindow.length - (filteredDrift ? filteredDrift.length : 0),
            lastUpdated: timestamp,
          },
        },
      ];

      this.emit('state:position', {
        data: patch,
        source: 'position-service',
        timestamp,
        trace: false,
      });
    }
  }

  _computeWindowStats(values) {
    if (!Array.isArray(values) || values.length === 0) {
      return {
        count: 0,
        mean: null,
        std: null,
        min: null,
        max: null,
      };
    }

    let count = 0;
    let mean = 0;
    let M2 = 0;
    let min = null;
    let max = null;

    for (const v of values) {
      if (!Number.isFinite(v)) continue;
      count += 1;
      const delta = v - mean;
      mean = mean + delta / count;
      const delta2 = v - mean;
      M2 = M2 + delta * delta2;
      min = min === null ? v : Math.min(min, v);
      max = max === null ? v : Math.max(max, v);
    }

    const std = count > 1 ? Math.sqrt(M2 / (count - 1)) : null;

    return {
      count,
      mean,
      std,
      min,
      max,
    };
  }
}
export default PositionService;