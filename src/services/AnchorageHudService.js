import BaseService from "./BaseService.js";
import { getStateManager } from "../relay/core/state/StateManager.js";
import Database from "better-sqlite3";
import storageService from "../bluetooth/services/storage/storageService.js";
import {
  parseGPXRoute,
  calculateRouteDistances,
  findClosestRoutePoint,
} from "../bridges/gpx-route-parser.js";
import { queryAnchoragesAlongRoute } from "../bridges/route-queries.js";

/**
 * Anchorage HUD lifecycle and efficiency model:
 * - Stays dormant when no active route exists.
 * - Registers route/state listeners only while a route is active.
 * - Loads anchorages once per active route using route-based spatial filtering.
 * - Re-scores recommendations from live state (boat/forecast/tide/current) without
 *   re-querying the database each cycle.
 * - Refreshes consistently from filtered anchorage-relevant patch events,
 *   while still avoiding direct weather/tide service subscriptions.
 */
export class AnchorageHudService extends BaseService {
  constructor(options) {
    super("anchorage-hud", "continuous");

    if (!options || typeof options !== "object") {
      throw new Error("AnchorageHudService requires options");
    }

    this.dbPath = options.dbPath;
    this.shorelineDbPath = options.shorelineDbPath;
    this.shorelineSpatiaLitePath = options.shorelineSpatiaLitePath;
    this._storageService = storageService;
    this._stateManager = getStateManager();

    this._activeRouteId = null;
    this._routeGpxData = null;
    this._routeWithDistances = [];

    this._anchoragesAlongRoute = [];
    this._boatState = {
      latitude: null,
      longitude: null,
      sog: null,
      routeProgressNm: null,
      lastRecomputeAt: null,
    };

    this._preferences = null;

    this._activeRouteHandler = null;
    this._anchoragePatchHandler = null;

    this._shorelineDb = null;
    this._shorelineDistanceStmt = null;
    this._shorelineConfigWarningShown = false;
    this._shorelineRuntimeWarningShown = false;

    this._lastRecommendationsSignature = null;
    this._lastSummarySignature = null;
  }

  async start() {
    if (this.isRunning) {
      return;
    }

    if (!this.dbPath || typeof this.dbPath !== "string" || !this.dbPath.trim()) {
      throw new Error("AnchorageHudService requires ANCHORAGE_DB_PATH to be defined");
    }

    this._stateManager = getStateManager();
    if (!this._stateManager) {
      throw new Error("AnchorageHudService requires a StateManager instance");
    }

    await super.start();

    this._initializeAsync().catch((err) => {
      console.error("[AnchorageHudService] Background initialization failed:", err);
    });
  }

  async _initializeAsync() {
    await this._fetchUserConfig();
    this._initShorelineDatabase();
    await this._loadRouteAndAnchorages();

    this._registerActiveRouteHandler();

    if (this._activeRouteId) {
      this._registerRuntimeHandlers();
      this._recomputeAndPublish();
    }
  }

  async stop() {
    if (!this.isRunning) {
      return;
    }

    this._unregisterRuntimeHandlers();

    if (this._stateManager && this._activeRouteHandler) {
      this._stateManager.off("state:active-route", this._activeRouteHandler);
    }
    this._activeRouteHandler = null;

    if (this._shorelineDb) {
      this._shorelineDb.close();
      this._shorelineDb = null;
      this._shorelineDistanceStmt = null;
    }

    await super.stop();
  }

  _registerActiveRouteHandler() {
    if (this._activeRouteHandler) {
      return;
    }

    this._activeRouteHandler = (event) => {
      this._handleActiveRouteEvent(event);
    };

    this._stateManager.on("state:active-route", this._activeRouteHandler);
  }

  _registerRuntimeHandlers() {
    if (!this._anchoragePatchHandler) {
      this._anchoragePatchHandler = (event) => {
        if (!event || !Array.isArray(event.data)) {
          return;
        }
        this._processAnchoragePatch(event.data);
      };
      this._stateManager.on("state:anchorage-patch", this._anchoragePatchHandler);
    }
  }

  _unregisterRuntimeHandlers() {
    if (this._stateManager && this._anchoragePatchHandler) {
      this._stateManager.off("state:anchorage-patch", this._anchoragePatchHandler);
    }
    this._anchoragePatchHandler = null;
  }

  async _handleActiveRouteEvent(event) {
    const newRouteId = event?.routeId || null;

    if (newRouteId && newRouteId !== this._activeRouteId) {
      this._activeRouteId = newRouteId;
      await this._fetchUserConfig(newRouteId);
      this._initShorelineDatabase();
      await this._loadRouteAndAnchorages();
      this._registerRuntimeHandlers();
      this._recomputeAndPublish();
      return;
    }

    if (!newRouteId && this._activeRouteId) {
      this._activeRouteId = null;
      this._routeGpxData = null;
      this._routeWithDistances = [];
      this._anchoragesAlongRoute = [];
      this._boatState.routeProgressNm = null;
      this._unregisterRuntimeHandlers();
      this._publishRecommendations([]);
      this._publishSummary(null);
    }
  }

