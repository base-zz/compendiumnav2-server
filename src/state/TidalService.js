import { fetchWeatherApi } from 'openmeteo';
import debug from 'debug';

const log = debug('cn2:tidal-service');
const error = debug('cn2:tidal-service:error');

// Marine API endpoint
const MARINE_API_URL = 'https://marine-api.open-meteo.com/v1/marine';

class TidalService {
    constructor(stateDataStore) {
        this.stateDataStore = stateDataStore;
        this.cache = {
            tidalData: null,
            lastFetch: null,
            cacheDuration: 3600000, // 1 hour in milliseconds
        };
    }

    async getTidalData() {
        try {
            // Check if we have valid cached data
            const now = Date.now();
            if (this.cache.tidalData && 
                this.cache.lastFetch && 
                (now - this.cache.lastFetch) < this.cache.cacheDuration) {
                log('Returning cached tidal data');
                return this.cache.tidalData;
            }

            // Get current position from state data
            const position = this.stateDataStore.getState('navigation.position');
            
            if (!position || !position.latitude || !position.longitude) {
                throw new Error('Position data not available in state store');
            }

            const params = {
                latitude: position.latitude,
                longitude: position.longitude,
                hourly: [
                    'wave_height', 'wave_direction', 'wave_period', 
                    'wind_wave_peak_period', 'wind_wave_height', 
                    'wind_wave_direction', 'wind_wave_period', 
                    'swell_wave_height', 'swell_wave_direction', 
                    'swell_wave_period', 'swell_wave_peak_period', 
                    'sea_level_height_msl', 'sea_surface_temperature', 
                    'ocean_current_velocity', 'ocean_current_direction'
                ],
                current: [
                    'wave_height', 'wave_direction', 'wave_period', 
                    'sea_level_height_msl', 'sea_surface_temperature', 
                    'ocean_current_velocity', 'ocean_current_direction'
                ],
                timezone: 'auto'
            };

            console.log(`Fetching marine data for position: ${position.latitude}, ${position.longitude}`);
            
            const responses = await fetchWeatherApi(MARINE_API_URL, params);
            const response = responses[0];

            if (!response) {
                throw new Error('No response from marine data service');
            }

            const utcOffsetSeconds = response.utcOffsetSeconds();
            const timezone = response.timezone();
            const timezoneAbbreviation = response.timezoneAbbreviation();
            const latitude = response.latitude();
            const longitude = response.longitude();

            const current = response.current();
            const hourly = response.hourly();

            // Process marine data
            const marineData = {
                current: {
                    time: new Date((Number(current.time()) + utcOffsetSeconds) * 1000),
                    seaLevelHeightMsl: current.variables(0)?.value(),
                    waveHeight: current.variables(1)?.value(),
                    waveDirection: current.variables(2)?.value(),
                    wavePeriod: current.variables(3)?.value(),
                    windWavePeakPeriod: current.variables(4)?.value(),
                    windWaveHeight: current.variables(5)?.value(),
                    windWaveDirection: current.variables(6)?.value(),
                    windWavePeriod: current.variables(7)?.value()
                },
                hourly: {
                    time: [...Array((Number(hourly.timeEnd()) - Number(hourly.time())) / hourly.interval())].map(
                        (_, i) => new Date((Number(hourly.time()) + i * hourly.interval() + utcOffsetSeconds) * 1000)
                    ),
                    waveHeight: hourly.variables(0)?.valuesArray() || [],
                    waveDirection: hourly.variables(1)?.valuesArray() || [],
                    wavePeriod: hourly.variables(2)?.valuesArray() || [],
                    windWaveDirection: hourly.variables(3)?.valuesArray() || [],
                    windWavePeriod: hourly.variables(4)?.valuesArray() || [],
                    swellWaveHeight: hourly.variables(5)?.valuesArray() || [],
                    swellWaveDirection: hourly.variables(6)?.valuesArray() || [],
                    swellWavePeriod: hourly.variables(7)?.valuesArray() || [],
                    oceanCurrentDirection: hourly.variables(8)?.valuesArray() || [],
                    oceanCurrentVelocity: hourly.variables(9)?.valuesArray() || [],
                    seaLevelHeightMsl: hourly.variables(10)?.valuesArray() || []
                },
                metadata: {
                    latitude,
                    longitude,
                    timezone,
                    timezoneAbbreviation,
                    lastUpdated: new Date().toISOString(),
                    source: 'openmeteo-marine',
                    note: 'Data from Open-Meteo Marine API'
                }
            };

            // Helper function to convert array-like objects to arrays
            const toArray = (obj, limit = 24) => {
                if (!obj) return [];
                if (Array.isArray(obj)) return obj.slice(0, limit);
                return Object.values(obj).slice(0, limit);
            };

            // Minimal logging for successful fetch
            log(`Fetched marine data with ${marineData.hourly?.time?.length || 0} hourly points`);
            
            // Update cache
            this.cache.tidalData = marineData;
            this.cache.lastFetch = now;
            return marineData;

        } catch (err) {
            error('Error fetching marine data:', err);
            // Return fallback data if the API call fails
            return this.getFallbackTidalData();
        }
    }
    
