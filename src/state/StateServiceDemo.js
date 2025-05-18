/**
 * StateServiceDemo
 * 
 * This is a demo implementation of StateService that replays recorded boat data
 * from SQLite database instead of generating fake data. It provides realistic
 * state updates using actual recorded data that can be used for development and testing.
 */

import EventEmitter from 'events';
import { stateData } from './StateData.js';
import { stateManager } from '../../relay/core/state/StateManager.js';
import sqlite3 from 'sqlite3';

export class StateServiceDemo extends EventEmitter {
  constructor() {
    super();
    this._debug = console.log.bind(console, '[StateServiceDemo]');
    this._db = new sqlite3.Database('./signalk_dev.db');
    this._currentIndex = 0;
    this._data = [];
    this._isPlaying = false;
    this._playInterval = null;
    this._mockMultipleDataInterval = null;
    
    // Pagination parameters for data loading
    this._batchSize = 1000; // Number of records to load at once
    this._currentBatch = 0; // Current batch number
    this._hasMoreData = true; // Flag to indicate if there's more data to load
    this._totalDataCount = 0; // Total number of records in the database
    
    // Initial values for persistent mock data
    this._mockTankLevels = {
      freshWater1: 100,
      freshWater2: 95,
      wasteWater1: 10,
      wasteWater2: 15,
      blackWater1: 20,
      blackWater2: 25
    };
    
    this._mockFuelLevels = {
      fuel1: 90,
      fuel2: 85
    };
    
    this._mockEngineHours = {
      engine1: 1200,
      engine2: 1100
    };
    
    this._mockBatteryLevels = {
      battery1: 95,
      battery2: 90,
      battery3: 85,
      battery4: 80
    };
    
    this._loadRecordedData();
  }
  
