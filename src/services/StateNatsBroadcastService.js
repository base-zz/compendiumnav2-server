import BaseService from "./BaseService.js";
import { connect, StringCodec } from "nats";
import { getStateManager } from "../relay/core/state/StateManager.js";

export class StateNatsBroadcastService extends BaseService {
  constructor(options = {}) {
    super("state-nats-broadcast", "continuous");

    this.subjectPrefix = options.subjectPrefix;
    this.broadcastKeys = options.broadcastKeys;
    this.fullPatchSubject = options.fullPatchSubject;
    this.natsUrl = options.natsUrl;
    this.serverName = options.serverName;
    this.boatId = options.boatId || "unknown";

    this.bridgeEnabled = options.bridgeEnabled || false;
    this.bridgeSubject = options.bridgeSubject || "state.bridge";
    this.bridgeIntervalMs = options.bridgeIntervalMs || 5000;
    this.bridgeKeys = options.bridgeKeys || ["position", "navigation", "forecast", "tides"];

    this._connection = null;
    this._codec = StringCodec();
    this._stateManager = null;
    this._statePatchHandler = null;

    // Bridge cache for aggregated publishing
    this._bridgeCache = {};
    this._bridgeInterval = null;
    this._forecastInterval = null;
    this._tidesInterval = null;
  }

  async start() {
    if (this.isRunning) {
      return;
    }

    if (!this.natsUrl) {
      throw new Error(
        "StateNatsBroadcastService requires NATS_URL to be defined"
      );
    }

    if (!this.subjectPrefix) {
      throw new Error(
        "StateNatsBroadcastService requires NATS_STATE_SUBJECT_PREFIX to be defined"
      );
    }

    if (!Array.isArray(this.broadcastKeys) || this.broadcastKeys.length === 0) {
      throw new Error(
        "StateNatsBroadcastService requires NATS_BROADCAST_KEYS to be defined"
      );
    }

    this._stateManager = getStateManager();
    if (!this._stateManager) {
      throw new Error(
        "StateNatsBroadcastService requires a StateManager instance"
      );
    }

    const connectionConfig = {
      servers: this.natsUrl,
    };
    if (this.serverName) {
      connectionConfig.name = this.serverName;
    }

    this._connection = await connect(connectionConfig);

    this._statePatchHandler = (event) => {
      if (!event || !this._connection) {
        return;
      }

      const payload = {
        type: "state:patch",
        data: event.data,
        boatId: event.boatId,
        timestamp: event.timestamp,
      };

      const patches = Array.isArray(event.data) ? event.data : [];
      const touchedKeys = new Set();

      for (const patch of patches) {
        if (!patch || typeof patch.path !== "string") {
          continue;
        }

        const topLevelKey = patch.path.split("/")[1];
        if (!topLevelKey) {
          continue;
        }

        // Cache data for bridge if enabled
        if (this.bridgeEnabled && this.bridgeKeys.includes(topLevelKey)) {
          this._cacheBridgeData(topLevelKey, patch.path, patch.value);
        }

        if (!this.broadcastKeys.includes(topLevelKey)) {
          continue;
        }

        touchedKeys.add(topLevelKey);
      }

      // Publish per-key routing (original behavior)
      for (const key of touchedKeys) {
        const subject = `${this.subjectPrefix}.${key}`;
        this._connection.publish(subject, this._codec.encode(JSON.stringify(payload)));
      }

      if (this.fullPatchSubject) {
        this._connection.publish(this.fullPatchSubject, this._codec.encode(JSON.stringify(payload)));
      }
    };

    this._stateManager.on("state:patch", this._statePatchHandler);

    // Start periodic publishing for bridge (position/depth/wind)
    if (this.bridgeEnabled) {
      this._seedBridgeCache();
      this._bridgeInterval = setInterval(() => {
        this._publishBridge();
      }, this.bridgeIntervalMs);
    }

    // Start periodic publishing for forecast (every 15 min)
    // Always start interval - it will check for data availability internally
    if (this.bridgeEnabled) {
      this._forecastInterval = setInterval(() => {
        this._publishForecast();
      }, 15 * 60 * 1000); // 15 minutes
    }

    // Start periodic publishing for tides (every 15 min)
    // Always start interval - it will check for data availability internally
    if (this.bridgeEnabled) {
      this._tidesInterval = setInterval(() => {
        this._publishTides();
      }, 15 * 60 * 1000); // 15 minutes
    }

    await super.start();

    let logMsg = `Broadcasting state patches to NATS subjects '${this.subjectPrefix}.<key>' via ${this.natsUrl}`;
    if (this.bridgeEnabled) {
      logMsg += `; bridge aggregator to '${this.bridgeSubject}' every ${this.bridgeIntervalMs}ms`;
    }
    this.log(logMsg);
  }

