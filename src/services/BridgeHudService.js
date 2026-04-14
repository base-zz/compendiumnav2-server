import BaseService from "./BaseService.js";
import { connect, StringCodec } from "nats";
import { getStateManager } from "../relay/core/state/StateManager.js";
import Database from 'better-sqlite3';
import { NATS_SUBJECTS } from '../bridges/messages.js';
import { parseGPXRoute, calculateRouteDistances, findClosestRoutePoint } from '../bridges/gpx-route-parser.js';
import { queryBridgesAlongRoute } from '../bridges/route-queries.js';
import { NexusTideService } from '../bridges/nexus-tide-service.js';
import storageService from "../bluetooth/services/storage/storageService.js";

export class BridgeHudService extends BaseService {
  constructor(options = {}) {
    super("bridge-hud", "continuous");

    this.natsUrl = options.natsUrl;
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

    this._connection = null;
    this._codec = StringCodec();
    this._stateManager = null;
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

    // Subscriptions
    this._bridgeSub = null;

    console.log(`[BridgeHudService] CONSTRUCTOR called - natsUrl=${this.natsUrl}, dbPath=${this.dbPath}`);
  }

  async start() {
    console.log(`[BridgeHudService] START called - isRunning=${this.isRunning}, spatiaLitePath=${this.spatiaLitePath}`);
    
    if (this.isRunning) {
      console.log('[BridgeHudService] Already running, returning');
      return;
    }

    if (!this.natsUrl) {
      throw new Error("BridgeHudService requires NATS_URL to be defined");
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
      // Connect to NATS
      console.log('[BridgeHudService] Connecting to NATS...');
      this._connection = await connect({ servers: this.natsUrl });
      console.log('[BridgeHudService] Connected to NATS');

      // Initialize database
      await this._initDatabase();

      // Load bridges
      this._loadBridges();

      // Load route
      await this._loadRoute();

      // Initialize tide service
      this._tideService = new NexusTideService({
        dbPath: this.dbPath,
        spatiaLitePath: this.spatiaLitePath,
        requestTimeoutMs: 10000
      });

      // Fetch user configuration from storage
      await this._fetchUserConfig();

      // Subscribe to bridge data from StateNatsBroadcastService
      this._bridgeSub = this._connection.subscribe(NATS_SUBJECTS.INPUT.BRIDGE);
      console.log(`[BridgeHudService] Subscribed to ${NATS_SUBJECTS.INPUT.BRIDGE}`);

      // Start processing loop
      this._startProcessing();

      this.log(`Bridge HUD service fully initialized, publishing to ${NATS_SUBJECTS.UI.HEADER}, ${NATS_SUBJECTS.UI.NEXT_BRIDGE}, ${NATS_SUBJECTS.UI.ALERT}, ${NATS_SUBJECTS.UI.NOTIFICATION}`);
    } catch (err) {
      console.error('[BridgeHudService] Initialization failed:', err);
      throw err;
    }
  }

