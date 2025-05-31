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
        hourly: 'wave_height,wave_direction,water_temperature',
        current: 'wave_height,wave_direction,water_temperature'
      };

      const url = `${this.baseUrl}?${new URLSearchParams(params)}`;
      console.log(`[TidalService] Fetching data from: ${url}`);
      
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      
      // Process and return the data
      const tidalData = {
        current: {
          waveHeight: data.current?.wave_height,
          waveDirection: data.current?.wave_direction,
          waterTemperature: data.current?.water_temperature
        },
        // Add hourly data if needed
        hourly: data.hourly,
        lastUpdated: new Date().toISOString()
      };

      // Update state
      const currentState = this.stateService.getState();
      this.stateService.updateState({
        environment: {
          ...(currentState.environment || {}),
          tide: tidalData
        }
      });

      this.emit('data:updated', tidalData);
      return tidalData;
    } catch (error) {
      console.error('[TidalService] Error fetching tidal data:', error);
      this.emit('error', error);
      throw error;
    }
  }
}
