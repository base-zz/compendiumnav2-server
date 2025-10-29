/**
 * StateService
 *
 * This service connects to SignalK and other data sources to maintain
 * the unified StateData. It handles the connection, data mapping,
 * and synchronization with the relay system.
 */

import WebSocket from "ws";
import ContinuousService from "./ContinuousService.js";
import debug from "debug";
import { stateData } from "../state/StateData.js";
import { signalKAdapterRegistry } from "../relay/server/adapters/SignalKAdapterRegistry.js";
import fetch from "node-fetch";
import { extractAISTargetsFromSignalK } from "../state/extractAISTargets.js";
import { convertSignalKNotifications } from '../shared/convertSignalK.js';
import { UNIT_PRESETS } from '../shared/unitPreferences.js';
import { getServerUnitPreferences } from '../state/serverUnitPreferences.js';
import { UnitConversion } from '../shared/unitConversion.js';
import pkg from "fast-json-patch";
// StateManager is imported dynamically to avoid circular dependency
let stateManager = null;

// Function to set stateManager after imports are resolved
function setStateManager(manager) {
  stateManager = manager;
}

const { compare: jsonPatchCompare } = pkg;

class NewStateService extends ContinuousService {
  // Set to collect unique notification paths
  notificationPathsSeen = new Set();
  notificationPathLoggingStarted = false;

  startNotificationPathLogging() {
    if (this.notificationPathLoggingStarted) return;
    this.notificationPathLoggingStarted = true;
    console.log('[StateService] Starting 10-minute SignalK notification path logging.');
    setTimeout(() => {
      console.log('[StateService] Unique SignalK notification paths seen in last 10 minutes:');
      for (const path of this.notificationPathsSeen) {
        console.log('  -', path);
      }
      // Optionally reset for future runs
      this.notificationPathsSeen.clear();
      this.notificationPathLoggingStarted = false;
    }, 5 * 60 * 1000); // 10 minutes
  }

