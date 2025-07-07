import { EventEmitter } from "events";
import debug from "debug";
import { v4 as uuidv4 } from "uuid";
import { createStateDataModel } from "../../../shared/stateDataModel.js";
import storageService from "../../../bluetooth/services/storage/storageService.js";
import { RuleEngine2 } from "./ruleEngine2.js";
import { getRules } from "./allRules2.js";
import { AlertService } from "../services/AlertService.js";
import { getOrCreateAppUuid } from "../../../server/uniqueAppId.js";
import { defaultProfile } from "../../../config/profiles.js";
import { UNIT_PRESETS } from "../../../shared/unitPreferences.js";
import { recordPatch, recordFullState } from "./db.js";

// import { applyPatch } from 'fast-json-patch';
import pkg from "fast-json-patch";
const { applyPatch } = pkg;

const RECORD_DATA = false;

export class StateManager extends EventEmitter {
  getState() {
    const state = { ...(this.appState || {}) };
    return state;
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

    this.log = debug("cn2:state-manager");
    this.logError = debug("cn2:state-manager:error");
    
    // Initialize Bluetooth update queuing
    this._bluetoothDebounceDelays = {
      discovery: 1000,    // 1s for new device discovery
      update: 250         // 250ms for device updates
    };
    this._bluetoothDeviceQueue = new Map();
    this._bluetoothUpdateTimeouts = {
      discovery: null,
      update: null
    };
    this._knownDeviceIds = new Set(); // Track known devices
    
    // Custom clone function to handle function properties
    const safeClone = (obj) => {
      if (obj === null || typeof obj !== 'object') {
        return obj;
      }
      
      if (Array.isArray(obj)) {
        return obj.map(item => safeClone(item));
      }
      
      const result = {};
      for (const key in obj) {
        // Skip function properties when cloning
        if (typeof obj[key] !== 'function') {
          result[key] = safeClone(obj[key]);
        }
      }
      return result;
    };
    
    // Make safeClone available to other methods
    this._safeClone = safeClone;
    
    // Initialize with default state structure
    this.appState = initialState ? safeClone(initialState) : createStateDataModel();
    this._boatId = process.env.BOAT_ID || 'default-boat';
    this._clients = new Map(); // Map of clientId -> { ws, lastSeen }
    this._debouncedPatches = new Map(); // clientId -> { timer, patches }
    this._bluetoothUpdateQueue = [];
    this._bluetoothDebounceTimers = {
      discovery: null,
      update: null
    };
    this._knownDeviceIds = new Set();
    this._staleDeviceCleanupInterval = null;
    this._storageInitialized = false;
    
    // Initialize storage and start cleanup job
    this._initializeStorage().catch(error => {
      this.logError('Failed to initialize storage:', error);
    });

    // Initialize the new rule engine, which is event-driven
    this.ruleEngine = new RuleEngine2();
    const allRules = getRules(); // Get all rules from the new set

    this.log(`Retrieved ${allRules.length} rules from getRules().`);
    allRules.forEach((rule) => {
      this.log(`Attempting to add rule: ${rule.name || "Unnamed Rule"}`);
      this.ruleEngine.addRule(rule);
    });
    this.log(`Finished adding rules.`);

    // Listen for rule triggers and process their actions
    this.ruleEngine.on("rule-triggered", ({ rule, actionResult }) => {
      if (actionResult) {
        this.log(`Rule triggered: ${rule.name}, Action:`, JSON.stringify(actionResult));
        this._processRuleAction(actionResult);
      }
    });

    // Initialize the alert service
    this.alertService = new AlertService(this);

    this.currentProfile = this._safeClone(defaultProfile);
    this._boatId = getOrCreateAppUuid();
    this._clientCount = 0;
    this.tideData = null;
    this.weatherData = null;
    this._hasSentInitialFullState = false;
    // Track connected clients
    this.connectedClients = new Map();

    // Log when a client connects or disconnects
    this.on("client:connected", (clientId, platform) => {
      this._clientCount++;
      this.log(`Client connected: ${clientId} (${platform || "unknown platform"})`);
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
      this.log("Identity message received:", JSON.stringify({ clientId: identity.clientId, platform: identity.platform, role: identity.role, timestamp: new Date().toISOString(), boatId: this._boatId }, null, 2));
    });
  }

