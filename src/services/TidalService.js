import ScheduledService from "./ScheduledService.js";
import { fetchWeatherApi } from "openmeteo";
import { UNIT_PRESETS } from '../shared/unitPreferences.js';

export class TidalService extends ScheduledService {
  /** @type {Object} */
  stateService;
  
  /** @type {string} */
  baseUrl;
  
  /** @type {{latitude: number, longitude: number}} */
  position;
  
  /** @type {NodeJS.Timeout|null} */
  _updateTimeout;
  
  /** @type {Promise|null} */
  _currentFetch;
  constructor(stateService) {
    super("tidal", {
      interval: 7200000, // 2 hours
      immediate: true,
      runOnInit: true
    });
    
    if (!stateService || typeof stateService.getState !== 'function') {
      throw new Error('stateService must be provided and implement getState()');
    }
    
    this.stateService = stateService;
    this.baseUrl = "https://marine-api.open-meteo.com/v1/marine";
    this._isRunning = false;
    this._currentFetch = null;
    this._updateTimeout = null;
    this._positionAvailable = false;

    // Set up a default position (can be overridden by setPosition)
    this.position = {
      latitude: null,  // Will be set from real data only
      longitude: null,
    };
    
    // Bind methods
    this._onPositionAvailable = this._onPositionAvailable.bind(this);
    
    // Listen for position available events if the state service supports events
    if (this.stateService && typeof this.stateService.on === 'function') {
      this.log('Setting up position:available event listener');
      this.stateService.on('position:available', this._onPositionAvailable);
    } else {
      this.log('State service does not support events, will use polling');
    }
    
    // Add explicit initialization log
    // this.log("Initialized with state service:", {
    //   hasStateService: !!this.stateService,
    //   stateServiceType: this.stateService ? this.stateService.constructor.name : 'unknown',
    //   isReady: this.stateService && this.stateService.isReady
    // });
  }

  /**
   * Get the current unit preferences from state or use defaults
   * @private
   */
  async _getUnitPreferences() {
    try {
      // Try to get preferences from state
      const state = this.stateService?.getState();
      if (state?.preferences?.units) {
        return state.preferences.units;
      }
      // Fall back to imperial defaults if no preferences found
      return UNIT_PRESETS.IMPERIAL;
    } catch (error) {
      this.log('Could not get unit preferences, using defaults:', error.message);
      return UNIT_PRESETS.IMPERIAL;
    }
  }

