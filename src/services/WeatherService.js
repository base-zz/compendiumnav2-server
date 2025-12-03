import ScheduledService from "./ScheduledService.js";
import fetch from "node-fetch";
import debug from "debug";

console.log('[SERVICE] WeatherService module loaded');

export class WeatherService extends ScheduledService {
  /** @type {Object} */
  stateService;

  /** @type {Function|null} */
  _positionListener;

  /** @type {NodeJS.Timeout|null} */
  _delayedPositionCheck;

  debugLog = debug("weather-service");

  constructor() {
    super("weather", { interval: 900000, immediate: false, runOnInit: false });

    this.setServiceDependency("state");
    this.setServiceDependency("position");

    // Internal position state
    this.position = { latitude: null, longitude: null };
    this._hasScheduled = false;
    this._positionListener = null;
    this._stateFullUpdateHandler = null;
    this._delayedPositionCheck = null;
  }

  _seedPositionFromState() {
    if (!this.stateService || typeof this.stateService.getState !== 'function') {
      return false;
    }

    try {
      const state = this.stateService.getState();
      const navPosition = state?.navigation?.position;
      const latitude = navPosition?.latitude?.value ?? navPosition?.latitude ?? null;
      const longitude = navPosition?.longitude?.value ?? navPosition?.longitude ?? null;

      if (typeof latitude === 'number' && typeof longitude === 'number') {
        this.position = { latitude, longitude };
        return true;
      }
    } catch (error) {
      this.logError('Failed to seed weather position from state', error);
    }

    return false;
  }

  async _triggerInitialRunIfPossible() {
    if (this._hasScheduled) {
      return;
    }

    const hasInitialPosition = this._seedPositionFromState();
    if (hasInitialPosition) {
      this._hasScheduled = true;
      try {
        await this.run();
        this.log("WeatherService initial fetch complete.");
      } catch (err) {
        this.logError("Error running initial weather fetch:", err);
      }
      return;
    }

    // Set up deferred handler for when position becomes available later
    if (this.stateService && !this._stateFullUpdateHandler) {
      this._stateFullUpdateHandler = async () => {
        if (this._hasScheduled) {
          return;
        }
        const seeded = this._seedPositionFromState();
        if (!seeded) {
          return;
        }
        this._hasScheduled = true;
        try {
          await this.run();
          this.log("WeatherService initial fetch complete (post state update).");
        } catch (err) {
          this.logError("Error running weather fetch after state update:", err);
        }
        if (this.stateService && this._stateFullUpdateHandler) {
          this.stateService.off("state:full-update", this._stateFullUpdateHandler);
          this._stateFullUpdateHandler = null;
        }
      };
      this.stateService.on("state:full-update", this._stateFullUpdateHandler);
    }

    // Also set up a delayed check in case position arrives shortly after startup
    if (!this._delayedPositionCheck) {
      this._delayedPositionCheck = setTimeout(async () => {
        if (!this._hasScheduled && this._seedPositionFromState()) {
          this._hasScheduled = true;
          try {
            await this.run();
            this.log("WeatherService delayed initial fetch complete.");
            if (this.stateService && this._stateFullUpdateHandler) {
              this.stateService.off("state:full-update", this._stateFullUpdateHandler);
              this._stateFullUpdateHandler = null;
            }
          } catch (err) {
            this.logError("Error running delayed weather fetch:", err);
          }
        }
        this._delayedPositionCheck = null;
      }, 15000); // Check 15 seconds after startup
    }
  }

  async start() {
    if (this.isRunning) {
      return;
    }

    await super.start();

    const stateDependency = this.dependencies.state;
    if (!stateDependency || typeof stateDependency.getState !== "function") {
      throw new Error("WeatherService requires 'state' service with getState()");
    }
    this.stateService = stateDependency;

    const positionService = this.dependencies.position;
    if (!positionService || typeof positionService.on !== "function") {
      this.logError("WeatherService could not attach to PositionService");
      return;
    }

    if (this._positionListener) {
      positionService.off("position:update", this._positionListener);
      this._positionListener = null;
    }

    this._positionListener = async (position) => {
      if (
        position &&
        typeof position.latitude === "number" &&
        typeof position.longitude === "number"
      ) {
        this.position = {
          latitude: position.latitude,
          longitude: position.longitude,
        };

        if (!this._hasScheduled) {
          this._hasScheduled = true;
          try {
            await this.run();
          } catch (err) {
            this.logError("Error running initial weather fetch:", err);
          }
          this.log("WeatherService initial fetch complete.");
        }
      } else {
        this.logError("Received invalid position data from PositionService:", position);
      }
    };

    positionService.on("position:update", this._positionListener);
    this.debugLog("WeatherService attached to PositionService events");
    await this._triggerInitialRunIfPossible();
  }

  async stop() {
    if (this._positionListener && this.dependencies.position) {
      this.dependencies.position.off("position:update", this._positionListener);
      this._positionListener = null;
    }
    if (this.stateService && this._stateFullUpdateHandler) {
      this.stateService.off("state:full-update", this._stateFullUpdateHandler);
      this._stateFullUpdateHandler = null;
    }
    if (this._delayedPositionCheck) {
      clearTimeout(this._delayedPositionCheck);
      this._delayedPositionCheck = null;
    }
    await super.stop();
    this._hasScheduled = false;
  }

  /**
   * Implementation of the required run method from ScheduledService
   * @returns {Promise<void>}
   */
  async run() {
    return this.runNow();
  }

  async runNow() {
    this.debugLog("WeatherService.runNow() called");
    const { latitude, longitude } = this.position;
    if (
      typeof latitude !== "number" ||
      typeof longitude !== "number"
    ) {
      this.logError("No valid position available for weather fetch.");
      return;
    }
    this.debugLog(`Fetching weather for position: ${latitude}, ${longitude}`);

    // Check for user unit preferences
    let isMetric = false; // Default to imperial units for US users
    
    // If we have access to the state manager, check the user's preferences
    if (this.stateService && typeof this.stateService.getState === 'function') {
      try {
        const state = this.stateService.getState();
        // Check if user has set unit preferences (stored in userUnitPreferences)
        if (state && state.userUnitPreferences) {
          // If preset is IMPERIAL, use imperial units
          isMetric = state.userUnitPreferences.preset !== 'IMPERIAL';
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
        "visibility",
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
    this.log("Fetching weather from:", url);

    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Open-Meteo API error: ${response.statusText}`);
      }
      const weatherApiResponse = await response.json();
      
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
      
      this.emit("weather:update", formattedWeatherData);
      this.debugLog("Weather:update event emitted successfully");
    } catch (err) {
      this.logError("Weather fetch failed:", err);
    }
  }
}