  logNotificationPathsFromDelta(delta) {
    if (!this.notificationPathLoggingStarted) return;
    if (delta.updates) {
      for (const update of delta.updates) {
        if (update.values) {
          for (const valueObj of update.values) {
            if (valueObj.path && valueObj.path.startsWith('notifications.')) {
              this.notificationPathsSeen.add(valueObj.path);
            }
          }
        }
      }
    }
  }
  constructor() {
    // Call parent constructor with service name
    super('state');
    this.isInitialized = false;
    this.selfMmsi = null;
    this._debug = debug("state");
    this._lastFullEmit = 0;
    this._batchTimer = null;
    this._batchUpdates = {};
    this._aisRefreshTimer = null;
    this._notificationPaths = new Set();
    this._notificationPathLoggingTimer = null;
    this.signalKAdapter = null;
    this.signalKWsUrl = null;
    
    // Load user unit preferences - default to imperial if not set
    this.userUnitPreferences = null;
    this.preferencesPromise = this.loadUserUnitPreferences();
    
    this.hasLoggedFirstData = false;
    this.sources = new Map();
    this.updateQueue = new Map();
    this.updateTimer = null;
    this._lastFullEmit = 0;

    this.connections = {
      websocket: false,
      signalK: {
        websocket: false,
        lastMessage: null,
      },
    };



    this.EVENTS = {
      CONNECTED: "connected",
      DISCONNECTED: "disconnected",
      ERROR: "error",
      DATA_RECEIVED: "data:received",
      STATE_UPDATED: "state:updated",
      SOURCE_ADDED: "source:added",
      SOURCE_REMOVED: "source:removed",
      STATE_FULL_UPDATE: "state:full-update",
      STATE_PATCH: "state:patch",
    };
  }

/**
 * Starts the StateService and establishes necessary connections.
 * Initializes the service with the current configuration, sets up batch processing,
 * connects to SignalK, and starts notification path logging.
 * @returns {Promise<NewStateService>} The service instance for chaining
 * @emits service:state:starting - When the service is starting up
 * @emits service:state:started - When the service has successfully started
 * @emits service:state:error - If an error occurs during startup
 * @throws {Error} If the service fails to start
 */
  async start() {
    if (this.isRunning) {
      this.log('State service is already running');
      return;
    }
  
    try {
      this.emit('service:state:starting');
      this.log('Starting state service');
  
      // Initialize with current config or empty object if not set
      const config = this.config || {};
      if (this.preferencesPromise) {
        await this.preferencesPromise;
      }
      await this.initialize(config);
  
      // Set up batch processing if not already set up
      if (!this._batchTimer) {
        this._setupBatchProcessing();
      }
  
      // Connect to SignalK if not already connected
      if (!this.connections.signalK.websocket) {
        await this._connectToSignalK();
      }
  
      // Start notification path logging
      this.startNotificationPathLogging();
  
      this.isRunning = true;
      this.lastUpdated = new Date();
      
      this.emit('service:state:started', { 
        timestamp: this.lastUpdated,
        signalKConnected: this.connections.signalK.websocket
      });
      
      this.log('State service started successfully');
      return this;
    } catch (error) {
      this.logError('Failed to start state service:', error);
      this.emit('service:state:error', { 
        error: error.message,
        code: error.code,
        timestamp: new Date()
      });
      throw error;
    }
  }
  
/**
 * Stops the StateService and cleans up resources.
 * Disconnects from SignalK, clears all timers and intervals, and resets the service state.
 * @returns {Promise<void>}
 * @emits service:state:stopping - When the service is stopping
 * @emits service:state:stopped - When the service has successfully stopped
 * @emits service:state:error - If an error occurs during shutdown
 */  
  async stop() {
    if (!this.isRunning) {
      this.log('State service is not running');
      return;
    }
  
    try {
      this.emit('service:state:stopping');
      this.log('Stopping state service');
  
      // Clear any pending batch processing
      if (this._batchTimer) {
        clearTimeout(this._batchTimer);
        this._batchTimer = null;
      }
  
      // Clear AIS refresh interval
      if (this._aisRefreshTimer) {
        clearInterval(this._aisRefreshTimer);
        this._aisRefreshTimer = null;
      }
  
      // Clear any notification path logging
      if (this.notificationPathLoggingStarted) {
        clearTimeout(this._notificationPathLoggingTimer);
        this.notificationPathLoggingStarted = false;
        this.notificationPathsSeen.clear();
      }
  
      // Disconnect from SignalK if connected
      if (this.signalKAdapter && typeof this.signalKAdapter.disconnect === 'function') {
        try {
          await this.signalKAdapter.disconnect();
        } catch (error) {
          this.logError('Error disconnecting SignalK adapter:', error);
        }
        this.signalKAdapter = null;
      }
  
      // Clear any pending updates
      this.updateQueue.clear();
      this._batchUpdates = {};
  
      this.isRunning = false;
      this.isInitialized = false;
      this.lastUpdated = new Date();
  
      this.emit('service:state:stopped', { 
        timestamp: this.lastUpdated 
      });
      this.log('State service stopped successfully');
    } catch (error) {
      this.logError('Error stopping state service:', error);
      this.emit('service:state:error', { 
        error: error.message,
        code: error.code,
        timestamp: new Date()
      });
      throw error;
    }
  }
  

/**
   * Initializes the StateService with the provided configuration.
   * Sets up the SignalK adapter, batch processing, and connects to SignalK.
   * @param {Object} config - Configuration object containing SignalK URL and other parameters
   * @returns {Promise<void>}
   * @emits service:state:initializing - When the service is initializing
   * @emits service:state:initialized - When the service has successfully initialized
   * @emits service:state:error - If an error occurs during initialization
   * @throws {Error} If the service fails to initialize
   */
  async initialize(config = {}) {
    console.log("[StateService] Initializing with config:", config);
    const isNodeEnv = typeof process !== "undefined" && process.env;

    const signalKBaseUrl =
      config.signalKBaseUrl ||
      (isNodeEnv ? process.env.SIGNALK_URL : undefined);
    const reconnectDelay =
      config.reconnectDelay ||
      (isNodeEnv ? process.env.RECONNECT_DELAY : undefined);
    const maxReconnectAttempts =
      config.maxReconnectAttempts ||
      (isNodeEnv ? process.env.MAX_RECONNECT_ATTEMPTS : undefined);
    const updateInterval = config.updateInterval || process.env.UPDATE_INTERVAL;

    // Check for missing configuration parameters and provide detailed error messages
    const missingParams = [];
    if (!signalKBaseUrl) missingParams.push('SIGNALK_URL');
    if (!reconnectDelay) missingParams.push('RECONNECT_DELAY');
    if (!maxReconnectAttempts) missingParams.push('MAX_RECONNECT_ATTEMPTS');
    if (!updateInterval) missingParams.push('UPDATE_INTERVAL');
    
    if (missingParams.length > 0) {
      throw new Error(`Missing required configuration parameters: ${missingParams.join(', ')}. Please check your .env file.`);
    }

    this.config = {
      signalKBaseUrl,
      signalKToken: config.signalKToken || process.env.SIGNALK_TOKEN || null,
      reconnectDelay: parseInt(reconnectDelay, 10),
      maxReconnectAttempts: parseInt(maxReconnectAttempts, 10),
      updateInterval: parseInt(updateInterval, 10),
      debug:
        config.debug !== undefined
          ? config.debug
          : process.env.DEBUG === "true",
      ...config,
    };

    this._setupBatchProcessing();
    await this._discoverSignalKServer();
    // Start notification path logging when service initializes
    this.startNotificationPathLogging();
    await this._connectToSignalK();

    try {
      const vesselsUrl = `${this.config.signalKBaseUrl.replace(
        /\/$/,
        ""
      )}/v1/api/vessels`;
      const selfUrl = `${this.config.signalKBaseUrl.replace(
        /\/$/,
        ""
      )}/v1/api/self`;
      const headers = this.config.signalKToken
        ? { Authorization: `Bearer ${this.config.signalKToken}` }
        : {};

      const [vesselsResponse, selfResponse] = await Promise.all([
        fetch(vesselsUrl, { headers }),
        fetch(selfUrl, { headers }),
      ]);

      if (vesselsResponse.ok && selfResponse.ok) {
        const [vesselsData, selfData] = await Promise.all([
          vesselsResponse.json(),
          selfResponse.json(),
        ]);

        this.selfMmsi = selfData?.replace("vessels.", "");
        const aisTargets = extractAISTargetsFromSignalK(
          vesselsData,
          this.selfMmsi
        );
        stateData.aisTargets = aisTargets;

        this.startAISPeriodicRefresh(async () => {
          const url = `${this.config.signalKBaseUrl.replace(
            /\/$/,
            ""
          )}/v1/api/vessels`;
          const response = await fetch(url, { headers });
          if (!response.ok)
            throw new Error(`Failed to fetch /vessels: ${response.status}`);
          return { vessels: await response.json() };
        }, 10000);
      }
    } catch (err) {
      console.warn("[StateService] Error fetching initial data:", err);
    }

    this._debug("StateService initialized");
    return this;
  }

/**
 * Gets the current status of the StateService.
 * Returns an object containing service state, connection status, and statistics.
 * @returns {Object} Status object containing:
 * @property {boolean} isInitialized - Whether the service is initialized
 * @property {Date} lastUpdated - Timestamp of the last update
 * @property {Object} connections - Connection status
 * @property {Object} connections.signalK - SignalK connection details
 * @property {boolean} connections.signalK.connected - Connection status
 * @property {string} connections.signalK.url - SignalK WebSocket URL
 * @property {Object} dataStats - Data statistics
 * @property {number} dataStats.aisTargets - Number of AIS targets
 * @property {number} dataStats.pendingUpdates - Number of pending updates
 * @property {number} dataStats.batchUpdates - Number of batched updates
 * @property {Object} config - Current configuration
 * @property {string} config.signalKBaseUrl - Base URL for SignalK
 * @property {number} config.pingInterval - Current ping interval in ms
 */
  getStatus() {
    return {
      // Base status from ContinuousService
      ...super.getStatus(),
      
      // Service-specific status
      isInitialized: this.isInitialized,
      lastUpdated: this.lastUpdated,
      notificationPathLogging: this.notificationPathLoggingStarted,
      notificationPathsSeen: this.notificationPathsSeen.size,
      
      // Connection status
      connections: {
        signalK: {
          connected: this.connections.signalK.websocket,
          lastMessage: this.connections.signalK.lastMessage,
          url: this.signalKWsUrl
        }
      },
      
      // Data statistics
      dataStats: {
        aisTargets: Object.keys(stateData.aisTargets || {}).length,
        pendingUpdates: this.updateQueue.size,
        batchUpdates: Object.keys(this._batchUpdates || {}).length
      },
      
      // Configuration
      config: {
        signalKBaseUrl: this.config?.signalKBaseUrl || null,
        pingInterval: this.config?.updateInterval || null
      }
    };
  }