  /**
   * Wait for state service to be ready
   * @private
   * @param {number} timeout - Timeout in ms
   */
  async _waitForStateServiceReady(timeout = 10000) {
    if (this.stateService.isReady) return;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timeout waiting for state service to be ready")), timeout);
      this.stateService.once && this.stateService.once("ready", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /**
   * Wait for position data to become available
   * @private
   * @param {number} timeout - Timeout in milliseconds
   * @returns {Promise<{latitude: number, longitude: number}>}
   */
  async _waitForPosition(timeout = 300000) { // 5 minutes timeout
    // First check if we already have position from an event
    if (this._positionAvailable && this.position?.latitude != null && this.position?.longitude != null) {
      this.log(`Using position from event: ${this.position.latitude}, ${this.position.longitude}`);
      return { 
        latitude: this.position.latitude, 
        longitude: this.position.longitude 
      };
    }
    
    const startTime = Date.now();
    let lastLogTime = 0;
    const logInterval = 5000; // Log every 5 seconds
    let attemptCount = 0;
    
    this.log("Starting to wait for position data with timeout of", timeout, "ms");
    
    while (Date.now() - startTime < timeout) {
      attemptCount++;
      try {
        // Get the current state - stateData is returned directly from NewStateServiceDemo.getState()
        const stateData = this.stateService.getState();
        
        // Add memory address/reference logging to help debug instance sharing
        const stateRef = `${stateData}`;
        
        // this.log(`Got state data (attempt ${attemptCount}):`, {
        //   hasStateData: !!stateData,
        //   stateDataType: typeof stateData,
        //   stateRef: stateRef,
        //   hasNavigation: !!stateData.navigation,
        //   hasPosition: !!stateData.navigation?.position
        // });

        // Check if we have valid position data
        const position = stateData.navigation?.position;
        if (position?.latitude?.value != null && position?.longitude?.value != null) {
          const lat = Number(position.latitude.value);
          const lon = Number(position.longitude.value);
          
          this.log(`Found position values: lat=${lat}, lon=${lon}, validating...`);
          
          // Validate the position values
          if (!isNaN(lat) && !isNaN(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) {
            this.log(`Got valid position: ${lat}, ${lon}`);
            return { latitude: lat, longitude: lon };
          } else {
            this.log(`Invalid position values: lat=${lat}, lon=${lon}`);
          }
        } else {
          if (Date.now() - lastLogTime >= logInterval) {
            this.log("Position data not found or incomplete:", {
              hasPosition: !!position,
              hasLatitude: !!position?.latitude,
              hasLongitude: !!position?.longitude,
              latValue: position?.latitude?.value,
              lonValue: position?.longitude?.value,
              positionKeys: position ? Object.keys(position) : null,
              latitudeKeys: position?.latitude ? Object.keys(position.latitude) : null,
              longitudeKeys: position?.longitude ? Object.keys(position.longitude) : null
            });
            lastLogTime = Date.now();
          }
        }
        
        // Log every 5 seconds
        const now = Date.now();
        if (now - lastLogTime >= logInterval) {
          this.log(`Waiting for valid position data... (${Math.round((now - startTime) / 1000)}s elapsed)`);
          this.log('Current position state:', JSON.stringify({
            hasPosition: !!position,
            latitude: position?.latitude,
            longitude: position?.longitude
          }, null, 2));
          lastLogTime = now;
        }
        
        // Wait for a bit before checking again
        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (error) {
        this.logError('Error checking position:', error.message);
        // Continue waiting even if there's an error checking position
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    const errorMsg = `Timed out waiting for position data after ${timeout}ms`;
    this.logError(`${errorMsg}`);
    throw new Error(errorMsg);
  }

  /**
   * Check if valid position data is available in the state
   * @returns {boolean} True if valid position data is available
   */
  /**
   * Handler for position:available events from state service
   * @param {Object} positionData - The position data object
   * @private
   */
  _onPositionAvailable(positionData) {
    this.log('Received position:available event:', positionData);
    
    if (!positionData || typeof positionData.latitude !== 'number' || typeof positionData.longitude !== 'number') {
      this.logError('Invalid position data received in event');
      return;
    }
    
    // Update our position with the received data
    this.position = {
      latitude: positionData.latitude,
      longitude: positionData.longitude
    };
    
    this._positionAvailable = true;
    this.log(`Position updated from event: lat=${positionData.latitude}, lon=${positionData.longitude}`);
    
    // If we're not currently fetching data, trigger a fetch now that we have position
    if (!this._currentFetch) {
      this.log('Position available, triggering tidal data fetch');
      // Use setTimeout to avoid immediate execution and allow other operations to complete
      setTimeout(() => this.run(), 1000);
    }
  }
  
  _hasValidPositionData() {
    try {
      const stateData = this.stateService.getState();
      if (!stateData || !stateData.navigation || !stateData.navigation.position) {
        return false;
      }
      
      const position = stateData.navigation.position;
      if (!position.latitude || !position.longitude || 
          position.latitude.value === null || position.longitude.value === null) {
        return false;
      }
      
      const lat = Number(position.latitude.value);
      const lon = Number(position.longitude.value);
      
      return !isNaN(lat) && !isNaN(lon) && 
             lat >= -90 && lat <= 90 && 
             lon >= -180 && lon <= 180;
    } catch (error) {
      this.logError('Error checking position data:', error.message);
      return false;
    }
  }
  
  async run() {
    // Add explicit run method log
    this.log("Run method called at", new Date().toISOString());
    
    if (this._currentFetch) {
      this.log('Update already in progress, returning existing promise');
      return this._currentFetch;
    }
    
    this.log("Starting tidal data fetch...");
    
    // Check if position data is already available
    const hasPosition = this._hasValidPositionData();
    this.log(`Position data check: ${hasPosition ? 'AVAILABLE' : 'NOT AVAILABLE'}`);
    
    // Log the state service instance and state data for debugging
    const stateData = this.stateService.getState();
    // this.log("State service instance check:", {
    //   stateServiceType: this.stateService.constructor.name,
    //   stateDataExists: !!stateData,
    //   hasNavigation: !!stateData?.navigation,
    //   hasPosition: !!stateData?.navigation?.position,
    //   stateRef: `${stateData}`
    // });
    
    try {
      // Wait for state service to be ready before proceeding
      // await this._waitForStateServiceReady();
      // Create a promise that resolves when the current fetch completes
      this._currentFetch = (async () => {
        try {
          // Check if state service is available and has getState method
          if (!this.stateService || typeof this.stateService.getState !== 'function') {
            throw new Error('State service is not properly initialized');
          }
          
          // If the state service has an initialization method, call it
          if (typeof this.stateService.initialize === 'function') {
            this.log("Initializing state service...");
            try {
              await this.stateService.initialize();
              this.log("State service is now ready");
            } catch (error) {
              this.logError("Error initializing state service:", error.message);
              throw error;
            }
          }

          // Wait for position data with retry logic
          this.log("Waiting for position data...");
          const position = await this._waitForPosition(60000); // 60 second timeout for position
          this.log(`Got position: ${position.latitude}, ${position.longitude}`);
          
          if (!position?.latitude || !position?.longitude) {
            throw new Error('Invalid position data received');
          }

      // Get user's unit preferences
      const unitPrefs = await this._getUnitPreferences();
      const isMetric = unitPrefs?.length === 'm'; // Check if using metric for length

      const params = {
        latitude: position.latitude,
        longitude: position.longitude,
        // Daily forecast
        daily: [
          'wave_height_max',
          'wave_direction_dominant',
          'wave_period_max',
          'wind_wave_height_max',
          'wind_wave_direction_dominant',
          'swell_wave_height_max',
          'swell_wave_direction_dominant'
        ],
        // Hourly forecast
        hourly: [
          'wave_height',
          'wave_direction',
          'wave_period',
          'wind_wave_peak_period',
          'wind_wave_height',
          'wind_wave_direction',
          'wind_wave_period',
          'swell_wave_height',
          'swell_wave_direction',
          'swell_wave_period',
          'swell_wave_peak_period',
          'sea_level_height_msl',
          'sea_surface_temperature',
          'ocean_current_velocity',
          'ocean_current_direction'
        ],
        // Current conditions
        current: [
          'wave_height',
          'wave_direction',
          'wave_period',
          'sea_level_height_msl',
          'sea_surface_temperature',
          'ocean_current_velocity',
          'ocean_current_direction'
        ],
        // Set units based on preferences
        temperature_unit: unitPrefs?.temperature === '°C' ? 'celsius' : 'fahrenheit',
        wind_speed_unit: 'kn', // Always use knots for marine applications
        wave_height_unit: isMetric ? 'm' : 'ft',
        current_velocity_unit: isMetric ? 'kmh' : 'mph',
        timezone: 'auto',
        timeformat: 'iso8601'
      };

      // Make the API request using openmeteo's fetchWeatherApi
      const responses = await fetchWeatherApi(this.baseUrl, params);

      // Process first location
      const response = responses[0];

      if (!response) {
        throw new Error("No response data received from the API");
      }

      this.log(`Raw marine data received`);

      // Get metadata from response
      const utcOffsetSeconds = response.utcOffsetSeconds();
      const timezone = response.timezone();
      const timezoneAbbreviation = response.timezoneAbbreviation();
      const latitude = response.latitude();
      const longitude = response.longitude();

      // Get the actual data objects
      const current = response.current();
      const hourly = response.hourly();
      const daily = response.daily();

      if (!current || !hourly || !daily) {
        throw new Error("Incomplete response data from the API");
      }

      const now = new Date().toISOString();
      // Extract position values safely, ensuring they're primitive numbers
      const positionData = {
        latitude: position?.latitude != null ? Number(position.latitude) : null,
        longitude: position?.longitude != null ? Number(position.longitude) : null,
      };

      // Process the marine data into our state format
      const marineData = {
        current: {
          time: new Date(
            (Number(current.time()) + utcOffsetSeconds) * 1000
          ).toISOString(),
          values: {
            waveHeight: current.variables(0)?.value(),
            waveDirection: current.variables(1)?.value(),
            wavePeriod: current.variables(2)?.value(),
            seaLevelHeightMsl: current.variables(3)?.value(),
            seaSurfaceTemperature: current.variables(4)?.value(),
            oceanCurrentVelocity: current.variables(5)?.value(),
            oceanCurrentDirection: current.variables(6)?.value(),
          },
        },
        hourly: {
          time: [
            ...Array(
              (Number(hourly.timeEnd()) - Number(hourly.time())) /
                hourly.interval()
            ),
          ].map((_, i) =>
            new Date(
              (Number(hourly.time()) +
                i * hourly.interval() +
                utcOffsetSeconds) *
                1000
            ).toISOString()
          ),
          values: {
            waveHeight: hourly.variables(0)?.valuesArray() || [],
            waveDirection: hourly.variables(1)?.valuesArray() || [],
            wavePeriod: hourly.variables(2)?.valuesArray() || [],
            windWavePeakPeriod: hourly.variables(3)?.valuesArray() || [],
            windWaveHeight: hourly.variables(4)?.valuesArray() || [],
            windWaveDirection: hourly.variables(5)?.valuesArray() || [],
            windWavePeriod: hourly.variables(6)?.valuesArray() || [],
            swellWaveHeight: hourly.variables(7)?.valuesArray() || [],
            swellWaveDirection: hourly.variables(8)?.valuesArray() || [],
            swellWavePeriod: hourly.variables(9)?.valuesArray() || [],
            swellWavePeakPeriod: hourly.variables(10)?.valuesArray() || [],
            seaLevelHeightMsl: hourly.variables(11)?.valuesArray() || [],
            seaSurfaceTemperature: hourly.variables(12)?.valuesArray() || [],
            oceanCurrentVelocity: hourly.variables(13)?.valuesArray() || [],
            oceanCurrentDirection: hourly.variables(14)?.valuesArray() || [],
          },
        },
        daily: {
          time: [
            ...Array(
              (Number(daily.timeEnd()) - Number(daily.time())) /
                daily.interval()
            ),
          ].map((_, i) =>
            new Date(
              (Number(daily.time()) + i * daily.interval() + utcOffsetSeconds) *
                1000
            ).toISOString()
          ),
          values: {
            waveHeightMax: daily.variables(0)?.valuesArray() || [],
            waveDirectionDominant: daily.variables(1)?.valuesArray() || [],
            wavePeriodMax: daily.variables(2)?.valuesArray() || [],
            windWaveHeightMax: daily.variables(3)?.valuesArray() || [],
            windWaveDirectionDominant: daily.variables(4)?.valuesArray() || [],
          },
        },
        metadata: {
          latitude,
          longitude,
          timezone,
          timezoneAbbreviation,
          last_updated: now,
        },
      };

      // Log the raw data for debugging
      this.log("Processed marine data:");
 
      this.emit('tide:update', marineData);
      
      // Also log the event emission for debugging
      this.log(`Emitted 'tide:update' event with data:`, 
        Object.keys(marineData).join(', '));

          // Return the data that was stored in the state
          return marineData;
        } finally {
          this._currentFetch = null;
        }
      })();
      
      return await this._currentFetch;
    } catch (error) {
      this.logError("Error fetching tidal data:", error);
      throw error;
    }
  }
}
