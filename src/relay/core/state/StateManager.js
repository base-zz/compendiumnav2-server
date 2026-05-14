import { EventEmitter } from "events";
import debug from "debug";
import { createStateDataModel } from "../../../shared/stateDataModel.js";
import storageService from "../../../bluetooth/services/storage/storageService.js";
import { RuleEngine2 } from "./ruleEngine2.js";
import { getRules } from "./allRules2.js";
import { AlertService } from "../services/AlertService.js";
import { recomputeAnchorDerivedState } from "./anchorStateHelpers.js";
import { calculateBearing, calculateDistance, projectPoint, toRad } from "./geoUtils.js";
import { getOrCreateAppUuid } from "../../../server/uniqueAppId.js";
import { defaultProfile } from "../../../config/profiles.js";
import { UNIT_PRESETS } from "../../../shared/unitPreferences.js";
// import { applyPatch } from 'fast-json-patch';
import pkg from "fast-json-patch";
const { applyPatch } = pkg;

const log = debug("state-manager");
//const logError = debug("state-manager:error");
const logState = debug("state-manager:state");

export class StateManager extends EventEmitter {
  getState() {
    const state = { ...(this.appState || {}) };
    return state;
  }

  _ensurePositionRoot(patches) {
    const needsPosition = patches.some((operation) =>
      operation.path.startsWith("/position/")
    );

    if (!needsPosition) {
      return;
    }

    if (!this.appState.position || typeof this.appState.position !== "object") {
      this.appState.position = {};
      logState("Initialized missing position root on appState");
    }
  }

  /**
   * Get all selected Bluetooth devices
   * @returns {Object} - Object with device IDs as keys and device objects as values
   */
  getSelectedBluetoothDevices() {
    return this.appState.bluetooth?.selectedDevices || {};
  }

  /**
   * Get all Bluetooth devices (selected and unselected)
   * @returns {Object} - Object with device IDs as keys and device objects as values
   */
  getAllBluetoothDevices() {
    return this.appState.bluetooth?.devices || {};
  }

  /**
   * Get the boat ID
   * @returns {string} - The boat ID
   */
  get boatId() {
    return this._boatId;
  }

  /**
   * Get the client count
   * @returns {number} - The client count
   */
  get clientCount() {
    return this._clientCount;
  }

  /**
   * Allows setting the initial state after construction.
   * Usage: stateManager2.initialState = yourStateObject;
   */
  set initialState(state) {
    if (typeof state !== "object" || state == null) {
      throw new Error("initialState must be a non-null object");
    }
    this.appState = this._safeClone(state);
  }

  constructor(initialState) {
    super();

    this.log = debug("state-manager");
    this.logError = debug("state-manager:error");

    // Initialize Bluetooth update queuing
    this._bluetoothDebounceDelays = {
      discovery: 1000, // 1s for new device discovery
      update: 250, // 250ms for device updates
    };
    this._bluetoothDeviceQueue = new Map();
    this._bluetoothUpdateTimeouts = {
      discovery: null,
      update: null,
    };
    this._knownDeviceIds = new Set(); // Track known devices

    // Custom clone function to handle function properties
    const safeClone = (obj) => {
      if (obj === null) {
        return obj;
      }

      if (Array.isArray(obj)) {
        return obj.map((item) => safeClone(item));
      }

      if (typeof obj !== "object") {
        return obj;
      }

      const result = {};
      for (const key in obj) {
        // Skip function properties when cloning
        if (typeof obj[key] !== "function") {
          result[key] = safeClone(obj[key]);
        }
      }
      return result;
    };

    // Make safeClone available to other methods
    this._safeClone = safeClone;

    // Initialize with default state structure
    this.appState = initialState
      ? safeClone(initialState)
      : createStateDataModel();
    this._boatId = process.env.BOAT_ID || "default-boat";
    this._clients = new Map(); // Map of clientId -> { ws, lastSeen }
    this._debouncedPatches = new Map(); // clientId -> { timer, patches }
    this._bluetoothUpdateQueue = [];
    this._bluetoothDebounceTimers = {
      discovery: null,
      update: null,
    };
    this._knownDeviceIds = new Set();
    this._staleDeviceCleanupInterval = null;
    this._storageInitialized = false;

    // Initialize storage and start cleanup job
    this._initializeStorage().catch((error) => {
      this.logError("Failed to initialize storage:", error);
    });

    // Initialize the new rule engine, which is event-driven
    this.log('[StateManager] constructor: before creating RuleEngine2');
    this.ruleEngine = new RuleEngine2();
    this.log('[StateManager] constructor: after RuleEngine2, before getRules');
    const allRules = getRules(); // Get all rules from the new set
    this.log('[StateManager] constructor: after getRules, rule count = %s', Array.isArray(allRules) ? allRules.length : 'NON_ARRAY');

    this.log(`Retrieved ${allRules.length} rules from getRules().`);
    allRules.forEach((rule) => {
      this.log(`Attempting to add rule: ${rule.name || "Unnamed Rule"}`);
      this.ruleEngine.addRule(rule);
    });
    this.log(`Finished adding rules.`);
    this.log('[StateManager] constructor: finished adding rules');

    // Listen for rule engine actions and process them via AlertService/etc.
    this.ruleEngine.on("actions", (actions) => {
      if (!Array.isArray(actions) || actions.length === 0) return;

      actions.forEach((actionResult) => {
        if (!actionResult || typeof actionResult !== "object") return;

        this.log(
          `RuleEngine2 action:`,
          JSON.stringify(actionResult)
        );
        this._processRuleAction(actionResult);
      });
    });

    // Initialize the alert service
    this.log('[StateManager] constructor: before AlertService');
    this.alertService = new AlertService(this);
    this.log('[StateManager] constructor: after AlertService, before defaultProfile clone');

    this.currentProfile = this._safeClone(defaultProfile);
    this.log('[StateManager] constructor: after defaultProfile clone, before getOrCreateAppUuid');
    this._boatId = getOrCreateAppUuid();
    this.log('[StateManager] constructor: after getOrCreateAppUuid, constructor continuing');

    this._clientCount = 0;
    this.tideData = null;
    this.weatherData = null;
    this._hasSentInitialFullState = false;
    this._lastFullStateTime = 0;
    // Send full state update every 5 minutes to ensure sync
    this.FULL_STATE_INTERVAL = 5 * 60 * 1000; // 5 minutes in milliseconds
    // Track connected clients
    this.connectedClients = new Map();

    // Log when a client connects or disconnects
    this.on("client:connected", (clientId, platform) => {
      this._clientCount++;
      this.log(
        `Client connected: ${clientId} (${platform || "unknown platform"})`
      );
      this.log(`Total clients: ${this._clientCount}`);
    });

    this.on("client:disconnected", (clientId) => {
      this._clientCount = Math.max(0, this._clientCount - 1);
      this.log(`Client disconnected: ${clientId}`);
      this.log(`Remaining clients: ${this._clientCount}`);
      this.connectedClients.delete(clientId);
    });

    // Log when an identity message is processed
    this.on("identity:received", (identity) => {
      this.log(
        "Identity message received:",
        JSON.stringify(
          {
            clientId: identity.clientId,
            platform: identity.platform,
            role: identity.role,
            timestamp: new Date().toISOString(),
            boatId: this._boatId,
          },
          null,
          2
        )
      );
    });
  }

  /**
   * Listens to a service for 'state:patch' events and forwards them.
   * This is the primary mechanism for services to update the central state.
   * @param {EventEmitter} service - The service instance to listen to.
   */
  listenToService(service) {
    if (service && typeof service.on === "function") {
      const serviceName =
        service?.serviceId || service.constructor?.name || "unnamed service";
      this.log(`Now listening to '${serviceName}' for events.`);

      // Log service details for debugging
      this.log(
        `Service details: type=${typeof service}, constructor=${
          service.constructor?.name
        }, has emit=${typeof service.emit === "function"}`
      );

      // Log available events on the service
      let eventNames = [];
      if (service.eventNames && typeof service.eventNames === "function") {
        eventNames = service.eventNames();
      }
      this.log(
        `Service '${serviceName}' has these registered events: ${eventNames.join(
          ", "
        )}`
      );

      // Set up weather:update listener
      this.log(
        `Setting up weather:update listener for service '${serviceName}'`
      );
      service.on("weather:update", (data) => {
        this.log(`Received weather:update from '${serviceName}', forwarding.`);
        this.log(
          `[StateManager] Weather data details: type=${typeof data}, hasData=${!!data}, keys=${
            data ? Object.keys(data).join(", ") : "none"
          }`
        );
        this.log(
          `Weather data details: type=${typeof data}, hasData=${!!data}, keys=${
            data ? Object.keys(data).join(", ") : "none"
          }`
        );
        this.setWeatherData(data);
      });

      // Set up tide:update listener
      this.log(`Setting up tide:update listener for service '${serviceName}'`);
      service.on("tide:update", (data) => {
        this.log(`Received tide:update from '${serviceName}', forwarding.`);
        this.log(`[StateManager] Tide data details: type=${typeof data}, hasData=${!!data}, keys=${
          data ? Object.keys(data).join(", ") : "none"
        }`);
        this.setTideData(data);
      });

      // Set up victron:update listener
      this.log(`Setting up victron:update listener for service '${serviceName}'`);
      service.on("victron:update", (data) => {
        this.log(`Received victron:update from '${serviceName}', forwarding.`);
        this.log(
          `Victron data details: type=${typeof data}, hasData=${!!data}, keys=${
            data ? Object.keys(data).join(", ") : "none"
          }`
        );
        this.setVictronData(data);
      });

      service.on("state:full-update", ({ data }) => {
        try {
          this.log(
            `Received state:full-update from '${serviceName}', forwarding.`
          );
          this.setFullState(data);
        } catch (err) {
          this.logError(
            `Error applying full state update from '${serviceName}':`,
            err
          );
        }
      });

      // Add listener for state:patch events
      service.on("state:position", ({ data, source, timestamp, trace }) => {
        try {
          this.applyPatchAndForward(data);
        } catch (err) {
          this.logError(`Error applying patch from '${serviceName}':`, err);
        }
      });

      this.log(
        `Successfully set up all event listeners for service '${serviceName}'`
      );
    } else {
      this.logError("listenToService called with an invalid service object:", {
        serviceExists: !!service,
        serviceType: typeof service,
        hasOnMethod: service && typeof service.on === "function",
      });
    }
  }

