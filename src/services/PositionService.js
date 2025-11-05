import ContinuousService from './ContinuousService.js';

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
}

export default PositionService;