import BaseService from "./BaseService.js";
import { getStateManager } from "../relay/core/state/StateManager.js";
import Database from "better-sqlite3";
import storageService from "../bluetooth/services/storage/storageService.js";
import {
  parseGPXRoute,
  calculateRouteDistances,
  findClosestRoutePoint,
} from "../bridges/gpx-route-parser.js";
import { queryMarinasAlongRoute } from "../bridges/route-queries.js";

/**
 * Marina HUD lifecycle and efficiency model:
 * - Stays dormant when no active route exists.
 * - Registers route/state listeners only while a route is active.
 * - Loads marinas once per active route using route-based spatial filtering.
 * - Re-scores recommendations from live state (position/navigation) without
 *   re-querying the database each cycle.
 * - Refreshes consistently from filtered marina-relevant patch events.
 */
export class MarinaService extends BaseService {
  constructor(options) {
    super("marina-hud", "continuous");

    if (!options || typeof options !== "object") {
      throw new Error("MarinaService requires options");
    }

    this.dbPath = options.dbPath;
    this._storageService = storageService;
    this._stateManager = getStateManager();

    this._activeRouteId = null;
    this._routeGpxData = null;
    this._routeWithDistances = [];

    this._marinasAlongRoute = [];
    this._boatState = {
      latitude: null,
      longitude: null,
      sog: null,
      routeProgressNm: null,
      lastRecomputeAt: null,
    };

    this._preferences = null;

    this._activeRouteHandler = null;
    this._marinaPatchHandler = null;

    this._lastRecommendationsSignature = null;
    this._lastSummarySignature = null;
  }

  async start() {
    if (this.isRunning) {
      return;
    }

    if (!this.dbPath || typeof this.dbPath !== "string" || !this.dbPath.trim()) {
      throw new Error("MarinaService requires MARINA_DB_PATH to be defined");
    }

    this._stateManager = getStateManager();
    if (!this._stateManager) {
      throw new Error("MarinaService requires a StateManager instance");
    }

    await super.start();

    this._initializeAsync().catch((err) => {
      console.error("[MarinaService] Background initialization failed:", err);
    });
  }

  async _initializeAsync() {
    await this._fetchUserConfig();
    await this._loadRouteAndMarinas();

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
    if (!this._marinaPatchHandler) {
      this._marinaPatchHandler = (event) => {
        if (!event || !Array.isArray(event.data)) {
          return;
        }
        this._processMarinaPatch(event.data);
      };
      this._stateManager.on("state:marina-patch", this._marinaPatchHandler);
    }
  }

  _unregisterRuntimeHandlers() {
    if (this._stateManager && this._marinaPatchHandler) {
      this._stateManager.off("state:marina-patch", this._marinaPatchHandler);
    }
    this._marinaPatchHandler = null;
  }

  async _handleActiveRouteEvent(event) {
    const newRouteId = event?.routeId || null;

    if (newRouteId && newRouteId !== this._activeRouteId) {
      this._activeRouteId = newRouteId;
      await this._fetchUserConfig(newRouteId);
      await this._loadRouteAndMarinas();
      this._registerRuntimeHandlers();
      this._recomputeAndPublish();
      return;
    }

    if (!newRouteId && this._activeRouteId) {
      this._activeRouteId = null;
      this._routeGpxData = null;
      this._routeWithDistances = [];
      this._marinasAlongRoute = [];
      this._boatState.routeProgressNm = null;
      this._unregisterRuntimeHandlers();
      this._publishRecommendations([]);
      this._publishSummary(null);
    }
  }