  /**
   * Apply a JSON patch (RFC 6902) to the managed state and emit to clients.
   * Emits 'state:patch' with the patch array.
   * Triggers rule evaluation after patch is applied.
   * @param {Array} patch - JSON patch array
   */
  applyPatchAndForward(patch) {
    if (!Array.isArray(patch) || patch.length === 0) {
      log('applyPatchAndForward called with empty/invalid patch');
      return;
    }

    log(`applyPatchAndForward received ${patch.length} operations`);

    try {
      // Get fresh state with all structures
      const currentState = this.appState;

      // Filter out any altitude-related operations first
      const filteredPatch = patch.filter((operation) => {
        return !operation.path.includes("altitude");
      });

      // Validate remove operations against the canonical state
      const validPatch = filteredPatch.filter((operation) => {
        if (operation.op === "remove") {
          return this._pathExists(currentState, operation.path);
        }
        return true;
      });

      if (validPatch.length === 0) {
        log('No valid patches after filtering');
        return;
      }

      logState(`Applying ${validPatch.length} valid patches: ${validPatch.map(p => p.path).join(', ')}`);

      // Ensure parent paths exist before applying the patch
      this._ensureParentPaths(validPatch);
      this._ensurePositionRoot(validPatch);

      const stateBeforePatch = this._safeClone(this.appState);

      // Apply to both our local state and the canonical state
      // Use mutateDocument=true so patch persists in this.appState
      let sanitizedPatch = validPatch;

      const applySafely = (target, operations) => {
        let ops = operations;
        while (ops.length) {
          try {
            applyPatch(target, ops, true, true);
            log("Successfully applied patches");
            return ops;
          } catch (patchError) {
            const conciseMessage =
              typeof patchError.message === "string"
                ? patchError.message.split("\n")[0]
                : patchError.message;

            if (
              patchError?.name === "OPERATION_PATH_UNRESOLVABLE" &&
              typeof patchError.index === "number"
            ) {
              log(
                `Skipping unresolved patch op at index ${patchError.index}: ${conciseMessage}`
              );
              ops = ops.filter((_, idx) => idx !== patchError.index);
              continue;
            }

            const errorInfo = {
              name: patchError.name,
              message: conciseMessage,
              index: patchError.index,
              operation: patchError.operation,
            };
            console.error(
              `[StateManager] Error applying patches:`,
              JSON.stringify(errorInfo, null, 2)
            );
            throw patchError;
          }
        }
        return ops;
      };

      sanitizedPatch = applySafely(this.appState, sanitizedPatch);
      if (sanitizedPatch.length === 0) {
        log("All patch operations skipped after resolving inconsistencies");
        return;
      }
      sanitizedPatch = applySafely(currentState, sanitizedPatch);

      // Check for obsolete AIS proximity alerts when anchor warning range changes
      this._checkObsoleteAISAlerts(sanitizedPatch, stateBeforePatch);

      // Run state helpers (e.g., anchor derived state) after the patch has been
      // fully applied to appState, so helpers see the latest snapshot.
      this._runStateHelpers(sanitizedPatch);

      // Convert patch to a change object and notify the rule engine
      const changes = this._convertPatchToStateChanges(
        sanitizedPatch,
        stateBeforePatch
      );

      this.ruleEngine.updateState(changes);

      const patchForEmit = sanitizedPatch.map((operation) => {
        if (
          operation?.op === "replace" &&
          operation?.path === "/anchor"
        ) {
          return {
            ...operation,
            value: this.appState?.anchor,
          };
        }

        return operation;
      });

      const activeRouteOperation = patchForEmit.find(
        (operation) => operation?.path === "/routes/activeRoute"
      );

      const eventTimestamp = Date.now();

      // Always emit patch events for direct server
      const patchPayload = {
        type: "state:patch",
        data: patchForEmit,
        boatId: this._boatId,
        timestamp: eventTimestamp,
      };

      const bridgeRelevantPatchData = patchForEmit.filter((operation) => {
        const path = operation?.path;
        return (
          typeof path === "string" &&
          (path.startsWith("/routes/") ||
            path.startsWith("/position/") ||
            path.startsWith("/navigation/"))
        );
      });

      const anchorageRelevantPatchData = patchForEmit.filter((operation) => {
        const path = operation?.path;
        return (
          typeof path === "string" &&
          (
            path.startsWith("/routes/") ||
            path.startsWith("/position/") ||
            path.startsWith("/navigation/") ||
            path === "/forecast" ||
            path.startsWith("/forecast/") ||
            path === "/tides" ||
            path.startsWith("/tides/") ||
            path === "/vessel/info/dimensions/draft" ||
            path.startsWith("/vessel/info/dimensions/draft/")
          )
        );
      });

      const marinaRelevantPatchData = patchForEmit.filter((operation) => {
        const path = operation?.path;
        return (
          typeof path === "string" &&
          (
            path.startsWith("/routes/") ||
            path.startsWith("/position/") ||
            path.startsWith("/navigation/")
          )
        );
      });

      if (bridgeRelevantPatchData.length > 0) {
        this.emit("state:bridge-patch", {
          type: "state:bridge-patch",
          data: bridgeRelevantPatchData,
          boatId: this._boatId,
          timestamp: eventTimestamp,
        });
      }

      if (anchorageRelevantPatchData.length > 0) {
        this.emit("state:anchorage-patch", {
          type: "state:anchorage-patch",
          data: anchorageRelevantPatchData,
          boatId: this._boatId,
          timestamp: eventTimestamp,
        });
      }

      if (marinaRelevantPatchData.length > 0) {
        this.emit("state:marina-patch", {
          type: "state:marina-patch",
          data: marinaRelevantPatchData,
          boatId: this._boatId,
          timestamp: eventTimestamp,
        });
      }

      if (activeRouteOperation) {
        this.emit("state:active-route", {
          type: "state:active-route",
          boatId: this._boatId,
          op: activeRouteOperation.op,
          routeId: activeRouteOperation?.value?.routeId || null,
          routeName: activeRouteOperation?.value?.routeName || null,
          timestamp: eventTimestamp,
        });
      }

      const windAngleOps = patchForEmit.filter((op) => {
        if (!op || typeof op !== "object") return false;
        if (typeof op.path !== "string") return false;

        const path = op.path;
        if (!path.includes("/wind/")) return false;

        if (path.includes("/angle")) return true;
        return false;
      });

      if (windAngleOps.length > 0) {
        const listenerCount = this.listenerCount("state:patch");
        const opsSummary = windAngleOps.map((op) => ({
          op: op.op,
          path: op.path,
          value: Object.prototype.hasOwnProperty.call(op, "value") ? op.value : undefined,
        }));
      }

      logState(`Emitting state:patch event with ${patchForEmit.length} operations, listener count: ${this.listenerCount('state:patch')}`);
      this.emit("state:patch", patchPayload);

      
    } catch (error) {
      this.logError("Patch error:", error);
    }
  }

  // Helper remains the same
  _pathExists(obj, path) {
    const parts = path.split("/").filter((p) => p);
    let current = obj;
    for (const part of parts) {
      if (!current || typeof current !== "object" || !(part in current)) {
        return false;
      }
      current = current[part];
    }
    return true;
  }

  _ensureParentPaths(patches) {
    // Use a Set to track parent paths we've already processed in this batch.
    const ensuredPaths = new Set();

    patches.forEach((operation) => {
      // Ensure parent paths for both 'add' and 'replace' operations
      if (operation.op === "add" || operation.op === "replace") {
        const pathParts = operation.path.substring(1).split("/");
        pathParts.pop(); // We only care about the parent path.

        if (pathParts.length === 0) return; // No parent path.

        const parentPath = pathParts.join("/");
        // If we've already ensured this parent path, we can skip it.
        if (ensuredPaths.has(parentPath)) {
          return;
        }

        // Navigate and create if it's a new path for this batch.
        let current = this.appState;
        for (const part of pathParts) {
          if (!current[part]) {
            current[part] = {};
            logState(`Created missing parent path: ${part}`);
          }
          current = current[part];
        }

        // Mark this parent path as done.
        ensuredPaths.add(parentPath);
      }
    });
  }

  /**
   * Emit the full state to clients.
   * Emits 'state:full-update' with the full appState object.
   */
  shouldEmitFullState() {
    const now = Date.now();
    // Send full state if we haven't sent it yet OR if it's time for a periodic update
    return (
      !this._hasSentInitialFullState ||
      now - this._lastFullStateTime > this.FULL_STATE_INTERVAL
    );
  }

  emitFullState() {
    if (!this.shouldEmitFullState()) return;
    this._hasSentInitialFullState = true;
    this._lastFullStateTime = Date.now();

    // Log if this is a periodic update
    if (this._lastFullStateTime > 0) {
      this.log(
        "[StateManager][emitFullState] Sending periodic full state update"
      );
    }
    // Always emit full state updates regardless of client count
    const timestamp = new Date().toISOString();

    const payload = {
      type: "state:full-update",
      data: this.appState,
      boatId: this._boatId,
      role: "boat-server",
      timestamp: Date.now(),
    };

    this.log(
      `[StateManager][emitFullState] Emitting full state update with payload keys: ${Object.keys(
        payload
      ).join(", ")}`
    );
    this.emit("state:full-update", payload);

  }

  /**
   * Broadcast the current state to all clients.
   * This is an alias for emitFullState for backward compatibility.
   */
  broadcastStateUpdate() {
    this.emitFullState();
  }

  /**
   * Updates the number of connected clients.
   * This method is called by the RelayServer when it receives a status update.
   * @param {number} count - The new number of clients.
   */
  updateClientCount(count) {
    if (typeof count === "number" && count >= 0) {
      const previousCount = this._clientCount;
      this._clientCount = count;

      this.log(`Client count updated: ${previousCount} -> ${count}`);

      // If we just got clients after having none, send a full state update
      if (previousCount === 0 && count > 0) {
        this.log("First client connected, sending full state update.");
        this.broadcastStateUpdate();
      }
    }
  }

  /**
   * Set the client count directly.
   * This is used by the RelayServer when it receives a status update from the VPS.
   * @param {number} count - The new client count.
   */
  setClientCount(count) {
    if (typeof count === "number" && count >= 0) {
      this._clientCount = count;
      this.log(`Client count explicitly set to: ${this._clientCount}`);
    }
  }

  setTideData(tideData) {
    if (!tideData) {
      this.logError("setTideData called with null or undefined data");
      return;
    }

    this.log('[StateManager] setTideData called with data: %o', {
      hasData: !!tideData,
      type: typeof tideData,
      keys: tideData ? Object.keys(tideData) : []
    });

    // Update state
    this.tideData = tideData;
    this.appState.tides = tideData;
    this.ruleEngine?.updateState({ tides: tideData });

    this.log('[StateManager] Tide data stored in appState.tides: %o', {
      hasTides: !!this.appState.tides,
      type: typeof this.appState.tides,
      keys: this.appState.tides ? Object.keys(this.appState.tides) : []
    });

    this.log(`[StateManager][setTideData] Emitting tide:update event`);
    const tideUpdatePayload = {
      type: "tide:update",
      data: tideData,
      timestamp: Date.now(),
      boatId: this._boatId,
      role: "boat-server",
    };
    this.emit("tide:update", tideUpdatePayload);

    this.emit("state:anchorage-patch", {
      type: "state:anchorage-patch",
      data: [
        {
          op: "replace",
          path: "/tides",
          value: this.appState.tides,
        },
      ],
      boatId: this._boatId,
      timestamp: Date.now(),
    });

    this.log(
      `[StateManager][setTideData] Broadcasting full state update with tide data`
    );
    this.emitFullState(); // Broadcast the change to all clients
  }

  setFullState(data) {
    if (!data) return;
    this.appState = this._safeClone(data);

    // Normalize any derived state after a full replacement
    this._runStateHelpers(null);

    this.emit("state:full-update", {
      type: "state:full-update",
      data: this.appState,
      boatId: this._boatId,
      role: "boat-server",
      timestamp: Date.now(),
    });
    this.ruleEngine.updateState(this.appState);
  }