  /**
   * Update AIS targets from SignalK data and emit a full update
   * @param {Object} fullSignalKData - Complete SignalK data including vessels
   * @returns {Promise<void>}
   */
  async updateAISTargetsFromSignalK(fullSignalKData) {
    try {
      const startTime = Date.now();
      
      // Ensure we have valid data to work with
      if (!fullSignalKData?.vessels) {
        console.warn("[StateService] Invalid SignalK data received for AIS update");
        return;
      }

      // Log notification paths from full SignalK data if present
      if (fullSignalKData && typeof this.logNotificationPathsFromDelta === 'function') {
        this.logNotificationPathsFromDelta(fullSignalKData);
      }
      // --- SignalK Notification Handling ---
    // Extract notifications from any update values with paths like 'notifications.category.key'
    if (fullSignalKData && fullSignalKData.updates) {
      const notifications = {};
      for (const update of fullSignalKData.updates) {
        if (update.values) {
          for (const valueObj of update.values) {
            if (valueObj.path && valueObj.path.startsWith('notifications.')) {
              // Parse category/key from path, e.g. 'notifications.instrument.NoFix'
              const pathParts = valueObj.path.split('.');
              if (pathParts.length === 3) {
                const [, category, key] = pathParts;
                if (!notifications[category]) notifications[category] = {};
                notifications[category][key] = {
                  meta: {},
                  value: valueObj.value,
                  $source: valueObj.$source || '',
                  timestamp: valueObj.value?.timestamp || '',
                  pgn: valueObj.pgn || undefined
                };
              }
            }
          }
        }
      }
      if (Object.keys(notifications).length > 0) {
        const alerts = convertSignalKNotifications(notifications);
        this._queueUpdate('alerts.active', alerts, 'signalK');
      }
    }
    // --- End SignalK Notification Handling ---

      // Extract AIS targets from SignalK data
      const newAisTargetsArray = extractAISTargetsFromSignalK(
        fullSignalKData.vessels,
        this.selfMmsi
      );
      // Only log if needed: comment out verbose logs
      // console.log(`[StateService] Extracted ${newAisTargetsArray.length} AIS targets in ${Date.now() - extractStartTime}ms`);
      
      // Convert array to object with MMSI keys
      const newAisTargets = {};
      newAisTargetsArray.forEach(target => {
        if (target && target.mmsi) {
          newAisTargets[target.mmsi] = target;
        }
      });
       
      // Get current targets for comparison
      const oldAisTargets = stateData.aisTargets || {};
      
      // Analyze the current and new targets directly using object keys
      const oldMmsiSet = new Set(Object.keys(oldAisTargets));
      const newMmsiSet = new Set(Object.keys(newAisTargets));
      
      // Analyze changes
      const addedTargets = [];
      const removedTargets = [];
      const updatedTargets = [];
      const unchangedTargets = [];
      
      // Find added targets (in new but not in old)
      for (const mmsi of newMmsiSet) {
        if (!oldMmsiSet.has(mmsi)) {
          addedTargets.push(newAisTargets[mmsi]);
        }
      }
      
      // Find removed targets (in old but not in new)
      for (const mmsi of oldMmsiSet) {
        if (!newMmsiSet.has(mmsi)) {
          removedTargets.push(oldAisTargets[mmsi]);
        }
      }
      
      // Find updated and unchanged targets (in both old and new)
      for (const mmsi of newMmsiSet) {
        if (oldMmsiSet.has(mmsi)) {
          const oldTarget = oldAisTargets[mmsi];
          const newTarget = newAisTargets[mmsi];
          
          if (this._hasTargetChanged(oldTarget, newTarget)) {
            updatedTargets.push(newTarget);
          } else {
            unchangedTargets.push(newTarget);
          }
        }
      }
      
      const totalChanges = addedTargets.length + removedTargets.length + updatedTargets.length;
      const totalTargets = Object.keys(newAisTargets).length;
      
      // Always update the state with the new targets
      stateData.aisTargets = newAisTargets;
      
      // Emit a full state update to ensure aisTargets are included
      this.emit(this.EVENTS.STATE_FULL_UPDATE, {
        type: 'state:full-update',
        data: stateData.state,
        source: 'signalK',
        timestamp: Date.now()
      });
      
      // Only proceed with individual updates if there are actual changes
      if (totalChanges > 0) {
        
        // Determine update strategy based on change volume
        // If changes exceed 30% of total targets or there are more than 20 changes, send full update
        // Otherwise, send individual patches
        const changeRatio = totalTargets > 0 ? totalChanges / totalTargets : 1;
        const useFullUpdate = changeRatio > 0.3 || totalChanges > 20;
        
        if (useFullUpdate) {
          // Emit a full update event for AIS targets
          this.emit(this.EVENTS.STATE_UPDATED, {
            type: 'state:updated',
            path: 'aisTargets',
            value: newAisTargets,
            source: 'signalK',
            timestamp: Date.now(),
            changes: {
              added: addedTargets.length,
              removed: removedTargets.length,
              updated: updatedTargets.length,
              unchanged: unchangedTargets.length
            }
          });
        } else {
          // Emit individual patches for each change
          
          // Create patches for each type of change
          const patches = [];
          
          // Added targets
          addedTargets.forEach(target => {
            patches.push({
              op: 'add',
              path: `/aisTargets/${target.mmsi}`,
              value: target
            });
          });
          
          // Removed targets
          removedTargets.forEach(target => {
            patches.push({
              op: 'remove',
              path: `/aisTargets/${target.mmsi}`
            });
          });
          
          // Updated targets
          updatedTargets.forEach(target => {
            patches.push({
              op: 'replace',
              path: `/aisTargets/${target.mmsi}`,
              value: target
            });
          });
          
          // Emit the patches
          this.emit(this.EVENTS.STATE_PATCH, {
            type: 'state:patch',
            path: 'aisTargets',
            patches: patches,
            source: 'signalK',
            timestamp: Date.now(),
            changes: {
              added: addedTargets.length,
              removed: removedTargets.length,
              updated: updatedTargets.length,
              unchanged: unchangedTargets.length
            }
          });
        }
      }
    } catch (error) {
      console.error('[StateService] Error in AIS target update process:', error);
    }
  }
  
