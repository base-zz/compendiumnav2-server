import ContinuousService from './ContinuousService.js';
import EventEmitter from 'events';
import { createStateDataModel } from '../shared/stateDataModel.js';
import { UNIT_PRESETS } from '../shared/unitPreferences.js';

/**
 * A demo implementation of NewStateService for development and testing.
 * This service uses the same state model as the production service but with mock data.
 */
class NewStateServiceDemo extends ContinuousService {
  constructor() {
    super('state-demo');
    
    // Initialize with the proper state model
    this.state = createStateDataModel(UNIT_PRESETS.IMPERIAL);
    this.eventEmitter = new EventEmitter();
    this.mockInterval = null;
    
    // Set some initial demo values
    this._initializeDemoState();
  }
  
  /**
   * Initialize the demo state with some default values
   */
  _initializeDemoState() {
    // Set initial position (San Francisco)
    this.state.navigation.position.latitude.value = 37.303640;
    this.state.navigation.position.longitude.value = -76.454768;
    this.state.navigation.position.timestamp = new Date().toISOString();
    this.state.navigation.position.source = 'demo';
    this.state.navigation.position.status = { value: 'valid', lastUpdated: new Date().toISOString() };
    
    // Set initial speed and course
    this.state.navigation.speed.sog.value = 0;
    this.state.navigation.course.cog.value = 0;
    this.state.navigation.course.heading.magnetic.value = 0;
    this.state.navigation.course.heading.true.value = 0;
    this.state.navigation.course.variation.value = 0;
    this.state.navigation.course.rateOfTurn.value = 0;
    
    // Set initial depth
    this.state.navigation.depth.belowTransducer.value = 10;
    this.state.navigation.depth.belowKeel.value = 8;
    this.state.navigation.depth.belowSurface.value = 12;
    
    // Set initial wind
    this.state.navigation.wind.apparent.speed.value = 8;
    this.state.navigation.wind.apparent.angle.value = 45;
    this.state.navigation.wind.apparent.direction.value = 45;
    this.state.navigation.wind.true.speed.value = 10;
    this.state.navigation.wind.true.direction.value = 50;
    
    // Initialize vessel info
    this.state.vessel.info.name = 'Demo Vessel';
    this.state.vessel.info.mmsi = '123456789';
    this.state.vessel.info.callsign = 'DEMO';
    this.state.vessel.info.type = 'sail';
    this.state.vessel.info.dimensions = {
      length: { value: 12, units: 'm' },
      beam: { value: 4, units: 'm' },
      draft: { value: 1.8, units: 'm' }
    };
    
    // Initialize environment data that services might need
    this.state.environment.weather.temperature.air.value = 75;
    this.state.environment.weather.temperature.water.value = 68;
    this.state.environment.weather.pressure.value = 30.1;
    this.state.environment.weather.humidity.value = 65;
    
    // Initialize marine data
    this.state.environment.marine.current = {
      seaLevelHeightMsl: { value: 0, units: 'ft', label: 'MSL', displayLabel: 'Mean Sea Level' },
      waveHeight: { value: 3.5, units: 'ft', label: 'Wave Ht' },
      waveDirection: { value: 180, units: 'deg', label: 'Wave Dir' },
      wavePeriod: { value: 8, units: 's', label: 'Wave Per' },
      windWaveHeight: { value: 3, units: 'ft', label: 'Wind Ht' },
      windWaveDirection: { value: 175, units: 'deg', label: 'Wind Dir' },
      windWavePeriod: { value: 7, units: 's', label: 'Wind Per' },
      windWavePeakPeriod: { value: 8, units: 's', label: 'Peak Per' },
      time: new Date().toISOString(),
      source: { value: 'demo', label: 'Source' }
    };
    
    // Initialize engine data
    this.state.vessel.systems.propulsion.engine1.rpm.value = 0;
    this.state.vessel.systems.propulsion.engine1.hours.value = 0;
    this.state.vessel.systems.propulsion.engine1.temperature.value = 0;
    this.state.vessel.systems.propulsion.engine1.oilPressure.value = 0;
    
    this.state.vessel.systems.propulsion.engine2.rpm.value = 0;
    this.state.vessel.systems.propulsion.engine2.hours.value = 0;
    this.state.vessel.systems.propulsion.engine2.temperature.value = 0;
    this.state.vessel.systems.propulsion.engine2.oilPressure.value = 0;
    
    // Initialize tanks with default values
    const tankTypes = [
      'freshWater1', 'freshWater2', 
      'wasteWater1', 'wasteWater2', 
      'blackWater1', 'blackWater2'
    ];
    
    tankTypes.forEach(tankId => {
      this.state.vessel.systems.tanks[tankId].value = 50; // 50% full by default
    });
    
    // Initialize fuel tanks
    const fuelTanks = ['fuel1', 'fuel2'];
    fuelTanks.forEach(tankId => {
      this.state.vessel.systems.propulsion[tankId].level.value = 50; // 50% full
      this.state.vessel.systems.propulsion[tankId].rate.value = 0; // 0 L/h when not running
      this.state.vessel.systems.propulsion[tankId].economy.value = 0.3; // 0.3 NM/L
    });
    
    // Initialize batteries
    const batteryIds = ['battery1', 'battery2', 'battery3', 'battery4'];
    batteryIds.forEach(id => {
      this.state.vessel.systems.electrical[id].voltage.value = 12.6;
      this.state.vessel.systems.electrical[id].current.value = 0;
      this.state.vessel.systems.electrical[id].capacity.value = 100;
    });
  }