  _processMarinaPatch(patchData) {
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

  async _fetchUserConfig(routeId = null) {
    await this._storageService.initialize();

    try {
      if (this._storageService && typeof this._storageService.getSetting === "function") {
        const marinaPreferences = await this._storageService.getSetting("marinaHudPreferences");
        this._preferences = marinaPreferences && typeof marinaPreferences === "object"
          ? marinaPreferences
          : null;
      } else {
        this._preferences = null;
      }
    } catch (err) {
      console.warn("[MarinaService] Could not fetch user preferences:", err.message);
      this._preferences = null;
    }

    if (routeId) {
      this._activeRouteId = routeId;
    }

    try {
      if (this._storageService && typeof this._storageService.getSetting === "function") {
        const activeRouteId = routeId || await this._storageService.getSetting("activeRouteId");
        this._activeRouteId = activeRouteId || null;

        const importedRoutes = await this._storageService.getSetting("importedRoutes");
        if (Array.isArray(importedRoutes) && this._activeRouteId) {
          const activeRoute = importedRoutes.find(
            (route) => route && route.routeId === this._activeRouteId,
          );
          this._routeGpxData = activeRoute?.gpx ? String(activeRoute.gpx) : null;
        } else {
          this._routeGpxData = null;
        }
      }
    } catch (err) {
      console.warn("[MarinaService] Could not fetch route data:", err.message);
    }
  }

  async _loadRouteAndMarinas() {
    if (!this._activeRouteId || !this._routeGpxData) {
      this._routeWithDistances = [];
      this._marinasAlongRoute = [];
      return;
    }

    try {
      const routePoints = parseGPXRoute(this._routeGpxData);
      this._routeWithDistances = calculateRouteDistances(routePoints);
    } catch (err) {
      console.error("[MarinaService] Failed to parse GPX route:", err.message);
      this._routeWithDistances = [];
      this._marinasAlongRoute = [];
      return;
    }

    try {
      const maxDistanceNM = this._preferences?.marinaHud?.maxDistanceFromRouteNM ?? 5;

      this._marinasAlongRoute = await queryMarinasAlongRoute(this._routeGpxData, {
        dbPath: this.dbPath,
        maxDistanceNM,
      });
    } catch (err) {
      console.error("[MarinaService] Failed to query marinas along route:", err.message);
      this._marinasAlongRoute = [];
    }
  }

  _recomputeAndPublish() {
    if (!this._activeRouteId || !Array.isArray(this._marinasAlongRoute) || this._marinasAlongRoute.length === 0) {
      return;
    }

    const state = this._stateManager?.getState?.();
    if (!state) {
      return;
    }

    this._updateBoatState(state);

    if (!Number.isFinite(this._boatState.latitude) || !Number.isFinite(this._boatState.longitude)) {
      return;
    }

    const recommendations = this._buildRecommendations(state);

    this._publishRecommendations(recommendations);
    this._publishSummary({
      activeRouteId: this._activeRouteId,
      candidateCount: this._marinasAlongRoute.length,
      recommendedCount: recommendations.length,
      generatedAt: Date.now(),
    });
  }

  _updateBoatState(state) {
    const position = state.position;
    const navigation = state.navigation;

    let positionSource = null;
    if (position && typeof position === "object") {
      if (typeof position.latitude === "number" && typeof position.longitude === "number") {
        positionSource = position;
      } else if (typeof position.value === "object" && position.value !== null) {
        if (typeof position.value.latitude === "number" && typeof position.value.longitude === "number") {
          positionSource = position.value;
        }
      }
    }

    let latitude = null;
    let longitude = null;
    if (positionSource) {
      latitude = positionSource.latitude;
      longitude = positionSource.longitude;
    }

    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      if (navigation && typeof navigation === "object") {
        if (typeof navigation.latitude === "number" && typeof navigation.longitude === "number") {
          latitude = navigation.latitude;
          longitude = navigation.longitude;
        } else if (typeof navigation.position === "object" && navigation.position !== null) {
          if (typeof navigation.position.latitude === "number" && typeof navigation.position.longitude === "number") {
            latitude = navigation.position.latitude;
            longitude = navigation.position.longitude;
          }
        }
      }
    }

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

  _buildRecommendations(state) {
    const routeProgressNm = this._boatState.routeProgressNm;

    const recommendations = [];

    for (const marina of this._marinasAlongRoute) {
      if (!marina || !Number.isFinite(marina.distanceAlongRoute)) {
        continue;
      }

      const scored = this._scoreMarina({
        marina,
        routeProgressNm,
      });

      const reachability = this._computeReachability({
        marina,
        routeProgressNm,
      });

      recommendations.push({
        id: marina.id ?? null,
        name: marina.name ?? null,
        city: marina.city ?? null,
        state: marina.state ?? null,
        latitude: marina.lat ?? null,
        longitude: marina.lon ?? null,
        vhf_channel: marina.vhf_channel ?? null,
        phone: marina.phone ?? null,
        fuel_diesel: marina.fuel_diesel ?? null,
        fuel_gas: marina.fuel_gas ?? null,
        fuel_price_diesel: marina.fuel_price_diesel ?? null,
        fuel_price_gas: marina.fuel_price_gas ?? null,
        amenities: marina.amenities ?? null,
        services: marina.services ?? null,
        raw_data_json: marina.raw_data_json ?? null,
        distance_from_route_nm: marina.distanceFromRoute,
        distance_along_route_nm: marina.distanceAlongRoute,
        score: scored.score,
        score_breakdown: scored.breakdown,
        is_ahead_on_route: reachability.isAhead,
        distance_to_marina_nm: reachability.distanceToMarina,
      });
    }

    recommendations.sort((a, b) => b.score - a.score);

    const maxRecommendations = this._preferences?.marinaHud?.maxRecommendations;
    if (Number.isFinite(maxRecommendations) && maxRecommendations > 0) {
      return recommendations.slice(0, maxRecommendations);
    }

    return recommendations;
  }

  _scoreMarina(context) {
    const { marina, routeProgressNm } = context;
    const prefs = this._preferences?.marinaHud;

    let score = 0;
    const breakdown = {};

    // Distance from route (closer is better)
    const distanceWeight = prefs?.distanceWeight ?? 50;
    if (Number.isFinite(marina.distanceFromRoute) && Number.isFinite(distanceWeight)) {
      const maxDistance = prefs?.maxDistanceFromRouteNM ?? 5;
      const distanceScore = Math.max(0, 1 - marina.distanceFromRoute / maxDistance) * distanceWeight;
      score += distanceScore;
      breakdown.distance = distanceScore;
    }

    // Fuel availability bonus
    const fuelWeight = prefs?.fuelWeight ?? 20;
    if (Number.isFinite(fuelWeight) && fuelWeight > 0) {
      let fuelBonus = 0;
      if (marina.fuel_diesel === 1 || marina.fuel_diesel === true) {
        fuelBonus += fuelWeight * 0.6;
      }
      if (marina.fuel_gas === 1 || marina.fuel_gas === true) {
        fuelBonus += fuelWeight * 0.4;
      }
      score += fuelBonus;
      breakdown.fuel = fuelBonus;
    }

    // Amenities bonus
    const amenitiesWeight = prefs?.amenitiesWeight ?? 15;
    if (Number.isFinite(amenitiesWeight) && amenitiesWeight > 0 && marina.amenities) {
      try {
        const amenities = typeof marina.amenities === "string" ? JSON.parse(marina.amenities) : marina.amenities;
        if (Array.isArray(amenities)) {
          const amenityScore = Math.min(amenities.length / 10, 1) * amenitiesWeight;
          score += amenityScore;
          breakdown.amenities = amenityScore;
        }
      } catch (e) {
        // Ignore parse errors
      }
    }

    // Services bonus
    const servicesWeight = prefs?.servicesWeight ?? 15;
    if (Number.isFinite(servicesWeight) && servicesWeight > 0 && marina.services) {
      try {
        const services = typeof marina.services === "string" ? JSON.parse(marina.services) : marina.services;
        if (Array.isArray(services)) {
          const serviceScore = Math.min(services.length / 5, 1) * servicesWeight;
          score += serviceScore;
          breakdown.services = serviceScore;
        }
      } catch (e) {
        // Ignore parse errors
      }
    }

    // Ahead on route bonus
    const aheadWeight = prefs?.aheadWeight ?? 10;
    if (Number.isFinite(aheadWeight) && aheadWeight > 0 && Number.isFinite(routeProgressNm) && Number.isFinite(marina.distanceAlongRoute)) {
      if (marina.distanceAlongRoute > routeProgressNm) {
        score += aheadWeight;
        breakdown.ahead = aheadWeight;
      }
    }

    return { score, breakdown };
  }

  _computeReachability(context) {
    const { marina, routeProgressNm } = context;

    if (!Number.isFinite(routeProgressNm) || !Number.isFinite(marina.distanceAlongRoute)) {
      return {
        isAhead: null,
        distanceToMarina: null,
      };
    }

    const distanceToMarina = Math.abs(marina.distanceAlongRoute - routeProgressNm);
    const isAhead = marina.distanceAlongRoute > routeProgressNm;

    return {
      isAhead,
      distanceToMarina,
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
          path: "/marinas/hud/recommendations",
          value: recommendations,
        },
      ],
      source: "marina-hud",
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
          path: "/marinas/hud/summary",
          value: summary,
        },
      ],
      source: "marina-hud",
      timestamp: Date.now(),
    });
  }
}
