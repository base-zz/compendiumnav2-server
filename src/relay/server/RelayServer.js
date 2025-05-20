import EventEmitter from "events";
import { stateManager } from "../core/state/StateManager.js";
import { syncOrchestrator } from "./core/sync/SyncOrchestrator.js";
import { VPSConnector } from "./services/VPSConnector.js";

export class RelayServer extends EventEmitter {
  constructor(config = {}) {
    super();

    // Validate configuration
    if (!config.port) throw new Error("RelayServer: port must be provided in config");
    if (!config.tokenSecret) throw new Error("RelayServer: tokenSecret is required");
    if (!config.vpsUrl) throw new Error("RelayServer: vpsUrl is required");

    this.config = {
      ...config,
      vpsReconnectInterval: config.vpsReconnectInterval || 5000,
      vpsMaxRetries: config.vpsMaxRetries || 10
    };

    // State management
    this._stateVersion = 0;
    this._messageBuffer = [];
    this._maxBufferSize = 100;
    this.stateManager = stateManager;
    
    // Client management
    this.clients = new Map();

    // Initialize services
    this.vpsConnector = new VPSConnector({
      tokenSecret: this.config.tokenSecret,
      vpsUrl: this.config.vpsUrl,
      reconnectInterval: this.config.vpsReconnectInterval,
      maxRetries: this.config.vpsMaxRetries
    });

    this.syncOrchestrator = syncOrchestrator;

    // Setup listeners
    this._setupStateListeners();
    this._setupConnectionListeners();

    // Setup maintenance intervals
    this._maintenanceIntervals = {
      tokenRefresh: setInterval(() => this._refreshVpsConnection(), 86400000), // 24 hours
      bufferMonitor: setInterval(() => this._monitorBuffer(), 60000) // 1 minute
    };
  }

  async initialize() {
    try {
      console.log("[RELAY] Initializing relay server");
      
      // Connect to VPS
      await this.vpsConnector.connect();
      
      // Setup server components
      this._setupServer();

      console.log(`[RELAY] Successfully initialized on port ${this.config.port}`);
      this.emit("initialized");
      return true;
    } catch (error) {
      console.error("[RELAY] Initialization failed:", error);
      this.emit("error", { 
        type: "init-failed", 
        error: error.message 
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
        console.log(`[RELAY] Client connection status update: ${clientCount} clients for boat ${boatId}`);
        
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
  
        switch (message.type) {
          case "get-full-state":
            this._handleFullStateRequest(message);
            break;
            
          case "state:full-update":  // Network message type
            this.emit("state:full-update", message.data); // Standardized event
            break;
            
          case "state:patch": // Network message type 
            this.emit("state:patch", message.data); // Already standardized
            break;
            
          default:
            this.emit("vps-message", message);
            break;
        }
      } catch (error) {
        console.error("[RELAY] Error processing VPS message:", error);
        this.emit("vps-error", { 
          error, 
          message: "Failed to process VPS message" 
        });
      }
    });
  }  

  _handleFullStateRequest(request) {
    const response = {
      type: "state:full-update",
      data: this.stateManager.getState(),
      boatId: this.stateManager.boatId,
      timestamp: Date.now(),
      requestId: request.requestId
    };
    this.vpsConnector.send(response);
    console.log(`[RELAY] Responded to state request ${request.requestId}`);
  }

  _sendToVPS(message) {
    // Only send messages if there are relay clients connected to the VPS
    if (this.stateManager.clientCount === 0) {
      // No remote clients connected to VPS, don't buffer or send messages
      return;
    }

    if (!this.vpsConnector.connected) {
      if (this._messageBuffer.length < this._maxBufferSize) {
        this._messageBuffer.push(message);
      } else {
        console.warn("[RELAY] Message buffer full, discarding oldest message");
        this._messageBuffer.shift();
        this._messageBuffer.push(message);
      }
      return;
    }
    
    try {
      // Include any buffered messages
      const messagesToSend = [message, ...this._messageBuffer];
      this.vpsConnector.send(messagesToSend);
      this._messageBuffer = [];
    } catch (error) {
      console.error("[RELAY] Failed to send to VPS:", error);
      this._messageBuffer.push(message); // Retry later
    }
  }

  _flushMessageBuffer() {
    if (this._messageBuffer.length > 0 && this.vpsConnector.connected) {
      console.log(`[RELAY] Flushing ${this._messageBuffer.length} buffered messages`);
      this.vpsConnector.send([...this._messageBuffer]);
      this._messageBuffer = [];
    }
  }

  _refreshVpsConnection() {
    console.log("[RELAY] Refreshing VPS connection");
    this.vpsConnector.disconnect();
    this.vpsConnector.connect().catch(error => {
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
    console.log(`[RELAY] Client ${clientId} connected (total: ${this.stateManager.clientCount})`);
    return clientId;
  }

  removeClient(clientId) {
    // Remove client from our local tracking
    this.clients.delete(clientId);
    
    if (this.stateManager.clientCount > 0) {
      // Update the client count in the StateManager
      const currentCount = this.stateManager.clientCount;
      this.stateManager.updateClientCount(currentCount - 1);
      console.log(`[RELAY] Client ${clientId} disconnected (remaining: ${this.stateManager.clientCount})`);
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
    
    // Clear intervals
    clearInterval(this._maintenanceIntervals.tokenRefresh);
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