  setWeatherData(weatherData) {
    if (!weatherData) {
      this.logError("setWeatherData called with null or undefined data");
      return;
    }

    this.log('[StateManager] setWeatherData called with data: %o', {
      hasData: !!weatherData,
      type: typeof weatherData,
      keys: weatherData ? Object.keys(weatherData) : []
    });

    log('Setting weather data in appState');
    this.weatherData = weatherData;
    this.appState.forecast = weatherData;

    this.log('[StateManager] Weather data stored in appState.forecast: %o', {
      hasForecast: !!this.appState.forecast,
      type: typeof this.appState.forecast,
      keys: this.appState.forecast ? Object.keys(this.appState.forecast) : []
    });

    this.ruleEngine.updateState({ forecast: weatherData });
    log('Rule engine updated with weather data');
    this.log(
      `[StateManager][setWeatherData] Rule engine updated with weather data`
    );

    log('Emitting weather:update event to clients');
    this.log(`[StateManager][setWeatherData] Emitting weather:update event`);
    // Wrap the weather data in the format the client expects
    const weatherUpdatePayload = {
      type: "weather:update",
      data: weatherData,
      timestamp: Date.now(),
      boatId: this._boatId,
      role: "boat-server",
    };
    this.emit("weather:update", weatherUpdatePayload);

    this.emit("state:anchorage-patch", {
      type: "state:anchorage-patch",
      data: [
        {
          op: "replace",
          path: "/forecast",
          value: this.appState.forecast,
        },
      ],
      boatId: this._boatId,
      timestamp: Date.now(),
    });

    log('Broadcasting full state update with weather data');
    this.emitFullState(); // Broadcast the change to all clients
    log('Full state update with weather data completed');
    this.log("Full state update with weather data completed");
  }

  setVictronData(victronData) {
    if (!victronData) {
      this.logError("setVictronData called with null or undefined data");
      return;
    }

    this.log("[StateManager] Setting Victron data via patches");
    
    // Convert the victron data structure to patches
    const patches = [];
    if (victronData.vessel && victronData.vessel.systems && victronData.vessel.systems.electrical) {
      Object.keys(victronData.vessel.systems.electrical).forEach(key => {
        patches.push({
          op: 'add',
          path: `/vessel/systems/electrical/${key}`,
          value: victronData.vessel.systems.electrical[key]
        });
      });
    }

    if (patches.length > 0) {
      log(`Applying ${patches.length} Victron patches`);
      this.applyPatchAndForward(patches);
    } else {
      log('No Victron patches to apply');
    }
  }

  /**
   * Update state with data from an external source (e.g., SignalK)
   * Preserves locally-authoritative domains (anchor, tides, forecast, bluetooth)
   * @param {Object} newStateData - The new state data from an external source
   */
  receiveExternalStateUpdate(newStateData) {
    this.log("[receiveExternalStateUpdate] called. Stack:", new Error().stack);
    if (!newStateData) {
      this.log("[WARN] Received empty state data from external source");
      return;
    }

    const incomingKeys = Object.keys(newStateData);

    // Define domains to preserve from external state updates
    const PRESERVED_DOMAINS = [
      { path: 'anchor', restore: (state, value) => { state.anchor = value; } },
      { path: 'tides', restore: (state, value) => { state.tides = value; } },
      { path: 'forecast', restore: (state, value) => { state.forecast = value; } },
      { path: 'bluetooth', restore: (state, value) => { state.bluetooth = value; } },
      {
        path: 'vessel.systems.electrical',
        get: (state) => state?.vessel?.systems?.electrical,
        restore: (state, value) => {
          if (!state.vessel || typeof state.vessel !== 'object') {
            state.vessel = {};
          }
          if (!state.vessel.systems || typeof state.vessel.systems !== 'object') {
            state.vessel.systems = {};
          }
          state.vessel.systems.electrical = value;
        },
        condition: (newState) => !newState?.vessel?.systems?.electrical,
      },
    ];

    // Preserve current state for each domain
    const preservedValues = PRESERVED_DOMAINS.map(domain => {
      const value = domain.get ? domain.get(this.appState) : this.appState[domain.path];
      return { domain, value };
    });

    // Replace the state with the new state
    this.appState = this._safeClone(newStateData);

    // Restore preserved states
    preservedValues.forEach(({ domain, value }) => {
      if (!value) return;

      // Check conditional restore if defined
      if (domain.condition && !domain.condition(this.appState)) {
        return;
      }

      domain.restore(this.appState, value);
    });

    // Forward aisTargets to the rule engine so AIS proximity rules can evaluate
    if (newStateData.aisTargets && Object.keys(newStateData.aisTargets).length > 0) {
      this.ruleEngine.updateState({ aisTargets: newStateData.aisTargets });
    }

    // Emit the updated state to clients. The emitFullState method itself will decide if it should run.
    this.emitFullState();
  }

  /**
   * Update anchor state with data from a client
   * This ensures the StateManager is the single source of truth for state changes
   * @param {Object} anchorData - The anchor data from the client
   */
  updateAnchorState(anchorData) {
    if (!anchorData) {
      this.log("[StateManager] Received empty anchor data");
      return;
    }

    try {
      const incomingAnchorPatch = this._unwrapAnchorPatch(anchorData);

      // Merge incoming anchor data into existing anchor state so that
      // server-maintained fields (e.g., history, derived distances) are
      // preserved and then recomputed by helpers.
      const currentAnchor = this.appState?.anchor || {};

      const sanitizedPatch = this._sanitizeIncomingAnchorPatch(incomingAnchorPatch);
      const action = typeof incomingAnchorPatch?.action === 'string' ? incomingAnchorPatch.action : null;

      const boatLatLon = this._getServerBoatLatLon();
      const serverNowIso = new Date().toISOString();
      const serverNowMs = Date.now();

      const wasDeployed = currentAnchor?.anchorDeployed === true;
      const willBeDeployed = sanitizedPatch?.anchorDeployed === true;
      const isDeployTransition = willBeDeployed && !wasDeployed;

      this._applyAnchorAction({
        action,
        incomingAnchorPatch,
        sanitizedPatch,
        currentAnchor,
        boatLatLon,
        serverNowIso,
        serverNowMs,
        isDeployTransition,
      });

      const mergedAnchor = this._deepMergeAnchor(currentAnchor, sanitizedPatch);

      this._preserveAnchorFenceRuntimeState(currentAnchor, mergedAnchor);

      // Create a patch to update the anchor state with the merged result
      const patch = [{ op: "replace", path: "/anchor", value: mergedAnchor }];

      // Apply the patch using our existing method
      this.applyPatchAndForward(patch);

      if (action === 'finalize_drop_now') {
        this.log('[StateManager][finalize_drop_now] persisted anchor values %o', {
          rode: this.appState?.anchor?.rode,
          warningRange: this.appState?.anchor?.warningRange,
          criticalRange: this.appState?.anchor?.criticalRange,
          deploymentPhase: this.appState?.anchor?.deploymentPhase,
          anchorSet: this.appState?.anchor?.anchorSet,
        });
      }

      return true;
    } catch (error) {
      this.logError("Error updating anchor state:", error);
      this.emit("error:anchor-update", { error, anchorData });
      return false;
    }
  }

  _applyAnchorAction({
    action,
    incomingAnchorPatch,
    sanitizedPatch,
    currentAnchor,
    boatLatLon,
    serverNowIso,
    serverNowMs,
    isDeployTransition,
  }) {
      // If anchor is being deployed now, capture the server's current boat position as
      // both the drop location and initial anchor location.

      if (action === 'drop_now') {
        this._applyAnchorDropNow({ sanitizedPatch, currentAnchor, boatLatLon, serverNowIso, serverNowMs });
      } else if (action === 'finalize_drop_now') {
        this._applyAnchorFinalizeDropNow({ incomingAnchorPatch, sanitizedPatch, currentAnchor, serverNowMs });
      } else if (action === 'cancel_drop_now') {
        this._applyAnchorCancelDropNow({ sanitizedPatch, currentAnchor, serverNowMs });
      } else if (action === 'set_after_deploy') {
        this._applyAnchorSetAfterDeploy({ incomingAnchorPatch, sanitizedPatch, currentAnchor, boatLatLon, serverNowIso });
        sanitizedPatch.anchorDeployed = true;
        sanitizedPatch.deploymentPhase = 'finalized';
        sanitizedPatch.anchorSet = true;
        sanitizedPatch.alertsSuppressed = false;
      } else if (action === 'reset_anchor_here') {
        this._applyAnchorResetHere({ sanitizedPatch, currentAnchor, boatLatLon, serverNowIso });
        sanitizedPatch.anchorDeployed = true;
        sanitizedPatch.deploymentPhase = 'finalized';
        sanitizedPatch.anchorSet = true;
        sanitizedPatch.alertsSuppressed = false;
      } else if (isDeployTransition) {
        this._applyCapturedDropAndAnchorPosition({ sanitizedPatch, currentAnchor, boatLatLon, serverNowIso });
        sanitizedPatch.anchorDeployed = true;
        sanitizedPatch.deploymentPhase = 'finalized';
        sanitizedPatch.anchorSet = true;
        sanitizedPatch.alertsSuppressed = false;
      } else if (sanitizedPatch.anchorDeployed === false) {
        sanitizedPatch.deploymentPhase = 'idle';
        sanitizedPatch.anchorSet = false;
        sanitizedPatch.alertsSuppressed = false;
      }
  }

  _applyAnchorDropNow({ sanitizedPatch, currentAnchor, boatLatLon, serverNowIso, serverNowMs }) {
    if (!boatLatLon) {
      throw new Error('drop_now requires server boat position but it is unavailable');
    }
    const dropDepthValue = sanitizedPatch?.anchorDropLocation?.depth?.value;
    const dropDepthUnits = sanitizedPatch?.anchorDropLocation?.depth?.units;
    const dropDepthSource = sanitizedPatch?.anchorDropLocation?.depthSource;
    if (dropDepthValue == null || dropDepthUnits == null || dropDepthSource == null) {
      throw new Error('drop_now requires anchorDropLocation.depth and anchorDropLocation.depthSource');
    }

    const positionCaptured = {
      latitude: { value: boatLatLon.boatLat, units: 'deg' },
      longitude: { value: boatLatLon.boatLon, units: 'deg' },
    };

    sanitizedPatch.anchorDropLocation = {
      ...(currentAnchor?.anchorDropLocation || {}),
      ...(sanitizedPatch.anchorDropLocation || {}),
      position: positionCaptured,
      time: serverNowIso,
    };

    sanitizedPatch.anchorLocation = {
      ...(currentAnchor?.anchorLocation || {}),
      ...(sanitizedPatch.anchorLocation || {}),
      position: positionCaptured,
      time: serverNowIso,
    };

    sanitizedPatch.anchorDeployed = true;
    sanitizedPatch.deploymentPhase = 'deploying';
    sanitizedPatch.anchorSet = false;
    sanitizedPatch.alertsSuppressed = true;
    sanitizedPatch.dragging = false;
    sanitizedPatch.aisWarning = false;
    sanitizedPatch.dropSession = {
      ...(currentAnchor?.dropSession || {}),
      startedAt: serverNowMs,
      endedAt: null,
      cancelledAt: null,
      measured: {
        currentDistanceFromDrop: 0,
        maxDistanceFromDrop: 0,
        currentBearingFromDropDeg: null,
        lastSampleAt: serverNowMs,
      },
    };
    this._resolveAnchorMonitoringAlerts('drop_now_started');
  }

  _applyAnchorCancelDropNow({ sanitizedPatch, currentAnchor, serverNowMs }) {
    sanitizedPatch.anchorDeployed = false;
    sanitizedPatch.deploymentPhase = 'idle';
    sanitizedPatch.anchorSet = false;
    sanitizedPatch.alertsSuppressed = false;
    sanitizedPatch.dragging = false;
    sanitizedPatch.aisWarning = false;
    sanitizedPatch.dropSession = {
      ...(currentAnchor?.dropSession || {}),
      endedAt: null,
      cancelledAt: serverNowMs,
      measured: {
        currentDistanceFromDrop: null,
        maxDistanceFromDrop: null,
        currentBearingFromDropDeg: null,
        lastSampleAt: null,
      },
    };
    this._resolveAnchorMonitoringAlerts('drop_now_cancelled');
  }

