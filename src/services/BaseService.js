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
    this.isReady = false; // Indicates if service is fully initialized
    this._dependencies = []; // Array of service names this service depends on
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
  /**
   * Add a service dependency
   * @param {string} serviceName - Name of the service to depend on
   * @returns {BaseService} Returns this for chaining
   */
  setServiceDependency(serviceName) {
    if (!this._dependencies.includes(serviceName)) {
      this._dependencies.push(serviceName);
      this.log(`Added dependency on service: ${serviceName}`);
    }
    return this; // Allow chaining
  }

  /**
   * Wait for all dependencies to be ready
   * @private
   * @param {ServiceManager} serviceManager - The service manager instance
   * @param {number} [timeout=10000] - Timeout in milliseconds
   */
  async _waitForDependencies(serviceManager, timeout = 10000) {
    if (!this._dependencies || this._dependencies.length === 0) {
      return; // No dependencies to wait for
    }

    this.log(`Waiting for dependencies: ${this._dependencies.join(', ')}`);
    await Promise.all(
      this._dependencies.map(name => 
        serviceManager.waitForServiceReady(name, timeout)
          .catch(error => {
            throw new Error(`Dependency ${name} failed to become ready: ${error.message}`);
          })
      )
    );
  }

  async start() {
    if (this.isRunning) {
      this.log('Service is already running');
      return;
    }
    
    try {
      this.emit(`service:${this.name}:starting`);
      this.log('Starting service');
      
      // Wait for dependencies before starting
      if (this.serviceManager) {
        await this._waitForDependencies(this.serviceManager);
      }
      
      this.isRunning = true;
      this.lastUpdated = new Date();
      
      // Mark as ready after successful start
      this.isReady = true;
      this.emit(`service:${this.name}:started`, { timestamp: this.lastUpdated });
      this.emit('ready');
      this.log('Service started successfully and is ready');
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
      this.isReady = false; // No longer ready when stopped
      
      this.emit(`service:${this.name}:stopped`, { timestamp: new Date() });
      this.emit('stopped');
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
  
  /**
   * Wait until the service is ready
   * @param {number} [timeout=5000] - Maximum time to wait in milliseconds
   * @returns {Promise<void>}
   */
  waitUntilReady(timeout = 5000) {
    if (this.isReady) {
      return Promise.resolve();
    }
    
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out waiting for ${this.name} service to be ready`));
      }, timeout);
      
      const onReady = () => {
        cleanup();
        resolve();
      };
      
      const cleanup = () => {
        clearTimeout(timeoutId);
        this.off('ready', onReady);
      };
      
      this.on('ready', onReady);
      
      // Check again in case ready event was emitted before we set up the listener
      if (this.isReady) {
        cleanup();
        resolve();
      }
    });
  }
}

export default BaseService;