  /**
   * Listens to a service for 'state:patch' events and forwards them.
   * This is the primary mechanism for services to update the central state.
   * @param {EventEmitter} service - The service instance to listen to.
   */
  listenToService(service) {
    if (service && typeof service.on === 'function') {
      const serviceName = service['name'] || 'unnamed service';
      this.log(`Now listening to '${serviceName}' for events.`);

      service.on('state:patch', ({ data }) => {
        try {
          this.log(`Received state:patch from '${serviceName}', forwarding.`);
          this.applyPatchAndForward(data);
        } catch (err) {
          this.logError(`Error applying patch from '${serviceName}':`, err);
        }
      });

      service.on('state:full-update', ({ data }) => {
        try {
          this.log(`Received state:full-update from '${serviceName}', forwarding.`);
          this.setFullState(data);
        } catch (err) {
          this.logError(`Error applying full state update from '${serviceName}':`, err);
        }
      });

      service.on('tide:update', (data) => {
        try {
          this.log(`Received tide:update from '${serviceName}', forwarding.`);
          this.setTideData(data);
        } catch (err) {
          this.logError(`Error applying tide update from '${serviceName}':`, err);
        }
      });

      service.on('weather:update', (data) => {
        try {
          this.log(`Received weather:update from '${serviceName}', forwarding.`);
          this.setWeatherData(data);
        } catch (err) {
          this.logError(`Error applying weather update from '${serviceName}':`, err);
        }
      });
    } else {
      this.logError('listenToService called with an invalid service object.');
    }
  }

