import { fetchWeatherApi } from 'openmeteo';
import debug from 'debug';

const log = debug('cn2:weather-service');
const error = debug('cn2:weather-service:error');

class WeatherService {
    constructor(stateDataStore) {
        this.stateDataStore = stateDataStore;
        this.baseUrl = 'https://api.open-meteo.com/v1/forecast';
        this.cache = {
            weatherData: null,
            lastFetch: null,
            cacheDuration: 1800000, // 30 minutes in milliseconds
        };
    }

    async getWeatherData() {
        try {
            // Check if we have valid cached data
            const now = Date.now();
            if (this.cache.weatherData && 
                this.cache.lastFetch && 
                (now - this.cache.lastFetch) < this.cache.cacheDuration) {
                log('Returning cached weather data');
                return this.cache.weatherData;
            }

            // Get current position from state data
            const position = this.stateDataStore.getState('navigation.position');
            
            if (!position || !position.latitude || !position.longitude) {
                throw new Error('Position data not available in state store');
            }

            const params = {
                latitude: position.latitude,
                longitude: position.longitude,
                daily: [
                    'weather_code', 'temperature_2m_max', 'temperature_2m_min', 
                    'sunrise', 'sunset', 'daylight_duration', 'sunshine_duration', 
                    'uv_index_max', 'precipitation_hours', 'precipitation_probability_max', 
                    'wind_speed_10m_max', 'wind_gusts_10m_max'
                ],
                hourly: [
                    'temperature_2m', 'relative_humidity_2m', 'dew_point_2m', 
                    'precipitation_probability', 'precipitation', 'rain', 
                    'pressure_msl', 'wind_speed_10m', 'wind_speed_80m', 'uv_index'
                ],
                current: [
                    'temperature_2m', 'relative_humidity_2m', 'apparent_temperature', 
                    'precipitation', 'rain', 'showers', 'wind_speed_10m'
                ],
                timezone: 'auto',
            };

            log(`Fetching weather data for position: ${position.latitude}, ${position.longitude}`);
            
            const responses = await fetchWeatherApi(this.baseUrl, params);
            const response = responses[0];

            if (!response) {
                throw new Error('No response from weather data service');
            }

            const utcOffsetSeconds = response.utcOffsetSeconds();
            const timezone = response.timezone();
            const timezoneAbbreviation = response.timezoneAbbreviation();
            const latitude = response.latitude();
            const longitude = response.longitude();

            const current = response.current();
            const hourly = response.hourly();
            const daily = response.daily();

            const sunrise = daily.variables(3);
            const sunset = daily.variables(4);

            // Process weather data
            const weatherData = {
                current: {
                    time: new Date((Number(current.time()) + utcOffsetSeconds) * 1000),
                    temperature2m: current.variables(0)?.value(),
                    relativeHumidity2m: current.variables(1)?.value(),
                    apparentTemperature: current.variables(2)?.value(),
                    precipitation: current.variables(3)?.value(),
                    rain: current.variables(4)?.value(),
                    showers: current.variables(5)?.value(),
                    windSpeed10m: current.variables(6)?.value(),
                },
                hourly: {
                    time: [...Array((Number(hourly.timeEnd()) - Number(hourly.time())) / hourly.interval())].map(
                        (_, i) => new Date((Number(hourly.time()) + i * hourly.interval() + utcOffsetSeconds) * 1000)
                    ),
                    temperature2m: hourly.variables(0)?.valuesArray() || [],
                    relativeHumidity2m: hourly.variables(1)?.valuesArray() || [],
                    dewPoint2m: hourly.variables(2)?.valuesArray() || [],
                    precipitationProbability: hourly.variables(3)?.valuesArray() || [],
                    precipitation: hourly.variables(4)?.valuesArray() || [],
                    rain: hourly.variables(5)?.valuesArray() || [],
                    pressureMsl: hourly.variables(6)?.valuesArray() || [],
                    windSpeed10m: hourly.variables(7)?.valuesArray() || [],
                    windSpeed80m: hourly.variables(8)?.valuesArray() || [],
                    uvIndex: hourly.variables(9)?.valuesArray() || [],
                },
                daily: {
                    time: [...Array((Number(daily.timeEnd()) - Number(daily.time())) / daily.interval())].map(
                        (_, i) => new Date((Number(daily.time()) + i * daily.interval() + utcOffsetSeconds) * 1000)
                    ),
                    weatherCode: daily.variables(0)?.valuesArray() || [],
                    temperature2mMax: daily.variables(1)?.valuesArray() || [],
                    temperature2mMin: daily.variables(2)?.valuesArray() || [],
                    sunrise: sunrise ? [...Array(sunrise.valuesInt64Length())].map(
                        (_, i) => new Date((Number(sunrise.valuesInt64(i)) + utcOffsetSeconds) * 1000)
                    ) : [],
                    sunset: sunset ? [...Array(sunset.valuesInt64Length())].map(
                        (_, i) => new Date((Number(sunset.valuesInt64(i)) + utcOffsetSeconds) * 1000)
                    ) : [],
                    daylightDuration: daily.variables(5)?.valuesArray() || [],
                    sunshineDuration: daily.variables(6)?.valuesArray() || [],
                    uvIndexMax: daily.variables(7)?.valuesArray() || [],
                    precipitationHours: daily.variables(8)?.valuesArray() || [],
                    precipitationProbabilityMax: daily.variables(9)?.valuesArray() || [],
                    windSpeed10mMax: daily.variables(10)?.valuesArray() || [],
                    windGusts10mMax: daily.variables(11)?.valuesArray() || [],
                },
                metadata: {
                    latitude,
                    longitude,
                    timezone,
                    timezoneAbbreviation,
                    lastUpdated: new Date().toISOString()
                }
            };

            // Update cache with minimal logging
            this.cache.weatherData = weatherData;
            this.cache.lastFetch = now;
            log(`Fetched weather data with ${weatherData.hourly?.time?.length || 0} hourly points`);
            return weatherData;

        } catch (err) {
            error('Error fetching weather data:', err);
            throw err;
        }
    }

