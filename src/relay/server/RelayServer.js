import EventEmitter from "events";
import { StateManager2 } from "../core/state/StateManager2.js";
import { syncOrchestrator } from "./core/sync/SyncOrchestrator.js";
import { VPSConnector } from "./services/VPSConnector.js";

export class RelayServer extends EventEmitter {
  constructor(config = {}) {
    super();

    // Validate configuration
    if (!config.port)
      throw new Error("RelayServer: port must be provided in config");
    // We only use key-based authentication now
    if (!config.vpsUrl) throw new Error("RelayServer: vpsUrl is required");

    /** @type {{vpsUrl: string, port: number, host: string, vpsReconnectInterval: number, vpsMaxRetries: number}} */
    this.config = {
      vpsUrl: config.vpsUrl,
      port: config.port,
      host: config.host || 'localhost',
      vpsReconnectInterval: config.vpsReconnectInterval || 5000,
      vpsMaxRetries: config.vpsMaxRetries || 10,
    };

    // State management
    this._stateVersion = 0;
    this._messageBuffer = [];
    this._maxBufferSize = 100;
    this.stateManager = new StateManager2();

    // Client management
    this.clients = new Map();

    // Initialize services
    this.vpsConnector = new VPSConnector({
      // No tokenSecret needed for key-based authentication
      vpsUrl: this.config.vpsUrl,
      reconnectInterval: this.config.vpsReconnectInterval,
      maxRetries: this.config.vpsMaxRetries,
      // Add missing properties that VPSConnector expects
      port: this.config.port,
      host: this.config.host
    });

    this.syncOrchestrator = syncOrchestrator;

    // Setup listeners
    this._setupStateListeners();
    this._setupConnectionListeners();

    // Setup maintenance intervals
    this._maintenanceIntervals = {
      connectionRefresh: setInterval(
        () => this._refreshVpsConnection(),
        86400000
      ), // 24 hours
      bufferMonitor: setInterval(() => this._monitorBuffer(), 60000), // 1 minute
    };
  }

  async initialize() {
    try {
      console.log("[RELAY] Initializing relay server");
      console.log(`[RELAY] VPS URL: ${this.config.vpsUrl}`);
      console.log(`[RELAY] Using authentication: key-based`);

      // Connect to VPS
      console.log("[RELAY] Attempting to connect to VPS...");
      try {
        await this.vpsConnector.connect();
        console.log("[RELAY] Successfully connected to VPS");
      } catch (vpsError) {
        console.error("[RELAY] VPS connection failed:", vpsError.message);
        console.log("[RELAY] Continuing without VPS connection");
        // Don't rethrow - we'll continue without VPS connection
      }

      // Setup server components
      this._setupServer();

      console.log(
        `[RELAY] Successfully initialized on port ${this.config.port}`
      );
      this.emit("initialized");
      return true;
    } catch (error) {
      console.error("[RELAY] Initialization failed:", error);
      this.emit("error", {
        type: "init-failed",
        error: error.message,
      });
      throw error;
    }
  }

  // ========== PRIVATE METHODS ========== //

  _setupStateListeners() {
    // Throttle profile updates
    this.stateManager.on("state-changed", (newState) => {
      if (newState.throttleProfile) {
        this.syncOrchestrator.updateThrottleProfile(newState.throttleProfile);
      }
    });

    // Forward StateManager payloads directly (flat structure)
    this._stateEventHandler = (payload) => this._sendToVPS(payload);
    this.stateManager.on("state:full-update", this._stateEventHandler);
    this.stateManager.on("state:patch", this._stateEventHandler);

    // Add these new handlers for tide and weather updates
    this._tideUpdateHandler = (data) => {
      this._sendToVPS({
        type: "tide:update",
        data,
        boatId: this.stateManager.boatId,
        timestamp: Date.now(),
      });
    };

    this._weatherUpdateHandler = (data) => {
      this._sendToVPS({
        type: "weather:update",
        data,
        boatId: this.stateManager.boatId,
        timestamp: Date.now(),
      });
    };

    this.stateManager.on("tide:update", this._tideUpdateHandler);
    this.stateManager.on("weather:update", this._weatherUpdateHandler);
  }