  _processAnchoragePatch(patchData) {
    if (!this._activeRouteId) {
      return;
    }

    let shouldRecompute = false;

    for (const patch of patchData) {
      if (typeof patch?.path !== "string") {
        continue;
      }

      if (
        patch.path.startsWith("/position/") ||
        patch.path.startsWith("/navigation/") ||
        patch.path.startsWith("/forecast/") ||
        patch.path === "/forecast" ||
        patch.path.startsWith("/tides/") ||
        patch.path === "/tides" ||
        patch.path === "/vessel/info/dimensions/draft" ||
        patch.path.startsWith("/vessel/info/dimensions/draft/") ||
        patch.path.startsWith("/routes/")
      ) {
        shouldRecompute = true;
        break;
      }
    }

    if (shouldRecompute) {
      this._recomputeAndPublish();
    }
  }

  _initShorelineDatabase() {
    if (this._shorelineDb) {
      this._shorelineDb.close();
      this._shorelineDb = null;
      this._shorelineDistanceStmt = null;
    }

    const shorelinePreferences = this._preferences?.shorelineProtection;
    const shorelineEnabled = shorelinePreferences?.enabled;

    if (!shorelineEnabled) {
      return;
    }

    const shorelineDbPath = shorelinePreferences?.shorelineDbPath ?? this.shorelineDbPath;
    if (typeof shorelineDbPath !== "string" || !shorelineDbPath.trim()) {
      if (!this._shorelineConfigWarningShown) {
        console.warn("[AnchorageHudService] shorelineProtection.enabled is true but shorelineProtection.shorelineDbPath is missing and no shorelineDbPath service option was provided; add one to use shoreline topology scoring.");
        this._shorelineConfigWarningShown = true;
      }
      return;
    }

    const spatiaLitePath = shorelinePreferences?.spatiaLitePath ?? this.shorelineSpatiaLitePath;
    if (typeof spatiaLitePath !== "string" || !spatiaLitePath.trim()) {
      if (!this._shorelineConfigWarningShown) {
        console.warn("[AnchorageHudService] shorelineProtection.enabled is true but shorelineProtection.spatiaLitePath is missing and no shorelineSpatiaLitePath service option was provided; add one to enable shoreline spatial queries.");
        this._shorelineConfigWarningShown = true;
      }
      return;
    }

    try {
      this._shorelineDb = new Database(shorelineDbPath);
      this._shorelineDb.loadExtension(spatiaLitePath);
      this._shorelineDistanceStmt = this._shorelineDb.prepare(`
        SELECT MIN(ST_Distance(
          Transform(geom, 3857),
          Transform(MakePoint(@lon, @lat, 4326), 3857)
        )) AS min_distance_m
        FROM icw_features
        WHERE json_extract(raw_attributes, '$.OBJL') IN (30, 122)
          AND MbrIntersects(
            geom,
            BuildMbr(@minLon, @minLat, @maxLon, @maxLat, 4326)
          )
      `);
    } catch (err) {
      if (!this._shorelineRuntimeWarningShown) {
        console.warn("[AnchorageHudService] Failed to initialize shoreline topology scoring:", err.message);
        this._shorelineRuntimeWarningShown = true;
      }
      if (this._shorelineDb) {
        this._shorelineDb.close();
      }
      this._shorelineDb = null;
      this._shorelineDistanceStmt = null;
    }
  }

  async _fetchUserConfig(routeIdOverride) {
    await this._storageService.initialize();

    const activeRouteId = routeIdOverride || await this._storageService.getSetting("activeRouteId");
    this._activeRouteId = activeRouteId || null;

    const importedRoutes = await this._storageService.getSetting("importedRoutes");
    if (Array.isArray(importedRoutes) && this._activeRouteId) {
      const activeRoute = importedRoutes.find(
        (route) => route && route.routeId === this._activeRouteId,
      );
      this._routeGpxData = activeRoute?.gpxData || null;
    } else {
      this._routeGpxData = null;
    }

    const anchoragePreferences = await this._storageService.getSetting("anchorageHudPreferences");
    this._preferences = anchoragePreferences && typeof anchoragePreferences === "object"
      ? anchoragePreferences
      : null;
  }

  async _loadRouteAndAnchorages() {
    if (!this._activeRouteId || !this._routeGpxData) {
      this._routeWithDistances = [];
      this._anchoragesAlongRoute = [];
      return;
    }

    const fs = await import("fs");
    const path = await import("path");
    const os = await import("os");

    const tempRouteFile = path.join(os.tmpdir(), `anchorage-route-${Date.now()}.gpx`);

    try {
      fs.writeFileSync(tempRouteFile, this._routeGpxData);

      const routePoints = await parseGPXRoute(tempRouteFile);
      this._routeWithDistances = calculateRouteDistances(routePoints);

      const searchDistanceNm = this._preferences?.searchDistanceNm;
      if (!Number.isFinite(searchDistanceNm) || searchDistanceNm <= 0) {
        console.warn("[AnchorageHudService] Missing anchorageHudPreferences.searchDistanceNm; add it to enable anchorage route query distance.");
        this._anchoragesAlongRoute = [];
        return;
      }

      this._anchoragesAlongRoute = await queryAnchoragesAlongRoute(tempRouteFile, {
        dbPath: this.dbPath,
        maxDistanceNM: searchDistanceNm,
      });
    } catch (err) {
      console.error("[AnchorageHudService] Failed to load route/anchorages:", err.message);
      this._routeWithDistances = [];
      this._anchoragesAlongRoute = [];
    } finally {
      try {
        fs.unlinkSync(tempRouteFile);
      } catch (_err) {
        // no-op
      }
    }
  }