  // Method to generate mock data for multiple tanks and battery banks
  generateMockMultipleTanksAndBatteries() {
    // Update tank levels (decrease MUCH more slowly over time)
    // Reduced decrease rates by a factor of 10 for fresh water tanks
    this._mockTankLevels.freshWater1 = Math.max(0, this._mockTankLevels.freshWater1 - (0.02 + Math.random() * 0.03));
    this._mockTankLevels.freshWater2 = Math.max(0, this._mockTankLevels.freshWater2 - (0.01 + Math.random() * 0.02));
    
    // Waste and black water tanks increase over time (also more slowly)
    // Reduced increase rates by a factor of 5 for waste/black water tanks
    this._mockTankLevels.wasteWater1 = Math.min(100, this._mockTankLevels.wasteWater1 + (0.02 + Math.random() * 0.04));
    this._mockTankLevels.wasteWater2 = Math.min(100, this._mockTankLevels.wasteWater2 + (0.01 + Math.random() * 0.03));
    this._mockTankLevels.blackWater1 = Math.min(100, this._mockTankLevels.blackWater1 + (0.02 + Math.random() * 0.03));
    this._mockTankLevels.blackWater2 = Math.min(100, this._mockTankLevels.blackWater2 + (0.01 + Math.random() * 0.02));
    
    // Update fuel levels (decrease when engines are running)
    const engine1Running = Math.random() > 0.3; // 70% chance engine 1 is running
    const engine2Running = Math.random() > 0.5; // 50% chance engine 2 is running
    
    if (engine1Running) {
      this._mockFuelLevels.fuel1 = Math.max(0, this._mockFuelLevels.fuel1 - (0.1 + Math.random() * 0.2));
    }
    
    if (engine2Running) {
      this._mockFuelLevels.fuel2 = Math.max(0, this._mockFuelLevels.fuel2 - (0.05 + Math.random() * 0.15));
    }
    
    // Update engine hours (increase when running)
    if (engine1Running) {
      this._mockEngineHours.engine1 += 0.01 + (Math.random() * 0.005); // Small increments for hours
    }
    
    if (engine2Running) {
      this._mockEngineHours.engine2 += 0.01 + (Math.random() * 0.005);
    }
    
    // Update battery levels (discharge/charge based on usage)
    // House batteries (1 & 2) discharge more when engines are off
    if (!engine1Running && !engine2Running) {
      // Discharging
      this._mockBatteryLevels.battery1 = Math.max(20, this._mockBatteryLevels.battery1 - (0.2 + Math.random() * 0.3));
      this._mockBatteryLevels.battery2 = Math.max(30, this._mockBatteryLevels.battery2 - (0.1 + Math.random() * 0.2));
    } else {
      // Charging
      this._mockBatteryLevels.battery1 = Math.min(100, this._mockBatteryLevels.battery1 + (0.3 + Math.random() * 0.4));
      this._mockBatteryLevels.battery2 = Math.min(100, this._mockBatteryLevels.battery2 + (0.2 + Math.random() * 0.3));
    }
    
    // Engine start batteries (3 & 4) discharge slightly when engines are off
    if (!engine1Running) {
      this._mockBatteryLevels.battery3 = Math.max(50, this._mockBatteryLevels.battery3 - (0.05 + Math.random() * 0.1));
    } else {
      this._mockBatteryLevels.battery3 = Math.min(100, this._mockBatteryLevels.battery3 + (0.2 + Math.random() * 0.3));
    }
    
    if (!engine2Running) {
      this._mockBatteryLevels.battery4 = Math.max(50, this._mockBatteryLevels.battery4 - (0.05 + Math.random() * 0.1));
    } else {
      this._mockBatteryLevels.battery4 = Math.min(100, this._mockBatteryLevels.battery4 + (0.2 + Math.random() * 0.3));
    }
    
    // Create the mock data object with updated values
    const mockData = {
      vessel: {
        systems: {
          // Electrical system with 4 battery banks
          electrical: {
            battery1: {
              voltage: { 
                value: parseFloat((11.5 + (this._mockBatteryLevels.battery1 / 20)).toFixed(1)),
                units: "V"
              },
              current: { 
                value: parseFloat((engine1Running || engine2Running ? 5 + (Math.random() * 5) : -2 - (Math.random() * 3)).toFixed(1)),
                units: "A"
              },
              capacity: { 
                value: Math.round(this._mockBatteryLevels.battery1),
                units: "%",
                threshold: 20,  // Alert threshold value
                thresholdOperator: 'LESS_THAN'  // Alert when level is LESS THAN threshold
              }
            },
            battery2: {
              voltage: { 
                value: parseFloat((11.5 + (this._mockBatteryLevels.battery2 / 20)).toFixed(1)),
                units: "V"
              },
              current: { 
                value: parseFloat((engine1Running || engine2Running ? 3 + (Math.random() * 4) : -1 - (Math.random() * 2)).toFixed(1)),
                units: "A"
              },
              capacity: { 
                value: Math.round(this._mockBatteryLevels.battery2),
                units: "%",
                threshold: 20,  // Alert threshold value
                thresholdOperator: 'LESS_THAN'  // Alert when level is LESS THAN threshold
              }
            },
            battery3: {
              voltage: { 
                value: parseFloat((11.8 + (this._mockBatteryLevels.battery3 / 25)).toFixed(1)),
                units: "V"
              },
              current: { 
                value: parseFloat((engine1Running ? 2 + (Math.random() * 3) : -0.5 - (Math.random() * 0.5)).toFixed(1)),
                units: "A"
              },
              capacity: { 
                value: Math.round(this._mockBatteryLevels.battery3),
                units: "%",
                threshold: 20,  // Alert threshold value
                thresholdOperator: 'LESS_THAN'  // Alert when level is LESS THAN threshold
              }
            },
            battery4: {
              voltage: { 
                value: parseFloat((11.8 + (this._mockBatteryLevels.battery4 / 25)).toFixed(1)),
                units: "V"
              },
              current: { 
                value: parseFloat((engine2Running ? 2 + (Math.random() * 3) : -0.5 - (Math.random() * 0.5)).toFixed(1)),
                units: "A"
              },
              capacity: { 
                value: Math.round(this._mockBatteryLevels.battery4),
                units: "%",
                threshold: 20,  // Alert threshold value
                thresholdOperator: 'LESS_THAN'  // Alert when level is LESS THAN threshold
              }
            }
          },
          // Propulsion system with 2 engines and 2 fuel tanks
          propulsion: {
            engine1: {
              rpm: { 
                value: engine1Running ? Math.floor(700 + Math.random() * 2300) : 0,
                units: "rpm"
              },
              hours: { 
                value: parseFloat(this._mockEngineHours.engine1.toFixed(1)),
                units: "hours"
              },
              temperature: { 
                value: parseFloat((engine1Running ? 170 + (Math.random() * 20) : 70 + (Math.random() * 10)).toFixed(1)),
                units: "°F"
              },
              oilPressure: { 
                value: parseFloat((engine1Running ? 40 + (Math.random() * 20) : 0).toFixed(1)),
                units: "psi"
              }
            },
            engine2: {
              rpm: { 
                value: engine2Running ? Math.floor(700 + Math.random() * 2300) : 0,
                units: "rpm"
              },
              hours: { 
                value: parseFloat(this._mockEngineHours.engine2.toFixed(1)),
                units: "hours"
              },
              temperature: { 
                value: parseFloat((engine2Running ? 175 + (Math.random() * 15) : 70 + (Math.random() * 10)).toFixed(1)),
                units: "°F"
              },
              oilPressure: { 
                value: parseFloat((engine2Running ? 45 + (Math.random() * 15) : 0).toFixed(1)),
                units: "psi"
              }
            },
            fuel1: {
              level: { 
                value: Math.round(this._mockFuelLevels.fuel1),
                units: "%"
              },
              rate: { 
                value: parseFloat((engine1Running ? 1.5 + (Math.random() * 2.5) : 0).toFixed(1)),
                units: "gal/h"
              },
              economy: { 
                value: parseFloat((engine1Running ? 0.8 + (Math.random() * 1.2) : 0).toFixed(1)),
                units: "nm/gal"
              }
            },
            fuel2: {
              level: { 
                value: Math.round(this._mockFuelLevels.fuel2),
                units: "%"
              },
              rate: { 
                value: parseFloat((engine2Running ? 1.2 + (Math.random() * 2.0) : 0).toFixed(1)),
                units: "gal/h"
              },
              economy: { 
                value: parseFloat((engine2Running ? 1.0 + (Math.random() * 1.0) : 0).toFixed(1)),
                units: "nm/gal"
              }
            }
          },
          // Multiple water tanks
          tanks: {
            freshWater1: { 
              value: Math.round(this._mockTankLevels.freshWater1),
              units: "%",
              label: "Water 1", 
              displayLabel: "Fresh Water 1", 
              description: "Fresh Water 1 Level",
              fluidType: "water",
              threshold: 20,  // Alert threshold value
              thresholdOperator: 'LESS_THAN'  // Alert when level is LESS THAN threshold
            },
            freshWater2: { 
              value: Math.round(this._mockTankLevels.freshWater2),
              units: "%",
              label: "Water 2", 
              displayLabel: "Fresh Water 2", 
              description: "Fresh Water 2 Level",
              fluidType: "water",
              threshold: 20,  // Alert threshold value
              thresholdOperator: 'LESS_THAN'  // Alert when level is LESS THAN threshold
            },
            wasteWater1: { 
              value: Math.round(this._mockTankLevels.wasteWater1),
              units: "%",
              label: "Waste 1", 
              displayLabel: "Waste Water 1", 
              description: "Waste Water 1 Level",
              fluidType: "waste",
              threshold: 80,  // Alert threshold value
              thresholdOperator: 'GREATER_THAN'  // Alert when level is GREATER THAN threshold
            },
            wasteWater2: { 
              value: Math.round(this._mockTankLevels.wasteWater2),
              units: "%",
              label: "Waste 2", 
              displayLabel: "Waste Water 2", 
              description: "Waste Water 2 Level",
              fluidType: "waste",
              threshold: 80,  // Alert threshold value
              thresholdOperator: 'GREATER_THAN'  // Alert when level is GREATER THAN threshold
            },
            blackWater1: { 
              value: Math.round(this._mockTankLevels.blackWater1),
              units: "%",
              label: "Black 1", 
              displayLabel: "Black Water 1", 
              description: "Black Water 1 Level",
              fluidType: "black",
              threshold: 80,  // Alert threshold value
              thresholdOperator: 'GREATER_THAN'  // Alert when level is GREATER THAN threshold
            },
            blackWater2: { 
              value: Math.round(this._mockTankLevels.blackWater2),
              units: "%",
              label: "Black 2", 
              displayLabel: "Black Water 2", 
              description: "Black Water 2 Level",
              fluidType: "black",
              threshold: 80,  // Alert threshold value
              thresholdOperator: 'GREATER_THAN'  // Alert when level is GREATER THAN threshold
            }
          }
        }
      }
    };
     
    // Create a complete update object with all our data
    // We'll use a single batchUpdate call to ensure atomic updates
    const completeUpdate = {
      vessel: {
        systems: {
          tanks: {},
          electrical: {}
        }
      }
    };

    // Add all tank data to the update object
    const mockTanks = mockData.vessel.systems.tanks;
    for (const tankKey in mockTanks) {
      completeUpdate.vessel.systems.tanks[tankKey] = mockTanks[tankKey];
      // console.log(`   Adding tank ${tankKey} to update:`, JSON.stringify(mockTanks[tankKey], null, 2));
    }

    // Add all electrical/battery data to the update object
    const mockElectrical = mockData.vessel.systems.electrical;
    for (const batteryKey in mockElectrical) {
      completeUpdate.vessel.systems.electrical[batteryKey] = mockElectrical[batteryKey];
      // console.log(`   Adding battery ${batteryKey} to update:`, JSON.stringify(mockElectrical[batteryKey], null, 2));
    }

    // Add the rest of the mock data (excluding tanks and electrical which we've already handled)
    const mockDataWithoutSpecial = JSON.parse(JSON.stringify(mockData));
    delete mockDataWithoutSpecial.vessel.systems.tanks;
    delete mockDataWithoutSpecial.vessel.systems.electrical;
    
    // Merge the mockDataWithoutSpecial into our completeUpdate
    Object.assign(completeUpdate, mockDataWithoutSpecial);
    
    // First, ensure the state structure exists
    if (!stateData.vessel) stateData.vessel = {};
    if (!stateData.vessel.systems) stateData.vessel.systems = {};
    if (!stateData.vessel.systems.tanks) stateData.vessel.systems.tanks = {};
    if (!stateData.vessel.systems.electrical) stateData.vessel.systems.electrical = {};
    
    // Create a deep clone of the mock data to avoid reference issues
    const mockDataClone = JSON.parse(JSON.stringify(mockData));
    
    // Update tanks in stateData first
    for (const tankKey in mockDataClone.vessel.systems.tanks) {
      if (!stateData.vessel.systems.tanks[tankKey]) {
        stateData.vessel.systems.tanks[tankKey] = {};
      }
      Object.assign(stateData.vessel.systems.tanks[tankKey], mockDataClone.vessel.systems.tanks[tankKey]);
    }
    
    // Update electrical/battery data in stateData
    for (const batteryKey in mockDataClone.vessel.systems.electrical) {
      if (batteryKey.startsWith('battery')) {
        if (!stateData.vessel.systems.electrical[batteryKey]) {
          stateData.vessel.systems.electrical[batteryKey] = {
            voltage: { value: 0, units: 'V' },
            current: { value: 0, units: 'A' },
            capacity: { value: 0, units: '%' }
          };
        }
        Object.assign(stateData.vessel.systems.electrical[batteryKey], mockDataClone.vessel.systems.electrical[batteryKey]);
      }
    }
    
    // Now update the state manager with the complete state
    stateManager.applyPatchAndForward({
      vessel: {
        systems: {
          tanks: stateData.vessel.systems.tanks,
          electrical: stateData.vessel.systems.electrical
        }
      }
    });
    
    // Emit the state update
    this.emit('state:patch', { 
      data: {
        vessel: {
          systems: {
            tanks: stateData.vessel.systems.tanks,
            electrical: stateData.vessel.systems.electrical
          }
        }
      } 
    });
    
    // // Verification - use a longer timeout to ensure data is updated first
    // setTimeout(() => {
    //   // Get the current state using getState() to ensure we're looking at the actual state
    //   const currentState = this.getState();
      
    //   // Verify tanks
    //   const stateTanks = currentState.vessel?.systems?.tanks;
      
    //   if (stateTanks) {
        
    //     // Check each tank to see if it was properly updated
    //     for (const tankKey in mockTanks) {
    //       const stateTank = stateTanks[tankKey];
          
    //       if (stateTank) {
    //         // Check if any old structure keys exist
    //         const oldKeys = ['freshWater', 'wasteWater', 'blackWater'].filter(key => key in stateTank);
    //         if (oldKeys.length > 0) {
    //           console.log(`   WARNING: Tank ${tankKey} still has old structure keys:`, oldKeys);
    //         }
    //       } else {
    //         console.log(`   ERROR: Tank ${tankKey} was NOT properly updated!`);
    //       }
    //     }
    //   } else {
    //     console.log('   ERROR: State tanks structure is undefined after update!');
    //   }
      
    //   // Verify electrical system
    //   const stateElectrical = currentState.vessel?.systems?.electrical;
      
    //   if (stateElectrical) {
        
    //     // Check each battery to see if it was properly updated
    //     for (const batteryKey in mockElectrical) {
    //       if (batteryKey.startsWith('battery')) {
    //         const stateBattery = stateElectrical[batteryKey];
            
    //         if (stateBattery) {
    //           console.log(`   Battery ${batteryKey} was properly updated:`);
    //         } else {
    //           console.log(`   ERROR: Battery ${batteryKey} was NOT properly updated!`);
    //         }
    //       }
    //     }
    //   } else {
    //     console.log('   ERROR: State electrical structure is undefined after update!');
    //   }
      
    //   // Final verification of overall state structure
    // }, 500); // Increased timeout to ensure state is fully updated


  }

