import ScheduledService from "./ScheduledService.js";
import fetch from "node-fetch";
import debug from "debug";

export class WeatherService extends ScheduledService {
  /** @type {Object} */
  stateService;
  
  debugLog = debug("weather-service");
  constructor(stateService, positionService) {
    super("weather", { interval: 800000, immediate: false, runOnInit: false });
    
    // Store reference to state service if provided
    if (stateService) {
      this.stateService = stateService;
    }

    // Internal position state
    this.position = { latitude: null, longitude: null };
    this._hasScheduled = false;

    // Listen for position updates from PositionService
    if (positionService && typeof positionService.on === "function") {
      console.log("[WeatherService] Attaching to positionService events");
      this.debugLog("WeatherService attaching to positionService events");
      positionService.on("position:update", (position) => {
        // console.log("[WeatherService] Received position:update:", position);
        if (
          typeof position.latitude === "number" &&
          typeof position.longitude === "number"
        ) {
          this.position = {
            latitude: position.latitude,
            longitude: position.longitude,
          };

          // Start scheduled runs after first valid position
          if (!this._hasScheduled) {
            this._hasScheduled = true;
            console.log("[WeatherService] Starting scheduled runs...");
            this.runNow(); // Run immediately
            this.start();  // Start interval scheduling
            console.log("[WeatherService] Scheduling started.");
            this.log("WeatherService scheduling started.");
          }
        } else {
          console.log("[WeatherService] Received invalid position data:", position);
          this.logError("Received invalid position data from PositionService:", position);
        }
      });
    } else {
      console.log("[WeatherService] Could not attach to PositionService - missing or invalid");
      this.debugLog("WeatherService could not attach to PositionService - missing or invalid");
      this.logError(
        "WeatherService could not attach to PositionService (missing or invalid)"
      );
    }
  }

  /**
   * Implementation of the required run method from ScheduledService
   * @returns {Promise<void>}
   */
  async run() {
    return this.runNow();
  }

  async runNow() {
    console.log("[WeatherService] runNow() called");
    this.debugLog("WeatherService.runNow() called");
    const { latitude, longitude } = this.position;
    if (
      typeof latitude !== "number" ||
      typeof longitude !== "number"
    ) {
      console.log("[WeatherService] No valid position available for weather fetch.");
      this.logError("No valid position available for weather fetch.");
      return;
    }
    console.log(`[WeatherService] Fetching weather for position: ${latitude}, ${longitude}`);
    this.debugLog(`Fetching weather for position: ${latitude}, ${longitude}`);

    // Check for user unit preferences
    let isMetric = false; // Default to imperial units for US users
    
    // If we have access to the state manager, check the user's preferences
    if (this.stateService && typeof this.stateService.getState === 'function') {
      try {
        const state = this.stateService.getState();
        // Check if user has set unit preferences
        if (state && state.userPreferences && state.userPreferences.units) {
          // If preset is IMPERIAL, use imperial units
          isMetric = state.userPreferences.units.preset !== 'IMPERIAL';
        }
        this.debugLog(`Using ${isMetric ? 'metric' : 'imperial'} units based on user preferences`);
      } catch (err) {
        this.logError('Error getting unit preferences from state:', err);
      }
    }

    const params = new URLSearchParams({
      latitude: String(latitude),
      longitude: String(longitude),
      current: [
        "temperature_2m",
        "relative_humidity_2m",
        "apparent_temperature",
        "is_day",
        "precipitation",
        "rain",
        "showers",
        "weather_code",
        "cloud_cover",
        "pressure_msl",
        "surface_pressure",
        "wind_speed_10m",
        "wind_direction_10m",
        "wind_gusts_10m",
      ].join(","),
      hourly: [
        "temperature_2m",
        "relative_humidity_2m",
        "apparent_temperature",
        "precipitation",
        "rain",
        "showers",
        "weather_code",
        "cloud_cover",
        "pressure_msl",
        "surface_pressure",
        "wind_speed_10m",
        "wind_direction_10m",
        "wind_gusts_10m",
      ].join(","),
      daily: [
        "temperature_2m_max",
        "temperature_2m_min",
        "apparent_temperature_max",
        "apparent_temperature_min",
        "precipitation_sum",
        "rain_sum",
        "showers_sum",
        "weather_code",
        "sunrise",
        "sunset",
        "wind_speed_10m_max",
        "wind_gusts_10m_max",
      ].join(","),
      temperature_unit: isMetric ? "celsius" : "fahrenheit",
      wind_speed_unit: isMetric ? "kmh" : "mph",
      precipitation_unit: isMetric ? "mm" : "inch",
      timezone: "auto",
    });

    const url = `https://api.open-meteo.com/v1/forecast?${params.toString()}`;
    console.log("[WeatherService] Fetching weather from:", url);
    this.log("Fetching weather from:", url);

    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Open-Meteo API error: ${response.statusText}`);
      }
      const weatherApiResponse = await response.json();
      console.log("[WeatherService] Received weather data from API");
      
      // Format the data in the expected structure for clients
      const formattedWeatherData = {
        current: weatherApiResponse.current,
        hourly: weatherApiResponse.hourly,
        daily: weatherApiResponse.daily,
        metadata: {
          latitude: weatherApiResponse.latitude,
          longitude: weatherApiResponse.longitude,
          timezone: weatherApiResponse.timezone,
          lastUpdated: new Date().toISOString(),
        },
        // Add these fields that the client expects
        type: "weather:update",
        timestamp: new Date().toISOString(),
      };
      
      this.log("EMITTING weather:update EVENT with data structure:", {
        dataType: typeof formattedWeatherData,
        hasCurrentData: !!formattedWeatherData.current,
        hasHourlyData: !!formattedWeatherData.hourly,
        hasDailyData: !!formattedWeatherData.daily,
        hasMetadata: !!formattedWeatherData.metadata,
        timestamp: new Date().toISOString(),
      });
      
      // Make sure we have the expected structure for the client
      if (!formattedWeatherData.current || !formattedWeatherData.hourly || !formattedWeatherData.daily) {
        this.logError("Weather data is missing expected sections");
      }
      
      console.log("[WeatherService] Emitting weather:update event");
      this.emit("weather:update", formattedWeatherData);
      console.log("[WeatherService] Weather:update event emitted successfully");
      this.debugLog("Weather:update event emitted successfully");
    } catch (err) {
      console.log("[WeatherService] Weather fetch failed:", err);
      this.logError("Weather fetch failed:", err);
    }
  }
}