  _validateFinalizeDropNowPayload({ incomingAnchorPatch, sanitizedPatch }) {
    const rodeAmount = sanitizedPatch?.rode?.amount;
    const rodeUnits = sanitizedPatch?.rode?.units;
    if (rodeAmount == null || rodeUnits == null) {
      throw new Error('finalize_drop_now requires rode.amount and rode.units');
    }
    if (!Number.isFinite(rodeAmount) || rodeAmount <= 0) {
      throw new Error('finalize_drop_now requires rode.amount > 0');
    }

    const warningRangeValue = sanitizedPatch?.warningRange?.r;
    const warningRangeUnits = sanitizedPatch?.warningRange?.units;
    if (warningRangeValue == null || warningRangeUnits == null) {
      throw new Error('finalize_drop_now requires warningRange.r and warningRange.units');
    }
    if (!Number.isFinite(warningRangeValue) || warningRangeValue <= 0) {
      throw new Error('finalize_drop_now requires warningRange.r > 0');
    }

    const criticalRangeValue = sanitizedPatch?.criticalRange?.r;
    const criticalRangeUnits = sanitizedPatch?.criticalRange?.units;
    if (criticalRangeValue == null || criticalRangeUnits == null) {
      throw new Error('finalize_drop_now requires criticalRange.r and criticalRange.units');
    }
    if (!Number.isFinite(criticalRangeValue) || criticalRangeValue <= 0) {
      throw new Error('finalize_drop_now requires criticalRange.r > 0');
    }

    const bearingValue = incomingAnchorPatch?.setBearing?.value;
    const bearingUnits = incomingAnchorPatch?.setBearing?.units;
    if (bearingValue == null || bearingUnits == null) {
      throw new Error('finalize_drop_now requires setBearing.value and setBearing.units');
    }
    if (!Number.isFinite(bearingValue) || typeof bearingUnits !== 'string' || bearingUnits.toLowerCase() !== 'deg') {
      throw new Error('finalize_drop_now requires setBearing.units="deg" and numeric value');
    }

    const depthValue = sanitizedPatch?.anchorDropLocation?.depth?.value;
    const depthUnits = sanitizedPatch?.anchorDropLocation?.depth?.units;
    const depthSource = sanitizedPatch?.anchorDropLocation?.depthSource;
    if (depthValue == null || depthUnits == null || depthSource == null) {
      throw new Error('finalize_drop_now requires anchorDropLocation.depth and anchorDropLocation.depthSource');
    }
  }

  _backfillFinalizeRodeFromMeasuredDistance({ sanitizedPatch, currentAnchor }) {
    const rodeUnits = this._resolveAnchorPreferredLengthUnits(currentAnchor, sanitizedPatch);
    if (rodeUnits == null) {
      throw new Error('finalize_drop_now requires resolvable length units from anchor state or preferences');
    }

    const rodeAmount = sanitizedPatch?.rode?.amount;
    if (Number.isFinite(rodeAmount) && rodeAmount > 0 && sanitizedPatch?.rode?.units != null) {
      return;
    }

    const measuredMeters = currentAnchor?.dropSession?.measured?.maxDistanceFromDrop;
    if (!Number.isFinite(measuredMeters)) {
      throw new Error('finalize_drop_now requires rode.amount or a measured dropSession.measured.maxDistanceFromDrop');
    }

    if (typeof rodeUnits !== 'string') {
      throw new Error('finalize_drop_now requires rode.units to be a string');
    }

    let convertedAmount = null;
    switch (rodeUnits.toLowerCase()) {
      case 'm':
      case 'meter':
      case 'meters':
        convertedAmount = measuredMeters;
        break;
      case 'ft':
      case 'foot':
      case 'feet':
        convertedAmount = measuredMeters / 0.3048;
        break;
      default:
        throw new Error('finalize_drop_now requires rode.units to be one of: m, meter, meters, ft, foot, feet');
    }

    sanitizedPatch.rode = {
      ...(sanitizedPatch.rode || {}),
      amount: convertedAmount,
      units: rodeUnits,
    };
  }

  _backfillFinalizeCriticalRangeFromRode(sanitizedPatch) {
    const criticalRangeValue = sanitizedPatch?.criticalRange?.r;
    const criticalRangeUnits = sanitizedPatch?.criticalRange?.units;
    if (
      Number.isFinite(criticalRangeValue) &&
      criticalRangeValue > 0 &&
      this._isAnchorLengthUnits(criticalRangeUnits)
    ) {
      return;
    }

    const rodeAmount = sanitizedPatch?.rode?.amount;
    const rodeUnits = sanitizedPatch?.rode?.units;
    if (!Number.isFinite(rodeAmount) || rodeAmount <= 0 || !this._isAnchorLengthUnits(rodeUnits)) {
      throw new Error('finalize_drop_now requires criticalRange or calculated rode to derive criticalRange');
    }

    sanitizedPatch.criticalRange = {
      ...(sanitizedPatch.criticalRange || {}),
      r: rodeAmount + 20,
      units: rodeUnits,
    };
  }

  _applyAnchorFinalizeDropNow({ incomingAnchorPatch, sanitizedPatch, currentAnchor, serverNowMs }) {
    this.log('[StateManager][finalize_drop_now] incoming payload summary %o', {
      rode: sanitizedPatch?.rode,
      warningRange: sanitizedPatch?.warningRange,
      criticalRange: sanitizedPatch?.criticalRange,
      setBearing: incomingAnchorPatch?.setBearing,
      anchorDropDepth: sanitizedPatch?.anchorDropLocation?.depth,
      anchorDropDepthSource: sanitizedPatch?.anchorDropLocation?.depthSource,
      measuredMaxDistanceFromDrop: currentAnchor?.dropSession?.measured?.maxDistanceFromDrop,
    });

    this._backfillFinalizeRodeFromMeasuredDistance({ sanitizedPatch, currentAnchor });
    this._backfillFinalizeCriticalRangeFromRode(sanitizedPatch);
    this._validateFinalizeDropNowPayload({ incomingAnchorPatch, sanitizedPatch });

    const bearingValue = incomingAnchorPatch?.setBearing?.value;

    sanitizedPatch.anchorDeployed = true;
    sanitizedPatch.deploymentPhase = 'finalized';
    sanitizedPatch.anchorSet = true;
    sanitizedPatch.alertsSuppressed = false;
    sanitizedPatch.dragging = false;
    sanitizedPatch.aisWarning = false;

    sanitizedPatch.dropSession = {
      ...(currentAnchor?.dropSession || {}),
      endedAt: serverNowMs,
      cancelledAt: null,
      measured: {
        ...(currentAnchor?.dropSession?.measured || {}),
      },
    };

    sanitizedPatch.anchorDropLocation = {
      ...(currentAnchor?.anchorDropLocation || {}),
      ...(sanitizedPatch.anchorDropLocation || {}),
      bearing: {
        ...(currentAnchor?.anchorDropLocation?.bearing || {}),
        value: bearingValue,
        units: 'deg',
      },
      originalBearing: {
        ...(currentAnchor?.anchorDropLocation?.originalBearing || {}),
        value: bearingValue,
        units: 'deg',
      },
    };
  }

  _applyCapturedDropAndAnchorPosition({ sanitizedPatch, currentAnchor, boatLatLon, serverNowIso }) {
    if (!boatLatLon) {
      console.warn('[StateManager] Anchor action requires server boat position but it is unavailable');
      return;
    }

    const positionCaptured = {
      latitude: { value: boatLatLon.boatLat, units: 'deg' },
      longitude: { value: boatLatLon.boatLon, units: 'deg' },
    };

    sanitizedPatch.anchorDropLocation = {
      ...(currentAnchor?.anchorDropLocation || {}),
      ...(sanitizedPatch.anchorDropLocation || {}),
      position: positionCaptured,
      time: serverNowIso,
    };

    sanitizedPatch.anchorLocation = {
      ...(currentAnchor?.anchorLocation || {}),
      ...(sanitizedPatch.anchorLocation || {}),
      position: positionCaptured,
      time: serverNowIso,
    };
  }

  _applyAnchorSetAfterDeploy({ incomingAnchorPatch, sanitizedPatch, currentAnchor, boatLatLon, serverNowIso }) {
    if (!boatLatLon) {
      console.warn('[StateManager] set_after_deploy requires server boat position but it is unavailable');
      return;
    }

    const setBearing = incomingAnchorPatch?.setBearing;
    const bearingValue = setBearing?.value;
    const bearingUnits = setBearing?.units;
    if (bearingValue == null || bearingUnits == null) {
      console.warn('[StateManager] set_after_deploy requires setBearing.value and setBearing.units');
      return;
    }
    if (!Number.isFinite(bearingValue) || typeof bearingUnits !== 'string' || bearingUnits.toLowerCase() !== 'deg') {
      console.warn('[StateManager] set_after_deploy requires setBearing.units="deg" and numeric value');
      return;
    }

    const rodeMeters = this._extractAnchorRodeLengthMeters({
      rode: sanitizedPatch?.rode != null ? sanitizedPatch.rode : currentAnchor?.rode,
    });
    if (rodeMeters == null) {
      console.warn('[StateManager] set_after_deploy requires rode (amount+units) either in patch or existing anchor state');
      return;
    }

    const dropDepthMeters = this._extractAnchorDropDepthMeters({
      anchorDropLocation:
        sanitizedPatch?.anchorDropLocation != null
          ? sanitizedPatch.anchorDropLocation
          : currentAnchor?.anchorDropLocation,
    });

    const effectiveHorizontalMeters =
      dropDepthMeters != null && dropDepthMeters >= 0 && rodeMeters > dropDepthMeters
        ? Math.sqrt((rodeMeters * rodeMeters) - (dropDepthMeters * dropDepthMeters))
        : rodeMeters;

    const projected = projectPoint(
      boatLatLon.boatLat,
      boatLatLon.boatLon,
      bearingValue,
      effectiveHorizontalMeters
    );
    if (!projected) {
      console.warn('[StateManager] set_after_deploy projection failed; not updating drop/anchor positions');
      return;
    }

    const projectedPositionObj = {
      latitude: { value: projected.latitude, units: 'deg' },
      longitude: { value: projected.longitude, units: 'deg' },
    };

    sanitizedPatch.anchorDropLocation = {
      ...(currentAnchor?.anchorDropLocation || {}),
      ...(sanitizedPatch.anchorDropLocation || {}),
      position: projectedPositionObj,
      time: serverNowIso,
    };

    if (sanitizedPatch.anchorDropLocation.depth == null && currentAnchor?.anchorDropLocation?.depth != null) {
      sanitizedPatch.anchorDropLocation.depth = currentAnchor.anchorDropLocation.depth;
    }
    if (sanitizedPatch.anchorDropLocation.depthSource == null && currentAnchor?.anchorDropLocation?.depthSource != null) {
      sanitizedPatch.anchorDropLocation.depthSource = currentAnchor.anchorDropLocation.depthSource;
    }

    sanitizedPatch.anchorLocation = {
      ...(currentAnchor?.anchorLocation || {}),
      ...(sanitizedPatch.anchorLocation || {}),
      position: projectedPositionObj,
      time: serverNowIso,
    };
  }

