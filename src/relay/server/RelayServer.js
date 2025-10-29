import EventEmitter from "events";
import debug from 'debug';
import { VPSConnector } from "./services/VPSConnector.js";
import { getClientSyncCoordinator } from './coordinatorSingleton.js';

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
    const coordinator = config.coordinator || getClientSyncCoordinator();
    if (!coordinator) throw new Error('RelayServer requires a ClientSyncCoordinator instance.');

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

    this._coordinator = coordinator;
    this._unregisterTransport = this._coordinator.registerTransport('relay', {
      send: (payload) => this._sendToVPS(payload),
      shouldSend: () => this.vpsConnector?.connected === true,
    });

    // Setup listeners
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

    if (this._unregisterTransport) {
      this._unregisterTransport();
      this._unregisterTransport = null;
    }
    
    // Remove all listeners on this emitter
    this.removeAllListeners();

    log('RelayServer closed.');
  }

  // ========== PRIVATE METHODS ========== //

  _handleVpsTransportMessage(message) {
    switch (message.type) {
      case "client-connected": {
        const boatId = message.boatId || this._coordinator.getBoatId?.() || "unknown";
        log(
          `New client connected via VPS: ${
            message.clientId || "unknown"
          } for boat ${boatId}`
        );
        this._coordinator.handleClientConnection({
          clientId: message.clientId,
        });
        break;
      }

      case "client-disconnected": {
        log(`Client disconnected from VPS: ${message.clientId || "unknown"}`);
        this._coordinator.handleClientDisconnection({
          clientId: message.clientId,
        });
        break;
      }

      default:
        log(`Forwarding message type ${message.type} to clients`);
        this._forwardToLocalClients(message);
        break;
    }
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
        const resolvedBoatId = boatId || this._coordinator.getBoatId?.() || 'unknown';
        log(
          `Client connection status update: ${clientCount} clients for boat ${resolvedBoatId}`
        );

        this._coordinator.handleClientCountUpdate({ boatId: resolvedBoatId, clientCount });
        this.emit("client-count-updated", { boatId: resolvedBoatId, clientCount });
      });
  }

  _forwardToLocalClients(payload) {
    if (!payload) {
      return;
    }

    const type = payload.type || 'vps-message';
    const data = payload.data ?? payload;

    this.emit(type, data);

    if (type !== 'vps-message') {
      this.emit('vps-message', payload);
    }
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

        const handled = this._coordinator.handleClientMessage({
          message,
          respond: (payload) => this._sendToVPS(payload),
          broadcast: (payload) => this._forwardToLocalClients(payload),
        });

        if (!handled) {
          this._handleVpsTransportMessage(message);
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

  _sendToVPS(message) {
    // Only send messages if there are relay clients connected to the VPS
    if (!this._coordinator || !this._coordinator.hasConnectedClients()) {
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

    this._coordinator.handleClientConnection({ clientId });
    log(`Client ${clientId} connected via RELAY`);

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

    this._coordinator.handleClientDisconnection({ clientId });
    log(`Client ${clientId} disconnected`);
    return true;
  }

  updateClientActivity() {
    // We no longer track individual client activity
    // Just return true if we have any clients
    return this._coordinator ? this._coordinator.hasConnectedClients() : false;
  }

  getClientCount() {
    return this._coordinator ? this._coordinator.getClientCount() : 0;
  }

  shutdown() {
    log("Starting shutdown sequence");

    if (this._unregisterTransport) {
      this._unregisterTransport();
      this._unregisterTransport = null;
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
