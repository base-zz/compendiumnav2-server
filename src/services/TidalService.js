import ScheduledService from "./ScheduledService.js";
import { fetchWeatherApi } from "openmeteo";
import { UNIT_PRESETS } from "../shared/unitPreferences.js";
import debug from "debug";

export class TidalService extends ScheduledService {
  /** @type {Object} */
  stateService;

  /** @type {string} */
  baseUrl;

  /** @type {{latitude: number, longitude: number}} */
  position;

  /** @type {Promise|null} */
  _currentFetch;

  debugLog = debug("tidal-service");

  constructor(stateService, positionService) {
    super("tidal", {
      interval: 7200000, // 2 hours
      immediate: false,
      runOnInit: false,
    });

    // Initialize state service reference with type checking
    if (!stateService || typeof stateService.getState !== "function") {
      throw new Error("stateService must be provided and implement getState()");
    }

    this.stateService = stateService;
    this.baseUrl = "https://marine-api.open-meteo.com/v1/marine";
    this._currentFetch = null;

    // Internal position state
    this.position = { latitude: null, longitude: null };
    this._hasScheduled = false;

    // Listen for position updates from PositionService
    if (positionService && typeof positionService.on === "function") {
      this.debugLog("TidalService attaching to positionService events");
      positionService.on("position:update", (position) => {
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
            this.runNow(); // Run immediately
            this.start(); // Start interval scheduling
            this.log("TidalService scheduling started.");
          }
        } else {
          this.logError(
            "Received invalid position data from PositionService:",
            position
          );
        }
      });
    } else {
      this.logError("TidalService could not attach to PositionService");
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
      // Check both possible paths for unit preferences
      if (state?.userPreferences?.units) {
        return state.userPreferences.units;
      } else if (state?.preferences?.units) {
        return state.preferences.units;
      }
      // Fall back to imperial defaults if no preferences found
      return UNIT_PRESETS.IMPERIAL;
    } catch (error) {
      this.log(
        "Could not get unit preferences, using defaults:",
        error.message
      );
      return UNIT_PRESETS.IMPERIAL;
    }
  }

  /**
   * Trigger an immediate run of the tidal data fetch
   * @returns {Promise<*>} The result of the task
   */
  async runNow() {
    this.log("runNow() called: triggering immediate tidal data fetch");
    return this.run();
  }

  async run() {
    this.log("TidalService.run() called");

    try {
      // Create a promise that resolves when the current fetch completes
      this._currentFetch = (async () => {
        try {
          const { latitude, longitude } = this.position;
          if (typeof latitude !== "number" || typeof longitude !== "number") {
            this.logError("No valid position available for tidal data fetch.");
            return;
          }

          // Get user's unit preferences
          const unitPrefs = await this._getUnitPreferences();
          let isMetric = false;
          if (unitPrefs?.preset) {
            isMetric = unitPrefs.preset !== "IMPERIAL";
          } else if (unitPrefs?.length) {
            isMetric = unitPrefs.length === "m";
          }

          // Define unit settings in a separate object for reuse
          const unitSettings = {
            temperature: unitPrefs?.temperature === "°C" ? "celsius" : "fahrenheit",
            windSpeed: "kn", // Always use knots for marine applications
            waveHeight: isMetric ? "m" : "ft",
            currentVelocity: isMetric ? "kmh" : "mph",
            length: isMetric ? "metric" : "imperial",
            precipitation: isMetric ? "mm" : "inch"
          };

          // Format for display to clients
          const displayUnits = {
            temperature: isMetric ? "°C" : "°F",
            windSpeed: "kn", // Always knots for marine applications
            waveHeight: isMetric ? "m" : "ft",
            currentVelocity: isMetric ? "km/h" : "kn"
          };

          this.log(
            `Using ${
              isMetric ? "metric" : "imperial"
            } units based on user preferences`
          );

          const params = {
            latitude,
            longitude,
            // Daily forecast
            daily: [
              "wave_height_max",
              "wave_direction_dominant",
              "wave_period_max",
              "wind_wave_height_max",
              "wind_wave_direction_dominant",
              "swell_wave_height_max",
              "swell_wave_direction_dominant",
            ],
            // Hourly forecast
            hourly: [
              "wave_height",
              "wave_direction",
              "wave_period",
              "wind_wave_peak_period",
              "wind_wave_height",
              "wind_wave_direction",
              "wind_wave_period",
              "swell_wave_height",
              "swell_wave_direction",
              "swell_wave_period",
              "swell_wave_peak_period",
              "sea_level_height_msl",
              "sea_surface_temperature",
              "ocean_current_velocity",
              "ocean_current_direction",
            ],
            // Current conditions
            current: [
              "wave_height",
              "wave_direction",
              "wave_period",
              "sea_level_height_msl",
              "sea_surface_temperature",
              "ocean_current_velocity",
              "ocean_current_direction",
            ],
            // Set units based on preferences
            temperature_unit: unitSettings.temperature,
            wind_speed_unit: unitSettings.windSpeed,
            wave_height_unit: unitSettings.waveHeight,
            current_velocity_unit: unitSettings.currentVelocity,
            "length_unit": unitSettings.length,
            // Ensure we're explicitly setting all unit-related parameters
            precipitation_unit: unitSettings.precipitation,
            timezone: "auto",
            timeformat: "iso8601",
          };

          // Make the API request using openmeteo's fetchWeatherApi
          const responses = await fetchWeatherApi(this.baseUrl, params);

          // Process first location
          const response = responses[0];

          if (!response) {
            throw new Error("No response data received from the API");
          }

          this.log(`Raw marine data received`);

          // Get metadata from response
          const utcOffsetSeconds = response.utcOffsetSeconds();
          const timezone = response.timezone();
          const timezoneAbbreviation = response.timezoneAbbreviation();
          const responseLatitude = response.latitude();
          const responseLongitude = response.longitude();

          // Get the actual data objects
          const current = response.current();
          const hourly = response.hourly();
          const daily = response.daily();

          if (!current || !hourly || !daily) {
            throw new Error("Incomplete response data from the API");
          }

          const now = new Date().toISOString();
          // Extract position values safely, ensuring they're primitive numbers
          const positionData = {
            latitude: latitude != null ? Number(latitude) : null,
            longitude: longitude != null ? Number(longitude) : null,
          };

          // Process the marine data into our state format
          const marineData = {
            // Add these fields that the client expects
            type: "tide:update",
            timestamp: now,
            // Include units information in the response
            units: displayUnits,
            current: {
              time: new Date(
                (Number(current.time()) + utcOffsetSeconds) * 1000
              ).toISOString(),
              values: {
                waveHeight: current.variables(0)?.value(),
                waveDirection: current.variables(1)?.value(),
                wavePeriod: current.variables(2)?.value(),
                seaLevelHeightMsl: current.variables(3)?.value(),
                seaSurfaceTemperature: current.variables(4)?.value(),
                oceanCurrentVelocity: current.variables(5)?.value(),
                oceanCurrentDirection: current.variables(6)?.value(),
              },
            },
            hourly: {
              time: [
                ...Array(
                  (Number(hourly.timeEnd()) - Number(hourly.time())) /
                    hourly.interval()
                ),
              ].map((_, i) =>
                new Date(
                  (Number(hourly.time()) +
                    i * hourly.interval() +
                    utcOffsetSeconds) *
                    1000
                ).toISOString()
              ),
              values: {
                waveHeight: hourly.variables(0)?.valuesArray() || [],
                waveDirection: hourly.variables(1)?.valuesArray() || [],
                wavePeriod: hourly.variables(2)?.valuesArray() || [],
                windWavePeakPeriod: hourly.variables(3)?.valuesArray() || [],
                windWaveHeight: hourly.variables(4)?.valuesArray() || [],
                windWaveDirection: hourly.variables(5)?.valuesArray() || [],
                windWavePeriod: hourly.variables(6)?.valuesArray() || [],
                swellWaveHeight: hourly.variables(7)?.valuesArray() || [],
                swellWaveDirection: hourly.variables(8)?.valuesArray() || [],
                swellWavePeriod: hourly.variables(9)?.valuesArray() || [],
                swellWavePeakPeriod: hourly.variables(10)?.valuesArray() || [],
                seaLevelHeightMsl: hourly.variables(11)?.valuesArray() || [],
                seaSurfaceTemperature:
                  hourly.variables(12)?.valuesArray() || [],
                oceanCurrentVelocity: hourly.variables(13)?.valuesArray() || [],
                oceanCurrentDirection:
                  hourly.variables(14)?.valuesArray() || [],
              },
            },
            daily: {
              time: [
                ...Array(
                  (Number(daily.timeEnd()) - Number(daily.time())) /
                    daily.interval()
                ),
              ].map((_, i) =>
                new Date(
                  (Number(daily.time()) +
                    i * daily.interval() +
                    utcOffsetSeconds) *
                    1000
                ).toISOString()
              ),
              values: {
                waveHeightMax: daily.variables(0)?.valuesArray() || [],
                waveDirectionDominant: daily.variables(1)?.valuesArray() || [],
                wavePeriodMax: daily.variables(2)?.valuesArray() || [],
                windWaveHeightMax: daily.variables(3)?.valuesArray() || [],
                windWaveDirectionDominant:
                  daily.variables(4)?.valuesArray() || [],
              },
            },
            metadata: {
              latitude: responseLatitude,
              longitude: responseLongitude,
              timezone,
              timezoneAbbreviation,
              last_updated: now,
              units: displayUnits,
            },
          };

          // Log the raw data for debugging
          this.log("Processed marine data:");

          this.log("EMITTING tide:update EVENT with data structure:", {
            dataType: typeof marineData,
            hasCurrentData: !!marineData.current,
            hasHourlyData: !!marineData.hourly,
            hasDailyData: !!marineData.daily,
            timestamp: marineData.timestamp,
          });

          // Check if we have listeners for the tide:update event
          const hasListeners = this.listenerCount("tide:update") > 0;
          this.log(
            `Has tide:update listeners: ${hasListeners}, count: ${this.listenerCount(
              "tide:update"
            )}`
          );

          // Emit the event
          this.emit("tide:update", marineData);
          // Return the data that was stored in the state
          return marineData;
        } finally {
          this._currentFetch = null;
        }
      })();

      return await this._currentFetch;
    } catch (error) {
      this.logError("Error fetching tidal data:", error);
      throw error;
    }
  }
}