  async stop() {
    if (!this.isRunning) {
      return;
    }

    if (this._bridgeSub) {
      this._bridgeSub.unsubscribe();
      this._bridgeSub = null;
    }

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

  async _initDatabase() {
    try {
      this._db = new Database(this.dbPath);
      console.log('[BridgeHudService] Database opened');

      // Load SpatiaLite extension
      try {
        this._db.loadExtension(this.spatiaLitePath);
        console.log('[BridgeHudService] SpatiaLite loaded');
        
        // Initialize spatial metadata
        try {
          this._db.exec(`SELECT InitSpatialMetaData(1);`);
        } catch (err) {
          // Table already exists, ignore
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

  async _startProcessing() {
    console.log('[BridgeHudService] Starting message processing loop...');
    
    (async () => {
      for await (const msg of this._bridgeSub) {
        try {
          const bridgeMessage = JSON.parse(this._codec.decode(msg.data));
          
          if (bridgeMessage.type === 'state:bridge' && bridgeMessage.data) {
            await this._handleBridgeMessage(bridgeMessage);
          }
        } catch (err) {
          console.error('[BridgeHudService] Error processing message:', err.message);
        }
      }
    })();
  }

  async _handleBridgeMessage(bridgeMessage) {
    const { position, depth, wind, speedOverGround } = bridgeMessage.data;
    
    // Update boat state
    if (position?.gps) {
      this._boatState.position = {
        latitude: position.gps.latitude,
        longitude: position.gps.longitude,
        heading: position.gps.heading || position.heading || null
      };
      this._boatState.sog = speedOverGround?.value;
      this._boatState.cog = bridgeMessage.data.courseOverGround?.value;

      // Publish header data
      this._publishHeader(depth, wind);

      // Find next bridge (throttled to every 1 second)
      const now = Date.now();
      if (!this._boatState.lastBridgeCheck || (now - this._boatState.lastBridgeCheck) > 1000) {
        this._boatState.lastBridgeCheck = now;
        await this._findAndPublishNextBridge();
      }
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

    this._connection.publish(NATS_SUBJECTS.UI.HEADER, this._codec.encode(JSON.stringify(headerData)));
    console.log(`[BridgeHudService] Published header: SOG=${headerData.sog}, COG=${headerData.cog}`);
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
      return null;
    }
    
    // Return the closest bridge ahead
    return bridgesAhead[0];
  }

  async _publishNextBridge(bridge) {
    // Get tide data for bridge location
    let tideData = null;
    try {
      tideData = await this._tideService.getEnvironmentalData(bridge.latitude, bridge.longitude);
    } catch (err) {
      console.warn('[BridgeHudService] Failed to get tide data:', err.message);
    }

    // Calculate dynamic clearance
    let dynamicClearance = null;
    let clearanceMargin = null;
    
    if (tideData && tideData.tide && 'height' in tideData.tide && typeof tideData.tide.height === 'number') {
      dynamicClearance = bridge.closed_height_mhw - tideData.tide.height;
      clearanceMargin = dynamicClearance - this._safeAirDraft;
    }

    const nextBridgeData = {
      id: bridge.external_id,
      name: bridge.name,
      latitude: bridge.latitude,
      longitude: bridge.longitude,
      distance_nm: bridge.distance_nm,
      charted_clearance_ft: bridge.closed_height_mhw,
      dynamic_clearance_ft: dynamicClearance,
      clearance_margin_ft: clearanceMargin,
      schedule_type: bridge.schedule_type,
      vhf_channel: bridge.vhf_channel,
      tier: bridge.tier,
      timestamp: Date.now()
    };

    // Add schedule-specific data
    if (bridge.schedule_type === 'SCHEDULED' && bridge.opening_intervals) {
      nextBridgeData.opening_intervals = bridge.opening_intervals;
      nextBridgeData.next_opening = this._calculateNextOpening(bridge);
    } else if (bridge.schedule_type === 'ON_DEMAND') {
      nextBridgeData.on_demand = true;
      nextBridgeData.should_hail = bridge.distance_nm <= 1.0;
    } else if (bridge.schedule_type === 'FIXED') {
      nextBridgeData.fixed = true;
      nextBridgeData.can_pass_closed = bridge.closed_height_mhw >= this._safeAirDraft;
    }

    this._connection.publish(NATS_SUBJECTS.UI.NEXT_BRIDGE, this._codec.encode(JSON.stringify(nextBridgeData)));
    console.log(`[BridgeHudService] Published next bridge: ${bridge.name} (${bridge.distance_nm.toFixed(2)}nm)`);

    // Publish alert if clearance is tight
    if (clearanceMargin !== null && clearanceMargin < 5) {
      this._publishAlert({
        type: 'CLEARANCE_WARNING',
        message: `Low clearance at ${bridge.name}: ${dynamicClearance.toFixed(1)}ft (margin: ${clearanceMargin.toFixed(1)}ft)`,
        severity: clearanceMargin < 0 ? 'CRITICAL' : 'WARNING',
        bridge_id: bridge.external_id
      });
    }
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

  _publishAlert(alert) {
    const alertData = {
      ...alert,
      timestamp: Date.now()
    };

    this._connection.publish(NATS_SUBJECTS.UI.ALERT, this._codec.encode(JSON.stringify(alertData)));
    console.log(`[BridgeHudService] Published alert: ${alert.message}`);
  }

  _publishNotification(notification) {
    const notificationData = {
      ...notification,
      timestamp: Date.now()
    };

    this._connection.publish(NATS_SUBJECTS.UI.NOTIFICATION, this._codec.encode(JSON.stringify(notificationData)));
    console.log(`[BridgeHudService] Published notification: ${notification.message}`);
  }
}