  _applyAnchorResetHere({ sanitizedPatch, currentAnchor, boatLatLon, serverNowIso }) {
    if (!boatLatLon) {
      console.warn('[StateManager] reset_anchor_here requires server boat position but it is unavailable');
      return;
    }

    const oldDropPos = currentAnchor?.anchorDropLocation?.position;
    const oldDropLat = oldDropPos?.latitude?.value;
    const oldDropLon = oldDropPos?.longitude?.value;

    const rodeUnits = sanitizedPatch?.rode?.units ?? currentAnchor?.rode?.units;
    if (Number.isFinite(oldDropLat) && Number.isFinite(oldDropLon) && typeof rodeUnits === 'string') {
      const movedDistanceMeters = calculateDistance(oldDropLat, oldDropLon, boatLatLon.boatLat, boatLatLon.boatLon);
      const convertedRodeAmount = this._convertMetersToRequestedLengthUnits(movedDistanceMeters, rodeUnits);
      if (convertedRodeAmount != null) {
        sanitizedPatch.rode = {
          ...(currentAnchor?.rode || {}),
          ...(sanitizedPatch.rode || {}),
          amount: convertedRodeAmount,
          units: rodeUnits,
        };
      }
    }

    this._applyCapturedDropAndAnchorPosition({ sanitizedPatch, currentAnchor, boatLatLon, serverNowIso });

    const moveBearingDeg = calculateBearing(oldDropLat, oldDropLon, boatLatLon.boatLat, boatLatLon.boatLon);
    if (moveBearingDeg == null) {
      return;
    }

    const existingBearingUnits = currentAnchor?.anchorDropLocation?.bearing?.units;
    const writeBearingValue =
      typeof existingBearingUnits === 'string' && existingBearingUnits.toLowerCase() === 'rad'
        ? toRad(moveBearingDeg)
        : moveBearingDeg;

    sanitizedPatch.anchorDropLocation = {
      ...(currentAnchor?.anchorDropLocation || {}),
      ...(sanitizedPatch.anchorDropLocation || {}),
      originalBearing: {
        ...(currentAnchor?.anchorDropLocation?.originalBearing || {}),
        value: writeBearingValue,
      },
      bearing: {
        ...(currentAnchor?.anchorDropLocation?.bearing || {}),
        value: writeBearingValue,
      },
    };

    if (Object.prototype.hasOwnProperty.call(sanitizedPatch.anchorDropLocation.originalBearing, 'degrees')) {
      sanitizedPatch.anchorDropLocation.originalBearing.degrees = moveBearingDeg;
    }
    if (Object.prototype.hasOwnProperty.call(sanitizedPatch.anchorDropLocation.bearing, 'degrees')) {
      sanitizedPatch.anchorDropLocation.bearing.degrees = moveBearingDeg;
    }
  }

  /**
   * Reset the anchor state back to the default model definition.
   * This is intended to be called when the client retrieves the anchor
   * ("anchor:reset" message), so the server becomes the single source
   * of truth for all anchor-derived fields again.
   */
  resetAnchorState() {
    this.log('[StateManager] anchor:reset received');

    try {
      const freshModel = createStateDataModel(UNIT_PRESETS.IMPERIAL);
      const freshAnchor = this._safeClone(freshModel.anchor);

      const patch = [{ op: "replace", path: "/anchor", value: freshAnchor }];
      this.applyPatchAndForward(patch);

      this.log("[StateManager][resetAnchorState] Anchor state reset to default model");
      return true;
    } catch (error) {
      this.logError("[StateManager][resetAnchorState] Error resetting anchor state:", error);
      return false;
    }
  }

  _unwrapAnchorPatch(anchorData) {
    return anchorData?.data && typeof anchorData.data === 'object'
      ? anchorData.data
      : anchorData;
  }

  _sanitizeIncomingAnchorPatch(incomingAnchorPatch) {
    const sanitizedPatch = { ...(incomingAnchorPatch || {}) };

    delete sanitizedPatch.action;
    delete sanitizedPatch.setBearing;

    if (sanitizedPatch.anchorDropLocation?.position != null) {
      sanitizedPatch.anchorDropLocation = { ...sanitizedPatch.anchorDropLocation };
      delete sanitizedPatch.anchorDropLocation.position;
    }
    if (sanitizedPatch.anchorLocation?.position != null) {
      sanitizedPatch.anchorLocation = { ...sanitizedPatch.anchorLocation };
      delete sanitizedPatch.anchorLocation.position;
    }

    if (sanitizedPatch.anchorDropLocation && typeof sanitizedPatch.anchorDropLocation === 'object') {
      sanitizedPatch.anchorDropLocation = { ...sanitizedPatch.anchorDropLocation };
      delete sanitizedPatch.anchorDropLocation.bearing;
      delete sanitizedPatch.anchorDropLocation.originalBearing;
      delete sanitizedPatch.anchorDropLocation.distancesFromCurrent;
      delete sanitizedPatch.anchorDropLocation.distancesFromDrop;
    }

    if (sanitizedPatch.anchorLocation && typeof sanitizedPatch.anchorLocation === 'object') {
      sanitizedPatch.anchorLocation = { ...sanitizedPatch.anchorLocation };
      delete sanitizedPatch.anchorLocation.bearing;
      delete sanitizedPatch.anchorLocation.originalBearing;
      delete sanitizedPatch.anchorLocation.distancesFromCurrent;
      delete sanitizedPatch.anchorLocation.distancesFromDrop;
      delete sanitizedPatch.anchorLocation.originalPosition;
    }

    delete sanitizedPatch.dragging;
    delete sanitizedPatch.history;

    return sanitizedPatch;
  }

  _extractAnchorRodeLengthMeters(anchor) {
    const rode = anchor?.rode;
    const amount = rode?.amount ?? rode?.value;
    const units = rode?.units ?? rode?.unit;
    if (amount == null || units == null) return null;
    if (!Number.isFinite(amount) || typeof units !== 'string') return null;
    switch (units.toLowerCase()) {
      case 'm':
      case 'meter':
      case 'meters':
        return amount;
      case 'ft':
      case 'foot':
      case 'feet':
        return amount * 0.3048;
      default:
        return null;
    }
  }

  _extractAnchorDropDepthMeters(patchOrAnchor) {
    const depthObj = patchOrAnchor?.anchorDropLocation?.depth;
    const depthSource = patchOrAnchor?.anchorDropLocation?.depthSource;
    const amount = depthObj?.value;
    const units = depthObj?.units;
    if (depthSource == null) return null;
    if (amount == null || units == null) return null;
    if (!Number.isFinite(amount) || typeof units !== 'string') return null;
    switch (units.toLowerCase()) {
      case 'm':
      case 'meter':
      case 'meters':
        return amount;
      case 'ft':
      case 'foot':
      case 'feet':
        return amount * 0.3048;
      default:
        return null;
    }
  }

  _convertMetersToRequestedLengthUnits(meters, units) {
    if (!Number.isFinite(meters) || typeof units !== 'string') return null;
    switch (units.toLowerCase()) {
      case 'm':
      case 'meter':
      case 'meters':
        return meters;
      case 'ft':
      case 'foot':
      case 'feet':
        return meters / 0.3048;
      default:
        return null;
    }
  }

  _getServerBoatLatLon() {
    const navLat = this.appState?.navigation?.position?.latitude?.value;
    const navLon = this.appState?.navigation?.position?.longitude?.value;

    const positionRoot =
      this.appState?.position && typeof this.appState.position === 'object'
        ? this.appState.position
        : {};
    const boatPositionFromPosition =
      positionRoot.signalk && typeof positionRoot.signalk === 'object'
        ? positionRoot.signalk
        : positionRoot;

    const fallbackBoatLat = typeof boatPositionFromPosition?.latitude === 'object'
      ? boatPositionFromPosition.latitude?.value
      : boatPositionFromPosition?.latitude;
    const fallbackBoatLon = typeof boatPositionFromPosition?.longitude === 'object'
      ? boatPositionFromPosition.longitude?.value
      : boatPositionFromPosition?.longitude;

    const boatLat = navLat != null ? navLat : fallbackBoatLat;
    const boatLon = navLon != null ? navLon : fallbackBoatLon;
    if (boatLat == null || boatLon == null) return null;
    if (!Number.isFinite(boatLat) || !Number.isFinite(boatLon)) return null;
    return { boatLat, boatLon };
  }

  _isAnchorLengthUnits(units) {
    if (typeof units !== 'string') return false;
    const normalized = units.toLowerCase();
    return normalized === 'm' ||
      normalized === 'meter' ||
      normalized === 'meters' ||
      normalized === 'ft' ||
      normalized === 'foot' ||
      normalized === 'feet';
  }

  _resolveAnchorPreferredLengthUnits(currentAnchor, sanitizedPatch) {
    const candidates = [
      currentAnchor?.rode?.units,
      this.appState?.preferences?.units?.length,
      this.appState?.preferences?.length,
      this.appState?.unitPreferences?.length,
      sanitizedPatch?.rode?.units,
    ];

    for (const candidate of candidates) {
      if (this._isAnchorLengthUnits(candidate)) {
        return candidate;
      }
    }

    return null;
  }

  _resolveAnchorMonitoringAlerts(reason) {
    if (!this.alertService || typeof this.alertService.resolveAlertsByTrigger !== 'function') {
      return;
    }

    const triggers = ['critical_range', 'anchor_dragging', 'ais_proximity'];
    let resolvedAny = false;
    for (const trigger of triggers) {
      const resolved = this.alertService.resolveAlertsByTrigger(trigger, { reason });
      if (Array.isArray(resolved) && resolved.length > 0) {
        resolvedAny = true;
      }
    }

    if (resolvedAny) {
      this._syncAlertsToRuleEngine();
      this._emitAlertsPatch();
    }
  }

  _preserveAnchorFenceRuntimeState(currentAnchor, mergedAnchor) {
    if (!Array.isArray(currentAnchor.fences) || !Array.isArray(mergedAnchor.fences)) {
      return;
    }

    const fencesById = new Map(currentAnchor.fences.map((fence) => [fence?.id, fence]));
    mergedAnchor.fences = mergedAnchor.fences.map((fence) => {
      const existingFence = fence?.id ? fencesById.get(fence.id) : null;
      if (!existingFence) {
        return fence;
      }

      const nextFence = { ...fence };
      if (nextFence.currentDistance == null && existingFence.currentDistance != null) {
        nextFence.currentDistance = existingFence.currentDistance;
        nextFence.currentDistanceUnits = existingFence.currentDistanceUnits;
      }
      if (nextFence.minimumDistance == null && existingFence.minimumDistance != null) {
        nextFence.minimumDistance = existingFence.minimumDistance;
        nextFence.minimumDistanceUnits = existingFence.minimumDistanceUnits;
        nextFence.minimumDistanceUpdatedAt = existingFence.minimumDistanceUpdatedAt;
      }
      if (!Array.isArray(nextFence.distanceHistory) && Array.isArray(existingFence.distanceHistory)) {
        nextFence.distanceHistory = existingFence.distanceHistory;
      }
      if (nextFence.inAlert == null && existingFence.inAlert != null) {
        nextFence.inAlert = existingFence.inAlert;
      }

      return nextFence;
    });
  }

