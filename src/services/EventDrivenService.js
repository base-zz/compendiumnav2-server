import BaseService from './BaseService.js';

/**
 * A service that runs in response to specific events.
 * Extend this for services that need to react to events or conditions.
 * 
 * @example
 * class AlertService extends EventDrivenService {
 *   constructor() {
 *     super('alerts');
 *   }
 *   
 *   async start() {
 *     await super.start();
 *     
 *     // Subscribe to weather updates
 *     this.weatherSubscription = this.serviceManager
 *       .getService('weather')
 *       .on('update', this.handleWeatherUpdate.bind(this));
 *   }
 *   
 *   handleWeatherUpdate(weatherData) {
 *     if (weatherData.temperature > 30) {
 *       this.emitEvent('alert', {
 *         type: 'high_temperature',
 *         severity: 'warning',
 *         message: 'High temperature warning!',
 *         data: weatherData
 *       });
 *     }
 *   }
 *   
 *   async stop() {
 *     // Clean up subscriptions
 *     if (this.weatherSubscription) {
 *       this.weatherSubscription();
 *     }
 *     await super.stop();
 *   }
 * }
 */
export class EventDrivenService extends BaseService {
  /**
   * Create a new event-driven service
   * @param {string} name - The name of the service (e.g., 'alerts', 'notifications')
   * @param {Object} [options] - Configuration options
   * @param {boolean} [options.autoCleanup=true] - Whether to automatically clean up subscriptions on stop
   */
  constructor(name, options = {}) {
    const { autoCleanup = true } = options;
    super(name, 'event-driven');
    
    /** @private */
    this._subscriptions = new Map();
    
    /** @private */
    this._autoCleanup = autoCleanup;
    
    /** @private */
    this._externalSubscriptions = new Set();
    
    this.log('Initializing event-driven service');
  }

  /**
   * Subscribe to an event
   * @param {string} eventName - Name of the event to subscribe to
   * @param {Function} handler - Function to call when event occurs
   * @returns {Function} Unsubscribe function
   */
  subscribe(eventName, handler) {
    if (typeof handler !== 'function') {
      throw new TypeError('Handler must be a function');
    }
    
    if (!this._subscriptions.has(eventName)) {
      this._subscriptions.set(eventName, new Set());
    }
    
    const handlers = this._subscriptions.get(eventName);
    handlers.add(handler);
    
    this.log(`Added subscription to ${eventName} (${handlers.size} total)`);
    
    // Return unsubscribe function
    return () => this._unsubscribe(eventName, handler);
  }
  
  /**
   * Unsubscribe a handler from an event
   * @private
   */
  _unsubscribe(eventName, handler) {
    if (!this._subscriptions.has(eventName)) return;
    
    const handlers = this._subscriptions.get(eventName);
    handlers.delete(handler);
    
    if (handlers.size === 0) {
      this._subscriptions.delete(eventName);
    }
    
    this.log(`Removed subscription from ${eventName} (${handlers.size} remaining)`);
  }
  
  /**
   * Track an external subscription for cleanup
   * @param {Function} unsubscribe - Function to call to unsubscribe
   * @returns {Function} The unsubscribe function
   * @protected
   */
  _trackSubscription(unsubscribe) {
    if (typeof unsubscribe !== 'function') {
      throw new TypeError('Unsubscribe must be a function');
    }
    
    this._externalSubscriptions.add(unsubscribe);
    
    // Return a wrapped unsubscribe function
    return () => {
      if (this._externalSubscriptions.has(unsubscribe)) {
        this._externalSubscriptions.delete(unsubscribe);
        unsubscribe();
      }
    };
  }

  /**
   * Emit an event to all subscribers
   * @param {string} eventName - Name of the event
   * @param {*} [data] - Data to pass to handlers
   * @param {Object} [options] - Additional options
   * @param {boolean} [options.async=false] - Whether to call handlers asynchronously
   */
  emitEvent(eventName, data, { async = false } = {}) {
    if (!this._subscriptions.has(eventName)) {
      return;
    }
    
    const handlers = Array.from(this._subscriptions.get(eventName));
    
    if (handlers.length === 0) {
      return;
    }
    
    this.log(`Emitting event '${eventName}' to ${handlers.length} handlers`);
    
    const emitToHandler = (handler) => {
      try {
        const result = handler(data, eventName);
        
        // If the handler returns a promise and we're in async mode, catch any rejections
        if (result && typeof result.catch === 'function') {
          result.catch(error => {
            this.logError(`Error in async handler for '${eventName}':`, error);
            this.emit('error', {
              event: eventName,
              error: error.message,
              stack: error.stack,
              timestamp: new Date()
            });
          });
        }
        
        return result;
      } catch (error) {
        this.logError(`Error in handler for '${eventName}':`, error);
        this.emit('error', {
          event: eventName,
          error: error.message,
          stack: error.stack,
          timestamp: new Date()
        });
      }
    };
    
    if (async) {
      // Run all handlers in parallel and wait for all to complete
      Promise.all(handlers.map(emitToHandler))
        .catch(error => {
          this.logError(`Error in async event '${eventName}':`, error);
        });
    } else {
      // Run handlers synchronously
      for (const handler of handlers) {
        emitToHandler(handler);
      }
    }
    
    // Emit a wildcard event that includes the event name
    this.emit('*', { event: eventName, data });
  }
  
  /**
   * Wait for a specific event
   * @param {string} eventName - Name of the event to wait for
   * @param {number} [timeout] - Optional timeout in milliseconds
   * @returns {Promise<*>} Resolves with the event data when the event occurs
   */
  once(eventName, timeout) {
    return new Promise((resolve, reject) => {
      let timer;
      
      const handler = (data) => {
        if (timer) clearTimeout(timer);
        unsubscribe();
        resolve(data);
      };
      
      const unsubscribe = this.subscribe(eventName, handler);
      
      if (timeout) {
        timer = setTimeout(() => {
          unsubscribe();
          reject(new Error(`Timeout waiting for event '${eventName}'`));
        }, timeout);
      }
    });
  }
  
  /**
   * Start the service
   * @override
   */
  async start() {
    if (this.isRunning) return;
    await super.start();
    this.log('Event-driven service started');
  }
  
  /**
   * Stop the service and clean up resources
   * @override
   */
  async stop() {
    if (!this.isRunning) return;
    
    this.log('Stopping event-driven service');
    
    if (this._autoCleanup) {
      this._cleanupSubscriptions();
    }
    
    await super.stop();
    this.log('Event-driven service stopped');
  }
  
  /**
   * Clean up all subscriptions
   * @protected
   */
  _cleanupSubscriptions() {
    // Clean up external subscriptions
    for (const unsubscribe of this._externalSubscriptions) {
      try {
        unsubscribe();
      } catch (error) {
        this.logError('Error during subscription cleanup:', error);
      }
    }
    this._externalSubscriptions.clear();
    
    // Clear all event subscriptions
    this._subscriptions.clear();
    
    this.log('Cleaned up all subscriptions');
  }
  
  /**
   * Get the current status of the service
   * @override
   * @returns {Object} Service status
   */
  status() {
    const subscriptionCount = Array.from(this._subscriptions.values())
      .reduce((sum, handlers) => sum + handlers.size, 0);
    
    return {
      ...super.status(),
      subscriptionCount,
      eventTypes: Array.from(this._subscriptions.keys()),
      externalSubscriptions: this._externalSubscriptions.size
    };
  }
}

export default EventDrivenService;
