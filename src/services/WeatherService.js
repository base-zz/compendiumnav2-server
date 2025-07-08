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
    this._currentFetch = null;
    this._positionCheckInterval = null;
    this._updateTimeout = null;
    this._positionAvailable = false;
    
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
    this._onPositionAvailable = this._onPositionAvailable.bind(this);
    
    // Listen for position:available events from state service
    if (stateService && typeof stateService.on === 'function') {
      this.log('[WeatherService] Setting up position:available event listener');
      stateService.on('position:available', this._onPositionAvailable);
    }
  }

  /**
   * Handle position:available event from state service
   * @private
   * @param {Object} positionData - Position data from event
   */
  _onPositionAvailable(positionData) {
    if (!positionData || !positionData.latitude || !positionData.longitude) {
      this.log('[WeatherService] Received position:available event but position data is invalid');
      return;
    }

    this.log(`[WeatherService] Received position:available event: ${positionData.latitude}, ${positionData.longitude}`);
    
    // Update internal position state
    this.position = {
      latitude: positionData.latitude,
      longitude: positionData.longitude
    };
    this._positionAvailable = true;
    
    // If we're not currently fetching, trigger a run with a slight delay
    // to allow for any other state updates to complete
    if (!this._currentFetch) {
      this.log('[WeatherService] Position updated, scheduling weather data fetch');
      clearTimeout(this._updateTimeout);
      this._updateTimeout = setTimeout(() => {
        this.run().catch(err => this.logError('[WeatherService] Error running after position update:', err));
      }, 1000); // 1 second delay
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
      this.log(`[WeatherService] Using position from event: ${this.position.latitude}, ${this.position.longitude}`);
      return { 
        latitude: this.position.latitude, 
        longitude: this.position.longitude 
      };
    }
    
    const startTime = Date.now();
    let lastLogTime = 0;
    const logInterval = 5000; // Log every 5 seconds
    let attemptCount = 0;
    
    this.log("[WeatherService] Starting to wait for position data with timeout of", timeout, "ms");
    
    // Log the state service instance for debugging
    this.log("[WeatherService] State service instance:", {
      type: this.stateService.constructor.name,
      serviceId: this.stateService.serviceId,
      stateServiceRef: this.stateService
    });
    
    while (Date.now() - startTime < timeout) {
      attemptCount++;
      try {
        // Get the current state
        const stateData = this.stateService.getState();
        
        // Add memory address/reference logging to help debug instance sharing
        const stateRef = `${stateData}`;
        
        this.log(`[WeatherService] Got state data (attempt ${attemptCount}):`, {
          hasStateData: !!stateData,
          stateDataType: typeof stateData,
          stateRef: stateRef,
          hasNavigation: !!stateData?.navigation,
          hasPosition: !!stateData?.navigation?.position
        });
        
        // Check if we have valid position data
        const position = stateData?.navigation?.position;
        if (position?.latitude?.value != null && position?.longitude?.value != null) {
          const lat = Number(position.latitude.value);
          const lon = Number(position.longitude.value);
          
          // Validate the position values
          if (!isNaN(lat) && !isNaN(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) {
            this.log(`[WeatherService] Found valid position in state: ${lat}, ${lon}`);
            return { latitude: lat, longitude: lon };
          }
        }
        
        // Log every 5 seconds
        const now = Date.now();
        if (now - lastLogTime >= logInterval) {
          this.log(`[WeatherService] Waiting for valid position data... (${Math.round((now - startTime) / 1000)}s elapsed)`);
          this.log('[WeatherService] Current position state:', JSON.stringify({
            hasPosition: !!position,
            latitude: position?.latitude?.value,
            longitude: position?.longitude?.value
          }, null, 2));
          lastLogTime = now;
        }
        
        // Wait for a bit before checking again
        await new Promise(resolve => setTimeout(resolve, 1000));
        
      } catch (error) {
        this.logError('[WeatherService] Error checking position:', error.message);
        // Continue waiting even if there's an error checking position
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    const errorMsg = `Timed out waiting for position data after ${timeout}ms`;
    this.logError(`[WeatherService] ${errorMsg}`);
    throw new Error(errorMsg);
  }


  
  async _initializeStateService() {
    // Check if state service is available and has getState method
    if (!this.stateService || typeof this.stateService.getState !== 'function') {
      throw new Error('State service is not properly initialized');
    }
    
    // If the state service has an initialization method, call it
    if (typeof this.stateService.initialize === 'function') {
      this.log('Initializing state service...');
      try {
        await this.stateService.initialize();
      } catch (error) {
        this.logError('Error initializing state service:', error.message);
        throw new Error(`State service initialization failed: ${error.message}`);
      }
    }
    
    this.log('State service is ready');
  }
  

  
  async run() {
    if (this._currentFetch) {
      this.log('Update already in progress, queuing next update');
      return this._currentFetch;
    }
    
    this.log('Starting weather data fetch...');
    
    try {
      // Create a promise that resolves when the current fetch completes
      this._currentFetch = (async () => {
        try {
          // Wait for position data with retry logic
          this.log('Waiting for position data...');
          const position = await this._waitForPosition(60000); // 60 second timeout for position
          
          if (!position?.latitude || !position?.longitude) {
            throw new Error('Invalid position data received');
          }
          
          this.log(`Got position: ${position.latitude}, ${position.longitude}`);
          
          // Fetch weather data with the obtained position
          this.log('Fetching weather data...');
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
      this.logError('Error in run:', error);
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
      this.log('Could not get unit preferences, using defaults:', error.message);
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
          this.log(`Successfully fetched weather data after ${attempt} attempts`);
        }
        return result;
      } catch (error) {
        lastError = error;
        const waitTime = 1000 * Math.pow(2, attempt - 1); // Exponential backoff
        this.log(`Attempt ${attempt} failed, retrying in ${waitTime}ms:`, error.message);
        
        if (attempt < retries) {
          await new Promise(resolve => setTimeout(resolve, waitTime));
        }
      }
    }
    
    this.logError(`All ${retries} attempts failed`);
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

      // this.log(`Fetching weather data from: ${this.baseUrl}?${params.toString()}`);
      
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
      // this.log('Prepared forecast data:', JSON.stringify(forecastData, null, 2));
      
      try {
        // Update the state with the new forecast data
        // await this.stateService.updateState({
        //   forecast: forecastData,
        // });
        
        this.emit('weather:update', forecastData);

        this.log('Successfully updated state with forecast data');
      } catch (error) {
        this.logError('Error updating state:', error);
        throw error;
      }
   
      return forecastData;
    } catch (error) {
      this.logError('Error fetching weather data:', error);
      this.emit('error', error);
      throw error;
    }
  }
}
