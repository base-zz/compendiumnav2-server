import { EventEmitter } from 'events';
import debug from 'debug';

console.log('[SERVICE] ServiceManager module loaded');

// Import ScheduledService with dynamic import to avoid circular dependencies
let ScheduledService;
try {
  ScheduledService = (await import('./ScheduledService.js')).default;
} catch (error) {
  console.error('ScheduledService not found, scheduling will be disabled');
}

export class ServiceManager {
  constructor() {
    this.services = new Map();
    this.timers = new Map();
    this.eventBus = new EventEmitter();
    this.isShuttingDown = false;

    // Set up debug logging
    this.log = debug('service-manager');
    this.logError = debug('service-manager:error');
  }

  registerService(name, service) {
    if (this.services.has(name)) {
      throw new Error(`Service with name '${name}' is already registered`);
    }

    // Store reference to service manager in the service
    service.serviceManager = this;

    // Forward all service events to the central bus
    service.on('*', (event, ...args) => {
      this.eventBus.emit(event, ...args);
      this.eventBus.emit('*', { service: name, event, args });
    });

    // Special handling for service errors
    service.on('error', (error) => {
      this.logError(`[${name}] Service error:`, error);
    });

    this.services.set(name, service);
    this.log(`Registered service: ${name} (${service.type})`);
    
    // Log dependencies if any
    if (service._dependencies && service._dependencies.length > 0) {
      this.log(`${name} depends on: ${service._dependencies.join(', ')}`);
    }
  }

  async startService(name) {
    const service = this.services.get(name);
    if (!service) {
      throw new Error(`Service '${name}' not found`);
    }

    if (service.isRunning) {
      this.log(`Service '${name}' is already running`);
      return;
    }

    try {
      this.log(`Starting service: ${name}`);
      await service.start();

      // Set up scheduling for scheduled services
      if (ScheduledService && service instanceof ScheduledService && service.options && service.options.interval) {
        const runner = async () => {
          if (this.isShuttingDown) return;
          
          try {
            this.log(`[${name}] Running scheduled task...`);
            await service.run();
            service.lastUpdated = new Date();
            service.emit('run:complete');
          } catch (error) {
            this.logError(`[${name}] Scheduled task failed:`, error);
            service.emit('run:error', error);
          }
        };

        // Initial run if requested
        if (service.options.immediate) {
          await runner();
        }

        // Set up interval
        const timer = setInterval(runner, service.options.interval);
        this.timers.set(name, timer);
        this.log(`Scheduled '${name}' to run every ${service.options.interval}ms`);
      }

      return service;
    } catch (error) {
      this.logError(`Failed to start service '${name}':`, error);
      throw error;
    }
  }

  async stopService(name) {
    const service = this.services.get(name);
    if (!service || !service.isRunning) return;

    try {
      this.log(`Stopping service: ${name}`);
      
      // Clear any running timers
      if (this.timers.has(name)) {
        clearInterval(this.timers.get(name));
        this.timers.delete(name);
      }

      await service.stop();
    } catch (error) {
      this.logError(`Error stopping service '${name}':`, error);
      throw error;
    }
  }

  async startAll() {
    const results = { started: [], errors: [] };
    
    // Get all service names in registration order
    const serviceNames = Array.from(this.services.keys());
    
    // Start services in registration order
    for (const name of serviceNames) {
      try {
        await this.startService(name);
        results.started.push(name);
      } catch (error) {
        this.logError(`Failed to start service ${name}:`, error);
        results.errors.push({ 
          name, 
          error: error.message || 'Unknown error',
          stack: error.stack 
        });
      }
    }

    return results;
  }

  async stopAll() {
    this.isShuttingDown = true;
    const results = { stopped: [], errors: [] };

    // Stop services in reverse order
    const services = Array.from(this.services.keys()).reverse();
    for (const name of services) {
      try {
        await this.stopService(name);
        results.stopped.push(name);
      } catch (error) {
        results.errors.push({ name, error });
      }
    }

    this.isShuttingDown = false;
    return results;
  }

  getService(name) {
    return this.services.get(name);
  }

  /**
   * Wait for a specific service to be ready
   * @param {string} name - Name of the service to wait for
   * @param {number} [timeout=10000] - Maximum time to wait in milliseconds
   * @returns {Promise<void>}
   */
  async waitForServiceReady(name, timeout = 10000) {
    const service = this.services.get(name);
    if (!service) {
      throw new Error(`Service '${name}' not found`);
    }

    // If service has waitUntilReady method, use it
    if (typeof service.waitUntilReady === 'function') {
      return service.waitUntilReady(timeout);
    }
    
    // Otherwise, just wait for the service to be running
    if (service.isRunning) {
      return Promise.resolve();
    }
    
    // If not running, wait for it to start
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out waiting for service '${name}' to be ready`));
      }, timeout);
      
      const onReady = () => {
        cleanup();
        resolve();
      };
      
      const cleanup = () => {
        clearTimeout(timeoutId);
        service.off('started', onReady);
      };
      
      service.on('started', onReady);
    });
  }
  
  /**
   * Wait for all services to be ready
   * @param {Object} [options] - Options
   * @param {number} [options.timeout=10000] - Timeout per service in milliseconds
   * @param {string[]} [options.services] - Specific services to wait for (default: all)
   * @returns {Promise<void>}
   */
  async waitForAllReady({ timeout = 10000, services } = {}) {
    const serviceNames = services || Array.from(this.services.keys());
    await Promise.all(
      serviceNames.map(name => this.waitForServiceReady(name, timeout))
    );
  }

  getStatus() {
    const status = {};
    for (const [name, service] of this.services) {
      status[name] = service.status();
    }
    return status;
  }

  // Event bus proxy methods
  on(event, listener) {
    this.eventBus.on(event, listener);
    return this;
  }

  once(event, listener) {
    this.eventBus.once(event, listener);
    return this;
  }

  off(event, listener) {
    this.eventBus.off(event, listener);
    return this;
  }
}

// Singleton instance
export const serviceManager = new ServiceManager();