  /**
   * Check if a specific AIS target has changed in important ways
   * @param {Object} oldTarget - The previous state of the target
   * @param {Object} newTarget - The current state of the target
   * @returns {boolean} True if the target has meaningful changes
   */
  _hasTargetChanged(oldTarget, newTarget) {
    // Check position changes
    if (oldTarget.position?.latitude !== newTarget.position?.latitude ||
        oldTarget.position?.longitude !== newTarget.position?.longitude) {
      return true;
    }
    
    // Check other important properties
    if (oldTarget.sog !== newTarget.sog ||
        oldTarget.cog !== newTarget.cog ||
        oldTarget.heading !== newTarget.heading) {
      return true;
    }
    
    return false;
  }
  
  /**
   * Analyze what properties are changing in updated targets
   * @param {Object} oldTargets - Object of old targets with MMSI keys
   * @param {Array} updatedTargets - Array of targets that have been updated
   * @returns {Object} Count of changes by property
   */
  _analyzeTargetChanges(oldTargets, updatedTargets) {
    const changes = {};
    
    updatedTargets.forEach(newTarget => {
      const mmsi = newTarget.mmsi;
      const oldTarget = oldTargets[mmsi];
      if (!oldTarget) return;
      
      // Check position
      if (oldTarget.position?.latitude !== newTarget.position?.latitude) {
        changes.latitude = (changes.latitude || 0) + 1;
      }
      if (oldTarget.position?.longitude !== newTarget.position?.longitude) {
        changes.longitude = (changes.longitude || 0) + 1;
      }
      
      // Check other properties
      if (oldTarget.sog !== newTarget.sog) {
        changes.sog = (changes.sog || 0) + 1;
      }
      if (oldTarget.cog !== newTarget.cog) {
        changes.cog = (changes.cog || 0) + 1;
      }
      if (oldTarget.heading !== newTarget.heading) {
        changes.heading = (changes.heading || 0) + 1;
      }
    });
    
    return changes;
  }
  
  // Method to emit the full state to all clients
  _emitFullState() {
    this._debug("Emitting full state update");
    this.emit(this.EVENTS.STATE_FULL_UPDATE, {
      type: "state:full-update",
      data: stateData,
      source: "signalK",
      timestamp: Date.now(),
    });
    this._lastFullEmit = Date.now();
  }

  startAISPeriodicRefresh(fetchSignalKFullState, intervalMs = 10000) {
    if (this._aisRefreshTimer) {
      console.log("[StateService] Stopping existing AIS refresh timer");
      clearInterval(this._aisRefreshTimer);
    }
    
    console.log(`[StateService] Starting AIS periodic refresh every ${intervalMs}ms`);
    
    this._aisRefreshTimer = setInterval(async () => {
      try {
        const startTime = Date.now();
        
        const fullSignalKData = await fetchSignalKFullState();
        const vesselCount = Object.keys(fullSignalKData?.vessels || {}).length;
        
        // console.log(`[StateService] Received SignalK data with ${vesselCount} vessels in ${Date.now() - startTime}ms`);
        
        await this.updateAISTargetsFromSignalK(fullSignalKData);
      } catch (err) {
        console.error("[StateService] AIS periodic refresh error:", err);
      }
    }, intervalMs);
    
    // console.log("[StateService] AIS refresh timer started");
  }

  stopAISPeriodicRefresh() {
    if (this._aisRefreshTimer) clearInterval(this._aisRefreshTimer);
    this._aisRefreshTimer = null;
  }

