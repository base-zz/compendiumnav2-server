import { EventEmitter } from "events";
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

export class StateManager2 extends EventEmitter {
  getState() {
    // console.log('[StateManager2][getState] called. Current anchor state:',
    //   JSON.stringify(this.appState?.anchor, null, 2)
    // );
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

    // console.log(
    //   "[StateManager2_CONSTRUCTOR_ENTRY_LOG] initialState: ",
    //   JSON.stringify(initialState, null, 2)
    // );

    super();
    
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
      console.error('Failed to initialize storage:', error);
    });

    // Initialize the new rule engine, which is event-driven
    this.ruleEngine = new RuleEngine2();
    const allRules = getRules(); // Get all rules from the new set

    console.log(
      `[StateManager2] Retrieved ${allRules.length} rules from getRules().`
    );
    allRules.forEach((rule) => {
      console.log(
        `[StateManager2] Attempting to add rule: ${rule.name || "Unnamed Rule"}`
      );
      this.ruleEngine.addRule(rule);
    });
    console.log(`[StateManager2] Finished adding rules.`);

    // Listen for rule triggers and process their actions
    this.ruleEngine.on("rule-triggered", ({ rule, actionResult }) => {
      if (actionResult) {
        console.log(
          `[StateManager2] Rule triggered: ${rule.name}, Action:`,
          JSON.stringify(actionResult)
        );
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
      console.log(
        `[StateManager2] Client connected: ${clientId} (${
          platform || "unknown platform"
        })`
      );
      console.log(`[StateManager2] Total clients: ${this._clientCount}`);
    });

    this.on("client:disconnected", (clientId) => {
      this._clientCount = Math.max(0, this._clientCount - 1);
      console.log(`[StateManager2] Client disconnected: ${clientId}`);
      console.log(`[StateManager2] Remaining clients: ${this._clientCount}`);
      this.connectedClients.delete(clientId);
    });

    // Log when an identity message is processed
    this.on("identity:received", (identity) => {
      console.log(
        "[StateManager2] Identity message received:",
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

      // console.log(
      //   "[StateManager2] this.appState.navigation AFTER applyPatch:",
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

      // const payload = {
      //   type: "state:patch",
      //   data: validPatch,
      //   boatId: this._boatId,
      //   timestamp: Date.now(),
      // };
      // console.log(
      //   "[StateManager2] PAYLOAD AFTER emit patch:",
      //   JSON.stringify(payload, null, 2)
      // );

      if (RECORD_DATA) {
        recordPatch(validPatch);
      }
    } catch (error) {
      console.error("[StateManager2] Patch error:", error);
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

    // console.log('[StateManager2][emitFullState] called. Anchor state:',
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

      console.log(
        `[StateManager2] Client count updated: ${previousCount} -> ${count}`
      );

      // If we just got clients after having none, send a full state update
      if (previousCount === 0 && count > 0) {
        console.log(
          "[StateManager2] First client connected, sending full state update."
        );
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
      console.log(
        `[StateManager2] Client count explicitly set to: ${this._clientCount}`
      );
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
    console.log('[StateManager2][receiveExternalStateUpdate] called. Stack:', new Error().stack);
    if (!newStateData) {
      console.warn(
        "[StateManager2] Received empty state data from external source"
      );
      return;
    }

    // Save the current anchor state before replacing
    const currentAnchorState = this.appState.anchor;
    console.log('[StateManager2][receiveExternalStateUpdate] anchor before:', JSON.stringify(currentAnchorState, null, 2));

    // Update the state with the new state
    this.appState = this._safeClone(newStateData);

    // Restore the anchor state if it exists
    if (currentAnchorState) {
      this.appState.anchor = currentAnchorState;
      console.log('[StateManager2][receiveExternalStateUpdate] anchor restored:', JSON.stringify(this.appState.anchor, null, 2));
    } else {
      console.log('[StateManager2][receiveExternalStateUpdate] no anchor to restore.');
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
    console.log('[StateManager2][updateAnchorState] called. Stack:', new Error().stack);
    if (!anchorData) {
      console.warn("[StateManager2] Received empty anchor data");
      return;
    }


    if (anchorData.anchorLocation && anchorData.anchorLocation.position) {
      const pos = anchorData.anchorLocation.position;
      console.log(
        `[StateManager2] Anchor position: ${pos.latitude}, ${pos.longitude}`
      );
    }

    if (anchorData.rode) {
      console.log(
        `[StateManager2] Rode length: ${anchorData.rode.value} ${anchorData.rode.unit}`
      );
    }

    if (
      anchorData.anchorDropLocation &&
      anchorData.anchorDropLocation.position
    ) {
      const pos = anchorData.anchorDropLocation.position;
      console.log(
        `[StateManager2] Drop position: ${pos.latitude}, ${pos.longitude}`
      );
    }



    try {
      // Create a patch to update the anchor state
      const patch = [{ op: "replace", path: "/anchor", value: anchorData }];

      // Apply the patch using our existing method
      this.applyPatchAndForward(patch);
      console.log('[StateManager2][updateAnchorState] anchor after update:', JSON.stringify(this.appState?.anchor, null, 2));
      console.log("[StateManager2] Anchor state updated successfully");

      return true;
    } catch (error) {
      console.error("[StateManager2] Error updating anchor state:", error);
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
      console.warn("[StateManager2] Invalid update received:", update);
      return;
    }

    // Debug logging
    console.log(
      "[StateManager2] Applying domain update:",
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
      console.error("[StateManager2] Failed to apply batch update:", error);
      return;
    }

    // Debug logging
    // console.log(
    //   "[StateManager2] State after update:",
    //   JSON.stringify({
    //     anchor: this.appState.anchor, // Just log anchor instead of full state
    //     updateSize: Object.keys(update).length,
    //   })
    // );

    if (!this.appState.anchor) {
      console.warn("[StateManager2] Anchor missing after update!");
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
      console.log('Storage service initialized');
      
      // Start cleanup job after storage is initialized
      this._startCleanupJob().catch(console.error);
      return true;
    } catch (error) {
      console.error('Failed to initialize storage:', error);
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
      const selected = await storageService.getSetting('bluetooth:selectedDevices', []);
      this.appState.bluetooth = this.appState.bluetooth || {};
      this.appState.bluetooth.selectedDevices = selected;
      
      // Emit initial state
      this.emit('state:patch', {
        type: 'state:patch',
        data: [{
          op: 'replace',
          path: '/bluetooth/selectedDevices',
          value: [...selected]
        }],
        boatId: this._boatId,
        timestamp: Date.now()
      });
    } catch (error) {
      console.error('Failed to load selected devices:', error);
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
          if (this.appState.bluetooth.selectedDevices?.includes(device.id)) {
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
          console.error(`Error cleaning up device ${device.id}:`, deviceError);
        }
      }

      if (cleanedCount > 0) {
        console.log(`Cleaned up ${cleanedCount} stale devices`);
      }
    } catch (error) {
      console.error('Error during stale device cleanup:', error);
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
    
    // Update in-memory state
    this.appState.bluetooth.status = newStatus;
    this.appState.bluetooth.enabled = enabled;
    this.appState.bluetooth.lastUpdated = now;
    
    // Emit targeted patch
    this.emit('state:patch', {
      type: 'state:patch',
      data: [
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
      ],
      boatId: this._boatId,
      timestamp: Date.now()
    });
  }



  /**
   * Set a device's selected state
   * @param {string} deviceId - The ID of the device
   * @param {boolean} selected - Whether the device should be selected
   * @returns {Promise<boolean>} True if the operation was successful
   */
  async setBluetoothDeviceSelected(deviceId, selected) {
    if (!this._storageInitialized) {
      await this._initializeStorage();
    }

    try {
      const currentSelection = this.appState.bluetooth?.selectedDevices || [];
      const isSelected = currentSelection.includes(deviceId);
        
      if (selected === isSelected) {
        return true; // No change needed
      }

      // Update in-memory state
      this.appState.bluetooth = this.appState.bluetooth || {};
      if (selected) {
        this.appState.bluetooth.selectedDevices = [...currentSelection, deviceId];
      } else {
        this.appState.bluetooth.selectedDevices = currentSelection.filter(id => id !== deviceId);
      }

      // Update storage
      try {
        await storageService.setSetting(
          'bluetooth:selectedDevices', 
          [...this.appState.bluetooth.selectedDevices]
        );

        // Update device in storage
        try {
          const device = await storageService.getDevice(deviceId);
          if (device) {
            device.isSelected = selected;
            await storageService.upsertDevice(device);
          }
        } catch (deviceError) {
          console.error('Failed to update device selection in storage:', deviceError);
          // Continue even if device update fails
        }

        // Emit patch
        this.emit('state:patch', {
          type: 'state:patch',
          data: [{
            op: 'replace',
            path: '/bluetooth/selectedDevices',
            value: [...this.appState.bluetooth.selectedDevices]
          }],
          boatId: this._boatId,
          timestamp: Date.now()
        });

        return true;
      } catch (error) {
        console.error('Failed to update device selection:', error);
        this.updateBluetoothStatus({
          state: 'error',
          error: `Device selection update failed: ${error.message}`
        });
        return false;
      }
    } catch (deviceError) {
      console.error('Error cleaning up device:', deviceError);
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
    if (!device || !device.id) {
      console.warn('[StateManager2] Cannot update device: Invalid device object');
      return;
    }

    // Initialize Bluetooth state if it doesn't exist
    if (!this.appState.bluetooth) {
      this.appState.bluetooth = {
        devices: {},
        selectedDevices: [],
        status: {},
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
    this._bluetoothDeviceQueue.set(device.id, updatedDevice);

    // Determine the debounce delay based on update type
    const delay = this._bluetoothDebounceDelays[updateType] || this._bluetoothDebounceDelays.update;
    
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
    if (!this._bluetoothDeviceQueue || this._bluetoothDeviceQueue.size === 0) return;
    
    // Clear any existing timeout for this update type
    if (this._bluetoothUpdateTimeouts && this._bluetoothUpdateTimeouts[updateType]) {
      clearTimeout(this._bluetoothUpdateTimeouts[updateType]);
      this._bluetoothUpdateTimeouts[updateType] = null;
    }
    
    // Convert queued devices to patch operations
    const updates = Array.from(this._bluetoothDeviceQueue.entries()).map(([id, device]) => ({
      op: 'replace',
      path: `/bluetooth/devices/${id}`,
      value: device
    }));
    
    // Clear the queue
    this._bluetoothDeviceQueue.clear();
    
    // Update the last updated timestamp
    const now = new Date().toISOString();
    updates.push({
      op: 'replace',
      path: '/bluetooth/lastUpdated',
      value: now
    });
    
    // Apply updates to the state
    updates.forEach(update => {
      if (update.op === 'replace' && update.path.startsWith('/bluetooth/devices/')) {
        const deviceId = update.path.split('/').pop();
        if (!this.appState.bluetooth.devices) {
          this.appState.bluetooth.devices = {};
        }
        this.appState.bluetooth.devices[deviceId] = update.value;
      }
    });
    
    this.appState.bluetooth.lastUpdated = now;
    
    // Emit the state patch
    this.emit('state:patch', {
      type: 'state:patch',
      data: updates,
      boatId: this._boatId,
      timestamp: Date.now(),
      updateType
    });
  }

  /**
   * Update sensor data for a specific Bluetooth device
   * @param {string} deviceId - The ID of the device
   * @param {Object} sensorData - The parsed sensor data
   * @returns {boolean} - True if the update was successful
   */
  updateBluetoothDeviceSensorData(deviceId, sensorData) {
    if (!deviceId || !sensorData) {
      console.warn('[StateManager2] Cannot update device sensor data: Invalid parameters');
      return false;
    }

    console.log(`[StateManager2] Updating sensor data for device ${deviceId}`);
    
    // Initialize Bluetooth state if it doesn't exist
    if (!this.appState.bluetooth) {
      this.appState.bluetooth = {
        devices: {},
        selectedDevices: [],
        status: {},
        lastUpdated: new Date().toISOString()
      };
      console.log(`[StateManager2] Initialized Bluetooth state`);
    }

    // Initialize devices object if it doesn't exist
    if (!this.appState.bluetooth.devices) {
      this.appState.bluetooth.devices = {};
      console.log(`[StateManager2] Initialized Bluetooth devices object`);
    }

    // Get the current device or create a new one
    const existingDevice = this.appState.bluetooth.devices[deviceId] || {};
    const isNewDevice = Object.keys(existingDevice).length === 0;
    console.log(`[StateManager2] ${isNewDevice ? 'Creating new' : 'Updating existing'} device ${deviceId}`);
    
    // Log sensor data preview
    const dataPreview = {};
    if (sensorData.temperature) dataPreview.temperature = sensorData.temperature.value;
    if (sensorData.humidity) dataPreview.humidity = sensorData.humidity.value;
    if (sensorData.pressure) dataPreview.pressure = sensorData.pressure.value;
    if (sensorData.battery) dataPreview.battery = sensorData.battery.voltage?.value;
    console.log(`[StateManager2] Sensor data for device ${deviceId}: ${JSON.stringify(dataPreview)}`);
    
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
    console.log(`[StateManager2] Updated state with sensor data for device ${deviceId}`);
    console.log(`[StateManager2] Current state now has ${Object.keys(this.appState.bluetooth.devices).length} Bluetooth devices`);
    
    // Log device details in state
    const deviceInState = this.appState.bluetooth.devices[deviceId];
    console.log(`[StateManager2] Device ${deviceId} in state:`, {
      name: deviceInState.name || 'Unknown',
      lastSeen: deviceInState.lastSeen,
      lastSensorUpdate: deviceInState.lastSensorUpdate,
      hasSensorData: !!deviceInState.sensorData
    });
    
    // Log the complete device object structure for verification
    console.log(`[StateManager2] Complete device object in state:`);
    console.dir(deviceInState, { depth: null, colors: true });

    return true;
  }
}

export const stateManager2 = new StateManager2();
