import { EventEmitter } from "events";
import { stateData } from "../../../state/StateData.js";
import { createStateDataModel } from "../../../shared/stateDataModel.js";
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
    console.log('[StateManager2][getState] called. Current anchor state:',
      JSON.stringify(this.appState?.anchor, null, 2)
    );
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
    this.appState = structuredClone(state);
  }

  constructor(initialState) {
    console.log(
      "[StateManager2_CONSTRUCTOR_ENTRY_LOG] StateManager2 constructor CALLED!"
    );

    console.log(
      "[StateManager2_CONSTRUCTOR_ENTRY_LOG] initialState: ",
      JSON.stringify(initialState, null, 2)
    );

    super();
    // Initialize with stateData's state which already has all structures
    this.appState = initialState
      ? structuredClone(initialState)
      : structuredClone(stateData.state);

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

    this.currentProfile = structuredClone(defaultProfile);
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

      const stateBeforePatch = structuredClone(this.appState);

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

    console.log('[StateManager2][emitFullState] called. Anchor state:',
      JSON.stringify(this.appState?.anchor, null, 2)
    );

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
    this.appState = structuredClone(newStateData);

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

    console.log("===== ANCHOR STATE UPDATE =====");
    console.log(
      `[StateManager2] Anchor deployed: ${anchorData.anchorDeployed}`
    );

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

    console.log('[StateManager2][updateAnchorState] anchor before update:', JSON.stringify(this.appState?.anchor, null, 2));

    console.log("================================");

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

    // Use stateData's batchUpdate to ensure proper structure handling
    const success = stateData.batchUpdate(update);
    if (!success) {
      console.error("[StateManager2] Failed to apply batch update");
      return;
    }

    // Refresh our local state with proper structure
    this.appState = structuredClone(stateData.state);

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
      structuredClone(stateBeforePatch),
      structuredClone(patchOperations),
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
}

export const stateManager2 = new StateManager2();