  async _discoverSignalKServer() {
    const infoUrl = this.config.signalKBaseUrl;
    const headers = this.config.signalKToken
      ? { Authorization: `Bearer ${this.config.signalKToken}` }
      : {};

    const response = await fetch(infoUrl, { headers });
    if (!response.ok) {
      throw new Error(
        `Failed to fetch SignalK server info: ${response.status} ${response.statusText}`
      );
    }

    const discoveryJson = await response.json();
    const wsUrl = discoveryJson?.endpoints?.v1?.["signalk-ws"];

    if (!wsUrl || typeof wsUrl !== "string" || !wsUrl.startsWith("ws")) {
      throw new Error(
        "SignalK WebSocket URL (signalk-ws) not found in discovery JSON."
      );
    }

    this.signalKWsUrl = wsUrl;
    this.signalKAdapter = signalKAdapterRegistry.findAdapter
      ? signalKAdapterRegistry.findAdapter(discoveryJson)
      : null;
  }

  async _connectToSignalK() {
    return new Promise((resolve, reject) => {
      let url = this.signalKWsUrl;
      if (this.config.signalKToken) {
        url += `?token=${this.config.signalKToken}`;
      }

      const socket = new WebSocket(url);
      this.connections.signalK.socket = socket;

      socket.on("open", () => {
        this._debug("Connected to SignalK");
        this.connections.signalK.connected = true;
        this.connections.signalK.reconnectAttempts = 0;

        socket.send(
          JSON.stringify({
            context: "*",
            subscribe: [
              {
                path: "*",
                period: this.config.updateInterval || 1000,
              },
            ],
          })
        );

        this.emit(this.EVENTS.CONNECTED, { source: "signalK" });
        resolve();
      });

      socket.on("message", (data) => {
        this._handleSignalKMessage(data);
      });

      socket.on("error", (error) => {
        this._debug(`SignalK connection error: ${error.message}`);
        this.emit(this.EVENTS.ERROR, {
          source: "signalK",
          error,
          message: error.message,
        });
      });

      socket.on("close", () => {
        this._debug("Disconnected from SignalK");
        this.connections.signalK.connected = false;
        this.emit(this.EVENTS.DISCONNECTED, { source: "signalK" });
        this._reconnectToSignalK();
      });
    });
  }

  _reconnectToSignalK() {
    if (
      this.connections.signalK.reconnectAttempts >=
      this.config.maxReconnectAttempts
    ) {
      this._debug("Max reconnect attempts reached, giving up");
      this.emit(this.EVENTS.ERROR, {
        source: "signalK",
        message: "Max reconnect attempts reached",
      });
      return;
    }

    this.connections.signalK.reconnectAttempts++;
    this._debug(
      `Reconnecting to SignalK (attempt ${this.connections.signalK.reconnectAttempts}/${this.config.maxReconnectAttempts})`
    );

    setTimeout(() => {
      this._connectToSignalK().catch(() => {});
    }, this.config.reconnectDelay);
  }

  async _handleSignalKMessage(data) {
    try {
      const message = JSON.parse(data);
      this.connections.signalK.lastMessage = Date.now();

      if (message.updates) {
        await this._processSignalKDelta(message);
      }
      this.emit(this.EVENTS.DATA_RECEIVED, {
        source: "signalK",
        timestamp: Date.now(),
      });
    } catch (error) {
      this._debug(`Error processing SignalK message: ${error.message}`);
      this.emit(this.EVENTS.ERROR, {
        source: "signalK",
        error,
        message: error.message,
        data,
      });
    }
  }

  async _processSignalKDelta(delta) {
    if (!delta.updates || !Array.isArray(delta.updates)) return;

    let processedData = delta;
    if (this.signalKAdapter?.processMessage) {
      processedData = this.signalKAdapter.processMessage(delta);
    }

    if (!processedData.updates) return;

    for (const update of processedData.updates) {
      if (!Array.isArray(update.values)) continue;

      const source =
        update.$source || (update.source && update.source.label) || "unknown";

      for (const value of update.values) {
        if (!value.path) continue;

        this._processSignalKValue(value.path, value.value, source);
      }
    }
  }

  /**
   * Load user unit preferences from storage
   * For server-side, we use a file-based approach instead of Capacitor Preferences
   * Defaults to imperial units if not set
   */
  async loadUserUnitPreferences() {
    try {
      // Use our server-specific implementation that doesn't rely on browser APIs
      this.userUnitPreferences = await getServerUnitPreferences();
      if (stateData) {
        stateData.userUnitPreferences = this.userUnitPreferences;
      }
      console.log('[StateService] Loaded user unit preferences:', this.userUnitPreferences);
      return this.userUnitPreferences;
    } catch (err) {
      console.error('[StateService] Error in loadUserUnitPreferences:', err);
      // Default to imperial units if there's any error
      this.userUnitPreferences = { 
        ...UNIT_PRESETS.IMPERIAL,
        preset: 'IMPERIAL'
      };
      if (stateData) {
        stateData.userUnitPreferences = this.userUnitPreferences;
      }
      return this.userUnitPreferences;
    }
  }