    // Fallback method that returns simulated data when the API is unavailable
    getFallbackTidalData() {
        const now = new Date();
        const hours = 24;
        const times = [];
        const waveHeights = [];
        const seaLevels = [];
        
        // Generate simple simulated data
        for (let i = 0; i < hours; i++) {
            const hour = new Date(now);
            hour.setHours(now.getHours() + i);
            times.push(hour);
            
            // Simulate semi-diurnal tide
            const tide = Math.sin((i / 6) * Math.PI);
            waveHeights.push(1.0 + (tide * 0.8)); // 0.2m to 1.8m waves
            seaLevels.push(0.5 + (tide * 0.3)); // Simulate small tidal changes
        }
        
        return {
            current: {
                time: now,
                seaLevelHeightMsl: seaLevels[0],
                waveHeight: waveHeights[0],
                waveDirection: 180,
                wavePeriod: 8,
                windWavePeakPeriod: 6,
                windWaveHeight: waveHeights[0] * 0.8,
                windWaveDirection: 225,
                windWavePeriod: 5
            },
            hourly: {
                time: times,
                waveHeight: waveHeights,
                waveDirection: waveHeights.map(() => 180 + (Math.random() * 90 - 45)),
                wavePeriod: waveHeights.map(h => 5 + (h * 2)),
                windWaveDirection: waveHeights.map(() => 225 + (Math.random() * 45 - 22.5)),
                windWavePeriod: waveHeights.map(h => 4 + (h * 1.5)),
                swellWaveHeight: waveHeights.map(h => h * 0.7),
                swellWaveDirection: waveHeights.map(() => 190 + (Math.random() * 30 - 15)),
                swellWavePeriod: waveHeights.map(h => 8 + (h * 1.2)),
                oceanCurrentDirection: waveHeights.map(() => 90 + (Math.random() * 60 - 30)),
                oceanCurrentVelocity: waveHeights.map(() => 0.5 + (Math.random() * 1.5)),
                seaLevelHeightMsl: seaLevels
            },
            metadata: {
                source: 'fallback',
                lastUpdated: new Date().toISOString(),
                note: 'Using fallback simulated marine data as the API is unavailable'
            }
        };
    }

    // Method to get the next high/low tide events
    async getNextTideEvents(count = 2) {
        try {
            const tidalData = await this.getTidalData();
            
            // Use sea level height data for tide prediction
            const seaLevels = tidalData.hourly?.seaLevelHeightMsl || [];
            const times = tidalData.hourly?.time || [];
            
            if (seaLevels.length < 3) {
                throw new Error('Not enough data points for tide prediction');
            }
            
            // Analyze the sea level data to find high and low tides
            const events = [];
            
            // Simple peak/valley detection algorithm
            for (let i = 1; i < seaLevels.length - 1; i++) {
                const prev = seaLevels[i - 1];
                const curr = seaLevels[i];
                const next = seaLevels[i + 1];
                
                // Check for high tide (peak)
                if (curr > prev && curr > next) {
                    events.push({
                        type: 'high',
                        time: times[i].toISOString(),
                        height: parseFloat(curr.toFixed(2)),
                        source: tidalData.metadata?.source || 'unknown'
                    });
                }
                // Check for low tide (valley)
                else if (curr < prev && curr < next) {
                    events.push({
                        type: 'low',
                        time: times[i].toISOString(),
                        height: parseFloat(curr.toFixed(2)),
                        source: tidalData.metadata?.source || 'unknown'
                    });
                }
                
                // Stop if we have enough events (2 events per tide cycle)
                if (events.length >= count * 2) {
                    break;
                }
            }
            
            // Filter for future events only
            const now = new Date();
            const futureEvents = events.filter(event => new Date(event.time) > now);
            
            // Sort by time and return requested count
            futureEvents.sort((a, b) => new Date(a.time) - new Date(b.time));
            
            // If we don't have enough future events, generate some fallback ones
            if (futureEvents.length < count) {
                return this.getFallbackTideEvents(count);
            }
            
            return futureEvents.slice(0, count);
            
        } catch (err) {
            error('Error getting next tide events:', err);
            // Return fallback data if there's an error
            return this.getFallbackTideEvents(count);
        }
    }
    
    // Helper method to generate fallback tide events
    getFallbackTideEvents(count) {
        const now = new Date();
        return [
            {
                type: 'high',
                time: new Date(now.getTime() + 6 * 60 * 60 * 1000).toISOString(),
                height: 1.2, // meters
                source: 'fallback',
                note: 'Using fallback tide prediction'
            },
            {
                type: 'low',
                time: new Date(now.getTime() + 12 * 60 * 60 * 1000).toISOString(),
                height: 0.3, // meters
                source: 'fallback',
                note: 'Using fallback tide prediction'
            }
        ].slice(0, count);
    }


    // Method to get current water level
    async getCurrentWaterLevel() {
        try {
            const tidalData = await this.getTidalData();
            
            // Check if we have valid current data
            if (!tidalData.current || !tidalData.current.time) {
                // Fallback to hourly data if current data is not available
                if (!tidalData.hourly?.seaLevelHeightMsl?.length) {
                    throw new Error('No water level data available');
                }
                return {
                    value: tidalData.hourly.seaLevelHeightMsl[0],
                    unit: 'm',
                    time: tidalData.hourly.time[0].toISOString()
                };
            }
            
            // Return current data if available
            return {
                value: tidalData.current.seaLevelHeightMsl,
                unit: 'm',
                time: tidalData.current.time.toISOString()
            };
        } catch (err) {
            error('Error getting current water level:', err);
            // Return a reasonable default value instead of throwing
            return {
                value: 0.5, // Default water level in meters
                unit: 'm',
                time: new Date().toISOString(),
                note: 'Using default water level due to error: ' + err.message
            };
        }
    }
}

export default TidalService;
