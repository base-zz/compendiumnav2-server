import ScheduledService from './ScheduledService.js';
import { UNIT_PRESETS } from '../shared/unitPreferences.js';

export class WeatherService extends ScheduledService {
  /** @type {Function} */
  _handlePositionUpdate;
  
  /** @type {Function} */
  _scheduleNextUpdate;
  
  /** @type {Object} */
  stateService;
  
  /** @type {string} */
  baseUrl;
  
  /** @type {boolean} */
  _isRunning;
  
  /** @type {Promise|null} */
  _currentFetch;
  
  /** @type {NodeJS.Timeout|null} */
  _positionCheckInterval;
  
  /** @type {{latitude: number|null, longitude: number|null}} */
  position;
  
  /** @type {NodeJS.Timeout|null} */
  _updateTimeout;
  constructor(stateService) {
    super('weather', {
      interval: 3600000, // 1 hour
      immediate: true,
      runOnInit: true
    });
    
    this.stateService = stateService;
    this.baseUrl = 'https://api.open-meteo.com/v1/forecast';
    this._isRunning = false;
    this._currentFetch = null;
    this._positionCheckInterval = null;
    this._updateTimeout = null;
    
    // Set up a default position (can be overridden by state updates)
    this.position = {
      latitude: null,
      longitude: null,
    };
    
    // Initialize state service reference with type checking
    if (!stateService || typeof stateService.getState !== 'function') {
      throw new Error('stateService must be provided and implement getState()');
    }
    
    // Initialize methods
    this._handlePositionUpdate = this._handlePositionUpdate?.bind?.(this) || (() => {});
    this._scheduleNextUpdate = this._scheduleNextUpdate?.bind?.(this) || (() => {});
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
            return { latitude: lat, longitude: lon };
          }
        }
        
        // Log every 5 seconds
        const now = Date.now();
        if (now - lastLogTime >= logInterval) {
          console.log(`[WeatherService] Waiting for valid position data... (${Math.round((now - startTime) / 1000)}s elapsed)`);
          console.log('[WeatherService] Current position state:', JSON.stringify({
            hasPosition: !!position,
            latitude: position?.latitude,
            longitude: position?.longitude
          }, null, 2));
          lastLogTime = now;
        }
        
        // Wait for a bit before checking again
        await new Promise(resolve => setTimeout(resolve, 1000));
        
      } catch (error) {
        console.error('[WeatherService] Error checking position:', error.message);
        // Continue waiting even if there's an error checking position
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    const errorMsg = `Timed out waiting for position data after ${timeout}ms`;
    console.error(`[WeatherService] ${errorMsg}`);
    throw new Error(errorMsg);
  }

  /**
   * Start the weather service
   * @override
   */
  async start() {
    if (this._isRunning) {
      console.log('[WeatherService] Service already running');
      return;
    }
    
    this._isRunning = true;
    console.log('[WeatherService] Starting weather service...');
    
    try {
      // Initialize state service connection
      await this._initializeStateService();
      
      // Start position updates listener - this runs this every 30 seconds - BAD
      // this._startPositionUpdates();
      
      // Run initial update if runOnInit is true
      if (this.options.runOnInit) {
        await this.run();
      }
    } catch (error) {
      this._isRunning = false;
      console.error('[WeatherService] Failed to start service:', error);
      throw error;
    }
  }
  
  async stop() {
    console.log('[WeatherService] Stopping service...');
    this._isRunning = false;
    
    // Cancel any in-progress fetch
    if (this._currentFetch) {
      try {
        await this._currentFetch;
      } catch (error) {
        console.warn('[WeatherService] Error during cleanup of in-progress fetch:', error);
      }
      this._currentFetch = null;
    }
    
    // Clear any intervals
    if (this._positionCheckInterval) {
      clearInterval(this._positionCheckInterval);
      this._positionCheckInterval = null;
    }
    
    console.log('[WeatherService] Service stopped');
  }
  
  async _initializeStateService() {
    // Check if state service is available and has getState method
    if (!this.stateService || typeof this.stateService.getState !== 'function') {
      throw new Error('State service is not properly initialized');
    }
    
    // If the state service has an initialization method, call it
    if (typeof this.stateService.initialize === 'function') {
      console.log('[WeatherService] Initializing state service...');
      try {
        await this.stateService.initialize();
      } catch (error) {
        console.error('[WeatherService] Error initializing state service:', error.message);
        throw new Error(`State service initialization failed: ${error.message}`);
      }
    }
    
    console.log('[WeatherService] State service is ready');
  }
  
  _startPositionUpdates() {
    // Check position every 30 seconds
    this._positionCheckInterval = setInterval(() => {
      if (this._isRunning) {
        this.run().catch(error => {
          console.error('[WeatherService] Error in scheduled position update:', error);
        });
      }
    }, 30000);
  }
  
  async run() {
    if (this._currentFetch) {
      console.log('[WeatherService] Update already in progress, queuing next update');
      return this._currentFetch;
    }
    
    console.log('[WeatherService] Starting weather data fetch...');
    
    try {
      // Create a promise that resolves when the current fetch completes
      this._currentFetch = (async () => {
        try {
          // Wait for position data with retry logic
          console.log('[WeatherService] Waiting for position data...');
          const position = await this._waitForPosition(60000); // 60 second timeout for position
          
          if (!position?.latitude || !position?.longitude) {
            throw new Error('Invalid position data received');
          }
          
          console.log(`[WeatherService] Got position: ${position.latitude}, ${position.longitude}`);
          
          // Fetch weather data with the obtained position
          console.log('[WeatherService] Fetching weather data...');
          const weatherData = await this.fetchWeatherData(position.latitude, position.longitude);
          
          // Emit the weather update event
          this.emit('weather:update', weatherData);
          
          return weatherData;
        } finally {
          this._currentFetch = null;
        }
      })();
      
      return await this._currentFetch;
    } catch (error) {
      console.error('[WeatherService] Error in run:', error);
      this.emit('weather:error', { error: error.message });
      throw error;
    }
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
      console.warn('[WeatherService] Could not get unit preferences, using defaults:', error.message);
      return UNIT_PRESETS.IMPERIAL;
    }
  }

  /**
   * Fetch weather data with retry logic
   * @private
   */
  async fetchWeatherData(latitude, longitude, retries = 2) {
    let lastError;
    
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const result = await this._fetchWeatherData(latitude, longitude);
        if (attempt > 1) {
          console.log(`[WeatherService] Successfully fetched weather data after ${attempt} attempts`);
        }
        return result;
      } catch (error) {
        lastError = error;
        const waitTime = 1000 * Math.pow(2, attempt - 1); // Exponential backoff
        console.warn(`[WeatherService] Attempt ${attempt} failed, retrying in ${waitTime}ms:`, error.message);
        
        if (attempt < retries) {
          await new Promise(resolve => setTimeout(resolve, waitTime));
        }
      }
    }
    
    console.error(`[WeatherService] All ${retries} attempts failed`);
    throw lastError;
  }
  
  /**
   * Internal method to perform the actual weather data fetch
   * @private
   */
  async _fetchWeatherData(latitude, longitude) {
    try {
      // Get user's unit preferences
      const unitPrefs = await this._getUnitPreferences();
      const isMetric = unitPrefs?.temperature === '°C';
      
      const params = new URLSearchParams({
        latitude: latitude,
        longitude: longitude,
        // Current weather conditions
        current: [
          'temperature_2m', 'relative_humidity_2m', 'apparent_temperature',
          'is_day', 'precipitation', 'rain', 'showers', 'weather_code',
          'cloud_cover', 'pressure_msl', 'surface_pressure',
          'wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m'
        ].join(','),
        // Hourly forecast
        hourly: [
          'temperature_2m', 'relative_humidity_2m', 'dew_point_2m',
          'apparent_temperature', 'precipitation_probability', 'precipitation',
          'rain', 'showers', 'snowfall', 'snow_depth', 'cloud_cover',
          'cloud_cover_low', 'cloud_cover_mid', 'cloud_cover_high',
          'wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m'
        ].join(','),
        // Daily forecast
        daily: [
          'weather_code', 'temperature_2m_max', 'temperature_2m_min',
          'sunrise', 'sunset', 'daylight_duration', 'sunshine_duration',
          'uv_index_max', 'uv_index_clear_sky_max', 'rain_sum', 'snowfall_sum',
          'precipitation_sum', 'precipitation_hours', 'precipitation_probability_max',
          'wind_speed_10m_max', 'wind_direction_10m_dominant', 'wind_gusts_10m_max'
        ].join(','),
        // Set units based on preferences
        temperature_unit: isMetric ? 'celsius' : 'fahrenheit',
        wind_speed_unit: 'kn', // Always use knots for marine applications
        precipitation_unit: isMetric ? 'mm' : 'inch',
        timezone: 'auto',
        timeformat: 'iso8601'
      });

      // console.log(`[WeatherService] Fetching weather data from: ${this.baseUrl}?${params.toString()}`);
      
      const response = await fetch(`${this.baseUrl}?${params.toString()}`);
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP error! status: ${response.status}, body: ${errorText}`);
      }

      const rawWeatherData = await response.json();
      const now = new Date().toISOString();
      
      // Create the raw forecast data
      const forecastData = {
        current: rawWeatherData.current,
        hourly: rawWeatherData.hourly,
        daily: rawWeatherData.daily,
        metadata: {
          latitude: rawWeatherData.latitude,
          longitude: rawWeatherData.longitude,
          timezone: rawWeatherData.timezone,
          lastUpdated: now
        }
      };
      
      // Log the data we're about to store
      // console.log('[WeatherService] Prepared forecast data:', JSON.stringify(forecastData, null, 2));
      
      try {
        // Update the state with the new forecast data
        // await this.stateService.updateState({
        //   forecast: forecastData,
        // });
        
        this.emit('weather:update', forecastData);

        console.log('[WeatherService] Successfully updated state with forecast data');
      } catch (error) {
        console.error('[WeatherService] Error updating state:', error);
        throw error;
      }
   
      return forecastData;
    } catch (error) {
      console.error('[WeatherService] Error fetching weather data:', error);
      this.emit('error', error);
      throw error;
    }
  }
}
