import ScheduledService from "./ScheduledService.js";
import { fetchWeatherApi } from "openmeteo";
import { UNIT_PRESETS } from "../shared/unitPreferences.js";
import debug from "debug";
import { findNearestTideStation, findNearestCurrentStation } from "./noaa/NoaaStationIndex.js";
import {
  fetchNoaaTidePredictions,
  fetchNoaaCurrentPredictions,
  interpolateHourlyTides,
  buildTidePayload,
} from "./noaa/NoaaDataFetcher.js";
import {
  findNearestBuoyStation,
  fetchNdbcBuoyData,
  buildWaveComparison,
} from "./noaa/NdbcBuoyFetcher.js";
import {
  fetchNwsMarineForecast,
  extractMarineHazards,
} from "./noaa/NwsMarineFetcher.js";
import { getSunMoonData } from "./noaa/SunMoonCalculator.js";
import {
  findNearestPortsStation,
  fetchPortsCurrentData,
  assessInletConditions,
} from "./noaa/PortsCurrentFetcher.js";

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

    // NOAA station tracking
    this._currentTideStation = null;
    this._currentCurrentStation = null;
    this._currentBuoyStation = null;
    this._currentPortsStation = null;
    this._maxStationDistanceKm = 100; // Max distance to use NOAA station (about 54 nm)
    this._maxBuoyDistanceKm = 150; // Buoys can be further offshore
    this._maxPortsDistanceKm = 50; // PORTS stations are at specific harbors/inlets

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
      this.log(
        `Initial tidal fetch scheduled with position latitude=${this.position.latitude}, longitude=${this.position.longitude}`
      );
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
    this.log(
      `Deferred tidal fetch scheduled (${source}) with position latitude=${this.position.latitude}, longitude=${this.position.longitude}`
    );
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
          this.log(
            `Initial tidal fetch scheduled from PositionService with position latitude=${position.latitude}, longitude=${position.longitude}`
          );
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
      this._currentFetch = (async () => {
        try {
          const { latitude, longitude } = this.position;
          if (typeof latitude !== "number" || typeof longitude !== "number") {
            this.logError("No valid position available for tidal data fetch.");
            return;
          }

          const unitPrefs = await this._getUnitPreferences();
          let isMetric = false;
          if (unitPrefs?.preset) {
            isMetric = unitPrefs.preset !== "IMPERIAL";
          } else if (unitPrefs?.length) {
            isMetric = unitPrefs.length === "m";
          }

          const noaaUnits = isMetric ? "metric" : "english";

          this.log(
            `Fetching tidal data for position latitude=${latitude}, longitude=${longitude}`
          );

          // Find nearest NOAA tide station
          const tideStation = await findNearestTideStation(latitude, longitude, {
            maxDistanceKm: this._maxStationDistanceKm,
          });

          // Find nearest NOAA current station
          const currentStation = await findNearestCurrentStation(latitude, longitude, {
            maxDistanceKm: this._maxStationDistanceKm,
          });

          // Find nearest NDBC buoy for wave observations
          const buoyStation = await findNearestBuoyStation(latitude, longitude, {
            maxDistanceKm: this._maxBuoyDistanceKm,
          });

          this._currentTideStation = tideStation;
          this._currentCurrentStation = currentStation;
          this._currentBuoyStation = buoyStation;

          if (tideStation) {
            this.log(
              `Found NOAA tide station: ${tideStation.name} (${tideStation.id}) at ${tideStation.distanceKm.toFixed(1)} km`
            );
          } else {
            this.log(
              `No NOAA tide station within ${this._maxStationDistanceKm} km, will use Open-Meteo only`
            );
          }

          if (currentStation) {
            this.log(
              `Found NOAA current station: ${currentStation.name} (${currentStation.id}) at ${currentStation.distanceKm.toFixed(1)} km`
            );
          }

          if (buoyStation) {
            this.log(
              `Found NDBC buoy: ${buoyStation.name} (${buoyStation.id}) at ${buoyStation.distanceKm.toFixed(1)} km`
            );
          }

          // Fetch NOAA tide predictions if station available
          let hiloData = null;
          let hourlyTideData = null;
          const forecastHours = 120; // 5 days
          if (tideStation) {
            try {
              hiloData = await fetchNoaaTidePredictions(tideStation.id, {
                rangeHours: forecastHours,
                units: noaaUnits,
              });
              this.log(`Fetched ${hiloData.length} NOAA tide predictions`);

              hourlyTideData = interpolateHourlyTides(hiloData, forecastHours);
              this.log(`Interpolated ${hourlyTideData.length} hourly tide values`);
            } catch (err) {
              this.logError("Failed to fetch NOAA tide predictions:", err);
            }
          }

          // Fetch NOAA current predictions if station available
          let currentData = null;
          if (currentStation) {
            try {
              currentData = await fetchNoaaCurrentPredictions(currentStation.id, {
                rangeHours: forecastHours,
                units: noaaUnits,
                bin: currentStation.bin,
              });
              this.log(`Fetched ${currentData.length} NOAA current predictions`);
            } catch (err) {
              this.logError("Failed to fetch NOAA current predictions:", err);
            }
          }

          // Fetch Open-Meteo data for waves/SST (always needed for wave data)
          let openMeteoData = null;
          try {
            openMeteoData = await this._fetchOpenMeteoData(latitude, longitude, isMetric);
            this.log("Fetched Open-Meteo wave/SST data");
          } catch (err) {
            this.logError("Failed to fetch Open-Meteo data:", err);
          }

          // Fetch NDBC buoy observations if station available
          let ndbcData = null;
          if (buoyStation) {
            try {
              ndbcData = await fetchNdbcBuoyData(buoyStation.id, { hoursToFetch: 24 });
              this.log(`Fetched ${ndbcData.observationCount} NDBC buoy observations`);
            } catch (err) {
              this.logError("Failed to fetch NDBC buoy data:", err);
            }
          }

          // Build wave comparison between NDBC (observed) and Open-Meteo (modeled)
          const waveComparison = buildWaveComparison(ndbcData, openMeteoData);
          if (waveComparison) {
            this.log(
              `Wave comparison: NDBC=${waveComparison.ndbc.waveHeight}m, Open-Meteo=${waveComparison.openMeteo.waveHeight}m, diff=${waveComparison.comparison.waveHeightDifference}m (${waveComparison.comparison.correlationNote})`
            );
          }

          // Fetch NWS marine forecast
          let nwsForecast = null;
          let marineHazards = [];
          try {
            nwsForecast = await fetchNwsMarineForecast(latitude, longitude);
            marineHazards = extractMarineHazards(nwsForecast.alerts || []);
            this.log(`Fetched NWS forecast with ${nwsForecast.alerts?.length || 0} alerts, ${marineHazards.length} marine hazards`);
          } catch (err) {
            this.logError("Failed to fetch NWS marine forecast:", err);
          }

          // Calculate sun/moon data
          let sunMoonData = null;
          try {
            sunMoonData = getSunMoonData(latitude, longitude, new Date());
            this.log(`Calculated sun/moon data: sunrise=${sunMoonData.sun.sunrise}, moon phase=${sunMoonData.moon.phaseName}`);
          } catch (err) {
            this.logError("Failed to calculate sun/moon data:", err);
          }

          // Find and fetch PORTS real-time current data (for inlet conditions)
          let portsStation = null;
          let portsData = null;
          try {
            portsStation = await findNearestPortsStation(latitude, longitude, {
              maxDistanceKm: this._maxPortsDistanceKm,
            });
            this._currentPortsStation = portsStation;

            if (portsStation) {
              this.log(`Found PORTS station: ${portsStation.name} (${portsStation.id}) at ${portsStation.distanceKm.toFixed(1)} km`);
              portsData = await fetchPortsCurrentData(portsStation.id, { hoursToFetch: 6 });
              this.log(`Fetched ${portsData.observationCount} PORTS current observations`);
            }
          } catch (err) {
            this.logError("Failed to fetch PORTS data:", err);
          }

          // Assess inlet conditions if we have relevant data
          let inletConditions = null;
          const currentPrediction = currentData?.length ? currentData.find((c) => new Date(c.time) > new Date()) : null;
          if (currentPrediction || portsData || ndbcData) {
            try {
              inletConditions = assessInletConditions({
                currentPrediction,
                portsObservation: portsData,
                buoyObservation: ndbcData,
                windSpeed: nwsForecast?.hourlyForecast?.[0]?.windSpeed ? parseInt(nwsForecast.hourlyForecast[0].windSpeed) : null,
                windDirection: null,
              });
              this.log(`Inlet conditions: ${inletConditions.riskLevel} risk, ${inletConditions.riskFactors.length} factors`);
            } catch (err) {
              this.logError("Failed to assess inlet conditions:", err);
            }
          }

          // Build unified payload
          const payload = buildTidePayload({
            hiloData,
            hourlyData: hourlyTideData,
            currentData,
            tideStation,
            currentStation,
            buoyStation,
            ndbcData,
            waveComparison,
            nwsForecast,
            marineHazards,
            sunMoonData,
            portsStation,
            portsData,
            inletConditions,
            units: noaaUnits,
            openMeteoData,
          });

          this.emit("tide:update", payload);
          return payload;
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

  async _fetchOpenMeteoData(latitude, longitude, isMetric) {
    const unitSettings = {
      temperature: isMetric ? "celsius" : "fahrenheit",
      windSpeed: "kn",
      waveHeight: isMetric ? "m" : "ft",
      currentVelocity: isMetric ? "kmh" : "mph",
      length: isMetric ? "metric" : "imperial",
      precipitation: isMetric ? "mm" : "inch",
    };

    const params = {
      latitude,
      longitude,
      daily: [
        "wave_height_max",
        "wave_direction_dominant",
        "wave_period_max",
        "wind_wave_height_max",
        "wind_wave_direction_dominant",
        "swell_wave_height_max",
        "swell_wave_direction_dominant",
      ],
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
        "sea_surface_temperature",
        "ocean_current_velocity",
        "ocean_current_direction",
      ],
      current: [
        "wave_height",
        "wave_direction",
        "wave_period",
        "sea_surface_temperature",
        "ocean_current_velocity",
        "ocean_current_direction",
      ],
      temperature_unit: unitSettings.temperature,
      wind_speed_unit: unitSettings.windSpeed,
      wave_height_unit: unitSettings.waveHeight,
      current_velocity_unit: unitSettings.currentVelocity,
      length_unit: unitSettings.length,
      precipitation_unit: unitSettings.precipitation,
      timezone: "auto",
      timeformat: "iso8601",
    };

    const responses = await fetchWeatherApi(this.baseUrl, params);
    const response = responses[0];

    if (!response) {
      throw new Error("No response data received from Open-Meteo API");
    }

    const utcOffsetSeconds = response.utcOffsetSeconds();
    const current = response.current();
    const hourly = response.hourly();
    const daily = response.daily();

    if (!current || !hourly || !daily) {
      throw new Error("Incomplete response data from Open-Meteo API");
    }

    return {
      current: {
        time: new Date(
          (Number(current.time()) + utcOffsetSeconds) * 1000
        ).toISOString(),
        values: {
          waveHeight: current.variables(0)?.value(),
          waveDirection: current.variables(1)?.value(),
          wavePeriod: current.variables(2)?.value(),
          seaSurfaceTemperature: current.variables(3)?.value(),
          oceanCurrentVelocity: current.variables(4)?.value(),
          oceanCurrentDirection: current.variables(5)?.value(),
        },
      },
      hourly: {
        time: [
          ...Array(
            (Number(hourly.timeEnd()) - Number(hourly.time())) / hourly.interval()
          ),
        ].map((_, i) =>
          new Date(
            (Number(hourly.time()) + i * hourly.interval() + utcOffsetSeconds) * 1000
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
          seaSurfaceTemperature: hourly.variables(11)?.valuesArray() || [],
          oceanCurrentVelocity: hourly.variables(12)?.valuesArray() || [],
          oceanCurrentDirection: hourly.variables(13)?.valuesArray() || [],
        },
      },
      daily: {
        time: [
          ...Array(
            (Number(daily.timeEnd()) - Number(daily.time())) / daily.interval()
          ),
        ].map((_, i) =>
          new Date(
            (Number(daily.time()) + i * daily.interval() + utcOffsetSeconds) * 1000
          ).toISOString()
        ),
        values: {
          waveHeightMax: daily.variables(0)?.valuesArray() || [],
          waveDirectionDominant: daily.variables(1)?.valuesArray() || [],
          wavePeriodMax: daily.variables(2)?.valuesArray() || [],
          windWaveHeightMax: daily.variables(3)?.valuesArray() || [],
          windWaveDirectionDominant: daily.variables(4)?.valuesArray() || [],
        },
      },
    };
  }
}