  // Start periodic updates of tank and battery data
  startMockMultipleTanksAndBatteries(intervalMs = 5000) {
    // Clear any existing interval
    if (this._mockMultipleDataInterval) {
      clearInterval(this._mockMultipleDataInterval);
    }
    
    // Set up periodic updates
    this._mockMultipleDataInterval = setInterval(() => {
      this.generateMockMultipleTanksAndBatteries();
    }, intervalMs);
    
    // Generate initial data
    this.generateMockMultipleTanksAndBatteries();
    
    this._debug('Started mock data for multiple tanks and batteries');
  }

  // Stop periodic updates
  stopMockMultipleTanksAndBatteries() {
    if (this._mockMultipleDataInterval) {
      clearInterval(this._mockMultipleDataInterval);
      this._mockMultipleDataInterval = null;
      this._debug('Stopped mock data for multiple tanks and batteries');
    }
  }

  async _loadRecordedData() {
    try {
      // Reset pagination parameters if this is a fresh load
      if (this._currentBatch === 0) {
        // Get total counts first to know how much data we have
        const patchesCount = await new Promise((resolve, reject) => {
          this._db.get('SELECT COUNT(*) as count FROM sk_patches', (err, row) => {
            if (err) reject(err);
            else resolve(row.count);
          });
        });
        
        const fullStatesCount = await new Promise((resolve, reject) => {
          this._db.get('SELECT COUNT(*) as count FROM full_state', (err, row) => {
            if (err) reject(err);
            else resolve(row.count);
          });
        });
        
        this._totalDataCount = patchesCount + fullStatesCount;
        this._debug(`Total records in database: ${this._totalDataCount}`);
      }
      
      // Calculate offsets for the current batch
      const patchOffset = (this._currentBatch * this._batchSize) / 2;
      const stateOffset = (this._currentBatch * this._batchSize) / 2;
      
      // Load a batch of patches from database
      const patches = await new Promise((resolve, reject) => {
        this._db.all(
          'SELECT * FROM sk_patches ORDER BY timestamp ASC LIMIT ? OFFSET ?', 
          [this._batchSize / 2, patchOffset],
          (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
          }
        );
      });

      // Load a batch of full states from database
      const fullStates = await new Promise((resolve, reject) => {
        this._db.all(
          'SELECT * FROM full_state ORDER BY timestamp ASC LIMIT ? OFFSET ?', 
          [this._batchSize / 2, stateOffset],
          (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
          }
        );
      });
      
      // Check if we have more data to load
      this._hasMoreData = patches.length === this._batchSize / 2 || fullStates.length === this._batchSize / 2;

      // Process the data
      const newData = [...patches, ...fullStates]
        .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
        .map(row => ({
          type: row.patch_json ? 'patch' : 'full_state',
          data: row.patch_json ? JSON.parse(row.patch_json) : JSON.parse(row.data),
          timestamp: row.timestamp,
          originalTimestamp: new Date(row.timestamp).getTime() // Store original timestamp as milliseconds
        }));
      
      // If this is the first batch, set the data directly
      // Otherwise, append to existing data
      if (this._currentBatch === 0) {
        this._data = newData;
      } else {
        this._data = [...this._data, ...newData];
      }

      this._debug(`Loaded batch ${this._currentBatch + 1}: ${newData.length} records. Total in memory: ${this._data.length}`);
      this._currentBatch++;
      
      // Initialize with the first full state if this is the first batch
      if (this._currentBatch === 1) {
        const firstFullState = this._data.find(d => d.type === 'full_state');
        if (firstFullState) {
          stateData.batchUpdate(firstFullState.data);
          
          // Clean up the state structure to ensure it matches the current model
          if (stateData.vessel?.systems) {
            try {
              // Remove old tank structure keys if they exist
              if (stateData.vessel.systems.tanks) {
                if (stateData.vessel.systems.tanks.freshWater) delete stateData.vessel.systems.tanks.freshWater;
                if (stateData.vessel.systems.tanks.wasteWater) delete stateData.vessel.systems.tanks.wasteWater;
                if (stateData.vessel.systems.tanks.blackWater) delete stateData.vessel.systems.tanks.blackWater;
                this._debug('Successfully removed old tank structure keys from loaded state');
              }
              
              // Remove old batteries structure if it exists
              if (stateData.vessel.systems.electrical?.batteries) {
                delete stateData.vessel.systems.electrical.batteries;
                this._debug('Successfully removed old batteries structure from loaded state');
              }
              
              // Ensure the electrical structure exists for our new battery objects
              if (!stateData.vessel.systems.electrical) {
                stateData.vessel.systems.electrical = {};
              }
              
            } catch (error) {
              this._debug('Error cleaning up old structure keys from loaded state:', error.message);
            }
          }
        }
      }
    } catch (error) {
      this._debug('Error loading recorded data:', error);
    }
  }

