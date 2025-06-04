import ScheduledService from './ScheduledService.js';

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
      latitude: 37.7749,  // Default to San Francisco
      longitude: -122.4194,
    };
  }

  async run() {
    console.log('[WeatherService] Fetching weather data...');
    
    try {
      let position = this.position;
      
      // Try to get position from state service if available
      try {
        const statePosition = this.stateService?.getState()?.navigation?.position;
        if (statePosition?.latitude?.value && statePosition?.longitude?.value) {
          position = {
            latitude: statePosition.latitude.value,
            longitude: statePosition.longitude.value
          };
        }
      } catch (error) {
        console.warn('[WeatherService] Could not get position from state, using default:', error.message);
      }
      
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
  
  async fetchWeatherData(latitude, longitude) {
    try {
      const params = new URLSearchParams({
        latitude: latitude,
        longitude: longitude,
        daily: ["weather_code", "temperature_2m_max", "temperature_2m_min", "sunrise", "sunset", "daylight_duration", "sunshine_duration", "uv_index_max", "uv_index_clear_sky_max", "rain_sum", "snowfall_sum", "showers_sum", "precipitation_sum", "precipitation_hours", "precipitation_probability_max", "wind_speed_10m_max", "wind_direction_10m_dominant", "wind_gusts_10m_max"],
        hourly: ["temperature_2m", "relative_humidity_2m", "dew_point_2m", "apparent_temperature", "precipitation_probability", "precipitation", "rain", "showers", "snowfall", "snow_depth", "cloud_cover", "cloud_cover_low", "cloud_cover_mid", "cloud_cover_high", "wind_speed_10m", "wind_direction_10m", "wind_gusts_10m"],
        current: ["temperature_2m", "relative_humidity_2m", "apparent_temperature", "is_day", "precipitation", "rain", "showers", "weather_code", "cloud_cover", "pressure_msl", "surface_pressure", "wind_speed_10m", "wind_direction_10m", "wind_gusts_10m"],
        timezone: 'auto',
        wind_speed_unit: 'kn',
        temperature_unit: 'fahrenheit',
        precipitation_unit: 'inch',
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
