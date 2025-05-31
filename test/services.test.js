import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { serviceManager, StateService, WeatherService, TidalService } from '../src/services/index.js';

describe('Service Manager', () => {
  let stateService;
  let weatherService;
  let tidalService;

  before(() => {
    // Create service instances
    stateService = new StateService();
    weatherService = new WeatherService(stateService);
    tidalService = new TidalService(stateService);

    // Register services
    serviceManager.registerService('state', stateService);
    serviceManager.registerService('weather', weatherService);
    serviceManager.registerService('tidal', tidalService);
  });

  after(async () => {
    // Clean up after tests
    await serviceManager.stopAll();
  });

  it('should register services', () => {
    expect(serviceManager.getService('state')).to.exist;
    expect(serviceManager.getService('weather')).to.exist;
    expect(serviceManager.getService('tidal')).to.exist;
  });

  it('should start and stop services', async () => {
    await serviceManager.startAll();
    
    // Verify services are running
    const status = serviceManager.getStatus();
    expect(status.state.isRunning).to.be.true;
    expect(status.weather.isRunning).to.be.true;
    expect(status.tidal.isRunning).to.be.true;

    // Stop services
    await serviceManager.stopAll();
    
    // Verify services are stopped
    const stoppedStatus = serviceManager.getStatus();
    expect(stoppedStatus.state.isRunning).to.be.false;
    expect(stoppedStatus.weather.isRunning).to.be.false;
    expect(stoppedStatus.tidal.isRunning).to.be.false;
  });

  it('should handle service errors', async () => {
    // This test verifies error handling without making actual API calls
    const errorService = {
      name: 'errorService',
      type: 'test',
      isRunning: false,
      async start() {
        this.isRunning = true;
        throw new Error('Test error');
      },
      async stop() {
        this.isRunning = false;
      },
      status() {
        return { isRunning: this.isRunning };
      },
      on() { /* Mock event emitter method */ },
      emit() { /* Mock event emitter method */ }
    };

    // Register and start the error service
    serviceManager.registerService('error', errorService);
    
    // The error should be caught and logged, but not crash the test
    await serviceManager.startService('error');
    
    // Verify the service is not running due to the error
    expect(serviceManager.getService('error').isRunning).to.be.false;
  });
});
