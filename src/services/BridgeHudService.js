import BaseService from "./BaseService.js";
import { getStateManager } from "../relay/core/state/StateManager.js";
import Database from "better-sqlite3";
import {
  parseGPXRoute,
  calculateRouteDistances,
  findClosestRoutePoint,
} from "../bridges/gpx-route-parser.js";
import { queryBridgesAlongRoute } from "../bridges/route-queries.js";
import { NexusTideService } from "../bridges/nexus-tide-service.js";
import storageService from "../bluetooth/services/storage/storageService.js";

/**
 * Bridge HUD lifecycle and efficiency model:
 * - Stays dormant when no active route exists.
 * - Always listens for active-route events, and only then enables bridge patch processing.
 * - Registers `state:bridge-patch` handler on activation and unregisters on deactivation.
 * - Emits JSON Patch arrays for HUD updates.
 * - Avoids redundant patch traffic by deduplicating unchanged header payloads.
 *
 * Note: time_to_arrival_minutes uses the string "Infinity" (not the JS Infinity value)
 * when SOG === 0 and distance is finite, because JSON.stringify(Infinity) === "null".
 * Frontend should check: time_to_arrival_minutes === "Infinity" and render ∞.
 */

export class BridgeHudService extends BaseService {
  constructor(options = {}) {
    super("bridge-hud", "continuous");

    this.boatId = options.boatId || "unknown";
    this.dbPath = options.dbPath;

    // SpatiaLite extension path
    this.spatiaLitePath =
      options.spatiaLitePath || "/usr/lib/aarch64-linux-gnu/mod_spatialite.so";

    // User configuration (fetched from storage)
    this._storageService = storageService;
    this._safeAirDraft = 62.0; // default, will be fetched from storage
    this._topSpeed = 7.0; // default, will be fetched from storage
    this._activeRouteId = null; // will be fetched from storage
    this._routeGpxData = null; // will be fetched from storage

    this._stateManager = getStateManager();
    this._statePatchHandler = null;
    this._activeRouteHandler = null;

    // Database and data
    this._db = null;
    this._routePoints = [];
    this._routeWithDistances = [];

    // Boat state
    this._boatState = {
      position: null,
      sog: null,
      cog: null,
      lastBridgeCheck: null,
    };

    this._lastHeaderData = null;

    // Tide service
    this._tideService = null;

    // Active bridge alerts (array for multiple simultaneous alerts)
    this._activeAlerts = [];

    // Active bridge notifications (array for multiple simultaneous notifications)
    this._activeNotifications = [];

    // Subscriptions
    this._bridgeSub = null;
  }

  async start() {
    if (this.isRunning) {
      return;
    }

    if (!this.dbPath) {
      throw new Error("BridgeHudService requires BRIDGE_DB_PATH to be defined");
    }

    this._stateManager = getStateManager();
    if (!this._stateManager) {
      throw new Error("BridgeHudService requires a StateManager instance");
    }

    // Mark service as ready first, then do heavy initialization in background
    await super.start();

    // Do heavy initialization asynchronously
    this._initializeAsync().catch((err) => {
      console.error(
        "[BridgeHudService] Background initialization failed:",
        err,
      );
    });
  }

  async _initializeAsync() {
    try {
      // Initialize database
      await this._initDatabase();

      // Fetch user configuration from storage
      await this._fetchUserConfig();

      // Load route (after fetching user config so route data is available)
      await this._loadRoute();

      // Initialize tide service
      this._tideService = new NexusTideService({
        dbPath: this.dbPath,
        spatialitePath: this.spatiaLitePath,
        requestTimeoutMs: 10000,
      });

      this._activeRouteHandler = (event) => {
        this._handleActiveRouteEvent(event);
      };
      this._stateManager.on("state:active-route", this._activeRouteHandler);

      if (this._activeRouteId) {
        this._registerStatePatchHandler();
        this._seedBoatState();
      }
    } catch (err) {
      console.error("[BridgeHudService] Initialization failed:", err);
      throw err;
    }
  }

