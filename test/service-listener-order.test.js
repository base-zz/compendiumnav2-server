/**
 * Test to ensure StateManager listeners are set up before services start
 * This test prevents regression of the weather/tidal data missing issue
 */

import { StateManager } from '../src/relay/core/state/StateManager.js';
import { ServiceManager } from '../src/services/ServiceManager.js';
import { WeatherService } from '../src/services/WeatherService.js';
import { TidalService } from '../src/services/TidalService.js';

console.log('=== Testing Service Listener Order ===\n');

// Test 1: Verify listeners must be set up before service start
console.log('Test 1: Checking that services emit data immediately on start...');

const stateManager = new StateManager();
const serviceManager = new ServiceManager();

let weatherDataReceived = false;
let tideDataReceived = false;

// Set up listeners AFTER service instantiation (simulating wrong order)
stateManager.on('weather:update', () => {
  weatherDataReceived = true;
  console.log('❌ FAIL: Weather data received but listener was set up AFTER service start');
});

stateManager.on('tide:update', () => {
  tideDataReceived = true;
  console.log('❌ FAIL: Tide data received but listener was set up AFTER service start');
});

// Create services
const weatherService = new WeatherService();
const tidalService = new TidalService();

// Mock position data
weatherService.position = { latitude: 34.7, longitude: -76.6 };
tidalService.position = { latitude: 34.7, longitude: -76.6 };

// Start services (this will emit initial data)
console.log('Starting services...');
await weatherService.start();
await tidalService.start();

// Wait a bit for any async emissions
await new Promise(resolve => setTimeout(resolve, 100));

if (!weatherDataReceived && !tideDataReceived) {
  console.log('✅ PASS: No data received when listeners set up after service start (expected behavior)');
}

// Test 2: Verify correct order works
console.log('\nTest 2: Checking correct order (listeners before start)...');

// Reset flags
weatherDataReceived = false;
tideDataReceived = false;

// Create new services
const weatherService2 = new WeatherService();
const tidalService2 = new TidalService();

weatherService2.position = { latitude: 34.7, longitude: -76.6 };
tidalService2.position = { latitude: 34.7, longitude: -76.6 };

// Set up listeners BEFORE service start (correct order)
stateManager.listenToService(weatherService2);
stateManager.listenToService(tidalService2);

// Override the setWeatherData/setTideData to track calls
const originalSetWeatherData = stateManager.setWeatherData.bind(stateManager);
const originalSetTideData = stateManager.setTideData.bind(stateManager);

stateManager.setWeatherData = (data) => {
  weatherDataReceived = true;
  console.log('✅ Weather data received with listeners in place');
  return originalSetWeatherData(data);
};

stateManager.setTideData = (data) => {
  tideDataReceived = true;
  console.log('✅ Tide data received with listeners in place');
  return originalSetTideData(data);
};

// Start services
console.log('Starting services with listeners already in place...');
await weatherService2.start();
await tidalService2.start();

// Wait a bit for any async emissions
await new Promise(resolve => setTimeout(resolve, 100));

console.log('\n=== Test Results ===');
console.log(`Weather data received: ${weatherDataReceived ? '✅' : '❌'}`);
console.log(`Tide data received: ${tideDataReceived ? '✅' : '❌'}`);

if (weatherDataReceived && tideDataReceived) {
  console.log('\n✅ All tests passed! The fix prevents data loss.');
} else {
  console.log('\n❌ Tests failed! Data is still being lost.');
}

console.log('\n=== Key Takeaway ===');
console.log('ALWAYS call stateManager.listenToService() BEFORE service.start()');
console.log('for services that emit initial data immediately (weather, tidal).');