  _setupConnectionListeners() {
    this.vpsConnector
      .on("connected", () => {
        console.log("[RELAY] VPS connection established");
        this._flushMessageBuffer();
        this.emit("vps-connected");
      })
      .on("disconnected", () => {
        console.warn("[RELAY] VPS connection lost");
        this.emit("vps-disconnected");
      })
      .on("error", (error) => {
        console.error("[RELAY] VPS connection error:", error.message);
        this.emit("vps-error", error);
      })
      .on("max-retries", () => {
        console.error("[RELAY] VPS connection permanently lost");
        this.emit("vps-connection-lost");
      })
      .on("connectionStatus", ({ boatId, clientCount }) => {
        console.log(
          `[RELAY] Client connection status update: ${clientCount} clients for boat ${boatId}`
        );

        // Update the stateManager's client count
        if (boatId === this.stateManager.boatId) {
          this.stateManager.updateClientCount(clientCount);
          this.emit("client-count-updated", { boatId, clientCount });
        }
      });
  }

  _setupServer() {
    this.vpsConnector.on("message", (message) => {
      try {
        if (!message?.type) {
          console.warn("[RELAY] Received malformed message:", message);
          return;
        }

        console.debug(`[RELAY] Processing VPS message: ${message.type}`);

        // Log message type being sent to VPS with detailed information
        console.log(`[RELAY-SERVER] Received message from VPS:`, {
          type: message.type,
          messageId: message.id || "unknown",
          clientId: message.clientId || "unknown",
          boatId: message.boatId || "unknown",
          timestamp: new Date().toISOString(),
          dataSize: JSON.stringify(message).length,
        });

        // Log the raw message for debugging
        console.log(
          `[RELAY-SERVER-DEBUG] Raw message from VPS: ${JSON.stringify(
            message
          )}`
        );

        switch (message.type) {
          case "client-connected":
            // Handle client connection notification from VPS
            console.log(
              `[RELAY-SERVER] New client connected via VPS: ${
                message.clientId || "unknown"
              } for boat ${message.boatId || "unknown"}`
            );
            // Update the state manager's client count
            if (this.stateManager) {
              const newCount = (this.stateManager.clientCount || 0) + 1;
              this.stateManager.updateClientCount(newCount);
              console.log(
                `[RELAY-SERVER] Updated client count: ${newCount}`
              );

              // Send a full state update to the new client
              console.log(
                `[RELAY-SERVER] Sending full state update to new client ${
                  message.clientId || "unknown"
                }`
              );
              const fullStateResponse = {
                type: "state:full-update",
                data: this.stateManager.getState(),
                boatId: this.stateManager.boatId,
                timestamp: Date.now(),
                clientId: message.clientId || "unknown",
              };
              this.vpsConnector.send(fullStateResponse);
            } else {
              console.warn(
                `[RELAY-SERVER] Cannot update client count: stateManager is not initialized`
              );
            }
            break;

          case "client-disconnected":
            // Handle client disconnection notification from VPS
            console.log(
              `[RELAY-SERVER] Client disconnected from VPS: ${
                message.clientId || "unknown"
              }`
            );
            // Update the state manager's client count
            if (this.stateManager) {
              const newCount = Math.max(0, (this.stateManager.clientCount || 1) - 1);
              this.stateManager.updateClientCount(newCount);
              console.log(
                `[RELAY-SERVER] Updated client count: ${newCount}`
              );
            }
            break;

          case "get-full-state":
          case "request-full-state": // Handle both types of full state requests
            console.log(
              `[RELAY-SERVER] Handling full state request from VPS, requestId: ${
                message.requestId || "unknown"
              }, clientId: ${message.clientId || "unknown"}`
            );
            this._handleFullStateRequest(message);
            break;

          case "state:full-update": // Network message type
            console.log(
              `[RELAY-SERVER] Broadcasting full state update to all clients, data size: ${
                JSON.stringify(message.data).length
              } bytes`
            );
            this.emit("state:full-update", message.data); // Standardized event
            break;

          case "state:patch": // Network message type
            const patchSize = message.data?.operations
              ? message.data.operations.length
              : 0;
            console.log(
              `[RELAY-SERVER] Broadcasting state patch to all clients, operations: ${patchSize}`
            );
            this.emit("state:patch", message.data); // Already standardized
            break;

          case "tide:update":
            console.log(`[RELAY-SERVER] Forwarding tide update to clients`);
            this.emit("tide:update", message.data);
            break;

          case "weather:update":
            console.log(`[RELAY-SERVER] Forwarding weather update to clients`);
            this.emit("weather:update", message.data);
            break;

          case "anchor:update":
            console.log(`[RELAY-SERVER] Processing anchor:update message:`, JSON.stringify(message.data, null, 2));
            try {
              const success = this.stateManager.updateAnchorState(message.data);
              console.log(`[RELAY-SERVER] Anchor update ${success ? 'succeeded' : 'failed'}`);
              // Optionally emit an event for listeners
              this.emit("anchor:update", { success, data: message.data });
            } catch (error) {
              console.error('[RELAY-SERVER] Error processing anchor update:', error);
              this.emit("error:anchor-update", { error, data: message.data });
            }
            break;

          default:
            console.log(
              `[RELAY-SERVER] Forwarding message type ${message.type} to clients`
            );
            this.emit("vps-message", message);
            break;
        }
      } catch (error) {
        console.error("[RELAY] Error processing VPS message:", error);
        this.emit("vps-error", {
          error,
          message: "Failed to process VPS message",
        });
      }
    });
  }