  async stop() {
    if (!this.isRunning) {
      return;
    }

    if (this._stateManager && this._statePatchHandler) {
      this._stateManager.off("state:patch", this._statePatchHandler);
    }
    this._statePatchHandler = null;

    if (this._stateManager && this._activeRouteHandler) {
      this._stateManager.off("state:active-route", this._activeRouteHandler);
    }
    this._activeRouteHandler = null;

    if (this._connection) {
      await this._connection.close();
      this._connection = null;
    }

    if (this._db) {
      this._db.close();
      this._db = null;
    }

    await super.stop();
  }

  _seedBoatState() {
    if (!this._stateManager) {
      return;
    }

    const state = this._stateManager.getState();
    if (!state) {
      return;
    }

    this._processStatePatch(state);
  }

  _registerStatePatchHandler() {
    if (this._statePatchHandler) {
      return;
    }

    // Only active while a route is active; receives filtered bridge-relevant patches.
    this._statePatchHandler = (event) => {
      if (!event || !event.data) {
        return;
      }
      this._processStatePatch(event.data);
    };
    this._stateManager.on("state:bridge-patch", this._statePatchHandler);
  }

  _unregisterStatePatchHandler() {
    if (!this._statePatchHandler) {
      return;
    }

    this._stateManager.off("state:bridge-patch", this._statePatchHandler);
    this._statePatchHandler = null;
  }

  async _handleActiveRouteEvent(event) {
    const newRouteId = event?.routeId || null;

    if (newRouteId && newRouteId !== this._activeRouteId) {
      this._activeRouteId = newRouteId;
      await this._fetchUserConfig();
      await this._loadRoute();
      this._registerStatePatchHandler();
      return;
    }

    if (!newRouteId && this._activeRouteId) {
      this._activeRouteId = null;
      this._routeGpxData = null;
      this._routeWithDistances = [];
      this._routePoints = [];
      this._unregisterStatePatchHandler();
    }
  }

  _processStatePatch(patchData) {
    if (!Array.isArray(patchData)) {
      this._processFullState(patchData);
      return;
    }

    // Hard gate: no active route means no bridge/nav processing work this cycle.
    if (!this._activeRouteId) {
      return;
    }

    // Active route exists - process navigation updates
    let positionUpdated = false;
    let navigationUpdated = false;

    for (const patch of patchData) {
      if (patch.path.startsWith("/position/")) {
        positionUpdated = true;
      } else if (patch.path.startsWith("/navigation/")) {
        navigationUpdated = true;
      }
    }

    if (positionUpdated || navigationUpdated) {
      // Get current state to update boat state
      const state = this._stateManager.getState();
      if (state) {
        this._updateBoatState(state);
      }
    }
  }

  _processFullState(stateData) {
    const { position } = stateData;

    if (position) {
      this._updateBoatState(stateData);
    }
  }

