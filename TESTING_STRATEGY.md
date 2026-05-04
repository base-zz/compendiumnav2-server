# Testing Strategy for CompendiumNav2 Server

## Overview

This document describes the testing strategy for the CompendiumNav2 server codebase, including how to test various components, testing patterns, and coverage goals.

## Testing Framework

- **Test Runner**: Mocha
- **Assertion Library**: Chai
- **Mocking Library**: Sinon (to be added)
- **Coverage**: nyc (Istanbul) (to be added)

## Component Categories

### 1. Entry Point and Bootstrap
- `mainServer.js` - Server entry point
- `services/bootstrap.js` - Service initialization

### 2. State Management
- `relay/core/state/StateManager.js` - Core state management
- `services/NewStateService.js` - SignalK connection and state updates
- `state/StateData.js` - State data structure

### 3. Services
- `services/ServiceManager.js` - Service lifecycle management
- `services/PositionService.js` - Position tracking
- `services/WeatherService.js` - Weather data
- `services/TidalService.js` - Tide data
- `services/BluetoothService.js` - Bluetooth device management
- `services/VictronModbusService.js` - Victron device communication
- `services/AlertService.js` - Alert management
- `services/MarinaService.js` - Marina data
- `services/AnchorageHudService.js` - Anchorage HUD
- `services/BridgeHudService.js` - Bridge HUD
- `services/MasterSyncService.js` - Master synchronization
- `services/StateNatsBroadcastService.js` - NATS broadcasting

### 4. API Routes
- `server/api/boatInfo.js` - Boat information endpoints
- `server/api/victron.js` - Victron endpoints
- `server/api/routes.js` - Route import/export
- `server/api/fuelPipeline.js` - Fuel data
- `server/vps/registration.js` - VPS registration

### 5. Storage
- `bluetooth/services/storage/storageService.js` - Storage abstraction
- `server/uniqueAppId.js` - UUID generation

### 6. Utilities
- `shared/stateDataModel.js` - State data model
- `shared/unitConversion.js` - Unit conversions
- `shared/unitPreferences.js` - Unit preferences
- `shared/convertSignalK.js` - SignalK data conversion
- `state/extractAISTargets.js` - AIS target extraction

### 7. Rules and Alerts
- `state/ruleEngine.js` - Rule engine
- `state/allRules.js` - All rules
- `state/anchorRules.js` - Anchor-specific rules
- `state/alertRules.js` - Alert rules

## Testing Approaches by Category

### Unit Tests

**Purpose**: Test individual functions and methods in isolation

**When to use**:
- Pure functions (no side effects)
- Utility functions
- Data transformation functions
- Individual service methods

**Examples**:
- `unitConversion.test.js` - Unit conversion functions
- `extractAISTargets.test.js` - AIS extraction logic
- `uniqueAppId.test.js` - UUID generation

**Mocking requirements**:
- Mock external dependencies (HTTP requests, WebSocket connections, database)
- Mock service dependencies
- Use Sinon stubs and spies

### Integration Tests

**Purpose**: Test how components work together

**When to use**:
- Service interactions
- State manager + service integration
- API route handlers
- Storage operations

**Examples**:
- `services.test.js` - Service manager integration
- `stateManager-integration.test.js` - State manager with services
- `api-routes.test.js` - API endpoint integration

**Setup requirements**:
- Real storage (in-memory SQLite for tests)
- Mock external services (SignalK, weather APIs)
- Test database fixtures

### End-to-End Tests

**Purpose**: Test complete user workflows

**When to use**:
- Critical user paths
- Server startup/shutdown
- Graceful error recovery

**Examples**:
- `server-lifecycle.test.js` - Server start/stop
- `signalk-reconnect.test.js` - SignalK reconnection
- `graceful-shutdown.test.js` - Shutdown sequence

**Setup requirements**:
- Full environment simulation
- Mock SignalK server
- Mock external APIs

## Testing Patterns

### Service Testing Pattern

```javascript
import { describe, it, before, after, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import { ServiceUnderTest } from '../src/services/ServiceUnderTest.js';

describe('ServiceUnderTest', () => {
  let service;
  let sandbox;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    // Create service with mocked dependencies
    service = new ServiceUnderTest();
  });

  afterEach(() => {
    sandbox.restore();
    if (service.isRunning) {
      return service.stop();
    }
  });

  describe('initialization', () => {
    it('should initialize with valid config', async () => {
      const config = { /* valid config */ };
      await service.initialize(config);
      expect(service.isInitialized).to.be.true;
    });

    it('should throw with missing required config', async () => {
      const config = { /* missing required params */ };
      await expect(service.initialize(config)).to.be.rejected;
    });
  });

  describe('lifecycle', () => {
    it('should start and stop cleanly', async () => {
      await service.start();
      expect(service.isRunning).to.be.true;
      await service.stop();
      expect(service.isRunning).to.be.false;
    });

    it('should handle start when already running', async () => {
      await service.start();
      await service.start(); // Should not throw
      expect(service.isRunning).to.be.true;
    });
  });
});
```