  /**
   * Convert a value from SignalK units to user's preferred units
   * @param {string} path - The SignalK path
   * @param {any} value - The value to convert
   * @param {string} sourceUnit - The source unit (usually metric from SignalK)
   * @returns {any} - The converted value in user's preferred units
   */
  _convertToUserUnits(path, value, sourceUnit) {
    // Skip conversion for non-numeric values
    if (typeof value !== 'number' || value === null) {
      return value;
    }

    // Determine the unit type based on the path
    let unitType = null;
    
    // Map SignalK paths to unit types
    if (path.includes('position.altitude') || 
        path.includes('depth') || 
        path.includes('length') || 
        path.includes('beam') || 
        path.includes('draft')) {
      unitType = 'length';
      sourceUnit = sourceUnit || 'm';
    } else if (path.includes('speed')) {
      unitType = 'speed';
      sourceUnit = sourceUnit || 'm/s';
    } else if (path.includes('temperature')) {
      unitType = 'temperature';
      sourceUnit = sourceUnit || '°C';
    } else if (path.includes('pressure')) {
      unitType = 'pressure';
      sourceUnit = sourceUnit || 'Pa';
    } else if (path.includes('angle') || path.includes('direction') || path.includes('heading') || path.includes('bearing')) {
      unitType = 'angle';
      sourceUnit = sourceUnit || 'rad';
    } else if (path.includes('volume')) {
      unitType = 'volume';
      sourceUnit = sourceUnit || 'L';
    }

    // If we can't determine the unit type, return the original value
    if (!unitType || !this.userUnitPreferences) {
      return value;
    }

    // Get the target unit from user preferences
    const targetUnit = this.userUnitPreferences[unitType];
    
    // Skip conversion if source and target are the same
    if (sourceUnit === targetUnit) {
      return value;
    }

    // Convert the value
    try {
      return UnitConversion.convert(value, sourceUnit, targetUnit);
    } catch (err) {
      console.error(`[StateService] Error converting ${value} from ${sourceUnit} to ${targetUnit}:`, err);
      return value; // Return original value on error
    }
  }

  _processSignalKValue(path, value, source) {
    // Log all incoming updates
    // console.log("[DEBUG] Incoming SignalK update:", path, value);

    // First check special transforms
    if (this._applySpecialTransform(path, value)) {
      return;
    }

    // Then check direct mappings
    const mapping = this._getCanonicalMapping(path);
    if (mapping) {
      // First apply any transform from the mapping
      let transformedValue = mapping.transform ? mapping.transform(value) : value;
      
      // Then convert units based on user preferences
      // Determine source unit from SignalK path
      let sourceUnit = null;
      if (path.includes('depth')) sourceUnit = 'm';
      else if (path.includes('speed')) sourceUnit = 'm/s';
      else if (path.includes('temperature')) sourceUnit = '°C';
      else if (path.includes('pressure')) sourceUnit = 'Pa';
      else if (path.includes('angle') || path.includes('direction') || path.includes('heading')) sourceUnit = 'rad';
      
      // Convert to user's preferred units
      const originalValue = transformedValue;
      transformedValue = this._convertToUserUnits(path, transformedValue, sourceUnit);
      if (path.includes('depth')) {
        console.log('[StateService] Depth conversion:', {
          original: originalValue,
          sourceUnit,
          targetUnit: this.userUnitPreferences?.length,
          converted: transformedValue
        });
      }
      
      // Queue the update with the converted value
      this._queueUpdate(mapping.path, transformedValue, source);

      return;
    }

    // Fallback to generic mapping
    // const fallbackPath = `external.signalK.${path.replace(/\./g, "_")}`;
    // this._queueUpdate(fallbackPath, value, source);
    // console.log("[DEBUG] Queued fallback update:", fallbackPath, value, source);
  }

  _applySpecialTransform(path, value) {
    const transform = this._getSpecialTransform(path);
    if (transform) {
      // First convert the value to user's preferred units
      // Determine source unit from SignalK path
      let sourceUnit = null;
      if (path.includes('depth')) sourceUnit = 'm';
      else if (path.includes('speed')) sourceUnit = 'm/s';
      else if (path.includes('temperature')) sourceUnit = '°C';
      else if (path.includes('pressure')) sourceUnit = 'Pa';
      else if (path.includes('angle') || path.includes('direction') || path.includes('heading')) sourceUnit = 'rad';
      
      // Convert to user's preferred units if it's a numeric value
      if (typeof value === 'number') {
        const convertedValue = this._convertToUserUnits(path, value, sourceUnit);
        // Apply the special transform with the converted value
        transform(convertedValue, stateData);
      } else {
        // Apply the special transform with the original value
        transform(value, stateData);
      }
      return true;
    }
    return false;
  }

  _getSpecialTransform(path) {
    // Special transforms take priority
    const specialTransforms = {
      "navigation.headingMagnetic": (value, state) => {
        // Normalize the magnetic heading and convert to degrees
        const normalizedMagneticHeading = UnitConversion.normalizeRadians(value);
        const magneticHeadingDegrees = UnitConversion.radToDeg(normalizedMagneticHeading);
        
        // Store with proper units
        state.navigation.course.heading.magnetic.value = magneticHeadingDegrees;
        state.navigation.course.heading.magnetic.units = 'deg';
        
        if (state.navigation.course.variation.value !== null) {
          // Calculate true heading, normalize, and convert to degrees
          const trueHeadingRad = normalizedMagneticHeading + state.navigation.course.variation.value;
          const normalizedTrueHeadingRad = UnitConversion.normalizeRadians(trueHeadingRad);
          const trueHeadingDegrees = UnitConversion.radToDeg(normalizedTrueHeadingRad);
          
          // Store with proper units
          state.navigation.course.heading.true.value = trueHeadingDegrees;
          state.navigation.course.heading.true.units = 'deg';
        }
      },
      "navigation.headingTrue": (value, state) => {
        // Normalize the true heading and convert to degrees
        const normalizedTrueHeading = UnitConversion.normalizeRadians(value);
        const trueHeadingDegrees = UnitConversion.radToDeg(normalizedTrueHeading);
        
        // Store with proper units
        state.navigation.course.heading.true.value = trueHeadingDegrees;
        state.navigation.course.heading.true.units = 'deg';
        
        if (state.navigation.course.variation.value !== null) {
          // Calculate magnetic heading, normalize, and convert to degrees
          const magneticHeadingRad = normalizedTrueHeading - state.navigation.course.variation.value;
          const normalizedMagneticHeadingRad = UnitConversion.normalizeRadians(magneticHeadingRad);
          const magneticHeadingDegrees = UnitConversion.radToDeg(normalizedMagneticHeadingRad);
          
          // Store with proper units
          state.navigation.course.heading.magnetic.value = magneticHeadingDegrees;
          state.navigation.course.heading.magnetic.units = 'deg';
        }
      },
      "environment.wind.angleApparent": (value, state) => {
        // Normalize the apparent wind angle and convert to degrees
        const normalizedWindAngleRad = UnitConversion.normalizeRadians(value);
        const windAngleDegrees = UnitConversion.radToDeg(normalizedWindAngleRad);
        
        // Store with proper units
        state.navigation.wind.apparent.angle.value = windAngleDegrees;
        state.navigation.wind.apparent.angle.units = 'deg';
        
        if (state.navigation.course.heading.true.value !== null) {
          // Get the heading in radians for calculation
          let headingRad;
          if (state.navigation.course.heading.true.units === 'deg') {
            headingRad = UnitConversion.degToRad(state.navigation.course.heading.true.value);
          } else {
            headingRad = state.navigation.course.heading.true.value;
          }
          
          // Calculate apparent wind direction, normalize, and convert to degrees
          const directionRad = headingRad + normalizedWindAngleRad;
          const normalizedDirectionRad = UnitConversion.normalizeRadians(directionRad);
          const directionDegrees = UnitConversion.radToDeg(normalizedDirectionRad);
          
          // Store with proper units
          state.navigation.wind.apparent.direction.value = directionDegrees;
          state.navigation.wind.apparent.direction.units = 'deg';
        }
      },
    };

    return specialTransforms[path];
  }