  _recomputeAndPublish() {
    if (!this._activeRouteId || !Array.isArray(this._anchoragesAlongRoute) || this._anchoragesAlongRoute.length === 0) {
      return;
    }

    const state = this._stateManager?.getState?.();
    if (!state || typeof state !== "object") {
      return;
    }

    this._updateBoatState(state);

    if (!Number.isFinite(this._boatState.latitude) || !Number.isFinite(this._boatState.longitude)) {
      return;
    }

    const sunsetIso = this._resolveSunsetIso(state);
    const recommendations = this._buildRecommendations(state, sunsetIso);
    const forecastChangeAlert = this._buildForecastChangeAlert(recommendations);

    this._publishRecommendations(recommendations);
    this._publishSummary({
      activeRouteId: this._activeRouteId,
      candidateCount: this._anchoragesAlongRoute.length,
      recommendedCount: recommendations.length,
      sunset: sunsetIso,
      forecast_change_alert: forecastChangeAlert,
      generatedAt: Date.now(),
    });
  }

  _updateBoatState(state) {
    const position = state.position;
    const navigation = state.navigation;

    let positionSource = null;
    if (position && typeof position === "object") {
      const sources = Object.keys(position);
      for (const source of sources) {
        const candidate = position[source];
        if (candidate && candidate.latitude !== undefined && candidate.longitude !== undefined) {
          positionSource = candidate;
          break;
        }
      }
    }

    if (!positionSource) {
      return;
    }

    const latitude = typeof positionSource.latitude === "number"
      ? positionSource.latitude
      : positionSource.latitude?.value;
    const longitude = typeof positionSource.longitude === "number"
      ? positionSource.longitude
      : positionSource.longitude?.value;

    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      return;
    }

    this._boatState.latitude = latitude;
    this._boatState.longitude = longitude;

    const sog = navigation?.speed?.sog?.value;
    this._boatState.sog = Number.isFinite(sog) ? sog : null;