  /**
   * Apply a JSON patch (RFC 6902) to the managed state and emit to clients.
   * Emits 'state:patch' with the patch array.
   * Triggers rule evaluation after patch is applied.
   * @param {Array} patch - JSON patch array
   */
  applyPatchAndForward(patch) {
    if (!Array.isArray(patch) || patch.length === 0) return;

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

      if (validPatch.length === 0) return;

      const stateBeforePatch = this._safeClone(this.appState);

      // Apply to both our local state and the canonical state
      // Use mutateDocument=true so patch persists in this.appState
      applyPatch(this.appState, validPatch, true, true);
      applyPatch(currentState, validPatch, true, true);

      // this.log(
      //   "[StateManager] this.appState.navigation AFTER applyPatch:",
      //   JSON.stringify(this.appState.navigation, null, 2)
      // );

      // Convert patch to a change object and notify the rule engine
      const changes = this._convertPatchToStateChanges(
        validPatch,
        stateBeforePatch
      );
      this.ruleEngine.updateState(changes);

      // Always emit patch events for direct server
      this.emit("state:patch", {
        type: "state:patch",
        data: validPatch,
        boatId: this._boatId,
        timestamp: Date.now(),
      });


      if (RECORD_DATA) {
        recordPatch(validPatch);
      }
    } catch (error) {
      this.logError("Patch error:", error);
      this.emit("error:patch-error", { error, patch });
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

  /**
   * Emit the full state to clients.
   * Emits 'state:full-update' with the full appState object.
   */
  shouldEmitFullState() {
    return !this._hasSentInitialFullState;
  }

  emitFullState() {
    if (!this.shouldEmitFullState()) return;
    this._hasSentInitialFullState = true;
    // Always emit full state updates regardless of client count
    const timestamp = new Date().toISOString();

    // this.log('[StateManager][emitFullState] called. Anchor state:',
    //   JSON.stringify(this.appState?.anchor, null, 2)
    // );

    const payload = {
      type: "state:full-update",
      data: this.appState,
      boatId: this._boatId,
      role: "boat-server",
      timestamp: Date.now(),
    };

    this.emit("state:full-update", payload);

    if (RECORD_DATA) {
      recordFullState(this.appState);
    }
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
    if (!tideData) return;
    this.tideData = tideData;
    this.appState.tides = tideData;
    this.emit("tide:update", tideData);
    this.ruleEngine.updateState({ tides: tideData });
    this.emitFullState(); // Broadcast the change to all clients
  }

  setFullState(data) {
    if (!data) return;
    this.appState = this._safeClone(data);
    this.emit('state:full-update', { 
      type: 'state:full-update',
      data: this.appState,
      boatId: this._boatId,
      role: 'boat-server',
      timestamp: Date.now(),
    });
    this.ruleEngine.updateState(this.appState);
  }

  setWeatherData(weatherData) {
    if (!weatherData) return;
    this.weatherData = weatherData;
    this.appState.forecast = weatherData;
    this.emit("weather:update", weatherData);
    this.ruleEngine.updateState({ forecast: weatherData });
    this.emitFullState(); // Broadcast the change to all clients
  }

  /**
   * Receive external state update (e.g. from StateService) while preserving anchor state
   * @param {Object} newStateData - The new state data from an external source
   */
  receiveExternalStateUpdate(newStateData) {
    this.log('[receiveExternalStateUpdate] called. Stack:', new Error().stack);
    if (!newStateData) {
      this.log("[WARN] Received empty state data from external source");
      return;
    }

    // Save the current anchor state before replacing
    const currentAnchorState = this.appState.anchor;
    this.log('[receiveExternalStateUpdate] anchor before:', JSON.stringify(currentAnchorState, null, 2));

    // Update the state with the new state
    this.appState = this._safeClone(newStateData);

    // Restore the anchor state if it exists
    if (currentAnchorState) {
      this.appState.anchor = currentAnchorState;
      this.log('[receiveExternalStateUpdate] anchor restored:', JSON.stringify(this.appState.anchor, null, 2));
    } else {
      this.log('[receiveExternalStateUpdate] no anchor to restore.');
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
    this.log('[StateManager][updateAnchorState] called. Stack:', new Error().stack);
    if (!anchorData) {
      this.log("[StateManager] Received empty anchor data");
      return;
    }


    if (anchorData.anchorLocation && anchorData.anchorLocation.position) {
      const pos = anchorData.anchorLocation.position;
      this.log(
        `[StateManager] Anchor position: ${pos.latitude}, ${pos.longitude}`
      );
    }

    if (anchorData.rode) {
      this.log(
        `[StateManager] Rode length: ${anchorData.rode.value} ${anchorData.rode.unit}`
      );
    }

    if (
      anchorData.anchorDropLocation &&
      anchorData.anchorDropLocation.position
    ) {
      const pos = anchorData.anchorDropLocation.position;
      this.log(
        `[StateManager] Drop position: ${pos.latitude}, ${pos.longitude}`
      );
    }



    try {
      // Create a patch to update the anchor state
      const patch = [{ op: "replace", path: "/anchor", value: anchorData }];

      // Apply the patch using our existing method
      this.applyPatchAndForward(patch);
      this.log('[StateManager][updateAnchorState] anchor after update:', JSON.stringify(this.appState?.anchor, null, 2));
      this.log("[StateManager] Anchor state updated successfully");

      return true;
    } catch (error) {
      this.logError("Error updating anchor state:", error);
      this.emit("error:anchor-update", { error, anchorData });
      return false;
    }
  }

  /**
   * Merge a domain update (e.g., from StateData/SignalK) into the unified appState.
   * Emits 'state-updated' after merging.
   * @param {Object} update - Partial state update (e.g., { signalK: ... })
   */

  applyDomainUpdate(update) {
    if (!update || typeof update !== "object") {
      this.log("[StateManager] Invalid update received:", update);
      return;
    }

    // Debug logging
    this.log(
      "[StateManager] Applying domain update:",
      JSON.stringify(update)
    );

    // Apply updates directly to our state
    try {
      // Apply each update in the batch
      Object.entries(update).forEach(([path, value]) => {
        const pathParts = path.split('.');
        let current = this.appState;
        
        // Navigate to the parent of the target property
        for (let i = 0; i < pathParts.length - 1; i++) {
          const part = pathParts[i];
          if (!current[part]) {
            current[part] = {};
          }
          current = current[part];
        }
        
        // Set the final property
        current[pathParts[pathParts.length - 1]] = value;
      });
      
      // Clone to ensure immutability
      this.appState = this._safeClone(this.appState);
    } catch (error) {
      this.logError("Failed to apply batch update:", error);
      return;
    }

    // Debug logging
    // this.log(
    //   "[StateManager] State after update:",
    //   JSON.stringify({
    //     anchor: this.appState.anchor, // Just log anchor instead of full state
    //     updateSize: Object.keys(update).length,
    //   })
    // );

    if (!this.appState.anchor) {
      this.log("[StateManager] Anchor missing after update!");
    }

    // Pass the update to the rule engine for evaluation
    this.ruleEngine.updateState(update);

    // Always emit state updates regardless of client count
    this.emit("state:full-update", {
      type: "state:full-update",
      data: this.appState,
      boatId: this._boatId,
      role: "boat-server",
      timestamp: Date.now(),
    });
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
        break;
      case "RESOLVE_ALERT":
        this.alertService.resolveAlertsByTrigger(action.trigger, action.data);
        break;
    }
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
      this.log('Storage service initialized');
      
      // Start cleanup job after storage is initialized
      this._startCleanupJob().catch(this.logError);
      return true;
    } catch (error) {
      this.logError('Failed to initialize storage:', error);
      this.updateBluetoothStatus({
        state: 'error',
        error: `Storage initialization failed: ${error.message}`
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
      // Load selected device IDs from storage
      const selectedIds = await storageService.getSetting('bluetooth:selectedDevices', []);
      this.appState.bluetooth = this.appState.bluetooth || {};
      
      // Initialize devices object if it doesn't exist
      if (!this.appState.bluetooth.devices) {
        this.appState.bluetooth.devices = {};
      }
      
      // Create a new object to store selected devices with full device objects
      const selectedDevicesObj = {};
      
      // For each selected ID, try to get the full device object
      for (const deviceId of selectedIds) {
        // Check if we have the device in memory first
        if (this.appState.bluetooth.devices[deviceId]) {
          // Use the device from memory
          selectedDevicesObj[deviceId] = this.appState.bluetooth.devices[deviceId];
        } else {
          // Try to get the device from storage
          try {
            const device = await storageService.getDevice(deviceId);
            if (device) {
              selectedDevicesObj[deviceId] = device;
              // Also add it to devices for consistency
              this.appState.bluetooth.devices[deviceId] = device;
            }
          } catch (deviceError) {
            this.log(`Failed to load device ${deviceId} from storage:`, deviceError);
            // Create a minimal placeholder device object
            selectedDevicesObj[deviceId] = { id: deviceId, isSelected: true };
          }
        }
      }
      
      // Update the state with the new object structure
      this.appState.bluetooth.selectedDevices = selectedDevicesObj;
      
      // Log the change for debugging
      this.log(`[StateManager] Loaded ${Object.keys(selectedDevicesObj).length} selected devices as objects`);
      
      // Emit initial state with the new object structure
      this.emit('state:patch', {
        type: 'state:patch',
        data: [{
          op: 'replace',
          path: '/bluetooth/selectedDevices',
          value: selectedDevicesObj
        }],
        boatId: this._boatId,
        timestamp: Date.now()
      });
    } catch (error) {
      this.logError('Failed to load selected devices:', error);
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
      const allDevices = await storageService.getAllDevices({ forceRefresh: true });
      
      for (const device of allDevices) {
        try {
          const lastSeen = new Date(device.lastSeen || 0).getTime();
          if ((now - lastSeen) <= STALE_TIMEOUT) continue;

          // Remove from selected devices if present
          if (this.appState.bluetooth.selectedDevices && this.appState.bluetooth.selectedDevices[device.id]) {
            await this.setBluetoothDeviceSelected(device.id, false);
          }
          
          // Remove from in-memory state
          if (this.appState.bluetooth.devices?.[device.id]) {
            delete this.appState.bluetooth.devices[device.id];
            
            // Emit patch for device removal
            this.emit('state:patch', {
              type: 'state:patch',
              data: [{
                op: 'remove',
                path: `/bluetooth/devices/${device.id}`
              }],
              boatId: this._boatId,
              timestamp: now
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
      this.logError('Error during stale device cleanup:', error);
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
      lastUpdated: now
    };
    
    const enabled = status.state === 'enabled';
    
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
        op: 'replace',
        path: '/bluetooth/status',
        value: newStatus
      },
      {
        op: 'replace',
        path: '/bluetooth/enabled',
        value: enabled
      },
      {
        op: 'replace',
        path: '/bluetooth/lastUpdated',
        value: now
      }
    ];
    
    // this.log(`[BLUETOOTH-DEBUG] Emitting Bluetooth state patch:`, JSON.stringify(patchData, null, 2));
    
    // Emit targeted patch
    this.emit('state:patch', {
      type: 'state:patch',
      data: patchData,
      boatId: this._boatId,
      timestamp: Date.now()
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
      const currentSelectedDevices = this.appState.bluetooth.selectedDevices || {};
      const isCurrentlySelected = !!currentSelectedDevices[deviceId];
      
      if (selected === isCurrentlySelected) {
        return true; // No change needed
      }
      
      // Create a new selectedDevices object (for immutability)
      const newSelectedDevices = { ...currentSelectedDevices };
      
      if (selected) {
        // Get the full device object from memory or storage
        let deviceObj;
        
        if (this.appState.bluetooth.devices && this.appState.bluetooth.devices[deviceId]) {
          // Use device from memory
          deviceObj = this._safeClone(this.appState.bluetooth.devices[deviceId]);
        } else {
          // Try to get from storage
          try {
            deviceObj = await storageService.getDevice(deviceId);
          } catch (storageError) {
            this.log(`Failed to get device ${deviceId} from storage:`, storageError);
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
        if (this.appState.bluetooth.devices && this.appState.bluetooth.devices[deviceId]) {
          this.appState.bluetooth.devices[deviceId].isSelected = false;
        }
      }
      
      // Update in-memory state with the new object
      this.appState.bluetooth.selectedDevices = newSelectedDevices;
      
      // For storage, we only store the array of IDs (for backward compatibility)
      const selectedIdsForStorage = Object.keys(newSelectedDevices);
      
      // Update storage
      try {
        await storageService.setSetting(
          'bluetooth:selectedDevices', 
          selectedIdsForStorage
        );
        
        // Update device in storage
        if (this.appState.bluetooth.devices && this.appState.bluetooth.devices[deviceId]) {
          const device = this.appState.bluetooth.devices[deviceId];
          await storageService.upsertDevice(device);
        }
        
        // Emit patch with the full device objects
        this.emit('state:patch', {
          type: 'state:patch',
          data: [{
            op: 'replace',
            path: '/bluetooth/selectedDevices',
            value: newSelectedDevices
          }],
          boatId: this._boatId,
          timestamp: Date.now()
        });
        
        return true;
      } catch (error) {
        this.logError('Failed to update device selection:', error);
        this.updateBluetoothStatus({
          state: 'error',
          error: `Device selection update failed: ${error.message}`
        });
        return false;
      }
    } catch (deviceError) {
      this.logError('Error updating device selection:', deviceError);
      return false;
    }
  }

/**
 * Update a Bluetooth device in the state with debouncing
 * @param {Object} device - The device to update
 * @param {string} updateType - Type of update ('discovery' or 'update')
 * @returns {void}
 */
updateBluetoothDevice(device, updateType = 'update') {
  // this.log(`[DEBUG-STATE] Device update received: ${JSON.stringify(device, null, 2)}`);

  if (!device || !device.id) {
    this.log('[StateManager] Cannot update device: Invalid device object');
    return;
  }

  // Initialize bluetooth state if it doesn't exist
  if (!this.appState.bluetooth) {
    this.appState.bluetooth = {
      lastUpdated: new Date().toISOString()
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
  
  // Update the device's lastSeen timestamp
  const updatedDevice = {
    ...device,
    lastSeen: now,
    // Preserve existing device properties if this is an update
    ...(this.appState.bluetooth.devices[device.id] || {})
  };

  // Add or update the device in the queue
  // this.log(`[DEBUG-STATE] Adding device ${device.id} to update queue`);
  this._bluetoothDeviceQueue.set(device.id, updatedDevice);

  // Log the current queue size
  // this.log(`[DEBUG-STATE] Current queue size: ${this._bluetoothDeviceQueue.size} devices`);

  // Determine the debounce delay based on update type
  const delay = this._bluetoothDebounceDelays[updateType] || this._bluetoothDebounceDelays.update;
  // this.log(`[DEBUG-STATE] Using debounce delay of ${delay}ms for update type ${updateType}`);
  
  // Clear any existing timeout for this update type
  if (this._bluetoothUpdateTimeouts && this._bluetoothUpdateTimeouts[updateType]) {
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
    
    this.log(`[StateManager] Committing ${this._bluetoothDeviceQueue.size} Bluetooth device updates`);
    
    // Clear any existing timeout for this update type
    if (this._bluetoothUpdateTimeouts && this._bluetoothUpdateTimeouts[updateType]) {
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
      
      // Create a patch for this device
      patches.push({
        op: 'replace',
        path: `/bluetooth/devices/${device.id}`,
        value: device
      });
      // this.log(`[DEBUG-STATE] Created patch for device ${device.id}`);
    });
    
    // Add lastUpdated patch
    patches.push({
      op: 'replace',
      path: '/bluetooth/lastUpdated',
      value: now
    });
    
    // Update the lastUpdated timestamp in the state
    this.appState.bluetooth.lastUpdated = now;
    
    // Add lastUpdated patch
    patches.push({
      op: 'replace',
      path: '/bluetooth/lastUpdated',
      value: now
    });
    
    // Update the lastUpdated timestamp in the state
    this.appState.bluetooth.lastUpdated = now;
    
    // Clear the device queue after processing
    // this.log(`[DEBUG-STATE] Clearing device queue after processing`);
    const queueSize = this._bluetoothDeviceQueue.size;
    this._bluetoothDeviceQueue.clear();
    
    // Emit the patches
    // Check if we have any listeners for the state:patch event
    const patchListeners = this.listeners('state:patch').length;
    
    const patchPayload = {
      type: 'state:patch',
      data: patches,
      boatId: this._boatId,
      timestamp: Date.now(),
      updateType: updateType
    };
    
    this.emit("state:patch", patchPayload);
    
    // Clear the queue
    this._bluetoothDeviceQueue.clear();
  }

 
  /**
   * Update sensor data for a specific Bluetooth device
   * @param {string} deviceId - The ID of the device
   * @param {Object} sensorData - The parsed sensor data
   * @returns {boolean} - True if the update was successful
   */
  updateBluetoothDeviceSensorData(deviceId, sensorData) {
    if (!deviceId || !sensorData) {
      this.log('[StateManager] Cannot update device sensor data: Invalid parameters');
      return false;
    }

    
    // Initialize Bluetooth state if it doesn't exist
    if (!this.appState.bluetooth) {
      this.appState.bluetooth = {
        devices: {},
        selectedDevices: {},
        status: {},
        lastUpdated: new Date().toISOString()
      };
      this.log(`[StateManager] Initialized Bluetooth state`);
    }

    // Initialize devices object if it doesn't exist
    if (!this.appState.bluetooth.devices) {
      this.appState.bluetooth.devices = {};
      this.log(`[StateManager] Initialized Bluetooth devices object`);
    }

    // Get the current device or create a new one
    const existingDevice = this.appState.bluetooth.devices[deviceId] || {};
    const isNewDevice = Object.keys(existingDevice).length === 0;
    this.log(`[StateManager] ${isNewDevice ? 'Creating new' : 'Updating existing'} device ${deviceId}`);
    
    // Log sensor data preview
    const dataPreview = {};
    if (sensorData.temperature) dataPreview.temperature = sensorData.temperature.value;
    if (sensorData.humidity) dataPreview.humidity = sensorData.humidity.value;
    if (sensorData.pressure) dataPreview.pressure = sensorData.pressure.value;
    if (sensorData.battery) dataPreview.battery = sensorData.battery.voltage?.value;
    this.log(`[StateManager] Sensor data for device ${deviceId}: ${JSON.stringify(dataPreview)}`);
    
    // Update the device with new sensor data
    const updatedDevice = {
      ...existingDevice,
      id: deviceId,
      lastSeen: new Date().toISOString(),
      sensorData: sensorData,  // Store the sensor data separately
      lastSensorUpdate: new Date().toISOString()
    };

    // Update the device in the state
    this.appState.bluetooth.devices[deviceId] = updatedDevice;
    this.appState.bluetooth.lastUpdated = new Date().toISOString();

    // Create a patch for this specific update
    const patch = [
      {
        op: 'replace',
        path: `/bluetooth/devices/${deviceId}`,
        value: updatedDevice
      },
      {
        op: 'replace',
        path: '/bluetooth/lastUpdated',
        value: this.appState.bluetooth.lastUpdated
      }
    ];

    // Emit the state patch
    this.emit('state:patch', {
      type: 'state:patch',
      data: patch,
      boatId: this._boatId,
      timestamp: Date.now(),
      updateType: 'sensor'
    });
    
    // Log state update completion
    this.log(`[StateManager] Updated state with sensor data for device ${deviceId}`);
    this.log(`[StateManager] Current state now has ${Object.keys(this.appState.bluetooth.devices).length} Bluetooth devices`);
    
    // Log device details in state
    const deviceInState = this.appState.bluetooth.devices[deviceId];
    this.log(`[StateManager] Device ${deviceId} in state:`, {
      name: deviceInState.name || 'Unknown',
      lastSeen: deviceInState.lastSeen,
      lastSensorUpdate: deviceInState.lastSensorUpdate,
      hasSensorData: !!deviceInState.sensorData
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
      this.log('[StateManager] Cannot update device metadata: Invalid parameters');
      return false;
    }

    this.log(`Updating metadata for device ${deviceId}: %o`, metadata);
    
    try {
      // Initialize the device if it doesn't exist
      if (!this.appState.bluetooth.devices) {
        this.appState.bluetooth.devices = {};
      }
      
      const existingDevice = this.appState.bluetooth.devices[deviceId] || {};
      
      // Update the device with new metadata
      const updatedDevice = {
        ...existingDevice,
        id: deviceId,
        ...metadata,
        lastUpdated: new Date().toISOString()
      };

      // Update the device in the state
      this.appState.bluetooth.devices[deviceId] = updatedDevice;
      this.appState.bluetooth.lastUpdated = new Date().toISOString();

      // Create a patch for this specific update
      const patch = [
        {
          op: 'replace',
          path: `/bluetooth/devices/${deviceId}`,
          value: updatedDevice
        },
        {
          op: 'replace',
          path: '/bluetooth/lastUpdated',
          value: this.appState.bluetooth.lastUpdated
        }
      ];

      // Emit the state patch
      this.emit('state:patch', {
        type: 'state:patch',
        data: patch,
        boatId: this._boatId,
        timestamp: Date.now(),
        updateType: 'metadata'
      });
      
      // Update device in storage if it exists
      try {
        if (this._storageInitialized) {
          const device = await storageService.getDevice(deviceId);
          if (device) {
            await storageService.upsertDevice({ ...device, ...metadata });
            this.log(`Updated device ${deviceId} metadata in storage`);
          }
        }
      } catch (storageError) {
        this.logError(`Failed to update device metadata in storage: ${storageError.message}`);
      }
      
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
    if (typeof isScanning !== 'boolean') {
      this.log('[StateManager] Invalid scanning status parameter, must be boolean');
      return false;
    }
    
    if (!this.appState.bluetooth) this.appState.bluetooth = {};
    
    const now = new Date().toISOString();
    
    this.appState.bluetooth.scanning = isScanning;
    this.appState.bluetooth.lastUpdated = now;
    
    const patchData = [
      { op: 'replace', path: '/bluetooth/scanning', value: isScanning },
      { op: 'replace', path: '/bluetooth/lastUpdated', value: now }
    ];
    
    this.emit('state:patch', {
      type: 'state:patch',
      data: patchData,
      boatId: this._boatId,
      timestamp: Date.now()
    });
    
    return true;
  }

  /**
   * Toggle Bluetooth enabled state
   * @param {boolean} enabled - Whether Bluetooth should be enabled
   * @returns {boolean} - True if the update was successful
   */
  toggleBluetooth(enabled) {
    if (typeof enabled !== 'boolean') {
      this.log('[StateManager] Invalid Bluetooth toggle parameter, must be boolean');
      return false;
    }
    
    this.log(`Toggling Bluetooth to: ${enabled ? 'enabled' : 'disabled'}`);
    
    this.updateBluetoothStatus({ state: enabled ? 'enabled' : 'disabled', error: null });
    
    return true;
  }
}

export const stateManager = new StateManager();
