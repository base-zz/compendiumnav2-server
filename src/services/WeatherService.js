import ScheduledService from './ScheduledService.js';
import { UNIT_PRESETS } from '../shared/unitPreferences.js';

export class WeatherService extends ScheduledService {
  constructor(stateService) {
    super('weather', {
      interval: 3600000, // 1 hour
      immediate: true,
      runOnInit: true
    });
    this.stateService = stateService;
    this.baseUrl = 'https://api.open-meteo.com/v1/forecast';
    
    // Set up a default position (can be overridden by state updates)
    this.position = {
      latitude: null,  // Default to San Francisco
      longitude: null,
    };
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
        const state = this.stateService.getState();
        const position = state?.navigation?.position;
        
        if (position?.latitude?.value && position?.longitude?.value) {
          return {
            latitude: position.latitude.value,
            longitude: position.longitude.value
          };
        }
        
        // Log progress periodically
        const now = Date.now();
        if (now - lastLogTime >= logInterval) {
          console.log(`[WeatherService] Waiting for position data... (${Math.round((now - startTime) / 1000)}s elapsed)`);
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
    
    throw new Error(`Timed out waiting for position data after ${timeout}ms`);
  }

  async run() {
    console.log('[WeatherService] Starting weather data fetch...');
    
    try {
      // Wait for state service to be ready with a longer timeout
      if (!this.stateService?.isReady) {
        console.log('[WeatherService] Waiting for state service to be ready...');
        try {
          await this.stateService.waitUntilReady(30000); // 30 second timeout
          console.log('[WeatherService] State service is now ready');
        } catch (error) {
          console.error('[WeatherService] Error waiting for state service:', error.message);
          throw error;
        }
      }

      // Wait for position data with retry logic
      console.log('[WeatherService] Waiting for position data...');
      const position = await this._waitForPosition(60000); // 60 second timeout for position
      console.log(`[WeatherService] Got position: ${position.latitude}, ${position.longitude}`);
      
      // Fetch weather data with the obtained position
      console.log('[WeatherService] Fetching weather data...');
      const weatherData = await this.fetchWeatherData(position.latitude, position.longitude);
      
      // Emit the weather update event
      this.emit('weather:update', weatherData);
      
      return weatherData;
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

  async fetchWeatherData(latitude, longitude) {
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
        wind_speed_unit: isMetric ? 'kmh' : 'mph',
        precipitation_unit: isMetric ? 'mm' : 'inch',
        timezone: 'auto',
        timeformat: 'iso8601',
        // Always request wind in knots for marine applications
        wind_speed_unit: 'kn'
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