  _getCanonicalMapping(path) {
    const signalKToCanonicalMappings = {
      "navigation.position": {
        path: "navigation.position",
        transform: (skObj) => ({
          latitude: { value: skObj.latitude ?? null, units: "deg" },
          longitude: { value: skObj.longitude ?? null, units: "deg" },
          timestamp: new Date().toISOString(),
        }),
      },
      // Course Data
      "navigation.courseOverGroundTrue": {
        path: "navigation.course.cog.value",
      },
      "navigation.headingMagnetic": {
        path: "navigation.course.heading.magnetic.value",
      },
      "navigation.headingTrue": {
        path: "navigation.course.heading.true.value",
      },
      "navigation.magneticVariation": {
        path: "navigation.course.variation.value",
      },
      "navigation.rateOfTurn": { path: "navigation.course.rateOfTurn.value" },
      "navigation.courseRhumbline.bearingTrackTrue": {
        path: "navigation.course.cog.value"
      },  

      // Speed Data
      "navigation.speedOverGround": { path: "navigation.speed.sog.value" },
      "navigation.speedThroughWater": { path: "navigation.speed.stw.value" },

      // Trip Data
      "navigation.trip.log": { path: "navigation.trip.log.value" },

      // Depth Data
      "environment.depth.belowTransducer": {
        path: "navigation.depth.belowTransducer.value",
        transform: function(value) {
          console.log('[StateService] Raw depth value received:', value);
          return value;
        }
      },

      // Wind Data
      "environment.wind.speedApparent": {
        path: "navigation.wind.apparent.speed.value",
      },
      "environment.wind.angleApparent": {
        path: "navigation.wind.apparent.angle.value",
      },
      "environment.wind.directionApparent": {
        path: "navigation.wind.apparent.direction.value",
      },

      // Environment Data
      "environment.outside.pressure": {
        path: "environment.weather.pressure.value",
      },
      "environment.outside.temperature": {
        path: "environment.weather.temperature.air.value",
      },
      "environment.water.temperature": {
        path: "environment.weather.temperature.water.value",
      },
      "environment.outside.humidity": {
        path: "environment.weather.humidity.value",
      },

      // Vessel Info
      mmsi: { path: "vessel.info.mmsi" },
      "vessel.name": { path: "vessel.info.name" },
      "vessel.callsignVhf": { path: "vessel.info.callsign" },
      "vessel.design.type": { path: "vessel.info.type" },
      "vessel.design.length": { path: "vessel.info.dimensions.length.value" },
      "vessel.design.beam": { path: "vessel.info.dimensions.beam.value" },
      "vessel.design.draft": { path: "vessel.info.dimensions.draft.value" },

      // Electrical Systems
      "electrical.batteries.voltage": {
        path: "vessel.systems.electrical.batteries.voltage.value",
      },
      "electrical.batteries.current": {
        path: "vessel.systems.electrical.batteries.current.value",
      },

      // Propulsion (with wildcard support)
      propulsion: {
        path: "vessel.systems.propulsion.engines",
        transform: (value, path) => {
          // Handle wildcard paths like propulsion.0.revolutions
          const parts = path.split(".");
          if (parts.length > 1 && !isNaN(parts[1])) {
            const index = parseInt(parts[1]);
            return { [index]: { [parts[2]]: value } };
          }
          return value;
        },
      },
      "tanks.fuel.currentLevel": {
        path: "vessel.systems.propulsion.fuel.level.value",
      },
      "tanks.fuel.rate": { path: "vessel.systems.propulsion.fuel.rate.value" },

      // Tanks
      "tanks.freshWater.currentLevel": {
        path: "vessel.systems.tanks.freshWater.value",
      },
      "tanks.wasteWater.currentLevel": {
        path: "vessel.systems.tanks.wasteWater.value",
      },
      "tanks.blackWater.currentLevel": {
        path: "vessel.systems.tanks.blackWater.value",
      },

    };

    // Check for exact match first
    if (signalKToCanonicalMappings[path]) {
      return signalKToCanonicalMappings[path];
    }

    // Check for wildcard matches (like propulsion.0.revolutions)
    for (const [skPath, mapping] of Object.entries(
      signalKToCanonicalMappings
    )) {
      if (skPath.includes("*")) {
        const regex = new RegExp(
          "^" + skPath.replace(".", "\\.").replace("*", "\\d+") + "$"
        );
        if (regex.test(path)) {
          return {
            ...mapping,
            transform: (value) =>
              mapping.transform ? mapping.transform(value, path) : value,
          };
        }
      }
    }

    return null;
  }

