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
  
  /** @type {boolean} */
  _isRunning;
  
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

    // Set up a default position (can be overridden by setPosition)
    this.position = {
      latitude: 37.7749,  // Default to San Francisco
      longitude: -122.4194,
    };
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
      this.warn('[TidalService] Could not get unit preferences, using defaults:', error.message);
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
  async _waitForPosition(timeout = 60000) {
    const startTime = Date.now();
    let lastLogTime = 0;
    const logInterval = 5000; // Log every 5 seconds
    
    while (Date.now() - startTime < timeout) {
      try {
        // Get the current state
        const state = this.stateService.getState();

        // Check if we have valid position data
        const position = state?.navigation?.position;
        if (position?.latitude?.value != null && position?.longitude?.value != null) {
          const lat = Number(position.latitude.value);
          const lon = Number(position.longitude.value);
          
          // Validate the position values
          if (!isNaN(lat) && !isNaN(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) {
            this.log(`[TidalService] Got valid position: ${lat}, ${lon}`);
            return { latitude: lat, longitude: lon };
          }
        }
        
        // Log every 5 seconds
        const now = Date.now();
        if (now - lastLogTime >= logInterval) {
          this.log(`[TidalService] Waiting for valid position data... (${Math.round((now - startTime) / 1000)}s elapsed)`);
          this.log('[TidalService] Current position state:', JSON.stringify({
            hasPosition: !!position,
            latitude: position?.latitude,
            longitude: position?.longitude
          }, null, 2));
          lastLogTime = now;
        }
        
        // Wait for a bit before checking again
        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (error) {
        this.logError('[TidalService] Error checking position:', error.message);
        // Continue waiting even if there's an error checking position
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    const errorMsg = `Timed out waiting for position data after ${timeout}ms`;
    this.logError(`[TidalService] ${errorMsg}`);
    throw new Error(errorMsg);
  }

  async run() {
    if (this._currentFetch) {
      this.log('[TidalService] Update already in progress, returning existing promise');
      return this._currentFetch;
    }
    
    this.log("[TidalService] Starting tidal data fetch...");
    
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
            this.log("[TidalService] Initializing state service...");
            try {
              await this.stateService.initialize();
              this.log("[TidalService] State service is now ready");
            } catch (error) {
              this.error("[TidalService] Error initializing state service:", error.message);
              throw error;
            }
          }

          // Wait for position data with retry logic
          this.log("[TidalService] Waiting for position data...");
          const position = await this._waitForPosition(60000); // 60 second timeout for position
          this.log(`[TidalService] Got position: ${position.latitude}, ${position.longitude}`);
          
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

      // this.log(
      //   `[TidalService] Fetching data from: ${this.baseUrl} with params:`,
      //   JSON.stringify(params, null, 2)
      // );

      // Make the API request using openmeteo's fetchWeatherApi
      const responses = await fetchWeatherApi(this.baseUrl, params);

      // Process first location
      const response = responses[0];

      if (!response) {
        throw new Error("No response data received from the API");
      }

      this.log(`[TidalService] Raw marine data received`);

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
        latitude:
          position?.latitude?.value != null
            ? Number(position.latitude.value)
            : null,
        longitude:
          position?.longitude?.value != null
            ? Number(position.longitude.value)
            : null,
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
      this.log("[TidalService] Processed marine data:");
 
      // Emit the event both directly and through the event emitter
      this.emit('tide:update', marineData);
      this._eventEmitter.emit('tide:update', marineData);
      
      // Also log the event emission for debugging
      this.log(`[TidalService] Emitted 'tide:update' event with data:`, 
        Object.keys(marineData).join(', '));

          // Return the data that was stored in the state
          return marineData;
        } finally {
          this._currentFetch = null;
        }
      })();
      
      return await this._currentFetch;
    } catch (error) {
      this.error("[TidalService] Error fetching tidal data:", error);
      throw error;
    }
  }
}
