import ScheduledService from "./ScheduledService.js";
import { fetchWeatherApi } from "openmeteo";
import { UNIT_PRESETS } from "../shared/unitPreferences.js";
import debug from "debug";

console.log('[SERVICE] TidalService module loaded');

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

  /** @type {Function|null} */
  _positionListener;

  /** @type {NodeJS.Timeout|null} */
  _delayedPositionCheck;

  constructor() {
    super("tidal", {
      interval: 7200000, // 2 hours
      immediate: false,
      runOnInit: false,
    });

    this.setServiceDependency("state");
    this.setServiceDependency("position");

    this.baseUrl = "https://marine-api.open-meteo.com/v1/marine";
    this._currentFetch = null;

    // Internal position state
    this.position = { latitude: null, longitude: null };
    this._hasScheduled = false;
    this._positionListener = null;
    this._stateFullUpdateHandler = null;
    this._statePatchHandler = null;
    this._delayedPositionCheck = null;
  }

  _seedPositionFromState() {
    if (!this.stateService || typeof this.stateService.getState !== "function") {
      this.logError('TidalService: stateService not available or missing getState');
      return false;
    }

    try {
      const state = this.stateService.getState();
      const navPosition = state?.navigation?.position;
      const latitude = navPosition?.latitude?.value ?? navPosition?.latitude ?? null;
      const longitude = navPosition?.longitude?.value ?? navPosition?.longitude ?? null;

      // Check if we have actual values (not null)
      const hasValidLat = typeof latitude === "number" && Number.isFinite(latitude);
      const hasValidLon = typeof longitude === "number" && Number.isFinite(longitude);

      
      if (hasValidLat && hasValidLon) {
        this.position = { latitude, longitude };
        this.debugLog("Seeded tidal position from state", this.position);
        return true;
      }
      this.debugLog("Unable to seed tidal position from state", {
        latitudeType: typeof latitude,
        longitudeType: typeof longitude,
      });
    } catch (error) {
      this.logError("Failed to seed tidal position from state", error);
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
        this.log("TidalService initial fetch complete.");
      } catch (err) {
        this.logError("Error running initial tidal fetch:", err);
      }
      return;
    }

    // Set up deferred handlers for when position becomes available later
    this.debugLog("No initial tidal position available, deferring to state updates");
    if (this.stateService) {
      if (!this._stateFullUpdateHandler) {
        this._stateFullUpdateHandler = async () => {
          await this._handleDeferredStateUpdate("state:full-update");
        };
        this.stateService.on("state:full-update", this._stateFullUpdateHandler);
      }

      if (!this._statePatchHandler) {
        this._statePatchHandler = async (event) => {
          const patches = Array.isArray(event?.patches)
            ? event.patches
            : Array.isArray(event?.data)
            ? event.data
            : null;
          if (!patches) {
            return;
          }
          const touchesNavigation = patches.some(
            (patch) =>
              typeof patch.path === "string" &&
              patch.path.startsWith("/navigation/position")
          );
          if (touchesNavigation) {
            await this._handleDeferredStateUpdate("state:patch");
          }
        };
        this.stateService.on("state:patch", this._statePatchHandler);
      }
    }

    // Also set up a delayed check in case position arrives shortly after startup
    if (!this._delayedPositionCheck) {
      this._delayedPositionCheck = setTimeout(async () => {
        if (!this._hasScheduled && this._seedPositionFromState()) {
          this._hasScheduled = true;
          try {
            await this.run();
            this.log("TidalService delayed initial fetch complete.");
            this._cleanupStateFallbackHandlers();
          } catch (err) {
            this.logError("Error running delayed tidal fetch:", err);
          }
        }
        this._delayedPositionCheck = null;
      }, 15000); // Check 15 seconds after startup
    }
  }

  async _handleDeferredStateUpdate(source) {
    if (this._hasScheduled) {
      return;
    }
    const seeded = this._seedPositionFromState();
    if (!seeded) {
      this.debugLog(`No valid position available for deferred tidal fetch after ${source}`);
      return;
    }
    this._hasScheduled = true;
    try {
      await this.run();
      this.log(`TidalService initial fetch complete (post ${source}).`);
      this.debugLog(`TidalService initial fetch triggered by ${source}`);
    } catch (err) {
      this.logError(`Error running tidal fetch after ${source}:`, err);
    }
    this._cleanupStateFallbackHandlers();
  }

  _cleanupStateFallbackHandlers() {
    if (this.stateService && this._stateFullUpdateHandler) {
      this.stateService.off("state:full-update", this._stateFullUpdateHandler);
      this._stateFullUpdateHandler = null;
    }
    if (this.stateService && this._statePatchHandler) {
      this.stateService.off("state:patch", this._statePatchHandler);
      this._statePatchHandler = null;
    }
  }

  async start() {
    if (this.isRunning) {
      return;
    }

    await super.start();

    const stateDependency = this.dependencies.state;
    if (!stateDependency || typeof stateDependency.getState !== "function") {
      throw new Error("TidalService requires 'state' service with getState()");
    }
    this.stateService = stateDependency;

    const positionService = this.dependencies.position;
    if (!positionService || typeof positionService.on !== "function") {
      this.logError("TidalService could not attach to PositionService");
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
            this.logError("Error running initial tidal fetch:", err);
          }
          this.log("TidalService initial fetch complete.");
        }
      } else {
        this.logError("Received invalid position data from PositionService:", position);
      }
    };

    positionService.on("position:update", this._positionListener);
    this.debugLog("TidalService attached to PositionService events");
    await this._triggerInitialRunIfPossible();
  }

  async stop() {
    if (this._positionListener && this.dependencies.position) {
      this.dependencies.position.off("position:update", this._positionListener);
      this._positionListener = null;
    }
    this._cleanupStateFallbackHandlers();
    if (this._delayedPositionCheck) {
      clearTimeout(this._delayedPositionCheck);
      this._delayedPositionCheck = null;
    }
    await super.stop();
    this._hasScheduled = false;
  }

  /**
   * Get the current unit preferences from state or use defaults
   * @private
   */
  async _getUnitPreferences() {
    try {
      // Try to get preferences from state (stored in userUnitPreferences)
      const state = this.stateService?.getState();
      if (state?.userUnitPreferences) {
        return state.userUnitPreferences;
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

          this.log(
            `Fetching tidal data for position latitude=${latitude}, longitude=${longitude}`
          );

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
