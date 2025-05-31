import ContinuousService from './ContinuousService.js';
import EventEmitter from 'events';

/**
 * A demo implementation of NewStateService for development and testing.
 * This service demonstrates the basic structure with mock data generation.
 */
class NewStateServiceDemo extends ContinuousService {
  constructor() {
    super('state-demo');
    this.state = {
      navigation: {
        position: {
          latitude: 0,
          longitude: 0
        },
        speedOverGround: 0,
        courseOverGroundTrue: 0
      },
      environment: {
        depth: {
          belowKeel: 0,
          belowSurface: 0
        },
        wind: {
          speedTrue: 0,
          directionTrue: 0
        }
      },
      electrical: {
        batteries: {}
      },
      tanks: {}
    };
    this.eventEmitter = new EventEmitter();
    this.mockInterval = null;
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
    // Generate battery data
    const batteryIds = ['battery-1', 'battery-2'];
    const batteries = {};
    
    batteryIds.forEach((id, index) => {
      const capacity = 100 + (index * 50); // 100Ah and 150Ah
      const soc = 20 + Math.random() * 80; // Random SOC between 20% and 100%
      const voltage = 12 + (Math.random() * 2); // 12-14V
      
      batteries[id] = {
        name: `Battery ${index + 1}`,
        capacity,
        stateOfCharge: soc,
        voltage,
        current: 0 - (Math.random() * 5), // -5A to 0A
        timeRemaining: (capacity * (soc / 100)) / 5 * 3600, // Approximate seconds remaining
        temperature: 20 + (Math.random() * 10) // 20-30°C
      };
    });
    
    // Generate tank data
    const tankIds = ['tank-1', 'tank-2'];
    const tanks = {};
    
    tankIds.forEach((id, index) => {
      const capacity = 200 + (index * 100); // 200L and 300L
      const level = 10 + Math.random() * 90; // 10-100%
      
      tanks[id] = {
        name: `Tank ${index + 1}`,
        type: index === 0 ? 'fuel' : 'water',
        capacity,
        level,
        volume: (capacity * level) / 100,
        remaining: (capacity * level) / 100
      };
    });
    
    // Update state
    this.state.electrical.batteries = batteries;
    this.state.tanks = tanks;
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
