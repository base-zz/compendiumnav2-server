import BaseService from "./BaseService.js";
import { getStateManager } from "../relay/core/state/StateManager.js";
import Database from 'better-sqlite3';
import { parseGPXRoute, calculateRouteDistances, findClosestRoutePoint } from '../bridges/gpx-route-parser.js';
import { queryBridgesAlongRoute } from '../bridges/route-queries.js';
import { NexusTideService } from '../bridges/nexus-tide-service.js';
import storageService from "../bluetooth/services/storage/storageService.js";

export class BridgeHudService extends BaseService {
  constructor(options = {}) {
    super("bridge-hud", "continuous");

    this.boatId = options.boatId || "unknown";
    this.dbPath = options.dbPath;
    
    // SpatiaLite extension path
    this.spatiaLitePath = options.spatiaLitePath || '/usr/lib/aarch64-linux-gnu/mod_spatialite.so';
    console.log(`[BridgeHudService] spatiaLitePath from options: ${options.spatiaLitePath}, final: ${this.spatiaLitePath}`);

    // User configuration (fetched from storage)
    this._storageService = storageService;
    this._safeAirDraft = 62.0; // default, will be fetched from storage
    this._topSpeed = 7.0; // default, will be fetched from storage
    this._activeRouteId = null; // will be fetched from storage
    this._routeGpxData = null; // will be fetched from storage

    this._stateManager = getStateManager();
    this._statePatchHandler = null;

    // Database and data
    this._db = null;
    this._bridgeCache = [];
    this._routePoints = [];
    this._routeWithDistances = [];

    // Boat state
    this._boatState = {
      position: null,
      sog: null,
      cog: null,
      lastBridgeCheck: null
    };

    // Tide service
    this._tideService = null;

    // Active bridge alerts (array for multiple simultaneous alerts)
    this._activeAlerts = [];

    // Active bridge notifications (array for multiple simultaneous notifications)
    this._activeNotifications = [];

    // Subscriptions
    this._bridgeSub = null;

    console.log(`[BridgeHudService] CONSTRUCTOR called - dbPath=${this.dbPath}`);
  }

