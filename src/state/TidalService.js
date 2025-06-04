import ScheduledService from './ScheduledService.js';

export class TidalService extends ScheduledService {
  constructor(stateService) {
    super('tidal', {
      interval: 7200000, // 2 hours
      immediate: true
    });
    this.stateService = stateService;
    this.baseUrl = 'https://marine-api.open-meteo.com/v1/marine';
  }


  async run() {
    console.log('[TidalService] Fetching tidal data...');
    
    try {
      const position = this.stateService.getState().navigation?.position;
      if (!position || !position.latitude?.value || !position.longitude?.value) {
        throw new Error('Position data not available');
      }
  
      const params = {
        latitude: position.latitude.value,
        longitude: position.longitude.value,
        hourly: ['wave_height', 'wave_direction', 'water_temperature'],
        current: ['wave_height', 'wave_direction', 'water_temperature'],
        timezone: 'auto'
      };
  
      console.log(`[TidalService] Fetching data with params:`, params);
      
      const responses = await fetchWeatherApi(this.baseUrl, params);
      const response = responses[0];
  
      if (!response) {
        throw new Error('No response from marine data service');
      }
  
      const current = response.current();
      const hourly = response.hourly();
  
      const tidalData = {
        current: {
          waveHeight: current.variables(0)?.value(),
          waveDirection: current.variables(1)?.value(),
          waterTemperature: current.variables(2)?.value()
        },
        hourly: {
          time: Array.from(
            { length: (Number(hourly.timeEnd()) - Number(hourly.time())) / hourly.interval() },
            (_, i) => new Date((Number(hourly.time()) + i * hourly.interval()) * 1000)
          ),
          waveHeight: hourly.variables(0)?.valuesArray() || [],
          waveDirection: hourly.variables(1)?.valuesArray() || [],
          waterTemperature: hourly.variables(2)?.valuesArray() || []
        },
        lastUpdated: new Date().toISOString()
      };
  
      // Update state
      this.stateService.setState('environment.tides', tidalData);
      
      return tidalData;
    } catch (error) {
      console.error('[TidalService] Error fetching tidal data:', error);
      throw error;
    }
  }
}