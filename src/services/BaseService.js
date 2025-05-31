import EventEmitter from 'events';
import debug from 'debug';

/**
 * Base service class that all services should extend.
 * Provides event emission and basic lifecycle management.
 */
class BaseService extends EventEmitter {
  /**
   * Create a new service instance
   * @param {string} name - The name of the service
   * @param {string} [type='base'] - The type of the service
   */
  constructor(name, type = 'base') {
    super();
    this.name = name;
    this.type = type;
    this.isRunning = false;
    this.lastUpdated = null;
    
    // Set up debug logging
    this.log = debug(`cn2:${name}-service`);
    this.logError = debug(`cn2:${name}-service:error`);
    
    // Enable error logging by default
    if (this.logError.enabled === undefined) {
      debug.enable(`cn2:${name}-service:error`);
    }
    
    this._eventEmitter = new EventEmitter();
    
    // Forward events from the internal emitter to this instance
    this._eventEmitter.on('*', (event, ...args) => {
      this.emit(event, ...args);
    });
    
    this.log(`Initialized ${name} service (${type})`);
  }

  /**
   * Start the service
   * @emits {string} service:{name}:starting - Emitted when the service is starting
   * @emits {string} service:{name}:started - Emitted when the service has started successfully
   * @emits {Error} service:{name}:error - Emitted when an error occurs
   * @returns {Promise<void>}
   */
  async start() {
    if (this.isRunning) {
      this.log('Service is already running');
      return;
    }
    
    try {
      this.emit(`service:${this.name}:starting`);
      this.log('Starting service');
      
      this.isRunning = true;
      this.lastUpdated = new Date();
      
      this.emit(`service:${this.name}:started`, { timestamp: this.lastUpdated });
      this.log('Service started successfully');
    } catch (error) {
      this.logError('Failed to start service:', error);
      this.emit(`service:${this.name}:error`, { 
        error: error.message,
        code: error.code,
        timestamp: new Date()
      });
      throw error;
    }
  }

  /**
   * Stop the service
   * @emits {string} service:{name}:stopping - Emitted when the service is stopping
   * @emits {string} service:{name}:stopped - Emitted when the service has stopped
   * @emits {Error} service:{name}:error - Emitted when an error occurs
   * @returns {Promise<void>}
   */
  async stop() {
    if (!this.isRunning) {
      this.log('Service is not running');
      return;
    }
    
    try {
      this.emit(`service:${this.name}:stopping`);
      this.log('Stopping service');
      
      this.isRunning = false;
      
      this.emit(`service:${this.name}:stopped`, { timestamp: new Date() });
      this.log('Service stopped successfully');
    } catch (error) {
      this.logError('Error stopping service:', error);
      this.emit(`service:${this.name}:error`, { 
        error: error.message,
        code: error.code,
        timestamp: new Date()
      });
      throw error;
    }
  }

  /**
   * Get the current status of the service
   * @returns {Object} Service status with the following structure:
   * @property {string} name - Service name
   * @property {string} type - Service type
   * @property {boolean} isRunning - Whether the service is running
   * @property {Date|null} lastUpdated - When the service was last updated
   * @property {string} status - Human-readable status
   */
  status() {
    return {
      name: this.name,
      type: this.type,
      isRunning: this.isRunning,
      lastUpdated: this.lastUpdated,
      status: this.isRunning ? 'running' : 'stopped',
      // Add any additional status information here
    };
  }

  /**
   * Add a listener for a specific event
   * @param {string} event - The event name
   * @param {Function} listener - The callback function
   * @returns {BaseService} This instance for chaining
   */
  on(event, listener) {
    super.on(event, listener);
    return this;
  }

  /**
   * Add a one-time listener for a specific event
   * @param {string} event - The event name
   * @param {Function} listener - The callback function
   * @returns {BaseService} This instance for chaining
   */
  once(event, listener) {
    super.once(event, listener);
    return this;
  }

  /**
   * Remove a listener for a specific event
   * @param {string} event - The event name
   * @param {Function} listener - The callback function
   * @returns {BaseService} This instance for chaining
   */
  off(event, listener) {
    super.off(event, listener);
    return this;
  }

  /**
   * Emit an event
   * @param {string} event - The event name
   * @param {...*} args - Arguments to pass to the listeners
   * @returns {boolean} True if the event had listeners, false otherwise
   */
  emit(event, ...args) {
    return super.emit(event, ...args);
  }
}

export default BaseService;
