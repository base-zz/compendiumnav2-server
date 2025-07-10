import { serviceManager, StateService, WeatherService, TidalService } from './services/index.js';

export async function initializeServices() {
  try {
    console.log('Initializing services...');
    
    // Create service instances with proper dependency injection
    const stateService = new StateService();
    const weatherService = new WeatherService();
    const tidalService = new TidalService(stateService);

    // Register services
    serviceManager.registerService('state', stateService);
    serviceManager.registerService('weather', weatherService);
    serviceManager.registerService('tidal', tidalService);

    // Set up event listeners
    serviceManager.on('*', ({ service, event, args }) => {
      if (process.env.NODE_ENV !== 'production') {
        console.debug(`[${service}] ${event}`, ...args);
      }
    });

    // Start all services
    console.log('Starting services...');
    const { started, errors } = await serviceManager.startAll();
    
    if (errors.length > 0) {
      console.warn(`Failed to start ${errors.length} services`);
      errors.forEach(({ name, error }) => {
        console.error(`Failed to start ${name}:`, error);
      });
    }

    console.log(`Successfully started ${started.length} services:`, started);
    return serviceManager;
  } catch (error) {
    console.error('Failed to initialize services:', error);
    throw error;
  }
}

// Handle graceful shutdown
process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

async function gracefulShutdown() {
  console.log('\nShutting down services...');
  try {
    const { stopped, errors } = await serviceManager.stopAll();
    
    if (errors.length > 0) {
      console.warn(`Errors stopping ${errors.length} services`);
      errors.forEach(({ name, error }) => {
        console.error(`Error stopping ${name}:`, error);
      });
    }

    console.log(`Stopped ${stopped.length} services`);
    process.exit(0);
  } catch (error) {
    console.error('Error during shutdown:', error);
    process.exit(1);
  }
}

// Export the service manager for direct access if needed
export { serviceManager };