  async start() {
    console.log(`[BridgeHudService] START called - isRunning=${this.isRunning}, spatiaLitePath=${this.spatiaLitePath}`);
    
    if (this.isRunning) {
      console.log('[BridgeHudService] Already running, returning');
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
    this.log(`Bridge HUD service starting initialization in background`);

    // Do heavy initialization asynchronously
    this._initializeAsync().catch(err => {
      console.error('[BridgeHudService] Background initialization failed:', err);
    });
  }

  async _initializeAsync() {
    try {
      // Initialize database
      await this._initDatabase();

      // Load bridges
      this._loadBridges();

      // Load route
      await this._loadRoute();

      // Initialize tide service
      console.log(`[BridgeHudService] Creating NexusTideService with:`, {
        dbPath: this.dbPath,
        spatialitePath: this.spatiaLitePath,
        requestTimeoutMs: 10000
      });
      this._tideService = new NexusTideService({
        dbPath: this.dbPath,
        spatialitePath: this.spatiaLitePath,
        requestTimeoutMs: 10000
      });

      // Fetch user configuration from storage
      await this._fetchUserConfig();

      // Listen to state:patch events from state manager
      this._statePatchHandler = (event) => {
        if (!event || !event.data) {
          return;
        }
        this._processStatePatch(event.data);
      };
      this._stateManager.on("state:patch", this._statePatchHandler);
      console.log('[BridgeHudService] State patch handler registered');

      // Seed boat state from current state
      this._seedBoatState();

      this.log(`Bridge HUD service fully initialized, emitting bridge:hud-update events`);
    } catch (err) {
      console.error('[BridgeHudService] Initialization failed:', err);
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
      console.log('[BridgeHudService] No state manager available for seeding');
      return;
    }

    const state = this._stateManager.getState();
    if (!state) {
      console.log('[BridgeHudService] No state available for seeding');
      return;
    }

    console.log('[BridgeHudService] Seeding boat state from current state');
    this._processStatePatch(state);
  }

  _processStatePatch(patchData) {
    console.log(`[BridgeHudService] _processStatePatch called, type: ${Array.isArray(patchData) ? 'array' : typeof patchData}`);
    
    if (!Array.isArray(patchData)) {
      // If it's not an array, it might be a full state object (from seeding)
      console.log(`[BridgeHudService] Processing full state object`);
      this._processFullState(patchData);
      return;
    }

    console.log(`[BridgeHudService] Processing ${patchData.length} patch operations`);

    // Process individual patch operations
    let routeChanged = false;
    let positionUpdated = false;
    let navigationUpdated = false;

    for (const patch of patchData) {
      console.log(`[BridgeHudService] Patch: op=${patch.op}, path=${patch.path}`);
      if (patch.path === '/routes/activeRoute') {
        const newRouteId = patch.value?.routeId;
        console.log(`[BridgeHudService] Route patch: routeId=${newRouteId}, routeName=${patch.value?.routeName}`);
        if (newRouteId && newRouteId !== this._activeRouteId) {
          console.log(`[BridgeHudService] Route activated: ${newRouteId} (${patch.value?.routeName})`);
          this._activeRouteId = newRouteId;
          routeChanged = true;
        }
      } else if (patch.path.startsWith('/position/')) {
        positionUpdated = true;
      } else if (patch.path.startsWith('/navigation/')) {
        navigationUpdated = true;
      }
    }

    if (routeChanged) {
      console.log(`[BridgeHudService] Route changed, reloading data`);
      this._fetchUserConfig(); // Reload route data
      this._loadRoute();
    }

    if (positionUpdated || navigationUpdated) {
      console.log(`[BridgeHudService] Position/navigation updated, updating boat state`);
      // Get current state to update boat state
      const state = this._stateManager.getState();
      if (state) {
        this._updateBoatState(state);
      }
    }
  }

  _processFullState(stateData) {
    const { position, navigation, routes } = stateData;

    // Check for route activation changes
    if (routes?.activeRoute) {
      const newRouteId = routes.activeRoute.routeId;
      if (newRouteId && newRouteId !== this._activeRouteId) {
        console.log(`[BridgeHudService] Route activated: ${newRouteId} (${routes.activeRoute.routeName})`);
        this._activeRouteId = newRouteId;
        this._fetchUserConfig(); // Reload route data
        this._loadRoute();
      }
    }

    if (position) {
      this._updateBoatState(stateData);
    }
  }

  _updateBoatState(state) {
    console.log(`[BridgeHudService] _updateBoatState called`);
    const { position, navigation } = state;

    console.log(`[BridgeHudService] Position available: ${!!position}, Position keys: ${position ? Object.keys(position) : 'none'}`);
    console.log(`[BridgeHudService] Navigation available: ${!!navigation}`);
    console.log(`[BridgeHudService] SOG: ${navigation?.speed?.sog?.value}, COG: ${navigation?.course?.cog?.value}`);

    // Position is a dynamic object with source names as keys (e.g., signalk, gps, ais)
    // Check for any position source that has latitude/longitude
    let positionSource = null;
    if (position) {
      // Try to find a position source (signalk, gps, etc.)
      const sources = Object.keys(position);
      for (const source of sources) {
        if (position[source] && position[source].latitude !== undefined && position[source].longitude !== undefined) {
          positionSource = position[source];
          console.log(`[BridgeHudService] Found position source: ${source}`);
          break;
        }
      }
    }

    if (positionSource) {
      this._boatState.position = {
        latitude: positionSource.latitude,
        longitude: positionSource.longitude,
        heading: positionSource.heading || null
      };
      this._boatState.sog = navigation?.speed?.sog?.value;
      this._boatState.cog = navigation?.course?.cog?.value;

      console.log(`[BridgeHudService] Publishing header data: SOG=${this._boatState.sog}, COG=${this._boatState.cog}`);
      // Publish header data
      this._publishHeader(navigation?.depth?.belowTransducer, navigation?.wind?.apparent?.speed);

      // Find next bridge (throttled to every 1 second)
      const now = Date.now();
      if (!this._boatState.lastBridgeCheck || (now - this._boatState.lastBridgeCheck) > 1000) {
        this._boatState.lastBridgeCheck = now;
        console.log(`[BridgeHudService] Finding next bridge`);
        this._findAndPublishNextBridge();
      }
    } else {
      console.log(`[BridgeHudService] No position source available, skipping boat state update`);
    }
  }

  async _initDatabase() {
    try {
      this._db = new Database(this.dbPath);
      console.log('[BridgeHudService] Database opened');

      // Load SpatiaLite extension
      try {
        this._db.loadExtension(this.spatiaLitePath);
        console.log('[BridgeHudService] SpatiaLite loaded');
        
        // Initialize spatial metadata only if not already present
        try {
          const checkTable = this._db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='spatial_ref_sys'`);
          const tableExists = checkTable.get();
          if (!tableExists) {
            this._db.exec(`SELECT InitSpatialMetaData(1);`);
          }
        } catch (err) {
          // Ignore errors - metadata may already exist
        }
      } catch (err) {
        console.warn('[BridgeHudService] SpatiaLite not available:', err.message);
      }
    } catch (err) {
      throw new Error(`Failed to initialize database: ${err.message}`);
    }
  }

  async _fetchUserConfig() {
    try {
      await this._storageService.initialize();
      
      // Fetch bridge settings from storage
      const safeAirDraft = await this._storageService.getSetting('bridgeSafeAirDraft');
      if (safeAirDraft !== undefined && safeAirDraft !== null) {
        this._safeAirDraft = parseFloat(safeAirDraft);
        console.log(`[BridgeHudService] Fetched safeAirDraft from storage: ${this._safeAirDraft}ft`);
      }

      const topSpeed = await this._storageService.getSetting('bridgeTopSpeed');
      if (topSpeed !== undefined && topSpeed !== null) {
        this._topSpeed = parseFloat(topSpeed);
        console.log(`[BridgeHudService] Fetched topSpeed from storage: ${this._topSpeed}kts`);
      }

      // Fetch active route from storage
      const activeRouteId = await this._storageService.getSetting('activeRouteId');
      if (activeRouteId) {
        this._activeRouteId = activeRouteId;
        console.log(`[BridgeHudService] Fetched activeRouteId from storage: ${activeRouteId}`);
        
        // Fetch the route data
        const importedRoutes = await this._storageService.getSetting('importedRoutes');
        if (Array.isArray(importedRoutes)) {
          const activeRoute = importedRoutes.find(r => r.routeId === activeRouteId);
          if (activeRoute && activeRoute.gpxData) {
            this._routeGpxData = activeRoute.gpxData;
            console.log(`[BridgeHudService] Fetched GPX data for active route: ${activeRoute.name}`);
          }
        }
      }
    } catch (err) {
      console.warn('[BridgeHudService] Failed to fetch user config from storage:', err.message);
    }
  }

  _loadBridges() {
    try {
      const stmt = this._db.prepare('SELECT external_id, name, latitude, longitude, closed_height_mhw, tier, tier_description, schedule_type, opening_intervals, blackout_windows, vhf_channel, phone, normally_open_closed, current_rule_summary, bridge_type, constraints FROM bridges');
      this._bridgeCache = stmt.all();
      console.log(`[BridgeHudService] Loaded ${this._bridgeCache.length} bridges from database`);
    } catch (err) {
      console.error('[BridgeHudService] Failed to load bridges:', err.message);
      this._bridgeCache = [];
    }
  }

  async _loadRoute() {
    try {
      if (this._routeGpxData) {
        console.log('[BridgeHudService] Loading route from storage GPX data...');
        // Parse GPX data directly from string (parseGPXRoute expects a file path, need to adapt)
        // For now, write to temp file and parse
        const fs = await import('fs');
        const path = await import('path');
        const os = await import('os');
        const tempDir = os.tmpdir();
        const tempFile = path.join(tempDir, `route-${Date.now()}.gpx`);
        fs.writeFileSync(tempFile, this._routeGpxData);
        
        this._routePoints = await parseGPXRoute(tempFile);
        this._routeWithDistances = calculateRouteDistances(this._routePoints);
        
        // Clean up temp file
        fs.unlinkSync(tempFile);
        
        console.log(`[BridgeHudService] Route loaded: ${this._routePoints.length} points, ${this._routeWithDistances[this._routeWithDistances.length-1]?.distanceFromStart?.toFixed(1)}nm total`);
      } else {
        console.warn('[BridgeHudService] No GPX data available from storage');
        this._routePoints = [];
        this._routeWithDistances = [];
      }
    } catch (err) {
      console.warn('[BridgeHudService] Failed to load route:', err.message);
      this._routePoints = [];
      this._routeWithDistances = [];
    }
  }

  _publishHeader(depth, wind) {
    const headerData = {
      sog: this._boatState.sog,
      cog: this._boatState.cog,
      depth: depth?.belowTransducer?.value,
      wind: wind?.speedOverGround?.value,
      timestamp: Date.now()
    };

    this._stateManager.emit('state:patch', {
      type: 'state:patch',
      path: 'bridges.hud.header',
      value: headerData,
      source: 'bridge-hud',
      timestamp: Date.now()
    });
    console.log(`[BridgeHudService] Patched header state: SOG=${headerData.sog}, COG=${headerData.cog}`);
  }

  async _findAndPublishNextBridge() {
    const { latitude, longitude } = this._boatState.position;
    
    if (!latitude || !longitude) {
      return;
    }

    // Find next bridge on route
    const nextBridge = this._findNextBridgeOnRoute(latitude, longitude);

    if (nextBridge) {
      await this._publishNextBridge(nextBridge);
    } else {
      console.log('[BridgeHudService] No bridge found on route');
    }
  }

  async _findNextBridgeOnRoute(boatLat, boatLon, maxDistanceFromRoute = 2) {
    if (this._routeWithDistances.length === 0 || this._bridgeCache.length === 0) {
      return null;
    }
    
    // Find closest point on route to boat
    const closest = findClosestRoutePoint(this._routeWithDistances, boatLat, boatLon);
    
    if (closest.distanceNM > maxDistanceFromRoute) {
      console.log(`[BridgeHudService] Boat is ${closest.distanceNM.toFixed(2)}nm off route`);
      return null;
    }
    
    // Use route-queries module to find bridges along route
    // Since we already have the route loaded in memory, we can use the route points directly
    // queryBridgesAlongRoute expects a file path, so we'll need to write temp file
    const fs = await import('fs');
    const path = await import('path');
    const os = await import('os');
    const tempDir = os.tmpdir();
    const tempFile = path.join(tempDir, `route-query-${Date.now()}.gpx`);

    try {
      fs.writeFileSync(tempFile, this._routeGpxData || '');

      const bridgesAhead = await queryBridgesAlongRoute(
        tempFile,
        {
          dbPath: this.dbPath,
          maxDistanceNM: 2
        }
      );

      // Clean up temp file
      fs.unlinkSync(tempFile);

      if (!bridgesAhead || bridgesAhead.length === 0) {
        console.log('[BridgeHudService] No bridges found ahead on route');
        return null;
      }

      const bridge = bridgesAhead[0];
      if (bridge) {
        const distanceStr = bridge.distance_nm !== undefined ? bridge.distance_nm.toFixed(2) : 'unknown';
        console.log(`[BridgeHudService] Found next bridge: ${bridge.name || 'Unknown'} at ${distanceStr}nm`);
      }
      return bridge;
    } catch (err) {
      console.error('[BridgeHudService] Error finding bridges on route:', err.message);
      // Clean up temp file if it exists
      try {
        fs.unlinkSync(tempFile);
      } catch (cleanupErr) {
        // Ignore cleanup errors
      }
      return null;
    }
  }

  async _publishNextBridge(bridge) {
    if (!bridge) {
      console.warn('[BridgeHudService] Cannot publish next bridge - bridge is null/undefined');
      return;
    }

    // Get tide data for bridge location
    let tideData = null;
    if (bridge.latitude !== undefined && bridge.longitude !== undefined) {
      try {
        tideData = await this._tideService.getEnvironmentalData(bridge.latitude, bridge.longitude);
      } catch (err) {
        console.warn('[BridgeHudService] Failed to get tide data:', err.message);
      }
    } else {
      console.warn('[BridgeHudService] Bridge missing latitude/longitude, skipping tide data');
    }

    // Calculate dynamic clearance
    let dynamicClearance = null;
    let clearanceMargin = null;

    if (tideData && tideData.tide && 'height' in tideData.tide && typeof tideData.tide.height === 'number' && bridge.closed_height_mhw !== undefined && this._safeAirDraft !== undefined) {
      dynamicClearance = bridge.closed_height_mhw - tideData.tide.height;
      clearanceMargin = dynamicClearance - this._safeAirDraft;
    }

    const nextBridgeData = {
      id: bridge.external_id || null,
      name: bridge.name || 'Unknown Bridge',
      latitude: bridge.latitude !== undefined ? bridge.latitude : null,
      longitude: bridge.longitude !== undefined ? bridge.longitude : null,
      distance_nm: bridge.distance_nm !== undefined ? bridge.distance_nm : null,
      charted_clearance_ft: bridge.closed_height_mhw !== undefined ? bridge.closed_height_mhw : null,
      dynamic_clearance_ft: dynamicClearance,
      clearance_margin_ft: clearanceMargin,
      schedule_type: bridge.schedule_type || null,
      vhf_channel: bridge.vhf_channel || null,
      tier: bridge.tier || null,
      timestamp: Date.now()
    };

    // Add schedule-specific data
    if (bridge.schedule_type === 'SCHEDULED' && bridge.opening_intervals) {
      nextBridgeData.opening_intervals = bridge.opening_intervals;
      try {
        nextBridgeData.next_opening = this._calculateNextOpening(bridge);
      } catch (err) {
        console.warn('[BridgeHudService] Failed to calculate next opening:', err.message);
      }
    } else if (bridge.schedule_type === 'ON_DEMAND') {
      nextBridgeData.on_demand = true;
      nextBridgeData.should_hail = bridge.distance_nm !== undefined && bridge.distance_nm <= 1.0;
    } else if (bridge.schedule_type === 'FIXED') {
      nextBridgeData.fixed = true;
      if (bridge.closed_height_mhw !== undefined && this._safeAirDraft !== undefined) {
        nextBridgeData.can_pass_closed = bridge.closed_height_mhw >= this._safeAirDraft;
      }
    }

    this._stateManager.emit('state:patch', {
      type: 'state:patch',
      path: 'bridges.hud.nextBridge',
      value: nextBridgeData,
      source: 'bridge-hud',
      timestamp: Date.now()
    });
    const distanceStr = bridge.distance_nm !== undefined ? bridge.distance_nm.toFixed(2) : 'unknown';
    const bridgeName = bridge.name || 'Unknown Bridge';
    console.log(`[BridgeHudService] Patched next bridge state: ${bridgeName} (${distanceStr}nm)`);

    // Update alert for this bridge (add or remove based on clearance)
    if (bridge.external_id) {
      this._updateBridgeAlert(bridge, clearanceMargin, dynamicClearance);
    } else {
      console.warn('[BridgeHudService] Cannot update alert - bridge missing external_id');
    }
  }

  _updateBridgeAlert(bridge, clearanceMargin, dynamicClearance) {
    if (!bridge.external_id) {
      console.warn('[BridgeHudService] Cannot update alert - bridge missing external_id');
      return;
    }

    const alertIndex = this._activeAlerts.findIndex(a => a.bridge_id === bridge.external_id);
    const hasLowClearance = clearanceMargin !== null && clearanceMargin < 5;

    if (hasLowClearance && dynamicClearance !== null) {
      const bridgeName = bridge.name || 'Unknown Bridge';
      const alertData = {
        type: 'CLEARANCE_WARNING',
        message: `Low clearance at ${bridgeName}: ${dynamicClearance.toFixed(1)}ft (margin: ${clearanceMargin.toFixed(1)}ft)`,
        severity: clearanceMargin < 0 ? 'CRITICAL' : 'WARNING',
        bridge_id: bridge.external_id,
        bridge_name: bridgeName,
        bridge_latitude: bridge.latitude,
        bridge_longitude: bridge.longitude,
        timestamp: Date.now()
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
    this._stateManager.emit('state:patch', {
      type: 'state:patch',
      path: 'bridges.hud.alerts',
      value: [...this._activeAlerts],
      source: 'bridge-hud',
      timestamp: Date.now()
    });
    console.log(`[BridgeHudService] Patched alerts array: ${this._activeAlerts.length} active`);
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
    } catch (e) {
      intervals = bridge.opening_intervals.split(',').map(Number).sort((a, b) => a - b);
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
      time: nextOpening ? nextOpening.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null,
      minutes_until: minutesUntil !== Infinity ? Math.floor(minutesUntil) : null
    };
  }

  _addNotification(notification) {
    const notificationData = {
      id: `notif-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      ...notification,
      timestamp: Date.now()
    };

    this._activeNotifications.push(notificationData);
    this._publishNotifications();
    console.log(`[BridgeHudService] Added notification: ${notification.message}`);

    // Auto-remove notification after 30 seconds
    setTimeout(() => {
      this._removeNotification(notificationData.id);
    }, 30000);
  }

  _removeNotification(id) {
    const index = this._activeNotifications.findIndex(n => n.id === id);
    if (index >= 0) {
      this._activeNotifications.splice(index, 1);
      this._publishNotifications();
      console.log(`[BridgeHudService] Removed notification: ${id}`);
    }
  }

  _publishNotifications() {
    this._stateManager.emit('state:patch', {
      type: 'state:patch',
      path: 'bridges.hud.notifications',
      value: [...this._activeNotifications],
      source: 'bridge-hud',
      timestamp: Date.now()
    });
    console.log(`[BridgeHudService] Patched notifications array: ${this._activeNotifications.length} active`);
  }
}