  _updateBoatState(state) {
    // Only update boat state if there's an active route
    if (!this._activeRouteId) {
      return;
    }

    const { position, navigation } = state;

    // Position is a dynamic object with source names as keys (e.g., signalk, gps, ais)
    // Check for any position source that has latitude/longitude
    let positionSource = null;
    if (position) {
      // Try to find a position source (signalk, gps, etc.)
      const sources = Object.keys(position);
      for (const source of sources) {
        if (
          position[source] &&
          position[source].latitude !== undefined &&
          position[source].longitude !== undefined
        ) {
          positionSource = position[source];
          break;
        }
      }
    }

    if (positionSource) {
      const latitude =
        typeof positionSource.latitude === "number"
          ? positionSource.latitude
          : positionSource.latitude?.value;
      const longitude =
        typeof positionSource.longitude === "number"
          ? positionSource.longitude
          : positionSource.longitude?.value;

      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        return;
      }

      this._boatState.position = {
        latitude,
        longitude,
        heading: positionSource.heading || null,
      };
      this._boatState.sog = navigation?.speed?.sog?.value;
      this._boatState.cog = navigation?.course?.cog?.value;

      // Publish header data
      this._publishHeader(navigation?.depth, navigation?.wind);

      // Bridge lookup is rate-limited to avoid repeated expensive spatial queries.
      const now = Date.now();
      if (
        !this._boatState.lastBridgeCheck ||
        now - this._boatState.lastBridgeCheck > 1000
      ) {
        this._boatState.lastBridgeCheck = now;
        this._findAndPublishNextBridge();
      }
    }
  }

  async _initDatabase() {
    try {
      this._db = new Database(this.dbPath);

      // Load SpatiaLite extension
      try {
        this._db.loadExtension(this.spatiaLitePath);

        // Initialize spatial metadata only if not already present
        try {
          const checkTable = this._db.prepare(
            `SELECT name FROM sqlite_master WHERE type='table' AND name='spatial_ref_sys'`,
          );
          const tableExists = checkTable.get();
          if (!tableExists) {
            this._db.exec(`SELECT InitSpatialMetaData(1);`);
          }
        } catch (_err) {
          // Ignore errors - metadata may already exist
        }
      } catch (_err) {
        console.warn(
          "[BridgeHudService] SpatiaLite not available:",
          _err.message,
        );
      }
    } catch (err) {
      throw new Error(`Failed to initialize database: ${err.message}`);
    }
  }

  async _fetchUserConfig() {
    try {
      await this._storageService.initialize();

      // Fetch bridge settings from storage
      const safeAirDraft =
        await this._storageService.getSetting("bridgeSafeAirDraft");
      if (safeAirDraft !== undefined && safeAirDraft !== null) {
        this._safeAirDraft = parseFloat(safeAirDraft);
      }

      const topSpeed = await this._storageService.getSetting("bridgeTopSpeed");
      if (topSpeed !== undefined && topSpeed !== null) {
        this._topSpeed = parseFloat(topSpeed);
      }

      // Fetch active route from storage
      const activeRouteId =
        await this._storageService.getSetting("activeRouteId");
      if (activeRouteId) {
        this._activeRouteId = activeRouteId;

        // Fetch the route data
        const importedRoutes =
          await this._storageService.getSetting("importedRoutes");
        if (Array.isArray(importedRoutes)) {
          const activeRoute = importedRoutes.find(
            (r) => r.routeId === activeRouteId,
          );
          if (activeRoute && activeRoute.gpxData) {
            this._routeGpxData = activeRoute.gpxData;
          } else {
            // Clear route data if no active route or no GPX data
            this._routeGpxData = null;
            this._routeWithDistances = [];
            this._routePoints = [];
          }
        }
      } else {
        // Clear route data if no active route
        this._activeRouteId = null;
        this._routeGpxData = null;
        this._routeWithDistances = [];
        this._routePoints = [];
      }
    } catch (err) {
      console.warn(
        "[BridgeHudService] Failed to fetch user config from storage:",
        err.message,
      );
    }
  }

  async _loadRoute() {
    try {
      if (this._routeGpxData) {
        // Parse GPX data directly from string (parseGPXRoute expects a file path, need to adapt)
        // For now, write to temp file and parse
        const fs = await import("fs");
        const path = await import("path");
        const os = await import("os");
        const tempDir = os.tmpdir();
        const tempFile = path.join(tempDir, `route-${Date.now()}.gpx`);
        fs.writeFileSync(tempFile, this._routeGpxData);

        this._routePoints = await parseGPXRoute(tempFile);
        this._routeWithDistances = calculateRouteDistances(this._routePoints);

        // Clean up temp file
        fs.unlinkSync(tempFile);
      } else {
        console.warn(
          "[BridgeHudService] No GPX data available from storage, clearing route data",
        );
        this._routePoints = [];
        this._routeWithDistances = [];
      }
    } catch (_err) {
      console.error("[BridgeHudService] Failed to load route:", _err.message);
      this._routePoints = [];
      this._routeWithDistances = [];
    }
  }

  _publishHeader(depth, wind) {
    const depthValue = depth?.belowSurface?.value;
    const windValue = wind?.apparent?.speed?.value;

    const nextHeaderData = {
      sog: this._boatState.sog,
      cog: this._boatState.cog,
      depth: depthValue,
      wind: windValue,
    };

    // Skip identical payloads to reduce state churn/log/transport overhead.
    if (
      this._lastHeaderData &&
      this._lastHeaderData.sog === nextHeaderData.sog &&
      this._lastHeaderData.cog === nextHeaderData.cog &&
      this._lastHeaderData.depth === nextHeaderData.depth &&
      this._lastHeaderData.wind === nextHeaderData.wind
    ) {
      return;
    }

    this._lastHeaderData = { ...nextHeaderData };

    const headerData = {
      ...nextHeaderData,
      timestamp: Date.now(),
    };

    this._stateManager.emit("state:patch", {
      type: "state:patch",
      data: [{ op: "replace", path: "/bridges/hud/header", value: headerData }],
      source: "bridge-hud",
      timestamp: Date.now(),
    });
  }

  async _findAndPublishNextBridge() {
    const { latitude, longitude } = this._boatState.position;

    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      return;
    }

    if (!this._routeWithDistances || this._routeWithDistances.length === 0) {
      return;
    }

    // Find next bridge on route
    const nextBridge = await this._findNextBridgeOnRoute(latitude, longitude);

    if (nextBridge) {
      await this._publishNextBridge(nextBridge);
    }
  }

  async _findNextBridgeOnRoute(boatLat, boatLon, maxDistanceFromRoute = 2) {
    // Find closest point on route to boat
    const closest = findClosestRoutePoint(
      this._routeWithDistances,
      boatLat,
      boatLon,
    );

    if (closest.distanceNM > maxDistanceFromRoute) {
      return null;
    }

    // Use route-queries module to find bridges along route
    // Since we already have the route loaded in memory, we can use the route points directly
    // queryBridgesAlongRoute expects a file path, so we'll need to write temp file
    const fs = await import("fs");
    const path = await import("path");
    const os = await import("os");
    const tempDir = os.tmpdir();
    const tempFile = path.join(tempDir, `route-query-${Date.now()}.gpx`);

    try {
      fs.writeFileSync(tempFile, this._routeGpxData || "");

      const bridgesAhead = await queryBridgesAlongRoute(tempFile, {
        dbPath: this.dbPath,
        maxDistanceNM: 2,
      });

      // Clean up temp file
      fs.unlinkSync(tempFile);

      if (!bridgesAhead || bridgesAhead.length === 0) {
        return null;
      }

      const bridge = bridgesAhead[0];
      if (bridge) {
        // Map distanceFromRoute to distance_nm for consistency
        bridge.distance_nm = bridge.distanceFromRoute;
        // Include distance along route for reference
        bridge.distance_along_route_nm = bridge.distanceAlongRoute;
      }
      return bridge;
    } catch (_err) {
      console.error(
        "[BridgeHudService] Error finding bridges on route:",
        _err.message,
      );
      // Clean up temp file if it exists
      try {
        fs.unlinkSync(tempFile);
      } catch (_cleanupErr) {
        // Ignore cleanup errors
      }
      return null;
    }
  }

  async _publishNextBridge(bridge) {
    if (!bridge) {
      console.warn(
        "[BridgeHudService] Cannot publish next bridge - bridge is null/undefined",
      );
      return;
    }

    // Get tide data for bridge location
    let tideData = null;
    if (bridge.latitude !== undefined && bridge.longitude !== undefined) {
      try {
        tideData = await this._tideService.getEnvironmentalData(
          bridge.latitude,
          bridge.longitude,
        );
      } catch (err) {
        console.warn(
          "[BridgeHudService] Failed to get tide data:",
          err.message,
        );
      }
    } else {
      console.warn(
        "[BridgeHudService] Bridge missing latitude/longitude, skipping tide data",
      );
    }

    // Calculate dynamic clearance
    let dynamicClearance = null;
    let clearanceMargin = null;

    if (
      tideData &&
      tideData.tide &&
      "station" in tideData.tide &&
      typeof tideData.tide.height === "number" &&
      bridge.closed_height_mhw !== undefined &&
      this._safeAirDraft !== undefined
    ) {
      // Use height_mhw if available (converted from MLLW), otherwise fall back to height
      const tideHeight = tideData.tide.height_mhw != null && typeof tideData.tide.height_mhw === "number"
        ? tideData.tide.height_mhw
        : tideData.tide.height;
      dynamicClearance = bridge.closed_height_mhw - tideHeight;
      clearanceMargin = dynamicClearance - this._safeAirDraft;
    }

    // Calculate time to arrival.
    // Uses the string "Infinity" instead of JS Infinity because JSON.stringify(Infinity) === "null",
    // which would silently corrupt the value in transit. Frontend checks === "Infinity" and renders ∞.
    let timeToArrivalMinutes = null;
    const boatSOG = this._boatState.sog;

    if (
      bridge.distance_along_route_nm !== undefined &&
      bridge.distance_along_route_nm !== null
    ) {
      const boatClosest = findClosestRoutePoint(
        this._routeWithDistances,
        this._boatState.position.latitude,
        this._boatState.position.longitude,
      );

      if (
        boatClosest &&
        bridge.distance_along_route_nm > boatClosest.distanceFromStart
      ) {
        const distanceToBridge =
          bridge.distance_along_route_nm - boatClosest.distanceFromStart;

        if (distanceToBridge === null || distanceToBridge === undefined) {
          timeToArrivalMinutes = null;
        } else if (!boatSOG || boatSOG === 0) {
          // SOG is zero — boat is stationary, time to bridge is infinite
          timeToArrivalMinutes = "Infinity";
        } else if (
          Number.isFinite(boatSOG) &&
          Number.isFinite(distanceToBridge)
        ) {
          timeToArrivalMinutes = (distanceToBridge / boatSOG) * 60;
        } else {
          timeToArrivalMinutes = null;
        }
      } else if (
        boatClosest &&
        bridge.distance_along_route_nm <= boatClosest.distanceFromStart
      ) {
        // Already past the bridge along route
        timeToArrivalMinutes = 0;
      }
    }

    const nextBridgeData = {
      id: bridge.external_id || null,
      name: bridge.name || "Unknown Bridge",
      latitude: bridge.latitude !== undefined ? bridge.latitude : null,
      longitude: bridge.longitude !== undefined ? bridge.longitude : null,
      distance_nm: bridge.distance_nm !== undefined ? bridge.distance_nm : null,
      distance_along_route_nm:
        bridge.distance_along_route_nm !== undefined
          ? bridge.distance_along_route_nm
          : null,
      time_to_arrival_minutes: timeToArrivalMinutes,
      tide_height_ft: (tideData?.tide && "station" in tideData.tide && typeof tideData.tide.height === 'number')
        ? (tideData.tide.height_mhw != null && typeof tideData.tide.height_mhw === 'number' ? tideData.tide.height_mhw : tideData.tide.height)
        : null,
      charted_clearance_ft:
        bridge.closed_height_mhw !== undefined
          ? bridge.closed_height_mhw
          : null,
      dynamic_clearance_ft: dynamicClearance,
      clearance_margin_ft: clearanceMargin,
      schedule_type: bridge.schedule_type || null,
      vhf_channel: bridge.vhf_channel || null,
      tier: bridge.tier || null,
      timestamp: Date.now(),
    };

    // Add schedule-specific data
    if (bridge.schedule_type === "SCHEDULED" && bridge.opening_intervals) {
      nextBridgeData.opening_intervals = bridge.opening_intervals;
      try {
        nextBridgeData.next_opening = this._calculateNextOpening(bridge);
      } catch (err) {
        console.warn(
          "[BridgeHudService] Failed to calculate next opening:",
          err.message,
        );
      }
    } else if (bridge.schedule_type === "ON_DEMAND") {
      nextBridgeData.on_demand = true;
      nextBridgeData.should_hail =
        bridge.distance_nm !== undefined && bridge.distance_nm <= 1.0;
    } else if (bridge.schedule_type === "FIXED") {
      nextBridgeData.fixed = true;
      if (
        bridge.closed_height_mhw !== undefined &&
        this._safeAirDraft !== undefined
      ) {
        nextBridgeData.can_pass_closed =
          bridge.closed_height_mhw >= this._safeAirDraft;
      }
    }

    this._stateManager.emit("state:patch", {
      type: "state:patch",
      data: [
        {
          op: "replace",
          path: "/bridges/hud/nextBridge",
          value: nextBridgeData,
        },
      ],
      source: "bridge-hud",
      timestamp: Date.now(),
    });

    // Update alert for this bridge (add or remove based on clearance)
    if (bridge.external_id) {
      this._updateBridgeAlert(bridge, clearanceMargin, dynamicClearance);
    } else {
      console.warn(
        "[BridgeHudService] Cannot update alert - bridge missing external_id",
      );
    }
  }

  _updateBridgeAlert(bridge, clearanceMargin, dynamicClearance) {
    if (!bridge.external_id) {
      console.warn(
        "[BridgeHudService] Cannot update alert - bridge missing external_id",
      );
      return;
    }

    const alertIndex = this._activeAlerts.findIndex(
      (a) => a.bridge_id === bridge.external_id,
    );
    const hasLowClearance = clearanceMargin !== null && clearanceMargin < 5;

    if (hasLowClearance && dynamicClearance !== null) {
      const bridgeName = bridge.name || "Unknown Bridge";
      const alertData = {
        type: "CLEARANCE_WARNING",
        message: `Low clearance at ${bridgeName}: ${dynamicClearance.toFixed(1)}ft (margin: ${clearanceMargin.toFixed(1)}ft)`,
        severity: clearanceMargin < 0 ? "CRITICAL" : "WARNING",
        bridge_id: bridge.external_id,
        bridge_name: bridgeName,
        bridge_latitude: bridge.latitude,
        bridge_longitude: bridge.longitude,
        timestamp: Date.now(),
      };

      if (alertIndex >= 0) {
        // Update existing alert
        this._activeAlerts[alertIndex] = alertData;
      } else {
        // Add new alert
        this._activeAlerts.push(alertData);
      }
    } else if (alertIndex >= 0) {
      // Remove resolved alert
      this._activeAlerts.splice(alertIndex, 1);
    }

    // Publish full alerts array
    this._publishAlerts();
  }

  _publishAlerts() {
    this._stateManager.emit("state:patch", {
      type: "state:patch",
      data: [
        {
          op: "replace",
          path: "/bridges/hud/alerts",
          value: [...this._activeAlerts],
        },
      ],
      source: "bridge-hud",
      timestamp: Date.now(),
    });
  }

  _calculateNextOpening(bridge) {
    if (!bridge.opening_intervals) {
      return null;
    }

    const now = new Date();
    let intervals;

    try {
      const parsed = JSON.parse(bridge.opening_intervals);
      intervals = (parsed.minutes || []).map(Number).sort((a, b) => a - b);
    } catch (_e) {
      intervals = bridge.opening_intervals
        .split(",")
        .map(Number)
        .sort((a, b) => a - b);
    }

    const nowMinuteOfHour = now.getMinutes();
    const nowHour = now.getHours();
    let nextOpening = null;
    let minutesUntil = Infinity;

    for (const minuteMark of intervals) {
      const candidateDate = new Date(now);
      if (minuteMark > nowMinuteOfHour) {
        candidateDate.setMinutes(minuteMark, 0, 0);
      } else {
        candidateDate.setHours(nowHour + 1, minuteMark, 0, 0);
      }
      if (nextOpening === null || candidateDate < nextOpening) {
        nextOpening = candidateDate;
        minutesUntil = (nextOpening.getTime() - now.getTime()) / 60000;
      }
    }

    return {
      time: nextOpening
        ? nextOpening.toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          })
        : null,
      minutes_until:
        minutesUntil !== Infinity ? Math.floor(minutesUntil) : null,
    };
  }

  _addNotification(notification) {
    const notificationData = {
      id: `notif-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      ...notification,
      timestamp: Date.now(),
    };

    this._activeNotifications.push(notificationData);
    this._publishNotifications();

    // Auto-remove notification after 30 seconds
    setTimeout(() => {
      this._removeNotification(notificationData.id);
    }, 30000);
  }

  _removeNotification(id) {
    const index = this._activeNotifications.findIndex((n) => n.id === id);
    if (index >= 0) {
      this._activeNotifications.splice(index, 1);
      this._publishNotifications();
    }
  }

  _publishNotifications() {
    this._stateManager.emit("state:patch", {
      type: "state:patch",
      data: [
        {
          op: "replace",
          path: "/bridges/hud/notifications",
          value: [...this._activeNotifications],
        },
      ],
      source: "bridge-hud",
      timestamp: Date.now(),
    });
  }
}