  async _playNext() {
    // Check if we're near the end of the current batch and need to load more data
    // Load the next batch when we're 90% through the current batch
    if (this._hasMoreData && this._currentIndex >= this._data.length * 0.9) {
      await this._loadRecordedData();
    }
    
    // If we've reached the end of all data, loop back to the beginning
    if (this._currentIndex >= this._data.length) {
      this._debug('Reached end of data, looping back to beginning');
      this._currentIndex = 0;
      this._currentBatch = 0; // Reset batch counter to reload from the beginning
      this._startTime = Date.now(); // Reset start time when looping
      
      // Clear old data to free up memory before loading the first batch again
      this._data = [];
      await this._loadRecordedData();
    }

    const dataPoint = this._data[this._currentIndex];
    this._currentIndex++;

    // IMPORTANT: Save the current tanks structure before applying updates
    // This ensures we don't lose our mock tank data during playback
    const currentTanks = JSON.parse(JSON.stringify(stateData.vessel?.systems?.tanks || {}));
    
    // Log the current state of tanks before update
    // this._debug('Tank structure before playback update:', JSON.stringify(currentTanks, null, 2));

    // Update stateData directly for consistency
    stateData.batchUpdate(dataPoint.data);
    
    // Ensure the vessel systems structure exists
    if (!stateData.vessel) stateData.vessel = {};
    if (!stateData.vessel.systems) stateData.vessel.systems = {};
    
    // Restore the tanks structure
    stateData.vessel.systems.tanks = currentTanks;
    
    // Ensure the electrical structure has individual batteries
    if (!stateData.vessel.systems.electrical) {
      stateData.vessel.systems.electrical = {};
    }
    
    // Add or update individual battery objects if they don't exist
    const batteryData = {
      battery1: { voltage: { value: 12.5, units: 'V' }, current: { value: 5.2, units: 'A' }, capacity: { value: 95, units: '%' } },
      battery2: { voltage: { value: 12.3, units: 'V' }, current: { value: 4.8, units: 'A' }, capacity: { value: 90, units: '%' } },
      battery3: { voltage: { value: 12.4, units: 'V' }, current: { value: 5.0, units: 'A' }, capacity: { value: 85, units: '%' } },
      battery4: { voltage: { value: 12.2, units: 'V' }, current: { value: 4.5, units: 'A' }, capacity: { value: 80, units: '%' } }
    };
    
    // Update or add individual battery objects
    for (const [batteryId, battery] of Object.entries(batteryData)) {
      if (!stateData.vessel.systems.electrical[batteryId]) {
        stateData.vessel.systems.electrical[batteryId] = {};
      }
      Object.assign(stateData.vessel.systems.electrical[batteryId], battery);
    }
    
    // Remove the batteries object if it exists
    if (stateData.vessel.systems.electrical.batteries) {
      delete stateData.vessel.systems.electrical.batteries;
    }
    
    // Remove old tank structure keys if they exist
    try {
      if (stateData.vessel.systems.tanks.freshWater) delete stateData.vessel.systems.tanks.freshWater;
      if (stateData.vessel.systems.tanks.wasteWater) delete stateData.vessel.systems.tanks.wasteWater;
      if (stateData.vessel.systems.tanks.blackWater) delete stateData.vessel.systems.tanks.blackWater;
    } catch (error) {
      this._debug('Error removing old tank structure keys during playback:', error.message);
    }
    
    // Log the tank structure after update
    // this._debug('Tank structure after playback update:', JSON.stringify(stateData.vessel?.systems?.tanks, null, 2));
    
    // For patches, we need to be more careful to preserve the patch structure
    if (dataPoint.type === 'patch') {
      // For patches, we only want to emit the specific changes in the patch
      // but we need to make sure our tank modifications are included if the patch affects tanks
      const patchData = JSON.parse(JSON.stringify(dataPoint.data));
      
      // If the patch includes tank data, make sure it has our updated tank structure
      if (patchData.vessel?.systems?.tanks) {
        patchData.vessel.systems.tanks = JSON.parse(JSON.stringify(stateData.vessel.systems.tanks));
      }
      
      this.emit('state:patch', { data: patchData });
    } else {
      // Create a clean copy of the state with the correct structure
      const fullStateData = {
        navigation: JSON.parse(JSON.stringify(stateData.navigation || {})),
        environment: JSON.parse(JSON.stringify(stateData.environment || {})),
        vessel: {
          ...JSON.parse(JSON.stringify(stateData.vessel || {})),
          systems: {
            ...(stateData.vessel?.systems || {}),
            // Ensure tanks structure is preserved
            tanks: JSON.parse(JSON.stringify(stateData.vessel?.systems?.tanks || {})),
            // Create electrical structure with individual batteries
            electrical: (() => {
              const electrical = {};
              
              // Add individual battery objects
              for (const [key, value] of Object.entries(stateData.vessel?.systems?.electrical || {})) {
                if (key.startsWith('battery') && typeof value === 'object') {
                  electrical[key] = { ...value };
                }
              }
              
              // If no batteries found, create default ones
              if (Object.keys(electrical).length === 0) {
                electrical.battery1 = { voltage: { value: 12.5, units: 'V' }, current: { value: 5.2, units: 'A' }, capacity: { value: 95, units: '%' } };
                electrical.battery2 = { voltage: { value: 12.3, units: 'V' }, current: { value: 4.8, units: 'A' }, capacity: { value: 90, units: '%' } };
                electrical.battery3 = { voltage: { value: 12.4, units: 'V' }, current: { value: 5.0, units: 'A' }, capacity: { value: 85, units: '%' } };
                electrical.battery4 = { voltage: { value: 12.2, units: 'V' }, current: { value: 4.5, units: 'A' }, capacity: { value: 80, units: '%' } };
              }
              
              return electrical;
            })()
          }
        },
        anchor: JSON.parse(JSON.stringify(stateData.anchor || {})),
        aisTargets: JSON.parse(JSON.stringify(stateData.aisTargets || {})),
        alerts: JSON.parse(JSON.stringify(stateData.alerts || {}))
      };
      
      this.emit('state:full-update', { data: fullStateData });
    }
    
    // Also emit full state through the state manager
    stateManager.emitFullState();

    // Calculate when the next item should be played
    // We need to handle the case where we're at the end of the current data
    let nextIndex = this._currentIndex;
    if (nextIndex >= this._data.length) {
      nextIndex = 0; // Loop back to beginning if we're at the end
    }
    
    const nextDataPoint = this._data[nextIndex];
    const timeDiff = nextDataPoint.originalTimestamp - dataPoint.originalTimestamp;
    
    // Schedule the next playback
    this._playInterval = setTimeout(() => {
      this._playNext();
    }, timeDiff / this._playbackSpeedMultiplier);
  }