  /**
   * Get the current state
   * @returns {Object} The current state object
   */
  getState() {
    return this.state;
  }

  /**
   * Update the state with new values
   * @param {Object} updates - The updates to apply to the state
   */
  updateState(updates) {
    // Simple deep merge for demo purposes
    this.state = this._deepMerge(this.state, updates);
  }

  /**
   * Deep merge utility function
   * @private
   */
  _deepMerge(target, source) {
    const output = { ...target };
    if (this._isObject(target) && this._isObject(source)) {
      Object.keys(source).forEach(key => {
        if (this._isObject(source[key])) {
          if (!(key in target)) {
            Object.assign(output, { [key]: source[key] });
          } else {
            output[key] = this._deepMerge(target[key], source[key]);
          }
        } else {
          Object.assign(output, { [key]: source[key] });
        }
      });
    }
    return output;
  }

  /**
   * Check if value is an object
   * @private
   */
  _isObject(item) {
    return item && typeof item === 'object' && !Array.isArray(item);
  }

  /**
   * Start the demo service
   * @override
   */
  async start() {
    await super.start();
    this.log('Demo state service started');
  }
  
  /**
   * Start mock data generation for multiple tanks and batteries
   * @param {number} interval - Update interval in milliseconds
   */
  startMockMultipleTanksAndBatteries(interval) {
    if (this.mockInterval) {
      clearInterval(this.mockInterval);
    }
    
    // Generate initial data
    this._generateMockTankAndBatteryData();
    
    // Set up periodic updates
    this.mockInterval = setInterval(() => {
      this._generateMockTankAndBatteryData();
      // Emit update event
      this.eventEmitter.emit('state:full-update', { data: this.state });
    }, interval);
  }
  
  /**
   * Generate mock data for tanks and batteries
   * @private
   */
  _generateMockTankAndBatteryData() {
    // Generate battery data for 4 batteries as per the state model
    const batteryIds = ['battery1', 'battery2', 'battery3', 'battery4'];
    
    batteryIds.forEach((id) => {
      // Update battery values with some random variation
      const baseVoltage = 12.5 + (Math.random() * 1.5); // 12.5-14V
      const current = -1 * (Math.random() * 5); // -5A to 0A
      const soc = 20 + Math.random() * 80; // 20-100%
      
      this.state.vessel.systems.electrical[id].voltage.value = baseVoltage;
      this.state.vessel.systems.electrical[id].current.value = current;
      this.state.vessel.systems.electrical[id].capacity.value = soc;
    });
    
    // Update water and waste tanks
    const tankTypes = [
      'freshWater1', 'freshWater2', 
      'wasteWater1', 'wasteWater2', 
      'blackWater1', 'blackWater2'
    ];
    
    tankTypes.forEach((tankId) => {
      const level = 10 + Math.random() * 90; // 10-100%
      this.state.vessel.systems.tanks[tankId].value = level;
    });
    
    // Update fuel tanks (in propulsion system)
    const fuelTanks = ['fuel1', 'fuel2'];
    fuelTanks.forEach((tankId) => {
      const level = 10 + Math.random() * 90; // 10-100%
      this.state.vessel.systems.propulsion[tankId].level.value = level;
      this.state.vessel.systems.propulsion[tankId].rate.value = 5 + Math.random() * 15; // 5-20 L/h
      this.state.vessel.systems.propulsion[tankId].economy.value = 0.2 + Math.random() * 0.5; // 0.2-0.7 NM/L
    });
    
    // Update some navigation values to simulate movement
    this.state.navigation.position.latitude.value += (Math.random() * 0.001) - 0.0005; // Small random movement
    this.state.navigation.position.longitude.value += (Math.random() * 0.001) - 0.0005;
    this.state.navigation.position.timestamp = new Date().toISOString();
    
    // Update speed and course slightly
    this.state.navigation.speed.sog.value = Math.max(0, this.state.navigation.speed.sog.value + (Math.random() * 0.5) - 0.25);
    this.state.navigation.course.cog.value = (this.state.navigation.course.cog.value + (Math.random() * 10) - 5) % 360;
    
    // Update wind values slightly
    this.state.navigation.wind.apparent.speed.value = Math.max(0, this.state.navigation.wind.apparent.speed.value + (Math.random() * 2) - 1);
    this.state.navigation.wind.apparent.angle.value = (this.state.navigation.wind.apparent.angle.value + (Math.random() * 10) - 5) % 360;
    
    // Emit update event with the updated state
    this.eventEmitter.emit('state:updated', { data: this.state });
    this.eventEmitter.emit('state:full-update', { data: this.state });
  }
  
  /**
   * Add event listener
   * @param {string} event - Event name
   * @param {Function} listener - Event listener function
   */
  on(event, listener) {
    this.eventEmitter.on(event, listener);
  }
  
  /**
   * Remove event listener
   * @param {string} event - Event name
   * @param {Function} listener - Event listener function
   */
  off(event, listener) {
    this.eventEmitter.off(event, listener);
  }

  /**
   * Stop the demo service
   * @override
   */
  async stop() {
    if (this.mockInterval) {
      clearInterval(this.mockInterval);
      this.mockInterval = null;
    }
    await super.stop();
    this.log('Demo state service stopped');
  }
}

// Create and export a singleton instance
const newStateServiceDemo = new NewStateServiceDemo();
export { newStateServiceDemo, NewStateServiceDemo };