  async stop() {
    if (!this.isRunning) {
      return;
    }

    if (this._bridgeInterval) {
      clearInterval(this._bridgeInterval);
      this._bridgeInterval = null;
    }

    if (this._forecastInterval) {
      clearInterval(this._forecastInterval);
      this._forecastInterval = null;
    }

    if (this._tidesInterval) {
      clearInterval(this._tidesInterval);
      this._tidesInterval = null;
    }

    if (this._stateManager && this._statePatchHandler) {
      this._stateManager.off("state:patch", this._statePatchHandler);
    }

    this._statePatchHandler = null;
    this._stateManager = null;

    if (this._connection) {
      await this._connection.close();
      this._connection = null;
    }

    await super.stop();
  }

  _seedBridgeCache() {
    if (!this._stateManager) return;

    const state = this._stateManager.getState();
    if (!state) return;

    for (const key of this.bridgeKeys) {
      if (state[key]) {
        this._bridgeCache[key] = state[key];
      }
    }
  }

  _cacheBridgeData(topLevelKey, path, value) {
    // Parse the path to build nested structure
    // path format: "/navigation/depth/belowTransducer/value"
    const pathParts = path.split('/').filter(p => p);
    
    // Initialize the top-level object if not exists
    if (!this._bridgeCache[topLevelKey]) {
      this._bridgeCache[topLevelKey] = {};
    }
    
    // Navigate/build the nested structure
    let current = this._bridgeCache[topLevelKey];
    for (let i = 1; i < pathParts.length - 1; i++) {
      const part = pathParts[i];
      if (!current[part]) {
        current[part] = {};
      }
      current = current[part];
    }
    
    // Set the final value
    const finalKey = pathParts[pathParts.length - 1];
    current[finalKey] = value;
  }

  _publishBridge() {
    if (!this._connection) return;

    const payload = {
      type: "state:bridge",
      boatId: this.boatId,
      timestamp: Date.now(),
      data: {},
    };

    // Bridge contains only rapidly changing data
    // Position is top-level in state
    if (this._bridgeCache.position) {
      payload.data.position = this._bridgeCache.position;
    }

    // Depth is under navigation
    if (this._bridgeCache.navigation?.depth) {
      payload.data.depth = this._bridgeCache.navigation.depth;
    }

    // Wind is under navigation
    if (this._bridgeCache.navigation?.wind) {
      payload.data.wind = this._bridgeCache.navigation.wind;
    }

    // Only publish if we have data
    if (Object.keys(payload.data).length > 0) {
      const encodedPayload = this._codec.encode(JSON.stringify(payload));
      this._connection.publish(
        this.bridgeSubject,
        encodedPayload
      );
      this.log(`Published bridge message to ${this.bridgeSubject}: ${JSON.stringify(payload)}`);
    } else {
      this.log('Bridge has no data to publish yet');
    }
  }

  _publishForecast() {
    if (!this._connection) return;
    if (!this._bridgeCache.forecast) return;

    const payload = {
      type: "state:forecast",
      boatId: this.boatId,
      timestamp: Date.now(),
      data: this._bridgeCache.forecast,
    };

    const encodedPayload = this._codec.encode(JSON.stringify(payload));
    this._connection.publish(
      `${this.subjectPrefix}.forecast`,
      encodedPayload
    );
    this.log(`Published forecast message to ${this.subjectPrefix}.forecast: ${JSON.stringify(payload)}`);
  }

  _publishTides() {
    if (!this._connection) return;
    if (!this._bridgeCache.tides) return;

    const payload = {
      type: "state:tides",
      boatId: this.boatId,
      timestamp: Date.now(),
      data: this._bridgeCache.tides,
    };

    const encodedPayload = this._codec.encode(JSON.stringify(payload));
    this._connection.publish(
      `${this.subjectPrefix}.tides`,
      encodedPayload
    );
    this.log(`Published tides message to ${this.subjectPrefix}.tides: ${JSON.stringify(payload)}`);
  }
}

export default StateNatsBroadcastService;
