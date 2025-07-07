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

    const { sources = {} } = options;
    this.sources = sources;

 
    this._boundServices = []; // Keep track of services we've bound to for cleanup
    this._onPositionUpdate = this._onPositionUpdate.bind(this);
  }

  async start() {
    await super.start();
    this.log('Position service starting...');

    // Dynamically discover and bind to all position providers
    this.log('Searching for position provider services...');
    for (const serviceName in this.dependencies) {
      const service = this.dependencies[serviceName];

      // Check if the service adheres to the Position Provider convention
      if (service && service.providesPosition) {
        this.log(`Found position provider: '${serviceName}'. Binding to its 'position:update' event.`);
        
        const handler = (position) => this._onPositionUpdate(serviceName, position);
        service.on('position:update', handler);

        // Store the service and handler for later cleanup
        this._boundServices.push({ service, handler });
      }
    }

    this.log('Position service started successfully.');
  }

  async stop() {
    this.log('Stopping position service...');
    // Unbind all event listeners on stop
    this._boundServices.forEach(({ service, handler }) => {
      this.log(`Unbinding from ${service.name}`);
      service.off('position:update', handler);
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
  _onPositionUpdate(sourceName, position) {
    // Check if the source is configured in this service
    if (!this.sources[sourceName]) {
      this.log(`Received update from unconfigured source: ${sourceName}. Ignoring.`, 'warn');
      return;
    }

    if (position && typeof position.latitude === 'number' && typeof position.longitude === 'number') {
      this.log(`Received position from ${sourceName}: ${position.latitude}, ${position.longitude}. Emitting state:patch.`);
      
      const timestamp = new Date().toISOString();

      // The 'value' is the core data. The StateManager will use the '$source'
      // and 'timestamp' from the update to build the final state object.
      const patch = {
        updates: [{
          values: [{
            path: `position.${sourceName}`,
            value: {
              latitude: position.latitude,
              longitude: position.longitude,
            }
          }],
          $source: `compendium.positionservice.${sourceName}`,
          timestamp: timestamp,
        }]
      };

      // Emit the patch for the StateManager to consume
      this.emit('state:patch', { data: patch });

    } else {
      this.log(`Received invalid position data from ${sourceName}`, position, 'warn');
    }
  }
}

// Note: This service must now be instantiated with a configuration object.
// export default new PositionService();