    if (Array.isArray(this._routeWithDistances) && this._routeWithDistances.length > 0) {
      const closest = findClosestRoutePoint(this._routeWithDistances, latitude, longitude);
      if (closest && Number.isFinite(closest.distanceFromStart)) {
        this._boatState.routeProgressNm = closest.distanceFromStart;
      }
    }
  }

  _resolveSunsetIso(state) {
    return this._resolveWeatherSunsetIso(state);
  }

  _resolveWeatherSunsetIso(state) {
    const forecast = state?.forecast;
    const daily = forecast?.daily;
    const dailySunsets = daily?.sunset;
    const dailyTimes = daily?.time;
    const currentTimeIso = forecast?.current?.time;

    if (!Array.isArray(dailySunsets) || dailySunsets.length === 0) {
      return null;
    }

    if (Array.isArray(dailyTimes) && dailyTimes.length === dailySunsets.length && typeof currentTimeIso === "string" && currentTimeIso.trim()) {
      const currentDate = currentTimeIso.slice(0, 10);
      for (let i = 0; i < dailyTimes.length; i += 1) {
        const day = dailyTimes[i];
        const sunsetIso = dailySunsets[i];
        if (typeof day !== "string" || typeof sunsetIso !== "string" || !sunsetIso.trim()) {
          continue;
        }
        if (day === currentDate) {
          return sunsetIso;
        }
      }
    }

    for (const sunsetIso of dailySunsets) {
      if (typeof sunsetIso === "string" && sunsetIso.trim()) {
        return sunsetIso;
      }
    }

    return null;
  }

  _buildRecommendations(state, sunsetIso) {
    const forecastCurrent = state?.forecast?.current;
    const forecastHourly = state?.forecast?.hourly;
    const tides = state?.tides?.current?.values;

    const windSpeed = forecastCurrent?.wind_speed_10m;
    const windDirectionDeg = forecastCurrent?.wind_direction_10m;
    const hourlyMaxWindSpeed = this._extractHourlyMaxWindSpeed(forecastHourly);
    const oceanCurrentVelocity = tides?.oceanCurrentVelocity;
    const draft = state?.vessel?.info?.dimensions?.draft?.value;

    const routeProgressNm = this._boatState.routeProgressNm;
    const sog = this._boatState.sog;

    const recommendations = [];

    for (const anchorage of this._anchoragesAlongRoute) {
      if (!anchorage || !Number.isFinite(anchorage.distanceAlongRoute)) {
        continue;
      }

      const scored = this._scoreAnchorage({
        anchorage,
        windSpeed,
        windDirectionDeg,
        hourlyMaxWindSpeed,
        oceanCurrentVelocity,
        draft,
      });

      const reachability = this._computeSunsetReachability({
        anchorage,
        routeProgressNm,
        sog,
        sunsetIso,
      });

      const eveningConditions = this._buildEveningConditionsSummary({
        forecastHourly,
        etaIso: reachability.etaIso,
        sunsetIso,
      });

      recommendations.push({
        id: anchorage.id ?? null,
        name: anchorage.name ?? null,
        city: anchorage.city ?? null,
        state: anchorage.state ?? null,
        latitude: anchorage.lat ?? null,
        longitude: anchorage.lon ?? null,
        source_url: anchorage.source_url ?? null,
        distance_from_route_nm: anchorage.distanceFromRoute,
        distance_along_route_nm: anchorage.distanceAlongRoute,
        forecast_wind_speed_10m: Number.isFinite(windSpeed) ? windSpeed : null,
        forecast_wind_direction_10m: Number.isFinite(windDirectionDeg) ? windDirectionDeg : null,
        forecast_hourly_max_wind_10m: Number.isFinite(hourlyMaxWindSpeed) ? hourlyMaxWindSpeed : null,
        shoreline_shelter_score: Number.isFinite(scored.shorelineScore) ? scored.shorelineScore : null,
        shoreline_upwind_distance_nm: Number.isFinite(scored.shorelineUpwindDistanceNm) ? scored.shorelineUpwindDistanceNm : null,
        shoreline_downwind_distance_nm: Number.isFinite(scored.shorelineDownwindDistanceNm) ? scored.shorelineDownwindDistanceNm : null,
        score: scored.score,
        score_breakdown: scored.breakdown,
        reachable_before_sunset: reachability.reachableBeforeSunset,
        eta_iso: reachability.etaIso,
        eta_minutes: reachability.etaMinutes,
        sunset_iso: sunsetIso,
        evening_conditions: eveningConditions,
      });
    }

    recommendations.sort((a, b) => {
      const aReachableRank = a.reachable_before_sunset === true ? 1 : 0;
      const bReachableRank = b.reachable_before_sunset === true ? 1 : 0;
      if (aReachableRank !== bReachableRank) {
        return bReachableRank - aReachableRank;
      }
      return b.score - a.score;
    });

    const maxRecommendations = this._preferences?.maxRecommendations;
    if (Number.isFinite(maxRecommendations) && maxRecommendations > 0) {
      return recommendations.slice(0, maxRecommendations);
    }

    return recommendations;
  }

  _buildEveningConditionsSummary(context) {
    const { forecastHourly, etaIso, sunsetIso } = context;

    const timeline = forecastHourly?.time;
    const speeds = forecastHourly?.wind_speed_10m;
    const directions = forecastHourly?.wind_direction_10m;
    if (!Array.isArray(timeline) || !Array.isArray(speeds) || !Array.isArray(directions)) {
      return null;
    }

    const eveningWindowHours = this._preferences?.forecastWindowHours;
    if (!Number.isFinite(eveningWindowHours) || eveningWindowHours <= 0) {
      return null;
    }

    const nowMs = Date.now();
    const etaMs = typeof etaIso === "string" && etaIso.trim() ? Date.parse(etaIso) : NaN;
    const sunsetMs = typeof sunsetIso === "string" && sunsetIso.trim() ? Date.parse(sunsetIso) : NaN;

    const windowStartMs = Number.isFinite(etaMs) && etaMs > nowMs ? etaMs : nowMs;
    const windowEndByHoursMs = windowStartMs + eveningWindowHours * 60 * 60 * 1000;
    const windowEndMs = Number.isFinite(sunsetMs)
      ? Math.max(sunsetMs, windowEndByHoursMs)
      : windowEndByHoursMs;

    const windTimeline = [];
    for (let i = 0; i < timeline.length; i += 1) {
      const timeIso = timeline[i];
      const speed = speeds[i];
      const direction = directions[i];

      const pointMs = typeof timeIso === "string" ? Date.parse(timeIso) : NaN;
      if (!Number.isFinite(pointMs) || pointMs < windowStartMs || pointMs > windowEndMs) {
        continue;
      }
      if (!Number.isFinite(speed) || !Number.isFinite(direction)) {
        continue;
      }

      windTimeline.push({
        time_iso: timeIso,
        wind_speed_10m: speed,
        wind_direction_10m: direction,
        wind_direction_cardinal: this._toCardinalDirection(direction),
      });
    }

    if (windTimeline.length === 0) {
      return null;
    }

    let maxWindPoint = windTimeline[0];
    for (const point of windTimeline) {
      if (point.wind_speed_10m > maxWindPoint.wind_speed_10m) {
        maxWindPoint = point;
      }
    }

    const maxComfortWindKn = this._preferences?.weatherLimits?.maxComfortWindKn;
    const strongestWindBlock = this._buildStrongWindBlockSummary(windTimeline, maxComfortWindKn);

    const firstPoint = windTimeline[0];
    const lastPoint = windTimeline[windTimeline.length - 1];
    const directionalShiftDeg = this._angularDifferenceDeg(
      firstPoint.wind_direction_10m,
      lastPoint.wind_direction_10m,
    );

    const directionShiftSummary = `${firstPoint.wind_direction_cardinal} -> ${lastPoint.wind_direction_cardinal} (${Math.round(directionalShiftDeg)} deg shift)`;

    let captainNote = `Wind ${directionShiftSummary}; strongest around ${maxWindPoint.time_iso} at ${Math.round(maxWindPoint.wind_speed_10m)} kn.`;
    if (
      strongestWindBlock &&
      strongestWindBlock.direction_shift_warning &&
      strongestWindBlock.direction_shift_warning.notify_level === "strong"
    ) {
      const warning = strongestWindBlock.direction_shift_warning;
      captainNote = `Strong wind shift warning: ${warning.from_direction_cardinal} -> ${warning.to_direction_cardinal} while ${Math.round(strongestWindBlock.max_wind_kn)} kn winds persist (${strongestWindBlock.start_iso} to ${strongestWindBlock.end_iso}).`;
    }

    return {
      window_start_iso: new Date(windowStartMs).toISOString(),
      window_end_iso: new Date(windowEndMs).toISOString(),
      wind_timeline: windTimeline,
      max_wind_kn: maxWindPoint.wind_speed_10m,
      max_wind_eta_iso: maxWindPoint.time_iso,
      strongest_wind_block: strongestWindBlock,
      direction_shift_summary: directionShiftSummary,
      captain_note: captainNote,
    };
  }

  _buildStrongWindBlockSummary(windTimeline, strongWindThresholdKn) {
    if (!Array.isArray(windTimeline) || windTimeline.length === 0) {
      return null;
    }
    if (!Number.isFinite(strongWindThresholdKn)) {
      return null;
    }

    const blocks = [];
    let currentBlock = null;

    for (let i = 0; i < windTimeline.length; i += 1) {
      const point = windTimeline[i];
      if (!Number.isFinite(point?.wind_speed_10m) || !Number.isFinite(point?.wind_direction_10m)) {
        if (currentBlock) {
          blocks.push(currentBlock);
          currentBlock = null;
        }
        continue;
      }

      if (point.wind_speed_10m >= strongWindThresholdKn) {
        if (!currentBlock) {
          currentBlock = { points: [] };
        }
        currentBlock.points.push(point);
      } else if (currentBlock) {
        blocks.push(currentBlock);
        currentBlock = null;
      }
    }

    if (currentBlock) {
      blocks.push(currentBlock);
    }

    if (blocks.length === 0) {
      return null;
    }

    let strongestBlock = null;
    for (const block of blocks) {
      const points = block.points;
      if (!Array.isArray(points) || points.length === 0) {
        continue;
      }

      let sumWind = 0;
      let maxWind = points[0].wind_speed_10m;
      for (const point of points) {
        sumWind += point.wind_speed_10m;
        if (point.wind_speed_10m > maxWind) {
          maxWind = point.wind_speed_10m;
        }
      }

      const avgWind = sumWind / points.length;
      const candidate = {
        points,
        avgWind,
        maxWind,
      };

      if (!strongestBlock) {
        strongestBlock = candidate;
        continue;
      }

      if (candidate.avgWind > strongestBlock.avgWind) {
        strongestBlock = candidate;
        continue;
      }

      if (candidate.avgWind === strongestBlock.avgWind && candidate.points.length > strongestBlock.points.length) {
        strongestBlock = candidate;
      }
    }

    if (!strongestBlock || !Array.isArray(strongestBlock.points) || strongestBlock.points.length === 0) {
      return null;
    }

    const startPoint = strongestBlock.points[0];
    const endPoint = strongestBlock.points[strongestBlock.points.length - 1];
    const shiftDeg = this._angularDifferenceDeg(startPoint.wind_direction_10m, endPoint.wind_direction_10m);
    const preferredShelterDirection = this._toCardinalDirection((endPoint.wind_direction_10m + 180) % 360);
    const strongShiftThresholdDeg = this._preferences?.shorelineProtection?.strongShiftWarningDeg;
    const hasStrongShiftThreshold = Number.isFinite(strongShiftThresholdDeg);
    const hasShiftWarning = hasStrongShiftThreshold && shiftDeg >= strongShiftThresholdDeg;

    return {
      start_iso: startPoint.time_iso,
      end_iso: endPoint.time_iso,
      duration_hours: strongestBlock.points.length,
      avg_wind_kn: strongestBlock.avgWind,
      max_wind_kn: strongestBlock.maxWind,
      from_direction_cardinal: startPoint.wind_direction_cardinal,
      to_direction_cardinal: endPoint.wind_direction_cardinal,
      direction_shift_deg: shiftDeg,
      preferred_shelter_sector: preferredShelterDirection,
      direction_shift_warning: hasShiftWarning
        ? {
            enabled: true,
            notify_level: "strong",
            threshold_deg: strongShiftThresholdDeg,
            from_direction_cardinal: startPoint.wind_direction_cardinal,
            to_direction_cardinal: endPoint.wind_direction_cardinal,
            shift_deg: shiftDeg,
            advisory: `Sustained strong wind shift from ${startPoint.wind_direction_cardinal} to ${endPoint.wind_direction_cardinal}; prioritize ${preferredShelterDirection} shelter.`,
          }
        : null,
    };
  }

  _buildForecastChangeAlert(recommendations) {
    if (!Array.isArray(recommendations) || recommendations.length === 0) {
      return null;
    }

    let maxWindRecommendation = null;
    for (const recommendation of recommendations) {
      const maxWind = recommendation?.evening_conditions?.max_wind_kn;
      if (!Number.isFinite(maxWind)) {
        continue;
      }

      if (!maxWindRecommendation || maxWind > maxWindRecommendation.evening_conditions.max_wind_kn) {
        maxWindRecommendation = recommendation;
      }
    }

    if (!maxWindRecommendation) {
      return null;
    }

    const directionShiftSummary = maxWindRecommendation.evening_conditions?.direction_shift_summary;
    const maxWindKn = maxWindRecommendation.evening_conditions?.max_wind_kn;
    const maxWindEtaIso = maxWindRecommendation.evening_conditions?.max_wind_eta_iso;
    const strongestWindBlock = maxWindRecommendation.evening_conditions?.strongest_wind_block;
    const strongShiftWarning = strongestWindBlock?.direction_shift_warning;
    if (!Number.isFinite(maxWindKn) || typeof maxWindEtaIso !== "string") {
      return null;
    }

    return {
      strongest_wind_kn: maxWindKn,
      strongest_wind_eta_iso: maxWindEtaIso,
      strongest_wind_block: strongestWindBlock ?? null,
      direction_shift_summary: typeof directionShiftSummary === "string" ? directionShiftSummary : null,
      strong_direction_shift_warning: strongShiftWarning ?? null,
      notify_level: strongShiftWarning?.notify_level ?? "info",
      advisory: strongShiftWarning?.advisory ?? `Strongest expected wind near ${maxWindEtaIso} at ${Math.round(maxWindKn)} kn${typeof directionShiftSummary === "string" ? `; ${directionShiftSummary}` : ""}.`,
    };
  }

  _toCardinalDirection(directionDeg) {
    if (!Number.isFinite(directionDeg)) {
      return null;
    }

    const normalized = ((directionDeg % 360) + 360) % 360;
    const directions = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
    const index = Math.round(normalized / 45) % directions.length;
    return directions[index];
  }

  _angularDifferenceDeg(directionA, directionB) {
    if (!Number.isFinite(directionA) || !Number.isFinite(directionB)) {
      return 0;
    }

    const normalizedA = ((directionA % 360) + 360) % 360;
    const normalizedB = ((directionB % 360) + 360) % 360;
    const delta = Math.abs(normalizedA - normalizedB);
    return Math.min(delta, 360 - delta);
  }

  _scoreAnchorage(context) {
    const { anchorage, windSpeed, windDirectionDeg, hourlyMaxWindSpeed, oceanCurrentVelocity, draft } = context;
    const prefs = this._preferences;

    let score = 0;
    const breakdown = {};

    const weightPet = prefs?.weights?.petFriendly;
    if (Number.isFinite(weightPet) && Number.isFinite(anchorage.pet_friendly_rating)) {
      const contribution = anchorage.pet_friendly_rating * weightPet;
      score += contribution;
      breakdown.pet_friendly = contribution;
    }

    const weightHolding = prefs?.weights?.holding;
    if (Number.isFinite(weightHolding) && Number.isFinite(anchorage.holding_rating)) {
      const contribution = anchorage.holding_rating * weightHolding;
      score += contribution;
      breakdown.holding = contribution;
    }

    const weightWindProtection = prefs?.weights?.windProtection;
    if (Number.isFinite(weightWindProtection) && Number.isFinite(anchorage.wind_protection_rating)) {
      const contribution = anchorage.wind_protection_rating * weightWindProtection;
      score += contribution;
      breakdown.wind_protection = contribution;
    }

    const weightCurrentFlow = prefs?.weights?.currentFlow;
    if (Number.isFinite(weightCurrentFlow) && Number.isFinite(anchorage.current_flow_rating)) {
      const contribution = anchorage.current_flow_rating * weightCurrentFlow;
      score += contribution;
      breakdown.current_flow = contribution;
    }

    const maxComfortWindKn = prefs?.weatherLimits?.maxComfortWindKn;
    if (Number.isFinite(maxComfortWindKn) && Number.isFinite(windSpeed) && Number.isFinite(anchorage.wind_protection_rating)) {
      if (windSpeed > maxComfortWindKn) {
        const windPenalty = (windSpeed - maxComfortWindKn) * (5 - anchorage.wind_protection_rating);
        score -= windPenalty;
        breakdown.wind_penalty = -windPenalty;
      }
    }

    if (Number.isFinite(maxComfortWindKn) && Number.isFinite(hourlyMaxWindSpeed) && Number.isFinite(anchorage.wind_protection_rating)) {
      if (hourlyMaxWindSpeed > maxComfortWindKn) {
        const forecastWindPenalty = (hourlyMaxWindSpeed - maxComfortWindKn) * (5 - anchorage.wind_protection_rating);
        score -= forecastWindPenalty;
        breakdown.forecast_wind_penalty = -forecastWindPenalty;
      }
    }

    const maxComfortCurrent = prefs?.weatherLimits?.maxComfortCurrent;
    if (Number.isFinite(maxComfortCurrent) && Number.isFinite(oceanCurrentVelocity) && Number.isFinite(anchorage.current_flow_rating)) {
      if (Math.abs(oceanCurrentVelocity) > maxComfortCurrent) {
        const currentPenalty = (Math.abs(oceanCurrentVelocity) - maxComfortCurrent) * (5 - anchorage.current_flow_rating);
        score -= currentPenalty;
        breakdown.current_penalty = -currentPenalty;
      }
    }

    const draftSafetyBufferFt = prefs?.boatConstraints?.draftSafetyBufferFt;
    if (Number.isFinite(draftSafetyBufferFt) && Number.isFinite(draft) && typeof anchorage.depth === "string") {
      const parsedDepth = parseFloat(anchorage.depth);
      if (Number.isFinite(parsedDepth) && parsedDepth < draft + draftSafetyBufferFt) {
        const depthPenalty = (draft + draftSafetyBufferFt - parsedDepth) * 10;
        score -= depthPenalty;
        breakdown.depth_penalty = -depthPenalty;
      }
    }

    const shorelineContribution = this._scoreShorelineShelter({
      anchorage,
      windDirectionDeg,
      windSpeed,
      hourlyMaxWindSpeed,
    });
    if (shorelineContribution && Number.isFinite(shorelineContribution.score)) {
      score += shorelineContribution.score;
      breakdown.shoreline_shelter = shorelineContribution.score;
      if (Number.isFinite(shorelineContribution.upwindDistanceNm)) {
        breakdown.shoreline_upwind_distance_nm = shorelineContribution.upwindDistanceNm;
      }
      if (Number.isFinite(shorelineContribution.downwindDistanceNm)) {
        breakdown.shoreline_downwind_distance_nm = shorelineContribution.downwindDistanceNm;
      }
    }

    return {
      score,
      breakdown,
      shorelineScore: shorelineContribution?.score ?? null,
      shorelineUpwindDistanceNm: shorelineContribution?.upwindDistanceNm ?? null,
      shorelineDownwindDistanceNm: shorelineContribution?.downwindDistanceNm ?? null,
    };
  }

  _extractHourlyMaxWindSpeed(forecastHourly) {
    const hourlySpeeds = forecastHourly?.wind_speed_10m;
    if (!Array.isArray(hourlySpeeds) || hourlySpeeds.length === 0) {
      return null;
    }

    const horizonHours = this._preferences?.forecastWindowHours;
    if (!Number.isFinite(horizonHours) || horizonHours <= 0) {
      return null;
    }

    const limit = Math.min(hourlySpeeds.length, Math.floor(horizonHours));
    if (!Number.isFinite(limit) || limit <= 0) {
      return null;
    }

    let maxWind = null;
    for (let i = 0; i < limit; i += 1) {
      const value = hourlySpeeds[i];
      if (Number.isFinite(value) && (maxWind === null || value > maxWind)) {
        maxWind = value;
      }
    }
    return maxWind;
  }

  _scoreShorelineShelter(context) {
    const { anchorage, windDirectionDeg, windSpeed, hourlyMaxWindSpeed } = context;
    const shorelinePreferences = this._preferences?.shorelineProtection;

    if (!shorelinePreferences?.enabled) {
      return null;
    }

    if (!this._shorelineDistanceStmt) {
      return null;
    }

    if (!Number.isFinite(windDirectionDeg) || !Number.isFinite(anchorage?.lat) || !Number.isFinite(anchorage?.lon)) {
      return null;
    }

    const probeDistanceNm = shorelinePreferences?.probeDistanceNm;
    const searchRadiusNm = shorelinePreferences?.searchRadiusNm;
    const weight = shorelinePreferences?.weight;
    const windReferenceKn = shorelinePreferences?.windReferenceKn;
    const maxContribution = shorelinePreferences?.maxContribution;

    if (
      !Number.isFinite(probeDistanceNm) || probeDistanceNm <= 0 ||
      !Number.isFinite(searchRadiusNm) || searchRadiusNm <= 0 ||
      !Number.isFinite(weight) ||
      !Number.isFinite(windReferenceKn) || windReferenceKn <= 0
    ) {
      if (!this._shorelineConfigWarningShown) {
        console.warn("[AnchorageHudService] shorelineProtection requires probeDistanceNm, searchRadiusNm, weight, and windReferenceKn to be defined.");
        this._shorelineConfigWarningShown = true;
      }
      return null;
    }

    const upwindProbe = this._projectPoint(anchorage.lat, anchorage.lon, windDirectionDeg, probeDistanceNm);
    const downwindProbe = this._projectPoint(anchorage.lat, anchorage.lon, (windDirectionDeg + 180) % 360, probeDistanceNm);

    if (!upwindProbe || !downwindProbe) {
      return null;
    }

    const upwindDistanceM = this._queryNearestShorelineDistanceMeters(upwindProbe.latitude, upwindProbe.longitude, searchRadiusNm);
    const downwindDistanceM = this._queryNearestShorelineDistanceMeters(downwindProbe.latitude, downwindProbe.longitude, searchRadiusNm);

    if (!Number.isFinite(upwindDistanceM) || !Number.isFinite(downwindDistanceM)) {
      return null;
    }

    const upwindDistanceNm = upwindDistanceM / 1852;
    const downwindDistanceNm = downwindDistanceM / 1852;
    const upwindCoverage = (searchRadiusNm - Math.min(upwindDistanceNm, searchRadiusNm)) / searchRadiusNm;
    const directionalFactor = downwindDistanceNm / (upwindDistanceNm + downwindDistanceNm);
    const normalized = upwindCoverage * directionalFactor;

    const effectiveWind = Number.isFinite(hourlyMaxWindSpeed)
      ? hourlyMaxWindSpeed
      : windSpeed;
    const windIntensityFactor = Number.isFinite(effectiveWind)
      ? Math.min(effectiveWind / windReferenceKn, 1)
      : 0;

    let rawScore = normalized * windIntensityFactor * weight;
    if (Number.isFinite(maxContribution) && maxContribution > 0) {
      rawScore = Math.min(rawScore, maxContribution);
    }

    return {
      score: rawScore,
      upwindDistanceNm,
      downwindDistanceNm,
    };
  }

  _queryNearestShorelineDistanceMeters(latitude, longitude, searchRadiusNm) {
    if (!this._shorelineDistanceStmt) {
      return null;
    }

    const latDelta = searchRadiusNm / 60;
    const cosLatitude = Math.cos((latitude * Math.PI) / 180);
    if (!Number.isFinite(cosLatitude) || cosLatitude === 0) {
      return null;
    }

    const lonDelta = searchRadiusNm / (60 * Math.abs(cosLatitude));

    try {
      const row = this._shorelineDistanceStmt.get({
        lon: longitude,
        lat: latitude,
        minLon: longitude - lonDelta,
        minLat: latitude - latDelta,
        maxLon: longitude + lonDelta,
        maxLat: latitude + latDelta,
      });
      const distance = row?.min_distance_m;
      return Number.isFinite(distance) ? distance : null;
    } catch (err) {
      if (!this._shorelineRuntimeWarningShown) {
        console.warn("[AnchorageHudService] Shoreline distance query failed:", err.message);
        this._shorelineRuntimeWarningShown = true;
      }
      return null;
    }
  }

  _projectPoint(latitude, longitude, bearingDeg, distanceNm) {
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || !Number.isFinite(bearingDeg) || !Number.isFinite(distanceNm)) {
      return null;
    }

    const earthRadiusNm = 3440.065;
    const angularDistance = distanceNm / earthRadiusNm;
    const bearingRad = (bearingDeg * Math.PI) / 180;
    const latRad = (latitude * Math.PI) / 180;
    const lonRad = (longitude * Math.PI) / 180;

    const projectedLatRad = Math.asin(
      Math.sin(latRad) * Math.cos(angularDistance) +
      Math.cos(latRad) * Math.sin(angularDistance) * Math.cos(bearingRad),
    );

    const projectedLonRad = lonRad + Math.atan2(
      Math.sin(bearingRad) * Math.sin(angularDistance) * Math.cos(latRad),
      Math.cos(angularDistance) - Math.sin(latRad) * Math.sin(projectedLatRad),
    );

    const projectedLatitude = (projectedLatRad * 180) / Math.PI;
    const projectedLongitude = (projectedLonRad * 180) / Math.PI;

    if (!Number.isFinite(projectedLatitude) || !Number.isFinite(projectedLongitude)) {
      return null;
    }

    return {
      latitude: projectedLatitude,
      longitude: projectedLongitude,
    };
  }

  _computeSunsetReachability(context) {
    const { anchorage, routeProgressNm, sog, sunsetIso } = context;

    if (!Number.isFinite(routeProgressNm) || !Number.isFinite(sog) || sog <= 0) {
      return { reachableBeforeSunset: null, etaIso: null, etaMinutes: null };
    }

    if (typeof sunsetIso !== "string" || !sunsetIso.trim()) {
      return { reachableBeforeSunset: null, etaIso: null, etaMinutes: null };
    }

    const remainingNm = anchorage.distanceAlongRoute - routeProgressNm;
    const safeRemainingNm = remainingNm > 0 ? remainingNm : 0;

    const etaHours = safeRemainingNm / sog;
    if (!Number.isFinite(etaHours)) {
      return { reachableBeforeSunset: null, etaIso: null, etaMinutes: null };
    }

    const etaMs = Date.now() + etaHours * 60 * 60 * 1000;
    const etaIso = new Date(etaMs).toISOString();

    const sunsetMs = Date.parse(sunsetIso);
    if (!Number.isFinite(sunsetMs)) {
      return { reachableBeforeSunset: null, etaIso, etaMinutes: Math.round(etaHours * 60) };
    }

    return {
      reachableBeforeSunset: etaMs <= sunsetMs,
      etaIso,
      etaMinutes: Math.round(etaHours * 60),
    };
  }

  _publishRecommendations(recommendations) {
    const signature = JSON.stringify(recommendations);
    if (signature === this._lastRecommendationsSignature) {
      return;
    }

    this._lastRecommendationsSignature = signature;

    this._stateManager.emit("state:patch", {
      type: "state:patch",
      data: [
        {
          op: "replace",
          path: "/anchorages/hud/recommendations",
          value: recommendations,
        },
      ],
      source: "anchorage-hud",
      timestamp: Date.now(),
    });
  }

  _publishSummary(summary) {
    const signature = JSON.stringify(summary);
    if (signature === this._lastSummarySignature) {
      return;
    }

    this._lastSummarySignature = signature;

    this._stateManager.emit("state:patch", {
      type: "state:patch",
      data: [
        {
          op: "replace",
          path: "/anchorages/hud/summary",
          value: summary,
        },
      ],
      source: "anchorage-hud",
      timestamp: Date.now(),
    });
  }
}
