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
    super('tidal', {
      interval: 7200000, // 2 hours
      immediate: false,
      runOnInit: false
    });
    
    // Initialize state service reference with type checking
    if (!stateService || typeof stateService.getState !== 'function') {
      throw new Error('stateService must be provided and implement getState()');
    }
    
    this.stateService = stateService;
    this.baseUrl = "https://marine-api.open-meteo.com/v1/marine";
    this._currentFetch = null;
    this._positionAvailable = false;
    
    // Initialize internal position tracking
    this._internalPosition = {
      latitude: null,
      longitude: null,
      timestamp: null,
      source: null
    };
    
    // Set up a default position
    this.position = {
      latitude: null,  // Will be set from real data only
      longitude: null
    };
    
    // Bind methods
    this._onPositionAvailable = this._onPositionAvailable.bind(this);
    
    // Add dependency on PositionService
    this.setServiceDependency('position-service');
    
    // Listen for position:update event to know when we can start
    this.on("position:update", async (position) => {
      this.log(`Position data available: ${JSON.stringify({
        lat: position?.latitude,
        lon: position?.longitude,
        source: position?.source,
        timestamp: position?.timestamp ? new Date(position.timestamp).toISOString() : 'none'
      })}`);
      
      if (!this.isRunning) {
        this.log("Starting scheduled tasks for the first time");
        this.start();
      }
      
      // Run immediately when position is available
      try {
        this.log("Running initial tidal data fetch");
        await this.runNow();
        this.log("Initial tidal data fetch completed successfully");
      } catch (err) {
        this.logError("Initial tidal data fetch failed:", err);
      }
    });

    // Set up position:update listener when dependencies are resolved
    this.on("dependencies:resolved", () => {
      this.log("Dependencies resolved, checking for PositionService");
      const positionService = this.dependencies["position-service"];
      if (!positionService) {
        this.logError("PositionService dependency not available, tidal data may not update");
        return;
      }

      this.log("PositionService dependency found, setting up position listener:", {
        type: positionService.constructor?.name || 'Unknown',
        id: positionService.serviceId || 'unknown',
      });

      // Set up position:update listener
      const onPositionAvailable = (position) => {
        this.log("Received position:update event from PositionService:", {
          lat: position?.latitude,
          lon: position?.longitude,
          source: position?.source
        });

        // Update internal position
        this._onPositionAvailable({
          latitude: position.latitude,
          longitude: position.longitude,
          timestamp: position.timestamp || new Date().toISOString(),
          source: position.source || 'unknown'
        });
      };

      // Remove any existing listeners to prevent duplicates
      positionService.removeListener("position:update", onPositionAvailable);
      positionService.on("position:update", onPositionAvailable);
      
      this.log("Position available listener has been set up");

      // Check if we already have position data
      if (positionService._primarySource && positionService._positions?.[positionService._primarySource]) {
        const position = positionService._positions[positionService._primarySource];
        this.log("Initial position data already available, processing...");
        onPositionAvailable({
          ...position,
          source: positionService._primarySource,
          isPrimary: true
        });
      } else {
        this.log("No initial position data available yet, waiting for position:update event...");
      }
    });
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
      return { 
        latitude: this.position.latitude, 
        longitude: this.position.longitude 
      };
    }
    
    const startTime = Date.now();
    let lastLogTime = 0;
    const logInterval = 5000; // Log every 5 seconds
    let attemptCount = 0;
    
    this.log("Waiting for position data...");
    
    // Check if we have access to the PositionService
    const positionService = this.dependencies['position-service'];
    if (!positionService) {
      this.log('PositionService not available, cannot get position data', 'warn');
      throw new Error('PositionService not available');
    }
    
    while (Date.now() - startTime < timeout) {
      attemptCount++;
      try {
        // Try to get the current position from the PositionService
        if (positionService._primarySource && positionService._positions[positionService._primarySource]) {
          const primaryPosition = positionService._positions[positionService._primarySource];
          const lat = primaryPosition.latitude;
          const lon = primaryPosition.longitude;
          
          this.log(`Found position from PositionService: lat=${lat}, lon=${lon}, source=${positionService._primarySource}`);
          
          // Validate the position values
          if (!isNaN(lat) && !isNaN(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) {
            this.log(`Got valid position: ${lat}, ${lon} from source: ${positionService._primarySource}`);
            
            // Update our internal position tracking
            this.position = { latitude: lat, longitude: lon };
            this._internalPosition = {
              latitude: lat,
              longitude: lon,
              timestamp: primaryPosition.timestamp || new Date().toISOString(),
              source: positionService._primarySource
            };
            this._positionAvailable = true;
            
            return { latitude: lat, longitude: lon };
          } else {
            this.log(`Invalid position values from PositionService: lat=${lat}, lon=${lon}`);
          }
        } else {
          if (Date.now() - lastLogTime >= logInterval) {
            this.log("No primary position source available in PositionService", {
              hasPrimarySource: !!positionService._primarySource,
              primarySource: positionService._primarySource || 'none',
              availableSources: Object.keys(positionService._positions || {}),
            });
            lastLogTime = Date.now();
          }
        }
        
        // Log every 5 seconds
        const now = Date.now();
        if (now - lastLogTime >= logInterval) {
          this.log(`Waiting for valid position data... (${Math.round((now - startTime) / 1000)}s elapsed)`);
          lastLogTime = now;
        }
        
        // Wait for a bit before checking again
        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (error) {
        this.logError('Error checking position:', error.message);
        // Wait a bit before retrying
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
    
    // If we get here, we've timed out
    throw new Error(`Timed out waiting for position data after ${timeout}ms`);
  }

  /**
   * Check if valid position data is available in the state
   * @returns {boolean} True if valid position data is available
   */
  /**
   * Handler for position:update events from state service
   * @param {Object} positionData - The position data object
   * @private
   */
  _onPositionAvailable(positionData) {
    if (!positionData || typeof positionData.latitude !== 'number' || typeof positionData.longitude !== 'number') {
      this.logError('Invalid position data received in event');
      return;
    }
    
    // Update our position with the received data
    this.position = {
      latitude: positionData.latitude,
      longitude: positionData.longitude
    };
    
    // Update internal position tracking
    this._internalPosition = {
      latitude: positionData.latitude,
      longitude: positionData.longitude,
      timestamp: positionData.timestamp || new Date().toISOString(),
      source: 'position:update event'
    };
    
    this._positionAvailable = true;
    this.log(`Position updated: ${positionData.latitude.toFixed(4)}, ${positionData.longitude.toFixed(4)}`);
    // No immediate fetch triggered - will use in next scheduled run
  }
  
  _hasValidPositionData() {
    try {
      // Get position from PositionService instead of state service
      const positionService = this.dependencies['position-service'];
      if (!positionService || !positionService._primarySource) {
        return false;
      }
      
      const primaryPosition = positionService._positions[positionService._primarySource];
      if (!primaryPosition || typeof primaryPosition.latitude !== 'number' || typeof primaryPosition.longitude !== 'number') {
        return false;
      }
      
      const lat = primaryPosition.latitude;
      const lon = primaryPosition.longitude;
      
      const isValid = !isNaN(lat) && !isNaN(lon) && 
             lat >= -90 && lat <= 90 && 
             lon >= -180 && lon <= 180;
      
      if (isValid) {
        // Update internal position from PositionService data
        this._internalPosition = {
          latitude: lat,
          longitude: lon,
          timestamp: primaryPosition.timestamp || new Date().toISOString(),
          source: positionService._primarySource
        };
        
        // Also update legacy position property for backward compatibility
        this.position = { latitude: lat, longitude: lon };
        this._positionAvailable = true;
        
        this.log(`Position from PositionService (${positionService._primarySource}): ${lat.toFixed(4)}, ${lon.toFixed(4)}`);
      }
      
      return isValid;
    } catch (error) {
      this.logError('Error checking position data:', error.message);
      return false;
    }
  }
  
  async run() {
    this.log('TidalService.run() called');
    const runId = Date.now();
    this.log(`[${runId}] TidalService run started`);

    // Check if we have internal position data
    if (!this._internalPosition?.latitude || !this._internalPosition?.longitude) {
      // Try to get position from the state
      if (this._hasValidPositionData()) {
        this.log("Using position from state data");
        // _hasValidPositionData already updated internal position if valid
      } else {
        this.log("Waiting for position data...");
        
        try {
          // Wait for position data with timeout
          const position = await this._waitForPosition(60000); // 60 second timeout
          
          // Update internal position
          this._internalPosition = {
            latitude: position.latitude,
            longitude: position.longitude,
            timestamp: new Date().toISOString(), // Always use current timestamp
            source: 'waitForPosition'
          };
          
          // Also update legacy position property
          this.position = position;
          this._positionAvailable = true;
          
          this.log(`Position obtained: ${position.latitude.toFixed(4)}, ${position.longitude.toFixed(4)}`);
        } catch (error) {
          this.logError("Failed to get position data:", error.message);
          return { success: false, error: "No position data available" };
        }
      }
    } else {
      this.log(`Using cached position: ${this._internalPosition.latitude.toFixed(4)}, ${this._internalPosition.longitude.toFixed(4)}`);
    }
    
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
 
      this.log('EMITTING tide:update EVENT with data structure:', {
        dataType: typeof marineData,
        hasCurrentData: !!marineData.current,
        hasHourlyData: !!marineData.hourly,
        hasDailyData: !!marineData.daily,
        timestamp: marineData.metadata?.lastUpdated
      });
      
      this.emit('tide:update', marineData);
      this.log('Tide:update event emitted successfully');
      
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
