import { EventEmitter } from 'events';

// Import ScheduledService with dynamic import to avoid circular dependencies
let ScheduledService;
try {
  ScheduledService = (await import('./ScheduledService.js')).default;
} catch (error) {
  console.warn('ScheduledService not found, scheduling will be disabled');
}

export class ServiceManager {
  constructor() {
    this.services = new Map();
    this.timers = new Map();
    this.eventBus = new EventEmitter();
    this.isShuttingDown = false;
  }

  registerService(name, service) {
    if (this.services.has(name)) {
      throw new Error(`Service with name '${name}' is already registered`);
    }

    // Forward all service events to the central bus
    service.on('*', (event, ...args) => {
      // const eventName = `${name}:${event}`;
      // this.eventBus.emit(eventName, ...args);
      this.eventBus.emit(event, ...args);
      this.eventBus.emit('*', { service: name, event, args });
    });

    // Special handling for service errors
    service.on('error', (error) => {
      console.error(`[${name}] Service error:`, error);
    });

    this.services.set(name, service);
    console.log(`[ServiceManager] Registered service: ${name} (${service.type})`);
  }

  async startService(name) {
    const service = this.services.get(name);
    if (!service) {
      throw new Error(`Service '${name}' not found`);
    }

    if (service.isRunning) {
      console.warn(`[ServiceManager] Service '${name}' is already running`);
      return;
    }

    try {
      console.log(`[ServiceManager] Starting service: ${name}`);
      await service.start();

      // Set up scheduling for scheduled services
      if (ScheduledService && service instanceof ScheduledService && service.options && service.options.interval) {
        const runner = async () => {
          if (this.isShuttingDown) return;
          
          try {
            console.log(`[${name}] Running scheduled task...`);
            await service.run();
            service.lastUpdated = new Date();
            service.emit('run:complete');
          } catch (error) {
            console.error(`[${name}] Scheduled task failed:`, error);
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
        console.log(`[ServiceManager] Scheduled '${name}' to run every ${service.options.interval}ms`);
      }

      return service;
    } catch (error) {
      console.error(`[ServiceManager] Failed to start service '${name}':`, error);
      throw error;
    }
  }

  async stopService(name) {
    const service = this.services.get(name);
    if (!service || !service.isRunning) return;

    try {
      console.log(`[ServiceManager] Stopping service: ${name}`);
      
      // Clear any running timers
      if (this.timers.has(name)) {
        clearInterval(this.timers.get(name));
        this.timers.delete(name);
      }

      await service.stop();
    } catch (error) {
      console.error(`[ServiceManager] Error stopping service '${name}':`, error);
      throw error;
    }
  }

  async startAll() {
    const results = { started: [], errors: [] };
    
    // Start services in registration order
    for (const [name] of this.services) {
      try {
        await this.startService(name);
        results.started.push(name);
      } catch (error) {
        results.errors.push({ name, error });
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