### State Manager Testing Pattern

```javascript
import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { StateManager } from '../src/relay/core/state/StateManager.js';

describe('StateManager', () => {
  let stateManager;

  beforeEach(() => {
    stateManager = new StateManager();
  });

  afterEach(async () => {
    await stateManager.shutdown();
  });

  describe('state updates', () => {
    it('should apply patches correctly', () => {
      const patch = [{
        op: 'replace',
        path: '/navigation/position/latitude',
        value: 34.5
      }];
      stateManager.applyPatchAndForward(patch);
      expect(stateManager.appState.navigation.position.latitude).to.equal(34.5);
    });

    it('should emit state:patch events', (done) => {
      stateManager.on('state:patch', (data) => {
        expect(data).to.have.property('type', 'state:patch');
        done();
      });
      stateManager.applyPatchAndForward([{ op: 'replace', path: '/test', value: 1 }]);
    });
  });
});
```

### API Route Testing Pattern

```javascript
import { describe, it, before, after, beforeEach } from 'mocha';
import { expect } from 'chai';
import request from 'supertest';
import express from 'express';
import { registerRoutes } from '../src/server/api/routes.js';

describe('API Routes', () => {
  let app;
  let server;

  before(() => {
    app = express();
    app.use(express.json());
    registerRoutes(app);
    server = app.listen(0); // Random port
  });

  after((done) => {
    server.close(done);
  });

  describe('GET /api/test', () => {
    it('should return 200 with valid data', async () => {
      const response = await request(app)
        .get('/api/test')
        .expect(200);
      expect(response.body).to.have.property('success', true);
    });

    it('should handle errors gracefully', async () => {
      const response = await request(app)
        .get('/api/test-error')
        .expect(500);
      expect(response.body).to.have.property('error');
    });
  });
});
```

## Coverage Goals

- **Overall Coverage**: 80%+
- **Critical Services**: 90%+ (StateManager, NewStateService, ServiceManager)
- **API Routes**: 85%+
- **Utilities**: 95%+
- **Edge Cases**: All identified edge cases must have tests

## Test Organization

```
test/
├── unit/
│   ├── utilities/
│   │   ├── unitConversion.test.js
│   │   ├── extractAISTargets.test.js
│   │   └── convertSignalK.test.js
│   ├── storage/
│   │   └── storageService.test.js
│   └── state/
│       └── stateDataModel.test.js
├── integration/
│   ├── services/
│   │   ├── serviceManager.test.js
│   │   ├── newStateService.test.js
│   │   └── positionService.test.js
│   └── state/
│       └── stateManager.test.js
├── api/
│   ├── boatInfo.test.js
│   ├── routes.test.js
│   └── victron.test.js
└── e2e/
    ├── server-lifecycle.test.js
    └── signalk-reconnect.test.js
```

## Mocking Strategy

### External Services
- **SignalK**: Mock WebSocket server, mock HTTP responses
- **Weather APIs**: Mock fetch responses with test data
- **Tide APIs**: Mock fetch responses with test data
- **Bluetooth**: Mock noble and HCI socket
- **Modbus**: Mock serial port and device responses

### Storage
- Use in-memory SQLite for tests
- Reset database before each test
- Provide fixture data for common scenarios

### WebSocket
- Use `ws` library to create test servers
- Simulate connection, message, error, close events
- Test reconnection logic

## CI/CD Integration

- Run tests on every push
- Fail PR if coverage drops below threshold
- Run tests on multiple Node.js versions
- Parallel test execution for speed

## Running Tests

```bash
# Run all tests
npm test

# Run unit tests only
npm run test:unit

# Run integration tests only
npm run test:integration

# Run with coverage
npm run test:coverage

# Run specific test file
npx mocha test/unit/utilities/unitConversion.test.js

# Run tests in watch mode
npm run test:watch
```

## Test Data Management

### Fixtures
Store test data in `test/fixtures/`:
- `signalK-responses.json` - Sample SignalK API responses
- `signalK-deltas.json` - Sample SignalK WebSocket deltas
- `ais-targets.json` - Sample AIS target data
- `weather-responses.json` - Sample weather API responses

### Test Database
- Use separate test database file
- Reset before each test suite
- Seed with fixture data as needed

## Common Test Scenarios

### Error Handling
- Network failures
- Invalid data formats
- Missing configuration
- Timeout scenarios
- Concurrent operations

### Edge Cases
- Empty data sets
- Null/undefined values
- Large data sets
- Rapid successive updates
- Concurrent state updates
- Reconnection during active operation

### Performance
- Measure critical path performance
- Test with realistic data volumes
- Identify memory leaks
- Test cleanup after operations