  _runStateHelpers(patchOps) {
    const hasPatchOps = Array.isArray(patchOps);

    // Anchor helper: only run when relevant paths change, or always for
    // full-state updates where patchOps is null.
    const anchorRelevant = hasPatchOps
      ? patchOps.some((op) =>
          typeof op.path === "string" &&
          (op.path.startsWith("/anchor") ||
            op.path.startsWith("/position") ||
            op.path.startsWith("/navigation") ||
            op.path.startsWith("/aisTargets"))
        )
      : true;

    // For quick troubleshooting without DEBUG noise, log when anchor-related
    // patches are processed. This avoids logging for high-frequency
    // /position-only updates.
    const hasAnchorPatch = hasPatchOps
      ? patchOps.some((op) =>
          typeof op.path === "string" && op.path.startsWith("/anchor")
        )
      : false;

    if (anchorRelevant) {
      const helperResult = recomputeAnchorDerivedState(this.appState, {
        stateManager: this,
        patchOps: patchOps,
      });
      if (helperResult) {
        const { anchor: updatedAnchor, changedPaths } = helperResult;
        
        if (hasAnchorPatch) {
          this.log(
            "[StateManager][_runStateHelpers] Anchor helper updated anchor state after anchor patch"
          );
        }
        logState(
          "[StateManager][_runStateHelpers] Anchor helper produced updated anchor state"
        );
        this.appState.anchor = updatedAnchor;
        
        // Emit granular patches for each changed path - never emit full anchor
        const patches = changedPaths.map(({ path, value }) => ({
          op: "replace",
          path,
          value,
        }));
        
        this.emit("state:patch", {
          type: "state:patch",
          data: patches,
          boatId: this._boatId,
          timestamp: Date.now(),
        });
        logState(`[StateManager][_runStateHelpers] Emitted ${patches.length} granular anchor patches`);
      } else {
        logState(
          "[StateManager][_runStateHelpers] Anchor helper made no changes to anchor state"
        );
      }
    }
  }

  _deepMergeAnchor(target, source) {
    if (!source || typeof source !== "object") {
      return target || {};
    }

    const result = { ...(target || {}) };

    Object.keys(source).forEach((key) => {
      const sourceValue = source[key];
      const targetValue = result[key];

      if (
        sourceValue &&
        typeof sourceValue === "object" &&
        !Array.isArray(sourceValue) &&
        targetValue &&
        typeof targetValue === "object" &&
        !Array.isArray(targetValue)
      ) {
        // Recursively merge nested objects
        result[key] = this._deepMergeAnchor(targetValue, sourceValue);
      } else {
        // Primitive values and arrays overwrite existing values
        result[key] = sourceValue;
      }
    });

    return result;
  }
 

  _sendCrewAlert(message) {
    this.emit("crew-alert", { message });
  }

  _processRuleAction(action) {
    switch (action.type) {
      case "SET_SYNC_PROFILE":
        this._applySyncProfile(action.config);
        break;
      case "CREW_ALERT":
        this._sendCrewAlert(action.message);
        break;
      case "CREATE_ALERT":
        this.alertService.createAlert(action.data);
        // Forward alerts state to rule engine and emit patch to clients
        this._syncAlertsToRuleEngine();
        this._emitAlertsPatch();
        break;
      case "RESOLVE_ALERT":
        this.alertService.resolveAlertsByTrigger(action.trigger, action.data);
        // Forward alerts state to rule engine and emit patch to clients
        this._syncAlertsToRuleEngine();
        this._emitAlertsPatch();
        break;
    }
  }

  _syncAlertsToRuleEngine() {
    this.ruleEngine.updateState({ alerts: this.appState.alerts || {} });
  }

  _emitAlertsPatch() {
    this.emit("state:patch", {
      type: "state:patch",
      data: [
        {
          op: "replace",
          path: "/alerts",
          value: this.appState.alerts
        }
      ],
      boatId: this._boatId,
      timestamp: Date.now(),
    });
  }

  _getNestedValue(obj, pathSegments) {
    // Safely retrieve a value from a nested object using an array of path segments
    return pathSegments.reduce(
      (acc, part) => (acc && acc[part] !== undefined ? acc[part] : undefined),
      obj
    );
  }