  _handleFullStateRequest(request) {
    console.log(
      `[RELAY-SERVER] Handling full state request from ${
        request.clientId || "unknown client"
      }, requestId: ${request.requestId || "unknown"}`
    );

    // Get the full state from the state manager
    const fullState = {
      ...this.stateManager.getState(),
      // Include tide and weather data if available
      ...(this.stateManager.tideData && { tide: this.stateManager.tideData }),
      ...(this.stateManager.weatherData && { weather: this.stateManager.weatherData })
    };

    // Log details about the state being sent
    const stateKeys = fullState ? Object.keys(fullState) : [];
    console.log(
      `[RELAY-SERVER] Full state contains ${
        stateKeys.length
      } top-level keys: ${stateKeys.join(", ")}`
    );
    console.log(
      `[RELAY-SERVER] Full state size: ${
        JSON.stringify(fullState).length
      } bytes`
    );

    const response = {
      type: "state:full-update",
      data: fullState,
      boatId: this.stateManager.boatId,
      timestamp: Date.now(),
      requestId: request.requestId || "unknown",
    };

    console.log(
      `[RELAY-SERVER] Sending full state response to VPS for boatId: ${this.stateManager.boatId}`
    );
    this.vpsConnector.send(response);
    console.log(
      `[RELAY-SERVER] Full state response sent to VPS, requestId: ${
        request.requestId || "unknown"
      }`
    );
  }

  _sendToVPS(message) {
    // Only send messages if there are relay clients connected to the VPS
    if (this.stateManager.clientCount === 0) {
      // No remote clients connected to VPS, don't buffer or send messages
      return;
    }

    // Log message type being sent to VPS with detailed information
    console.log(`[RELAY-SERVER] Sending message to VPS:`, {
      type: message.type,
      messageId: message.id || "unknown",
      timestamp: new Date().toISOString(),
      dataSize: JSON.stringify(message).length,
    });

    if (!this.vpsConnector.connected) {
      console.log(
        `[RELAY-SERVER] VPS not connected, buffering message: ${message.type}`
      );
      if (this._messageBuffer.length < this._maxBufferSize) {
        this._messageBuffer.push(message);
      } else {
        console.warn(
          "[RELAY-SERVER] Message buffer full, discarding oldest message"
        );
        this._messageBuffer.shift();
        this._messageBuffer.push(message);
      }
      return;
    }

    try {
      // Include any buffered messages
      const messagesToSend = [message, ...this._messageBuffer];
      console.log(
        `[RELAY-SERVER] Sending ${messagesToSend.length} messages to VPS`
      );
      this.vpsConnector.send(messagesToSend);
      this._messageBuffer = [];
      console.log(`[RELAY-SERVER] Successfully sent messages to VPS`);
    } catch (error) {
      console.error("[RELAY-SERVER] Failed to send to VPS:", error);
      this._messageBuffer.push(message); // Retry later
    }
  }

