# Service Architecture

This document outlines the service architecture for the application, including the `ServiceManager` and various services.

## Overview

The application uses a service-oriented architecture with the following key components:

- **ServiceManager**: Manages the lifecycle of all services, handles scheduling, and provides a central event bus.
- **StateService**: Manages application state and provides real-time updates.
- **WeatherService**: Fetches and manages weather data.
- **TidalService**: Fetches and manages tidal data.

## Service Types

### BaseService

The base class for all services. Provides common functionality like event emission and basic lifecycle management.

### ContinuousService

Extends `BaseService` for services that run continuously (like `StateService`).

### ScheduledService

Extends `BaseService` for services that run on a schedule (like `WeatherService` and `TidalService`).

## Service Manager

The `ServiceManager` is responsible for:

- Registering and managing services
- Starting and stopping services in the correct order
- Handling service dependencies
- Providing a central event bus for inter-service communication
- Managing scheduled tasks

## Integration

To integrate these services into your application:

1. Import and call `initializeServices()` from `integrateServices.js`
2. Access services through the `serviceManager` singleton
3. Listen for service events as needed

## Example Usage

```javascript
import { initializeServices, serviceManager } from './integrateServices';

async function startApp() {
  try {
    // Initialize all services
    await initializeServices();
    
    // Access a service
    const stateService = serviceManager.getService('state');
    
    // Listen for state updates
    serviceManager.on('state:state:update', (update) => {
      console.log('State updated:', update);
    });
    
    console.log('Application started');
  } catch (error) {
    console.error('Failed to start application:', error);
    process.exit(1);
  }
}

startApp();
```

## Testing

Run the test suite with:

```bash
npm test
```

## Adding a New Service

1. Create a new service class that extends either `ContinuousService` or `ScheduledService`
2. Implement the required methods (`start`, `stop`, etc.)
3. Register the service with the `ServiceManager`
4. Add tests for your service

## Error Handling

- Services should emit 'error' events for recoverable errors
- The `ServiceManager` will log errors but not crash the application
- Unhandled errors in scheduled tasks will be caught and logged

## Logging

- All service events are emitted on the `ServiceManager`'s event bus
- In development, all events are logged to the console
- In production, only errors and important events are logged

## Performance Considerations

- The `ServiceManager` ensures that services are started and stopped in the correct order
- Scheduled tasks are automatically cleaned up when services are stopped
- The event bus uses Node's built-in `EventEmitter`, which is optimized for most use cases
