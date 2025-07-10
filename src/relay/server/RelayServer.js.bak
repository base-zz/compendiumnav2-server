import EventEmitter from "events";
import debug from 'debug';
import { StateManager } from "../core/state/StateManager.js";
import { syncOrchestrator } from "./core/sync/SyncOrchestrator.js";
import { VPSConnector } from "./services/VPSConnector.js";

const log = debug('relay-server');
const logWarn = debug('relay-server:warn');
const logError = debug('relay-server:error');
const logTrace = debug('relay-server:trace');

export class RelayServer extends EventEmitter {
  constructor(config = {}) {
    super();
    log('RelayServer constructor called');

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
    if (!config.stateManager) throw new Error('RelayServer requires a stateManager instance.');
    this.stateManager = config.stateManager;

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
      log("Initializing relay server");
      log(`VPS URL: ${this.config.vpsUrl}`);

      // Connect to VPS
      log("Attempting to connect to VPS...");
      try {
        await this.vpsConnector.connect();
        log("Successfully connected to VPS");
      } catch (vpsError) {
        logError("VPS connection failed: %s", vpsError.message);
        log("Continuing without VPS connection");
        // Don't rethrow - we'll continue without VPS connection
      }

      // Setup server components
      this._setupServer();

      log(
        `Successfully initialized on port ${this.config.port}`
      );
      this.emit("initialized");
      return true;
    } catch (error) {
      logError("Initialization failed: %s", error);
      this.emit("error", {
        type: "init-failed",
        error: error.message,
      });
      throw error;
    }
  }

  close() {
    log('Closing RelayServer...');

    // Clear maintenance intervals
    for (const key in this._maintenanceIntervals) {
      clearInterval(this._maintenanceIntervals[key]);
    }

    // Disconnect from VPS
    if (this.vpsConnector) {
      this.vpsConnector.disconnect();
    }

    // Remove all event listeners from the state manager that this instance created
    if (this._stateEventHandler) {
      this.stateManager.removeListener('state:full-update', this._stateEventHandler);
      this.stateManager.removeListener('state:patch', this._stateEventHandler);
    }
    if (this._tideUpdateHandler) {
      this.stateManager.removeListener('tide:update', this._tideUpdateHandler);
    }
    if (this._weatherUpdateHandler) {
      this.stateManager.removeListener('weather:update', this._weatherUpdateHandler);
    }
    
    // Remove all listeners on this emitter
    this.removeAllListeners();

    log('RelayServer closed.');
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
        log("VPS connection established");
        this._flushMessageBuffer();
        this.emit("vps-connected");
      })
      .on("disconnected", () => {
        logWarn("VPS connection lost");
        this.emit("vps-disconnected");
      })
      .on("error", (error) => {
        logError("VPS connection error: %s", error.message);
        this.emit("vps-error", error);
      })
      .on("max-retries", () => {
        logError("VPS connection permanently lost");
        this.emit("vps-connection-lost");
      })
      .on("connectionStatus", ({ boatId, clientCount }) => {
        log(
          `Client connection status update: ${clientCount} clients for boat ${boatId}`
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
          logWarn("Received malformed message: %j", message);
          return;
        }

        logTrace(`Processing VPS message: ${message.type}`);

        // Log message type being sent to VPS with detailed information
        log(`Received message from VPS:`, {
          type: message.type,
          messageId: message.id || "unknown",
          clientId: message.clientId || "unknown",
          boatId: message.boatId || "unknown",
          timestamp: new Date().toISOString(),
          dataSize: JSON.stringify(message).length,
        });

        // Log the raw message for debugging
        logTrace(
          `Raw message from VPS: ${JSON.stringify(
            message
          )}`
        );

        switch (message.type) {
          case "client-connected":
            // Handle client connection notification from VPS
            log(
              `New client connected via VPS: ${
                message.clientId || "unknown"
              } for boat ${message.boatId || "unknown"}`
            );
            // Update the state manager's client count
            if (this.stateManager) {
              const newCount = (this.stateManager.clientCount || 0) + 1;
              this.stateManager.updateClientCount(newCount);
              log(
                `Updated client count: ${newCount}`
              );

              // Send a full state update to the new client
              log(
                `Sending full state update to new client ${
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
              logWarn(
                `Cannot update client count: stateManager is not initialized`
              );
            }
            break;

          case "client-disconnected":
            // Handle client disconnection notification from VPS
            log(
              `Client disconnected from VPS: ${
                message.clientId || "unknown"
              }`
            );
            // Update the state manager's client count
            if (this.stateManager) {
              const newCount = Math.max(0, (this.stateManager.clientCount || 1) - 1);
              this.stateManager.updateClientCount(newCount);
              log(
                `Updated client count: ${newCount}`
              );
            }
            break;

          case "get-full-state":
          case "request-full-state": // Handle both types of full state requests
            log(
              `Handling full state request from VPS, requestId: ${
                message.requestId || "unknown"
              }, clientId: ${message.clientId || "unknown"}`
            );
            this._handleFullStateRequest(message);
            break;

          case "state:full-update": // Network message type
            log(
              `Broadcasting full state update to all clients, data size: ${
                JSON.stringify(message.data).length
              } bytes`
            );
            this.emit("state:full-update", message.data); // Standardized event
            break;

          case "state:patch": // Network message type
            const patchSize = message.data?.operations
              ? message.data.operations.length
              : 0;
            log(
              `Broadcasting state patch to all clients, operations: ${patchSize}`
            );
            this.emit("state:patch", message.data); // Already standardized
            break;

          case "tide:update":
            log(`Forwarding tide update to clients`);
            this.emit("tide:update", message.data);
            break;

          case "weather:update":
            log(`Forwarding weather update to clients`);
            this.emit("weather:update", message.data);
            break;

          case "anchor:update":
            log(`Processing anchor:update message:`, JSON.stringify(message.data, null, 2));
            try {
              const success = this.stateManager.updateAnchorState(message.data);
              log(`Anchor update ${success ? 'succeeded' : 'failed'}`);
              // Optionally emit an event for listeners
              this.emit("anchor:update", { success, data: message.data });
            } catch (error) {
              logError('Error processing anchor update:', error);
              this.emit("error:anchor-update", { error, data: message.data });
            }
            break;

          default:
            log(
              `Forwarding message type ${message.type} to clients`
            );
            this.emit("vps-message", message);
            break;
        }
      } catch (error) {
        logError("Error processing VPS message:", error);
        this.emit("vps-error", {
          error,
          message: "Failed to process VPS message",
        });
      }
    });
  }

  _handleFullStateRequest(request) {
    log(
      `Handling full state request from ${
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
    log(
      `Full state contains ${
        stateKeys.length
      } top-level keys: ${stateKeys.join(", ")}`
    );
    log(
      `Full state size: ${
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

    log(
      `Sending full state response to VPS for boatId: ${this.stateManager.boatId}`
    );
    this.vpsConnector.send(response);
    log(
      `Full state response sent to VPS, requestId: ${
        request.requestId || "unknown"
      }`
    );
  }

  _sendToVPS(message) {
    // Only send messages if there are relay clients connected to the VPS
    if (this.stateManager.clientCount === 0) {
      logTrace('No clients connected, skipping message send to VPS');
      // No remote clients connected to VPS, don't buffer or send messages
      return;
    }

    // Log message type being sent to VPS with detailed information
    log(`Sending message to VPS:`, {
      type: message.type,
      messageId: message.id || "unknown",
      timestamp: new Date().toISOString(),
      dataSize: JSON.stringify(message).length,
    });

    if (!this.vpsConnector.connected) {
      log(
        `VPS not connected, buffering message: ${message.type}`
      );
      if (this._messageBuffer.length < this._maxBufferSize) {
        this._messageBuffer.push(message);
      } else {
        logWarn(
          "Message buffer full, discarding oldest message"
        );
        this._messageBuffer.shift();
        this._messageBuffer.push(message);
      }
      return;
    }

    try {
      // Include any buffered messages
      const messagesToSend = [message, ...this._messageBuffer];
      log(
        `Sending ${messagesToSend.length} messages to VPS`
      );
      this.vpsConnector.send(messagesToSend);
      this._messageBuffer = [];
      log(`Successfully sent messages to VPS`);
    } catch (error) {
      logError("Failed to send to VPS:", error);
      this._messageBuffer.push(message); // Retry later
    }
  }

  forwardMessageToVPS(clientId, message) {
    if (!this.vpsConnector) {
      logError(
        `Cannot forward message from client ${clientId} to VPS: VPS connector not initialized`
      );
      return;
    }

    log(
      `Forwarding message from client ${clientId} to VPS:`,
      {
        type: message.type,
        messageId: message.id || "unknown",
        timestamp: new Date().toISOString(),
        dataSize: JSON.stringify(message).length,
      }
    );

    this.vpsConnector.send(message);
    log(
      `Successfully forwarded message from client ${clientId} to VPS`
    );
  }

  _flushMessageBuffer() {
    if (this._messageBuffer.length > 0 && this.vpsConnector.connected) {
      log(
        `Flushing ${this._messageBuffer.length} buffered messages`
      );
      this.vpsConnector.send([...this._messageBuffer]);
      this._messageBuffer = [];
    }
  }

  _refreshVpsConnection() {
    this.vpsConnector.disconnect();
    this.vpsConnector.connect().catch((error) => {
      logError("VPS reconnection failed:", error);
    });
  }

  _monitorBuffer() {
    if (this._messageBuffer.length > 0) {
      log(`Message buffer size: ${this._messageBuffer.length}`);
    }
  }

  // ========== PUBLIC METHODS ========== //

  addClient(clientId) {
    // Add client to our local tracking
    this.clients.set(clientId, { connected: true, lastActivity: Date.now() });

    // Update the client count in the StateManager
    const currentCount = this.stateManager.clientCount;
    this.stateManager.updateClientCount(currentCount + 1);
    log(
      `Client ${clientId} connected via RELAY (total: ${this.stateManager.clientCount})`
    );

    // Log all active clients
    log(
      `Active relay clients: ${Array.from(
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
      log(
        `Client ${clientId} disconnected (remaining: ${this.stateManager.clientCount})`
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
    log("Starting shutdown sequence");

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

    log("Shutdown complete");
    this.emit("shutdown");
  }
}
