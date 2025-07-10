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
    this.dependencies = {}; // Object to hold instances of resolved dependencies
    this.lastUpdated = null;
    /** @type {import('./ServiceManager.js').ServiceManager | null} */
    this.serviceManager = null; // Injected by ServiceManager upon registration

    // Set up debug logging
    this.log = debug(`${name}`);
    this.logError = debug(`:${name}:error`);

    // Enable error logging by default
    if (this.logError.enabled === undefined) {
      debug.enable(`:${name}:error`);
    }
    
    this.log(`Initialized ${name} service (${type})`);
  }

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

      // Wait for dependencies before starting
      if (this.serviceManager) {
        await this._waitForDependencies(this.serviceManager);
      }

      this.isRunning = true;
      this.lastUpdated = new Date();
      this.isReady = true; // Mark service as ready
      this.emit(`service:${this.name}:started`);
      this.log('Service started successfully and is ready');
    } catch (error) {
      this.isReady = false;
      this.isRunning = false;
      this.logError(`Failed to start service: ${error.message}`);
      this.emit(`service:${this.name}:error`, error);
      throw error; // Re-throw the error to be caught by the caller
    }
  }

  /**
   * Wait for all dependencies to be ready
   * @private
   * @param {import('./ServiceManager.js').ServiceManager} serviceManager - The service manager instance
   * @param {number} [timeout=10000] - Timeout in milliseconds
   * @returns {Promise<void>}
   * @throws {Error} If a dependency fails to become ready
   */
  async _waitForDependencies(serviceManager, timeout = 10000) {
    if (!this._dependencies || this._dependencies.length === 0) {
      return; // No dependencies to wait for
    }

    this.log(`Waiting for dependencies: ${this._dependencies.join(', ')}`);
    await Promise.all(
      this._dependencies.map(async (name) => {
        try {
          await serviceManager.waitForServiceReady(name, timeout);
          this.dependencies[name] = serviceManager.getService(name);
          this.log(`Successfully resolved dependency: ${name}`);
        } catch (error) {
          throw new Error(`Dependency ${name} failed to become ready: ${error.message}`);
        }
      })
    );
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
   * Get the status of the service
   * @returns {{name: string, type: string, isRunning: boolean, isReady: boolean, lastUpdated: Date|null}}
   */
  getStatus() {
    return {
      name: this.name,
      type: this.type,
      isRunning: this.isRunning,
      isReady: this.isReady,
      lastUpdated: this.lastUpdated
    };
  }
  
  /**
   * Event listener for when the service is ready
   * @param {() => void} listener - The listener to call when the service is ready
   * @returns {this}
   */
  onReady(listener) {
    if (this.isReady) {
      listener();
    } else {
      this.once(`service:${this.name}:started`, listener);
    }
    return this;
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