  async startPlayback(playbackSpeed = 1.0) {
    if (this._isPlaying) return;
    
    this._isPlaying = true;
    this._playbackSpeedMultiplier = playbackSpeed;
    this._startTime = Date.now();
    this._currentIndex = 0;
    
    // Start the mock tank data generation to ensure we have consistent tank data during playback
    // Use a faster update interval during playback to ensure tank data is current
    this.startMockMultipleTanksAndBatteries(10000);
    
    // Generate initial mock data immediately to ensure tanks are set up before first playback
    this.generateMockMultipleTanksAndBatteries();
    
    // Start with the first data point
    await this._playNext();
    
    this._debug(`Started playback of recorded data at ${playbackSpeed}x speed with mock tank data enabled`);
  }

  // Add new method to control playback speed
  setPlaybackSpeed(speed) {
    if (!this._isPlaying) return;
    
    this._playbackSpeedMultiplier = speed;
    // Reset current interval to apply new speed
    if (this._playInterval) {
      clearTimeout(this._playInterval);
      this._playNext();
    }
    
    this._debug(`Playback speed changed to ${speed}x`);
  }

  stopPlayback() {
    if (!this._isPlaying) return;
    
    this._isPlaying = false;
    if (this._playInterval) {
      clearInterval(this._playInterval);
      this._playInterval = null;
    }
    
    // Stop the mock tank data generation when playback stops
    this.stopMockMultipleTanksAndBatteries();
    
    this._debug('Stopped playback of recorded data and mock tank data generation');
  }

  // Add methods that match the real StateService interface
  async initialize() {
    this._debug('Initializing demo state service with recorded data');
    await this._loadRecordedData();
    this.startPlayback();
    return this;
  }

  async connect() {
    this._debug('Connecting demo state service');
    return true;
  }

  disconnect() {
    this._debug('Disconnecting demo state service');
    this.stopPlayback();
    return true;
  }

  getState() {
    return stateData.state;
  }

  addListener(event, listener) {
    return this.on(event, listener);
  }

  removeListener(event, listener) {
    return this.off(event, listener);
  }
}

// Create singleton instance
export const stateServiceDemo = new StateServiceDemo();
