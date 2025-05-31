import ScheduledService from './ScheduledService.js';

export class WeatherService extends ScheduledService {
  constructor(stateService) {
    super('weather', {
      interval: 3600000, // 1 hour
      immediate: true
    });
    this.stateService = stateService;
    this.baseUrl = 'https://api.open-meteo.com/v1/forecast';
  }

  async run() {
    console.log('[WeatherService] Fetching weather data...');
    
    try {
      const position = this.stateService.getState().navigation?.position;
      if (!position || !position.latitude?.value || !position.longitude?.value) {
        throw new Error('Position data not available');
      }
      
      return await this.fetchWeatherData(position.latitude.value, position.longitude.value);
    } catch (error) {
      console.error('[WeatherService] Error in run:', error);
      throw error;
    }
  }
  
  async fetchWeatherData(latitude, longitude) {
    try {
      const params = new URLSearchParams({
        latitude: latitude,
        longitude: longitude,
        current: 'temperature_2m,relative_humidity_2m,wind_speed_10m',
        hourly: 'temperature_2m,precipitation_probability',
        timezone: 'auto'
      });

      const response = await fetch(`${this.baseUrl}?${params.toString()}`);
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      
      const weatherData = {
        current: {
          temperature: data.current?.temperature_2m,
          humidity: data.current?.relative_humidity_2m,
          windSpeed: data.current?.wind_speed_10m
        },
        // Process hourly data if needed
        hourly: data.hourly,
        lastUpdated: new Date().toISOString()
      };

      // Update state
      this.stateService.updateState({
        weather: weatherData
      });

      this.emit('data:updated', weatherData);
      return weatherData;
    } catch (error) {
      console.error('[WeatherService] Error fetching weather data:', error);
      this.emit('error', error);
      throw error;
    }
  }
}