  forwardMessageToVPS(clientId, message) {
    if (!this.vpsConnector) {
      console.error(
        `[RELAY-SERVER] Cannot forward message from client ${clientId} to VPS: VPS connector not initialized`
      );
      return;
    }

    console.log(
      `[RELAY-SERVER] Forwarding message from client ${clientId} to VPS:`,
      {
        type: message.type,
        messageId: message.id || "unknown",
        timestamp: new Date().toISOString(),
        dataSize: JSON.stringify(message).length,
      }
    );

    this.vpsConnector.send(message);
    console.log(
      `[RELAY-SERVER] Successfully forwarded message from client ${clientId} to VPS`
    );
  }

  _flushMessageBuffer() {
    if (this._messageBuffer.length > 0 && this.vpsConnector.connected) {
      console.log(
        `[RELAY] Flushing ${this._messageBuffer.length} buffered messages`
      );
      this.vpsConnector.send([...this._messageBuffer]);
      this._messageBuffer = [];
    }
  }

  _refreshVpsConnection() {
    console.log(
      "[RELAY] Refreshing VPS connection with key-based authentication"
    );
    this.vpsConnector.disconnect();
    this.vpsConnector.connect().catch((error) => {
      console.error("[RELAY] VPS reconnection failed:", error);
    });
  }

  _monitorBuffer() {
    if (this._messageBuffer.length > 0) {
      console.log(`[RELAY] Message buffer size: ${this._messageBuffer.length}`);
    }
  }

  // ========== PUBLIC METHODS ========== //

  addClient(clientId) {
    // Add client to our local tracking
    this.clients.set(clientId, { connected: true, lastActivity: Date.now() });

    // Update the client count in the StateManager
    const currentCount = this.stateManager.clientCount;
    this.stateManager.updateClientCount(currentCount + 1);
    console.log(
      `[RELAY-SERVER] Client ${clientId} connected via RELAY (total: ${this.stateManager.clientCount})`
    );

    // Log all active clients
    console.log(
      `[RELAY-SERVER] Active relay clients: ${Array.from(
        this.clients.keys()
      ).join(", ")}`
    );
    return clientId;
  }

  removeClient(clientId) {
    // Remove client from our local tracking
    this.clients.delete(clientId);

    if (this.stateManager.clientCount > 0) {
      // Update the client count in the StateManager
      const currentCount = this.stateManager.clientCount;
      this.stateManager.updateClientCount(currentCount - 1);
      console.log(
        `[RELAY] Client ${clientId} disconnected (remaining: ${this.stateManager.clientCount})`
      );
      return true;
    }
    return false;
  }

  updateClientActivity() {
    // We no longer track individual client activity
    // Just return true if we have any clients
    return this.stateManager.clientCount > 0;
  }

  getClientCount() {
    return this.stateManager.clientCount;
  }

  shutdown() {
    console.log("[RELAY] Starting shutdown sequence");

    // Remove StateManager event listeners
    if (this._stateEventHandler) {
      this.stateManager.off("state:full-update", this._stateEventHandler);
      this.stateManager.off("state:patch", this._stateEventHandler);
    }

    // Remove tide and weather update handlers
    if (this._tideUpdateHandler) {
      this.stateManager.off("tide:update", this._tideUpdateHandler);
    }
    if (this._weatherUpdateHandler) {
      this.stateManager.off("weather:update", this._weatherUpdateHandler);
    }

    // Clear intervals
    clearInterval(this._maintenanceIntervals.connectionRefresh);
    clearInterval(this._maintenanceIntervals.bufferMonitor);

    // Disconnect clients
    this.clients.clear();

    // Disconnect VPS
    if (this.vpsConnector.connected) {
      this.vpsConnector.disconnect();
    }

    // Remove all listeners
    this.removeAllListeners();

    console.log("[RELAY] Shutdown complete");
    this.emit("shutdown");
  }
}