  _calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371e3; // meters
    const φ1 = (lat1 * Math.PI) / 180;
    const φ2 = (lat2 * Math.PI) / 180;
    const Δφ = ((lat2 - lat1) * Math.PI) / 180;
    const Δλ = ((lon2 - lon1) * Math.PI) / 180;

    const a =
      Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
      Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c;
  }

  _queueUpdate(path, value, source) {
    this.updateQueue.set(path, { value, source });
    if (value !== null && value !== undefined && !this.hasLoggedFirstData) {
      console.log(
        `[StateService] RECEIVED FIRST DATA from SignalK: ${path} =`,
        value
      );
      this.hasLoggedFirstData = true;
    }
  }

  _setupBatchProcessing() {
    if (this.updateTimer) clearInterval(this.updateTimer);
    this.updateTimer = setInterval(() => {
      this._processBatchUpdates();
    }, this.config.updateInterval);
  }

  
  _processBatchUpdates() {
    if (this.updateQueue.size === 0) return;
  
    // console.log('[StateService] Processing batch updates'); // DEBUG

    const updates = [];
    const previousState = JSON.parse(JSON.stringify(stateData.state));

    this.updateQueue.forEach(({value, source}, path) => {
      // Skip external paths that aren't mapped to our canonical state
      if (path.startsWith('external.')) {
        console.debug(`[StateService] Skipping unmapped external path: ${path}`);
        return;
      }

      try {
        updates.push({ path, value });
      } catch (error) {
        console.warn(`[StateService] Failed to process update for ${path}:`, error);
      }
    });

  
    this.updateQueue.clear();
    // console.log('[StateService] After updateQueue clear'); // DEBUG

    if (updates.length > 0) {
      try {
        // Apply updates to stateData
        stateData.batchUpdate(updates);
        
        // Update derived values before generating patches
        stateData.convert.updateAllDerivedValues();

        const nextState = JSON.parse(JSON.stringify(stateData.state));
        const patches = jsonPatchCompare(previousState, nextState);

        // Apply patches to stateManager
        if (patches.length > 0 && stateManager) {
          stateManager.applyPatchAndForward(patches);
        }

        // console.log("[StateService] After stateData.convert.updateAllDefivedValues", JSON.stringify(stateData, null, 2));
      
        // const payload = {
        //   updates,
        //   patches,
        //   timestamp: Date.now()
        // };
        // console.log("[StateService] Emitting STATE_UPDATED event: ", payload);

        if (patches.length > 0) {
          this.emit(this.EVENTS.STATE_PATCH, {
            type: "state:patch",
            data: patches,
            source: "signalK",
            timestamp: Date.now(),
          });
        }

        if (!this._lastFullEmit || Date.now() - this._lastFullEmit > 30000) {
          this.emit(this.EVENTS.STATE_FULL_UPDATE, {
            type: "state:full-update",
            data: stateData.state,
            source: "signalK",
            timestamp: Date.now(),
          });
          this._lastFullEmit = Date.now();
        }

      } catch (error) {
        console.error('[StateService] Error applying updates:', error);
      }
    }
  }

  // Helper methods
  _getValueByPath(obj, path) {
    return path.split('.').reduce((o, p) => o?.[p], obj);
  }
  
  _deepEqual(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
  }


  registerExternalSource(sourceId, initialData = {}, updateHandler = null) {
    try {
      const success = stateData.addExternalSource(sourceId, initialData);
      if (success && updateHandler) {
        this.sources.set(sourceId, { updateHandler });
      }
      this.emit(this.EVENTS.SOURCE_ADDED, { sourceId, timestamp: Date.now() });
      return success;
    } catch (error) {
      this._debug(`Failed to register external source: ${error.message}`);
      this.emit(this.EVENTS.ERROR, {
        source: "stateService",
        error,
        message: `Failed to register external source: ${sourceId}`,
      });
    }
  }

  shutdown() {
    if (this.updateTimer) {
      clearInterval(this.updateTimer);
      this.updateTimer = null;
    }
    if (this._aisRefreshTimer) {
      clearInterval(this._aisRefreshTimer);
      this._aisRefreshTimer = null;
    }
    if (this.connections.signalK.socket) {
      this.connections.signalK.socket.close();
    }
    return true;
  }

  removeExternalSource(sourceId) {
    try {
      const success = stateData.removeExternalSource(sourceId);
      if (success) {
        this.sources.delete(sourceId);
        this.emit(this.EVENTS.SOURCE_REMOVED, {
          sourceId,
          timestamp: Date.now(),
        });
      }
      return success;
    } catch (error) {
      this._debug(`Failed to remove external source: ${error.message}`);
      this.emit(this.EVENTS.ERROR, {
        source: "stateService",
        error,
        message: `Failed to remove external source: ${sourceId}`,
      });
      return false;
    }
  }
}

// Create singleton instance
const newStateService = new NewStateService();

// Utility function for fetching full SignalK state
async function fetchSignalKFullState(signalKBaseUrl, signalKToken) {
  const url = `${signalKBaseUrl}/vessels`;
  const headers = signalKToken
    ? { Authorization: `Bearer ${signalKToken}` }
    : {};
  const response = await fetch(url, { headers });
  if (!response.ok)
    throw new Error(`Failed to fetch /vessels: ${response.status}`);
  return { vessels: await response.json() };
}

export { newStateService, NewStateService, fetchSignalKFullState, setStateManager };
