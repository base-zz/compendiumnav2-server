import { EventEmitter } from "events";
import { createStateDataModel } from "../../../shared/stateDataModel.js";
import { RuleEngine } from "./ruleEngine.js";
import { AllRules } from "./allRules.js";
import { AlertService } from "../services/AlertService.js";
import { getOrCreateAppUuid } from "../../../server/uniqueAppId.js";
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

  constructor() {
    super();
    // Initialize with stateData's state which already has all structures
    this.appState = structuredClone(stateData.state);

    // Initialize a single rule engine for all rules
    this.ruleEngine = new RuleEngine(AllRules); // For all rules (navigation, alerts, etc.)

    // Initialize the alert service
    this.alertService = new AlertService(this);

    this.currentProfile = this._createDefaultProfile();
    this._boatId = getOrCreateAppUuid();
    this._clientCount = 0;
    this.tideData = null;
    this.weatherData = null;
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
      const currentState = stateData.state;

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

      // Apply to both our local state and the canonical state
      applyPatch(this.appState, validPatch, true, false);
      applyPatch(currentState, validPatch, true, false);

      this.updateState(this.appState);

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
      console.error("[StateManager] Patch error:", error);
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
  emitFullState() {
    // Always emit full state updates regardless of client count
    const timestamp = new Date().toISOString();


    const payload = {
      type: "state:full-update",
      data: this.appState,
      boatId: this._boatId,
      role: "boat-server",
      timestamp: Date.now(),
    };

    this.emit("state:full-update", payload);

    // console.log(
    //   "[StateManager] Emitting full state update:",
    //   JSON.stringify(payload, null, 2)
    // );

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
   * Receive external state update (e.g. from StateService) while preserving anchor state
   * @param {Object} newStateData - The new state data from an external source
   */
  receiveExternalStateUpdate(newStateData) {
    if (!newStateData) {
      console.warn(
        "[StateManager] Received empty state data from external source"
      );
      return;
    }

    // Save the current anchor state before replacing
    const currentAnchorState = this.appState.anchor;

    // Update the state with the new state
    this.appState = structuredClone(newStateData);

    // Restore the anchor state if it exists
    if (currentAnchorState) {
      this.appState.anchor = currentAnchorState;
    }

    // Emit the updated state to clients
    this.emitFullState();
  }

  /**
   * Update anchor state with data from a client
   * This ensures the StateManager is the single source of truth for state changes
   * @param {Object} anchorData - The anchor data from the client
   */
  updateAnchorState(anchorData) {
    if (!anchorData) {
      console.warn("[StateManager] Received empty anchor data");
      return;
    }

    console.log("===== ANCHOR STATE UPDATE =====");
    console.log(`[StateManager] Anchor deployed: ${anchorData.anchorDeployed}`);

    if (anchorData.anchorLocation && anchorData.anchorLocation.position) {
      const pos = anchorData.anchorLocation.position;
      console.log(
        `[StateManager] Anchor position: ${pos.latitude}, ${pos.longitude}`
      );
    }

    if (anchorData.rode) {
      console.log(
        `[StateManager] Rode length: ${anchorData.rode.value} ${anchorData.rode.unit}`
      );
    }

    if (
      anchorData.anchorDropLocation &&
      anchorData.anchorDropLocation.position
    ) {
      const pos = anchorData.anchorDropLocation.position;
      console.log(
        `[StateManager] Drop position: ${pos.latitude}, ${pos.longitude}`
      );
    }

    console.log("================================");

    try {
      // Create a patch to update the anchor state
      const patch = [{ op: "replace", path: "/anchor", value: anchorData }];

      // Apply the patch using our existing method
      this.applyPatchAndForward(patch);
      console.log("[StateManager] Anchor state updated successfully");

      return true;
    } catch (error) {
      console.error("[StateManager] Error updating anchor state:", error);
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
      console.warn("[StateManager] Invalid update received:", update);
      return;
    }

    // Debug logging
    console.log(
      "[StateManager] Applying domain update:",
      JSON.stringify(update)
    );

    // Use stateData's batchUpdate to ensure proper structure handling
    const success = stateData.batchUpdate(update);
    if (!success) {
      console.error("[StateManager] Failed to apply batch update");
      return;
    }

    // Refresh our local state with proper structure
    this.appState = structuredClone(stateData.state);

    // Debug logging
    console.log(
      "[StateManager] State after update:",
      JSON.stringify({
        anchor: this.appState.anchor, // Just log anchor instead of full state
        updateSize: Object.keys(update).length,
      })
    );

    if (!this.appState.anchor) {
      console.warn("[StateManager] Anchor missing after update!");
    }

    // Evaluate alert rules to check for condition resolutions
    this._evaluateAlertRules();

    // Always emit state updates regardless of client count
    this.emit("state:full-update", {
      type: "state:full-update",
      data: this.appState,
      boatId: this._boatId,
      role: "boat-server",
      timestamp: Date.now(),
    });
  }

  updateState(newState, env = {}) {
    try {
      // Only merge if we have a valid newState
      if (newState && typeof newState === "object") {
        // Create a deep copy of the current state to avoid reference issues
        const currentState = JSON.parse(JSON.stringify(this.appState));

        // Merge the new state with the current state
        const mergedState = this._deepMerge(currentState, newState);

        // Update the app state
        this.appState = mergedState;

        // Emit the updated state
        this.emitFullState();
      }

      // Evaluate rules with the new state
      const actions = this.ruleEngine.evaluate(this.appState, env);

      // Process any actions from the rules
      actions.forEach((action) => {
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
            this.alertService.resolveAlertsByTrigger(
              action.trigger,
              action.data
            );
            break;
        }
      });

      // Emit profile updated event
      this.emit("profile-updated", {
        profile: this.currentProfile,
        boatId: this._boatId,
        timestamp: Date.now(),
      });

      return true;
    } catch (error) {
      console.error("[StateManager] Error in updateState:", error);
      return false;
    }
  }

  // Add a method to update client count
  updateClientCount(count) {
    const previousCount = this._clientCount;
    this._clientCount = count;

    console.log(
      `[StateManager] Client count updated: ${previousCount} -> ${count}`
    );

    // If we just got clients after having none, send a full state update
    if (previousCount === 0 && count > 0) {
      console.log("[StateManager] Clients connected, sending full state");
      this.broadcastStateUpdate();
    }
  }

  /**
   * Evaluate all alert rules to check for conditions and resolutions
   * @private
   */
  /**
   * Deep merge two objects
   * @private
   * @param {Object} target - The target object to merge into
   * @param {Object} source - The source object to merge from
   * @returns {Object} The merged object
   */
  _deepMerge(target, source) {
    const output = { ...target };

    if (this._isObject(target) && this._isObject(source)) {
      Object.keys(source).forEach((key) => {
        if (this._isObject(source[key])) {
          if (!(key in target)) {
            Object.assign(output, { [key]: source[key] });
          } else {
            output[key] = this._deepMerge(target[key], source[key]);
          }
        } else {
          Object.assign(output, { [key]: source[key] });
        }
      });
    }

    return output;
  }

  /**
   * Check if a value is an object
   * @private
   * @param {*} item - The value to check
   * @returns {boolean} True if the value is an object, false otherwise
   */
  _isObject(item) {
    return item && typeof item === "object" && !Array.isArray(item);
  }

  _evaluateAlertRules() {
    // Evaluate all rules against current state using the unified rule engine
    const actions = this.ruleEngine.evaluate(this.appState);

    // Filter for alert-related actions only
    const alertActions = actions.filter(
      (action) =>
        action.type === "CREATE_ALERT" || action.type === "RESOLVE_ALERT"
    );

    // Process alert actions using the AlertService
    const stateChanged = this.alertService.processAlertActions(alertActions);

    // Broadcast state update if any changes were made
    if (stateChanged) {
      this.broadcastStateUpdate();
    }
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

  _createDefaultProfile() {
    return {
      navigation: { base: 5000, multipliers: { CRITICAL: 0.2, HIGH: 0.8 } },
      anchor: { base: 10000 },
      depth: { base: 60000 },
      ais: { base: 10000 },
    };
  }

  setTideData(data) {
    this.tideData = data;
    this.emit('tide:update', data);
    this.emitFullState(); // Keep state in sync
  }
  
  setWeatherData(data) {
    this.weatherData = data;
    this.emit('weather:update', data);
    this.emitFullState(); // Keep state in sync
  }

}

const stateData = { state: createStateDataModel(UNIT_PRESETS.IMPERIAL) };
export const stateManager = new StateManager(stateData.state);
