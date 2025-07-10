import { PositionService } from './src/services/PositionService.js';
import { TidalService } from './src/services/TidalService.js';
import { WeatherService } from './src/services/WeatherService.js/index.js';
import EventEmitter from 'events';

// Mock state service
class MockStateService extends EventEmitter {
  constructor() {
    super();
    this.name = 'state';
    this._state = {
      navigation: {
        position: {
          latitude: { value: 37.7749 },
          longitude: { value: -122.4194 },
          timestamp: new Date().toISOString()
        }
      }
    };
  }
  
  getState() {
    return this._state;
  }
}

// Mock GPS service
class MockGPSService extends EventEmitter {
  constructor() {
    super();
    this.name = 'gps';
    this.providesPosition = true;
  }
}

// Mock AIS service
class MockAISService extends EventEmitter {
  constructor() {
    super();
    this.name = 'ais';
    this.providesPosition = true;
  }
}

// Create a test harness
async function testPositionService() {
  console.log('Starting Position Service Test');
  
  // Create mock services
  const stateService = new MockStateService();
  const gpsService = new MockGPSService();
  const aisService = new MockAISService();
  
  // Create position service with explicit source configurations and debug mode
  const positionService = new PositionService({
    sources: {
      gps: { priority: 1, timeout: 1000 },  // GPS is highest priority, but with short timeout for testing
      ais: { priority: 2, timeout: 5000 },  // AIS is secondary
      state: { priority: 3, timeout: 10000 } // State is lowest priority
    },
    debug: true // Enable extra logging
  });
  
  // Create TidalService and WeatherService
  const tidalService = new TidalService(stateService);
  const weatherService = new WeatherService();
  
  // Inject dependencies
  positionService.dependencies = {
    'state': stateService,
    'gps': gpsService,  // Match the source name in the configuration
    'ais': aisService   // Match the source name in the configuration
  };
  
  // Set up dependencies for TidalService and WeatherService
  tidalService.dependencies = {
    'position-service': positionService
  };
  
  weatherService.dependencies = {
    'position-service': positionService
  };
  
  // Listen for position:update events
  positionService.on('position:update', (position) => {
    console.log('POSITION AVAILABLE:', JSON.stringify(position));
    console.log(`Current primary source after position:update: ${positionService._primarySource}`);
    console.log(`Source priorities: ${JSON.stringify(positionService.sources)}`);
  });
  
  // Listen for state:patch events
  positionService.on('state:patch', (patch) => {
    console.log('STATE PATCH:', JSON.stringify(patch));
  });
  
  // Monitor TidalService position updates
  tidalService.on('dependencies:resolved', () => {
    console.log('TidalService dependencies resolved');
    // Trigger the dependencies:resolved event handlers
    tidalService.emit('dependencies:resolved');
  });
  
  // Monitor WeatherService position updates
  weatherService.on('dependencies:resolved', () => {
    console.log('WeatherService dependencies resolved');
    // Trigger the dependencies:resolved event handlers
    weatherService.emit('dependencies:resolved');
  });
  
  // Listen for position updates in TidalService
  const originalTidalOnPositionAvailable = tidalService._onPositionAvailable;
  tidalService._onPositionAvailable = function(positionData) {
    console.log('TidalService received position update:', JSON.stringify(positionData));
    return originalTidalOnPositionAvailable.call(this, positionData);
  };
  
  // Listen for position updates in WeatherService
  const originalWeatherOnPositionAvailable = weatherService._onPositionAvailable;
  weatherService._onPositionAvailable = function(positionData) {
    console.log('WeatherService received position update:', JSON.stringify(positionData));
    return originalWeatherOnPositionAvailable.call(this, positionData);
  };
  
  // Start all services
  console.log('\n--- Starting all services ---');
  await positionService.start();
  console.log('Position service started');
  
  await tidalService.start();
  console.log('Tidal service started');
  
  await weatherService.start();
  console.log('Weather service started');
  
  // Test scenario 1: GPS service emits position:update (highest priority)
  console.log('\n--- Test 1: GPS service position:update (highest priority) ---');
  gpsService.emit('position:update', {
    latitude: 37.7750,
    longitude: -122.4195,
    timestamp: new Date().toISOString()
  });
  
  // Wait a moment
  await new Promise(resolve => setTimeout(resolve, 500));
  console.log('Primary source after GPS update:', positionService._primarySource);
  
  // Test scenario 2: AIS service emits position:update (should not trigger position:update)
  console.log('\n--- Test 2: AIS service position:update (lower priority) ---');
  aisService.emit('position:update', {
    latitude: 37.7751,
    longitude: -122.4196,
    timestamp: new Date().toISOString()
  });
  
  // Wait a moment
  await new Promise(resolve => setTimeout(resolve, 500));
  console.log('Primary source after AIS update:', positionService._primarySource);
  
  // Test scenario 3: State service emits position:update (lowest priority)
  // With our new logic, this should NOT change the primary source since GPS is still valid
  console.log('\n--- Test 3: State service position:update (lowest priority) ---');
  stateService.emit('position:update', {
    latitude: 37.7749,
    longitude: -122.4194,
    timestamp: new Date().toISOString()
  });
  
  // Wait a moment
  await new Promise(resolve => setTimeout(resolve, 500));
  console.log('Primary source after state update:', positionService._primarySource);
  console.log('Expected: GPS should still be primary since it\'s not stale yet');
  
  // Wait a moment
  await new Promise(resolve => setTimeout(resolve, 500));
  
  // Test scenario 4: GPS service goes stale (simulate by waiting)
  console.log('\n--- Test 4: GPS service goes stale (waiting 2 seconds) ---');
  console.log('Current sources in position service:', Object.keys(positionService.sources));
  console.log('Current positions stored:', Object.keys(positionService._positions));
  console.log('Current primary source:', positionService._primarySource);
  
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  // Now AIS should become primary, emit from AIS again
  console.log('\n--- Test 5: AIS update after GPS is stale ---');
  console.log('After waiting, current primary source:', positionService._primarySource);
  
  aisService.emit('position:update', {
    latitude: 37.7752,
    longitude: -122.4197,
    timestamp: new Date().toISOString()
  });
  
  // Wait a moment to see the result
  await new Promise(resolve => setTimeout(resolve, 500));
  console.log('Final primary source:', positionService._primarySource);
  
  // Wait a moment
  await new Promise(resolve => setTimeout(resolve, 500));
  
  // Test scenario 6: Check TidalService and WeatherService position data
  console.log('\n--- Test 6: Checking TidalService and WeatherService position data ---');
  console.log('TidalService position data:', tidalService._internalPosition);
  console.log('WeatherService position data:', weatherService._internalPosition);
  
  // Test scenario 7: Manual position check using _hasValidPositionData
  console.log('\n--- Test 7: Manual position check using _hasValidPositionData ---');
  console.log('TidalService has valid position data:', tidalService._hasValidPositionData());
  console.log('WeatherService has valid position data:', weatherService._hasValidPositionData());
  
  // Stop all services
  console.log('\n--- Stopping all services ---');
  await weatherService.stop();
  console.log('Weather service stopped');
  
  await tidalService.stop();
  console.log('Tidal service stopped');
  
  await positionService.stop();
  console.log('Position service stopped');
}

// Run the test
testPositionService().catch(console.error);