  _convertPatchToStateChanges(patchOperations, stateBeforePatch) {
    const changes = {};
    // Create a temporary state to see the effects of the patch
    const tempPatchedState = applyPatch(
      this._safeClone(stateBeforePatch),
      this._safeClone(patchOperations),
      true,
      false
    ).newDocument;

    for (const op of patchOperations) {
      const pathSegments = op.path.substring(1).split("/"); // Assumes paths like "/foo/bar"
      const pathKey = op.path.substring(1).replace(/\//g, "."); // Convert to dot notation "foo.bar"

      switch (op.op) {
        case "add":
        case "replace":
          changes[pathKey] = this._getNestedValue(
            tempPatchedState,
            pathSegments
          );
          break;
        case "remove":
          changes[pathKey] = undefined; // Indicate removal for RuleEngine2's state cache
          break;
      }
    }
    return changes;
  }

  // Alert management has been moved to the AlertService

  /**
   * Check for obsolete AIS proximity alerts when anchor warning range changes
   * @param {Array} patchOps - Patch operations that were applied
   * @param {Object} stateBeforePatch - Snapshot before patch application
   */
  _checkObsoleteAISAlerts(patchOps, stateBeforePatch) {
    if (!Array.isArray(patchOps)) return;

    const warningRangePatch = patchOps.find((op) =>
      typeof op?.path === "string" &&
      (op.path === "/anchor" ||
        op.path === "/anchor/warningRange" ||
        op.path === "/anchor/warningRange/r")
    );

    if (!warningRangePatch) return;

    const previousWarningRadius = stateBeforePatch?.anchor?.warningRange?.r ?? null;
    let nextWarningRadius = this.appState?.anchor?.warningRange?.r ?? null;

    if (warningRangePatch.path === "/anchor/warningRange/r") {
      nextWarningRadius = warningRangePatch.value ?? nextWarningRadius;
    } else if (warningRangePatch.path === "/anchor/warningRange") {
      nextWarningRadius = warningRangePatch.value?.r ?? nextWarningRadius;
    } else if (warningRangePatch.path === "/anchor") {
      nextWarningRadius = warningRangePatch.value?.warningRange?.r ?? nextWarningRadius;
    }

    if (previousWarningRadius === nextWarningRadius) return;

    this.log('[StateManager] Anchor warning range changed, resolving AIS proximity alerts: %o', {
      previousWarningRadius,
      nextWarningRadius,
    });

    const resolvedAlerts = this.alertService.resolveAlertsByTrigger('ais_proximity', {
      reason: 'anchor_warning_range_changed',
      previousWarningRadius,
      nextWarningRadius,
    });

    if (Array.isArray(resolvedAlerts) && resolvedAlerts.length > 0) {
      this._syncAlertsToRuleEngine();
      this._emitAlertsPatch();
      this.emit('alerts:updated', {
        type: 'alerts:resolved',
        trigger: 'ais_proximity',
        alerts: resolvedAlerts,
        data: {
          reason: 'anchor_warning_range_changed',
          previousWarningRadius,
          nextWarningRadius,
        },
      });
    }

    const hasActiveAisProximityAlerts = this.appState?.alerts?.active?.some(
      (alert) => alert?.trigger === 'ais_proximity' && !alert?.acknowledged
    );

    if (!hasActiveAisProximityAlerts && this.appState?.anchor?.aisWarning !== false) {
      this.appState.anchor.aisWarning = false;
      this.emit('state:patch', {
        type: 'state:patch',
        data: [
          {
            op: 'replace',
            path: '/anchor/aisWarning',
            value: false,
          },
        ],
        boatId: this._boatId,
        timestamp: Date.now(),
      });
      this.ruleEngine.updateState({
        anchor: {
          ...(this.appState.anchor || {}),
        },
      });
    }
  }

  _applySyncProfile(config) {
    Object.entries(config).forEach(([dataType, settings]) => {
      this.currentProfile[dataType] = {
        ...this.currentProfile[dataType],
        ...settings,
      };
    });
  }

  /**
   * Initialize the storage service and load selected devices
   * @private
   */
  async _initializeStorage() {
    try {
      await storageService.initialize();
      await this._loadSelectedDevices();
      this._storageInitialized = true;
      this.log("Storage service initialized");

      // Start cleanup job after storage is initialized
      this._startCleanupJob().catch(this.logError);
      return true;
    } catch (error) {
      this.logError("Failed to initialize storage:", error);
      this.updateBluetoothStatus({
        state: "error",
        error: `Storage initialization failed: ${error.message}`,
      });
      throw error;
    }
  }

  /**
   * Load selected devices from storage
   * @private
   */
  async _loadSelectedDevices() {
    try {
      this.log('[StateManager] _loadSelectedDevices: Starting to load selected devices from storage');
      
      // Load selected device IDs from storage
      const selectedIds = await storageService.getSetting(
        "bluetooth:selectedDevices",
        []
      );
      
      this.log('[StateManager] _loadSelectedDevices: Loaded selectedIds from storage: %o', selectedIds);
      this.log('[StateManager] _loadSelectedDevices: selectedIds type: %s isArray: %s', typeof selectedIds, Array.isArray(selectedIds));
      
      this.appState.bluetooth = this.appState.bluetooth || {};

      // Initialize devices object if it doesn't exist
      if (!this.appState.bluetooth.devices) {
        this.appState.bluetooth.devices = {};
      }

      // Create a new object to store selected devices with full device objects
      const selectedDevicesObj = {};

      // For each selected ID, try to get the full device object
      for (const deviceId of selectedIds) {
        this.log(`[StateManager] _loadSelectedDevices: Processing device ${deviceId}`);
        
        // Check if we have the device in memory first
        if (this.appState.bluetooth.devices[deviceId]) {
          this.log(`[StateManager] _loadSelectedDevices: Found device ${deviceId} in memory`);
          // Use the device from memory
          selectedDevicesObj[deviceId] =
            this.appState.bluetooth.devices[deviceId];
        } else {
          this.log(`[StateManager] _loadSelectedDevices: Device ${deviceId} not in memory, trying storage...`);
          // Try to get the device from storage
          try {
            const device = await storageService.getDevice(deviceId);
            this.log(`[StateManager] _loadSelectedDevices: Storage returned: %s`, device ? 'device found' : 'null');
            if (device) {
              selectedDevicesObj[deviceId] = device;
              // Also add it to devices for consistency
              this.appState.bluetooth.devices[deviceId] = device;
              this.log(`[StateManager] _loadSelectedDevices: Added device ${deviceId} to state from storage`);
            } else {
              this.log(`[StateManager] _loadSelectedDevices: No device found in storage for ${deviceId}, creating placeholder`);
              selectedDevicesObj[deviceId] = { id: deviceId, isSelected: true };
            }
          } catch (deviceError) {
            this.log(`[StateManager] _loadSelectedDevices: Failed to load device ${deviceId} from storage: %s`, deviceError.message);
            // Create a minimal placeholder device object
            selectedDevicesObj[deviceId] = { id: deviceId, isSelected: true };
          }
        }
      }

      // Update the state with the new object structure
      this.appState.bluetooth.selectedDevices = selectedDevicesObj;

      // Log the change for debugging
      this.log(
        `[StateManager] Loaded ${
          Object.keys(selectedDevicesObj).length
        } selected devices as objects`
      );

      // Emit initial state with the new object structure
      this.emit("state:patch", {
        type: "state:patch",
        data: [
          {
            op: "replace",
            path: "/bluetooth/selectedDevices",
            value: selectedDevicesObj,
          },
        ],
        boatId: this._boatId,
        timestamp: Date.now(),
      });
    } catch (error) {
      this.logError("Failed to load selected devices:", error);
      throw error;
    }
  }

  /**
   * Start the stale device cleanup job
   * @private
   */
  async _startCleanupJob() {
    if (this._staleDeviceCleanupInterval) {
      clearInterval(this._staleDeviceCleanupInterval);
    }

    // Run cleanup every hour
    this._staleDeviceCleanupInterval = setInterval(
      () => this._cleanupStaleDevices(),
      60 * 60 * 1000 // 1 hour
    );

    // Initial cleanup
    await this._cleanupStaleDevices();
  }

  /**
   * Clean up stale devices that haven't been seen in a while
   * @private
   */
  async _cleanupStaleDevices() {
    if (!this._storageInitialized) return;

    const STALE_TIMEOUT = 7 * 24 * 60 * 60 * 1000; // 1 week
    const now = Date.now();
    let cleanedCount = 0;

    try {
      const allDevices = await storageService.getAllDevices({
        forceRefresh: true,
      });

      for (const device of allDevices) {
        try {
          const lastSeen = new Date(device.lastSeen || 0).getTime();
          if (now - lastSeen <= STALE_TIMEOUT) continue;

          // Remove from selected devices if present
          if (
            this.appState.bluetooth.selectedDevices &&
            this.appState.bluetooth.selectedDevices[device.id]
          ) {
            await this.setBluetoothDeviceSelected(device.id, false);
          }

          // Remove from in-memory state
          if (this.appState.bluetooth.devices?.[device.id]) {
            delete this.appState.bluetooth.devices[device.id];

            // Emit patch for device removal
            this.emit("state:patch", {
              type: "state:patch",
              data: [
                {
                  op: "remove",
                  path: `/bluetooth/devices/${device.id}`,
                },
              ],
              boatId: this._boatId,
              timestamp: now,
            });

            cleanedCount++;
          }
        } catch (deviceError) {
          this.logError(`Error cleaning up device ${device.id}:`, deviceError);
        }
      }

      if (cleanedCount > 0) {
        this.log(`Cleaned up ${cleanedCount} stale devices`);
      }
    } catch (error) {
      this.logError("Error during stale device cleanup:", error);
    }
  }

  /**
   * Update Bluetooth service status with targeted patches
   * @param {Object} status - Status object with state and optional error
   */
  updateBluetoothStatus(status) {
    if (!this.appState.bluetooth) {
      this.appState.bluetooth = {};
    }

    const now = new Date().toISOString();
    const newStatus = {
      ...(this.appState.bluetooth.status || {}),
      ...status,
      lastUpdated: now,
    };

    const enabled = status.state === "enabled";

    // this.log(`[BLUETOOTH-DEBUG] Updating Bluetooth status:`, {
    //   newState: status.state,
    //   enabled: enabled,
    //   previousState: this.appState.bluetooth.status?.state,
    //   previousEnabled: this.appState.bluetooth.enabled,
    //   timestamp: now
    // });

    // Update in-memory state
    this.appState.bluetooth.status = newStatus;
    this.appState.bluetooth.enabled = enabled;
    this.appState.bluetooth.lastUpdated = now;

    // Create patch data
    const patchData = [
      {
        op: "replace",
        path: "/bluetooth/status",
        value: newStatus,
      },
      {
        op: "replace",
        path: "/bluetooth/enabled",
        value: enabled,
      },
      {
        op: "replace",
        path: "/bluetooth/lastUpdated",
        value: now,
      },
    ];

    // this.log(`[BLUETOOTH-DEBUG] Emitting Bluetooth state patch:`, JSON.stringify(patchData, null, 2));

    // Emit targeted patch
    this.emit("state:patch", {
      type: "state:patch",
      data: patchData,
      boatId: this._boatId,
      timestamp: Date.now(),
    });

    return true;
  }

  /**
   * Set a Bluetooth device as selected or deselected
   * @param {string} deviceId - The ID of the device
   * @param {boolean} selected - Whether the device should be selected
   * @returns {Promise<boolean>} - True if the update was successful
   */
  async setBluetoothDeviceSelected(deviceId, selected) {
    this.log(`[BLUETOOTH-SELECT] Called with deviceId: ${deviceId}, selected: ${selected}`);
    this.log(`[BLUETOOTH-SELECT] Stack trace:`, new Error().stack);
    
    if (!this._storageInitialized) {
      await this._initializeStorage();
    }

    try {
      // Initialize bluetooth state if needed
      if (!this.appState.bluetooth) {
        this.appState.bluetooth = {};
      }

      // Initialize selectedDevices as an object if it doesn't exist
      if (!this.appState.bluetooth.selectedDevices) {
        this.appState.bluetooth.selectedDevices = {};
      }

      // Get current selected devices object
      const currentSelectedDevices =
        this.appState.bluetooth.selectedDevices || {};
      const isCurrentlySelected = !!currentSelectedDevices[deviceId];

      if (selected === isCurrentlySelected) {
        return true; // No change needed
      }

      // Create a new selectedDevices object (for immutability)
      const newSelectedDevices = { ...currentSelectedDevices };

      if (selected) {
        // Get the full device object from memory or storage
        let deviceObj;

        if (
          this.appState.bluetooth.devices &&
          this.appState.bluetooth.devices[deviceId]
        ) {
          // Use device from memory
          deviceObj = this._safeClone(
            this.appState.bluetooth.devices[deviceId]
          );
        } else {
          // Try to get from storage
          try {
            deviceObj = await storageService.getDevice(deviceId);
          } catch (storageError) {
            this.log(
              `Failed to get device ${deviceId} from storage:`,
              storageError
            );
            // Create minimal placeholder
            deviceObj = { id: deviceId };
          }
        }

        // Mark as selected
        deviceObj.isSelected = true;

        // Add to selected devices
        newSelectedDevices[deviceId] = deviceObj;

        // Also update in devices collection
        if (!this.appState.bluetooth.devices) {
          this.appState.bluetooth.devices = {};
        }
        this.appState.bluetooth.devices[deviceId] = deviceObj;
      } else {
        // Remove from selected devices
        delete newSelectedDevices[deviceId];

        // Update isSelected flag in devices collection if it exists
        if (
          this.appState.bluetooth.devices &&
          this.appState.bluetooth.devices[deviceId]
        ) {
          this.appState.bluetooth.devices[deviceId].isSelected = false;
        }
      }

      // Update in-memory state with the new object
      this.appState.bluetooth.selectedDevices = newSelectedDevices;

      // For storage, we only store the array of IDs (for backward compatibility)
      const selectedIdsForStorage = Object.keys(newSelectedDevices);
      
      // console.log('[StateManager] setBluetoothDeviceSelected: Saving to storage');
      // console.log('[StateManager] setBluetoothDeviceSelected: selectedIdsForStorage:', selectedIdsForStorage);

      // Update storage
      try {
        await storageService.setSetting(
          "bluetooth:selectedDevices",
          selectedIdsForStorage
        );
        
        // console.log('[StateManager] setBluetoothDeviceSelected: Successfully saved to storage');

        // Update device in storage
        if (
          this.appState.bluetooth.devices &&
          this.appState.bluetooth.devices[deviceId]
        ) {
          const device = this.appState.bluetooth.devices[deviceId];
          await storageService.upsertDevice(device);
        }

        // Emit patch with the full device objects
        this.emit("state:patch", {
          type: "state:patch",
          data: [
            {
              op: "replace",
              path: "/bluetooth/selectedDevices",
              value: newSelectedDevices,
            },
          ],
          boatId: this._boatId,
          timestamp: Date.now(),
        });

        return true;
      } catch (error) {
        this.logError("Failed to update device selection:", error);
        this.updateBluetoothStatus({
          state: "error",
          error: `Device selection update failed: ${error.message}`,
        });
        return false;
      }
    } catch (deviceError) {
      this.logError("Error updating device selection:", deviceError);
      return false;
    }
  }

  /**
   * Update a Bluetooth device in the state with debouncing
   * @param {Object} device - The device to update
   * @param {string} updateType - Type of update ('discovery' or 'update')
   * @returns {void}
   */
  updateBluetoothDevice(device, updateType = "update") {
    // this.log(`[DEBUG-STATE] Device update received: ${JSON.stringify(device, null, 2)}`);

    if (!device || !device.id) {
      this.log("[StateManager] Cannot update device: Invalid device object");
      return;
    }

    // Initialize bluetooth state if it doesn't exist
    if (!this.appState.bluetooth) {
      this.appState.bluetooth = {
        lastUpdated: new Date().toISOString(),
      };
    }

    // Initialize devices object if it doesn't exist
    if (!this.appState.bluetooth.devices) {
      this.appState.bluetooth.devices = {};
    }

    // Initialize the device queue if it doesn't exist
    if (!this._bluetoothDeviceQueue) {
      this._bluetoothDeviceQueue = new Map();
    }

    // Get the current timestamp for the update
    const now = new Date().toISOString();

    // Get existing device to preserve user customizations
    const existingDevice = this.appState.bluetooth.devices[device.id] || {};
    
    // Check if device is in selectedDevices
    const isSelected = !!(this.appState.bluetooth.selectedDevices && 
                          this.appState.bluetooth.selectedDevices[device.id]);
    
    // Update the device, preserving user customizations
    const updatedDevice = {
      ...existingDevice,  // Start with existing device data
      ...device,          // Apply new discovery data
      // Explicitly preserve user-defined properties
      userLabel: existingDevice.userLabel || device.userLabel || null,
      isSelected: isSelected,  // Preserve selection status
      // Update technical fields
      rssi: device.rssi,
      lastSeen: now,
    };

    // Add or update the device in the queue
    // this.log(`[DEBUG-STATE] Adding device ${device.id} to update queue`);
    this._bluetoothDeviceQueue.set(device.id, updatedDevice);

    // Log the current queue size
    // this.log(`[DEBUG-STATE] Current queue size: ${this._bluetoothDeviceQueue.size} devices`);

    // Determine the debounce delay based on update type
    const delay =
      this._bluetoothDebounceDelays[updateType] ||
      this._bluetoothDebounceDelays.update;
    // this.log(`[DEBUG-STATE] Using debounce delay of ${delay}ms for update type ${updateType}`);

    // Clear any existing timeout for this update type
    if (
      this._bluetoothUpdateTimeouts &&
      this._bluetoothUpdateTimeouts[updateType]
    ) {
      clearTimeout(this._bluetoothUpdateTimeouts[updateType]);
    }

    // Set a new timeout to commit the updates
    this._bluetoothUpdateTimeouts[updateType] = setTimeout(() => {
      this._commitBluetoothUpdates(updateType);
    }, delay);
  }

  /**
   * Commit all queued Bluetooth device updates in a single state patch
   * @param {string} updateType - Type of update being committed
   * @private
   */
  _commitBluetoothUpdates(updateType) {
    if (!this._bluetoothDeviceQueue || this._bluetoothDeviceQueue.size === 0) {
      this.log(`[DEBUG-STATE] No devices in queue to commit, skipping update`);
      return;
    }

    this.log(
      `[StateManager] Committing ${this._bluetoothDeviceQueue.size} Bluetooth device updates`
    );

    // Clear any existing timeout for this update type
    if (
      this._bluetoothUpdateTimeouts &&
      this._bluetoothUpdateTimeouts[updateType]
    ) {
      clearTimeout(this._bluetoothUpdateTimeouts[updateType]);
      this._bluetoothUpdateTimeouts[updateType] = null;
    }

    // Create patches for each device in the queue
    const now = new Date().toISOString();
    const patches = [];

    // Check if bluetooth structure exists in state
    if (!this.appState.bluetooth) {
      this.log(`[DEBUG-STATE] Creating bluetooth object in state`);
      this.appState.bluetooth = {};
    }

    // Check if devices structure exists
    if (!this.appState.bluetooth.devices) {
      this.log(`[DEBUG-STATE] Creating bluetooth.devices object in state`);
      this.appState.bluetooth.devices = {};
    }

    // this.log(`[DEBUG-STATE] Current state before updates: ${Object.keys(this.appState.bluetooth.devices || {}).length} devices`);

    // Process each device in the queue
    this._bluetoothDeviceQueue.forEach((device) => {
      if (!device || !device.id) {
        this.log(`[DEBUG-STATE] Skipping invalid device in queue`);
        return;
      }

      // this.log(`[DEBUG-STATE] Processing device ${device.id} (${device.name || 'unnamed'})`);

      // Update the device in the state
      const previousDevice = this.appState.bluetooth.devices[device.id];
      this.appState.bluetooth.devices[device.id] = device;
      // this.log(`[DEBUG-STATE] ${previousDevice ? 'Updated' : 'Added new'} device ${device.id} in state`);

      // Also update in selectedDevices if this device is selected
      if (device.isSelected && this.appState.bluetooth.selectedDevices) {
        const previousSelectedDevice = this.appState.bluetooth.selectedDevices[device.id];
        this.appState.bluetooth.selectedDevices[device.id] = device;
        patches.push({
          op: previousSelectedDevice ? "replace" : "add",
          path: `/bluetooth/selectedDevices/${device.id}`,
          value: device,
        });
      }

      // Create a patch for this device - use 'add' for new devices, 'replace' for existing
      patches.push({
        op: previousDevice ? "replace" : "add",
        path: `/bluetooth/devices/${device.id}`,
        value: device,
      });
      // this.log(`[DEBUG-STATE] Created patch for device ${device.id}`);
    });

    // Add lastUpdated patch
    patches.push({
      op: "replace",
      path: "/bluetooth/lastUpdated",
      value: now,
    });

    // Update the lastUpdated timestamp in the state
    this.appState.bluetooth.lastUpdated = now;

    // Clear the device queue after processing
    // this.log(`[DEBUG-STATE] Clearing device queue after processing`);
    const queueSize = this._bluetoothDeviceQueue.size;
    this._bluetoothDeviceQueue.clear();

    // Emit the patches
    // Check if we have any listeners for the state:patch event
    const patchListeners = this.listeners("state:patch").length;

    const patchPayload = {
      type: "state:patch",
      data: patches,
      boatId: this._boatId,
      timestamp: Date.now(),
      updateType: updateType,
    };

    logState(
      `Emitting state:patch event with ${patchPayload.data.length} operations`
    );
    logState(
      `Patch operations: ${JSON.stringify(
        patchPayload.data.map((op) => ({ op: op.op, path: op.path }))
      )}`
    );
    logState(
      `Current listener count for state:patch: ${this.listenerCount(
        "state:patch"
      )}`
    );
    this.emit("state:patch", patchPayload);
    logState("state:patch event emitted");
  }

  /**
   * Update sensor data for a specific Bluetooth device
   * @param {string} deviceId - The ID of the device
   * @param {Object} sensorData - The parsed sensor data
   * @returns {boolean} - True if the update was successful
   */
  updateBluetoothDeviceSensorData(deviceId, sensorData) {
    if (!deviceId || !sensorData) {
      this.log(
        "[StateManager] Cannot update device sensor data: Invalid parameters"
      );
      return false;
    }

    // Initialize Bluetooth state if it doesn't exist
    if (!this.appState.bluetooth) {
      this.appState.bluetooth = {
        devices: {},
        selectedDevices: {},
        status: {},
        lastUpdated: new Date().toISOString(),
      };
      this.log(`[StateManager] Initialized Bluetooth state`);
    }

    // Initialize devices object if it doesn't exist
    if (!this.appState.bluetooth.devices) {
      this.appState.bluetooth.devices = {};
      this.log(`[StateManager] Initialized Bluetooth devices object`);
    }

    // Get the current device or create a new one
    const existingDevice = this.appState.bluetooth.devices[deviceId];
    const isNewDevice = !existingDevice;
    this.log(
      `[StateManager] ${
        isNewDevice ? "Creating new" : "Updating existing"
      } device ${deviceId}`
    );

    // Log sensor data preview
    const dataPreview = {};
    if (sensorData.temperature)
      dataPreview.temperature = sensorData.temperature.value;
    if (sensorData.humidity) dataPreview.humidity = sensorData.humidity.value;
    if (sensorData.pressure) dataPreview.pressure = sensorData.pressure.value;
    if (sensorData.battery)
      dataPreview.battery = sensorData.battery.voltage?.value;
    this.log(
      `[StateManager] Sensor data for device ${deviceId}: ${JSON.stringify(
        dataPreview
      )}`
    );

    // Update the device with new sensor data
    const updatedDevice = {
      ...(existingDevice || {}),
      id: deviceId,
      lastSeen: new Date().toISOString(),
      sensorData: sensorData, // Store the sensor data separately
      lastSensorUpdate: new Date().toISOString(),
    };

    // Update the device in the state
    this.appState.bluetooth.devices[deviceId] = updatedDevice;
    this.appState.bluetooth.lastUpdated = new Date().toISOString();

    // Also update in selectedDevices if this device is selected
    if (this.appState.bluetooth.selectedDevices && 
        this.appState.bluetooth.selectedDevices[deviceId]) {
      this.appState.bluetooth.selectedDevices[deviceId] = updatedDevice;
    }

    // Create a patch for this specific update
    const patch = [
      {
        op: isNewDevice ? "add" : "replace",
        path: `/bluetooth/devices/${deviceId}`,
        value: updatedDevice,
      },
      {
        op: "replace",
        path: "/bluetooth/lastUpdated",
        value: this.appState.bluetooth.lastUpdated,
      },
    ];
    
    // Add patch for selectedDevices if device is selected
    if (this.appState.bluetooth.selectedDevices && 
        this.appState.bluetooth.selectedDevices[deviceId]) {
      patch.push({
        op: "replace",
        path: `/bluetooth/selectedDevices/${deviceId}`,
        value: updatedDevice,
      });
    }

    // Emit the state patch
    this.emit("state:patch", {
      type: "state:patch",
      data: patch,
      boatId: this._boatId,
      timestamp: Date.now(),
      updateType: "sensor",
    });

    // Log state update completion
    this.log(
      `[StateManager] Updated state with sensor data for device ${deviceId}`
    );
    this.log(
      `[StateManager] Current state now has ${
        Object.keys(this.appState.bluetooth.devices).length
      } Bluetooth devices`
    );

    // Log device details in state
    const deviceInState = this.appState.bluetooth.devices[deviceId];
    this.log(`[StateManager] Device ${deviceId} in state:`, {
      name: deviceInState.name || "Unknown",
      lastSeen: deviceInState.lastSeen,
      lastSensorUpdate: deviceInState.lastSensorUpdate,
      hasSensorData: !!deviceInState.sensorData,
    });

    return true;
  }

  /**
   * Update metadata for a Bluetooth device (e.g., rename it)
   * @param {string} deviceId - The ID of the device
   * @param {Object} metadata - The metadata to update (e.g., {name: 'New Name'})
   * @returns {Promise<boolean>} - True if the update was successful
   */
  async updateBluetoothDeviceMetadata(deviceId, metadata) {
    if (!deviceId || !metadata) {
      this.log(
        "[StateManager] Cannot update device metadata: Invalid parameters"
      );
      return false;
    }

    this.log(`Updating metadata for device ${deviceId}: %o`, metadata);

    try {
      // Initialize the device if it doesn't exist
      if (!this.appState.bluetooth.devices) {
        this.appState.bluetooth.devices = {};
      }

      const existingDevice = this.appState.bluetooth.devices[deviceId];
      const isNewDevice = !existingDevice;

      // Update the device with new metadata
      // Store metadata in a metadata property, not spread directly
      const updatedDevice = {
        ...(existingDevice || {}),
        id: deviceId,
        metadata: {
          ...((existingDevice && existingDevice.metadata) || {}),
          ...metadata,
          lastUpdated: new Date().toISOString()
        },
        lastUpdated: new Date().toISOString(),
      };

      // Update the device in the state
      this.appState.bluetooth.devices[deviceId] = updatedDevice;
      this.appState.bluetooth.lastUpdated = new Date().toISOString();

      // Create a patch for this specific update
      const patch = [
        {
          op: isNewDevice ? "add" : "replace",
          path: `/bluetooth/devices/${deviceId}`,
          value: updatedDevice,
        },
        {
          op: "replace",
          path: "/bluetooth/lastUpdated",
          value: this.appState.bluetooth.lastUpdated,
        },
      ];

      // Emit the state patch
      this.emit("state:patch", {
        type: "state:patch",
        data: patch,
        boatId: this._boatId,
        timestamp: Date.now(),
        updateType: "metadata",
      });

      // Update device in storage if it exists
      try {
        if (this._storageInitialized) {
          const device = await storageService.getDevice(deviceId);
          if (device) {
            // Store metadata in nested structure, matching the state structure
            const updatedStorageDevice = {
              ...device,
              metadata: {
                ...(device.metadata || {}),
                ...metadata
              }
            };
            await storageService.upsertDevice(updatedStorageDevice);
            this.log(`Updated device ${deviceId} metadata in storage`);
          }
        }
      } catch (storageError) {
        this.logError(
          `Failed to update device metadata in storage: ${storageError.message}`
        );
      }

      // Emit event for BluetoothService to listen to
      // This allows BluetoothService to update its DeviceManager
      this.emit("bluetooth:metadata-updated", {
        deviceId: deviceId,
        metadata: metadata
      });

      this.log(`Successfully updated metadata for device ${deviceId}`);
      return true;
    } catch (error) {
      this.logError(`Error updating device metadata: ${error.message}`);
      return false;
    }
  }

  /**
   * Update Bluetooth scanning status
   * @param {boolean} isScanning - Whether scanning is active
   * @returns {boolean} - True if the update was successful
   */
  updateBluetoothScanningStatus(isScanning) {
    if (typeof isScanning !== "boolean") {
      this.log(
        "[StateManager] Invalid scanning status parameter, must be boolean"
      );
      return false;
    }

    if (!this.appState.bluetooth) this.appState.bluetooth = {};

    const now = new Date().toISOString();

    this.appState.bluetooth.scanning = isScanning;
    this.appState.bluetooth.lastUpdated = now;

    const patchData = [
      { op: "replace", path: "/bluetooth/scanning", value: isScanning },
      { op: "replace", path: "/bluetooth/lastUpdated", value: now },
    ];

    this.emit("state:patch", {
      type: "state:patch",
      data: patchData,
      boatId: this._boatId,
      timestamp: Date.now(),
    });

    return true;
  }

  /**
   * Toggle Bluetooth enabled state
   * @param {boolean} enabled - Whether Bluetooth should be enabled
   * @returns {boolean} - True if the update was successful
   */
  toggleBluetooth(enabled) {
    if (typeof enabled !== "boolean") {
      this.log(
        "[StateManager] Invalid Bluetooth toggle parameter, must be boolean"
      );
      return false;
    }

    this.log(`Toggling Bluetooth to: ${enabled ? "enabled" : "disabled"}`);

    this.updateBluetoothStatus({
      state: enabled ? "enabled" : "disabled",
      error: null,
    });

    return true;
  }
}

export const stateManager = new StateManager();

let sharedStateManager = stateManager;

export function getStateManager(initialState = null) {
  if (!sharedStateManager) {
    sharedStateManager = new StateManager(initialState);
  } else if (initialState && !sharedStateManager._hasSentInitialFullState) {
    try {
      sharedStateManager.initialState = initialState;
    } catch (error) {
      sharedStateManager.logError("Failed to set shared state manager initial state", error);
    }
  }
  return sharedStateManager;
}

export function setStateManagerInstance(stateManagerInstance) {
  sharedStateManager = stateManagerInstance;
}