    // Helper methods to get specific weather data
    async getCurrentWeather() {
        try {
            const weatherData = await this.getWeatherData();
            return weatherData.current;
        } catch (err) {
            error('Error getting current weather:', err);
            throw err;
        }
    }

    async getHourlyForecast(hours = 24) {
        try {
            const weatherData = await this.getWeatherData();
            return {
                time: weatherData.hourly.time.slice(0, hours),
                temperature2m: weatherData.hourly.temperature2m.slice(0, hours),
                relativeHumidity2m: weatherData.hourly.relativeHumidity2m.slice(0, hours),
                precipitation: weatherData.hourly.precipitation.slice(0, hours),
                windSpeed10m: weatherData.hourly.windSpeed10m.slice(0, hours),
                uvIndex: weatherData.hourly.uvIndex.slice(0, hours)
            };
        } catch (err) {
            error('Error getting hourly forecast:', err);
            throw err;
        }
    }

    async getDailyForecast(days = 7) {
        try {
            const weatherData = await this.getWeatherData();
            return {
                time: weatherData.daily.time.slice(0, days),
                temperature2mMax: weatherData.daily.temperature2mMax.slice(0, days),
                temperature2mMin: weatherData.daily.temperature2mMin.slice(0, days),
                weatherCode: weatherData.daily.weatherCode.slice(0, days),
                precipitationProbabilityMax: weatherData.daily.precipitationProbabilityMax.slice(0, days),
                windSpeed10mMax: weatherData.daily.windSpeed10mMax.slice(0, days)
            };
        } catch (err) {
            error('Error getting daily forecast:', err);
            throw err;
        }
    }

    // Method to check if current weather conditions match certain criteria
    async checkWeatherConditions(conditions) {
        try {
            const current = await this.getCurrentWeather();
            
            const checks = {
                isRaining: current.rain > 0 || current.showers > 0,
                isWindy: current.windSpeed10m > (conditions.windyThreshold || 10), // m/s
                isCold: current.temperature2m < (conditions.coldThreshold || 10), // °C
                isHot: current.temperature2m > (conditions.hotThreshold || 30), // °C
                isHumid: current.relativeHumidity2m > (conditions.humidThreshold || 80), // %
            };

            return {
                ...checks,
                allConditionsMet: Object.values(checks).every(Boolean)
            };
        } catch (err) {
            error('Error checking weather conditions:', err);
            throw err;
        }
    }
}

export default WeatherService;
