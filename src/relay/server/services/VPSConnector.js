import WebSocket from "ws";
import EventEmitter from "events";
import jwt from "jsonwebtoken";
import { getOrCreateAppUuid } from "../../../server/uniqueAppId.js";
const boatId = getOrCreateAppUuid();

/**
 * VPSConnector
 *
 * Handles the connection from the Relay Server to the VPS Relay Proxy
 */
export class VPSConnector extends EventEmitter {
  constructor(config = {}) {
    super();
    this.config = config;
    this.connection = null;
    this.connected = false;
    this.retryCount = 0;
    this.reconnectTimer = null;
    // Ensure sensible defaults
    this.config.reconnectInterval = this.config.reconnectInterval || 5000;
    this.config.maxRetries = this.config.maxRetries || 10;
    if (!this.config.tokenSecret)
      throw new Error("VPSConnector: tokenSecret is required in config");
    if (!this.config.vpsUrl)
      throw new Error("VPSConnector: vpsUrl is required in config");
  }

  initialize(config = {}) {
    // Setup config using env vars or provided config
    const mergedConfig = { ...config };
    mergedConfig.vpsUrl = this._buildVpsUrl(config);
    mergedConfig.tokenSecret = process.env.TOKEN_SECRET;
    mergedConfig.reconnectInterval = this._getNumericConfig(
      "VPS_RECONNECT_INTERVAL",
      config.reconnectInterval,
      5000
    );
    mergedConfig.maxRetries = this._getNumericConfig(
      "VPS_MAX_RETRIES",
      config.maxRetries,
      10
    );
    if (!mergedConfig.tokenSecret) {
      throw new Error(
        "TOKEN_SECRET must be set in .env or passed via config.\n" +
          "Add to .env:\nTOKEN_SECRET=your_secure_secret_here\n" +
          'Or pass as: vpsConnector.initialize({ tokenSecret: "..." })'
      );
    }
    this.config = mergedConfig;
  }

  _buildVpsUrl() {
    const host = process.env.VPS_HOST;
    const port = process.env.VPS_WS_PORT;
    const path = process.env.VPS_PATH || "/relay";
    const protocol = process.env.NODE_ENV === "production" ? "wss" : "ws";

    if (!host)
      throw new Error("VPS_HOST must be set in the environment or config.");

    if (process.env.NODE_ENV !== "production") {
      if (!port) throw new Error("VPS_WS_PORT must be set in development.");
      console.warn(
        "[SECURITY WARNING] Using insecure WebSocket connection for development"
      );
      return `${protocol}://${host}:${port}${path}`;
    }

    // Production
    if (port && port !== "443" && port !== "80") {
      throw new Error(
        "Production allows only port 443 (wss), 80 (ws), or omit VPS_WS_PORT for default."
      );
    }
    // Omit port for default (80/443)
    return port
      ? `${protocol}://${host}:${port}${path}`
      : `${protocol}://${host}${path}`;
  }

  _getNumericConfig(envVar, configValue, defaultValue) {
    const value = process.env[envVar] || configValue;
    return value ? parseInt(value, 10) : defaultValue;
  }

  /**
   * Generate a token for authentication with the VPS Relay Proxy
   */

  _generateToken() {
    const payload = {
      originId: "relay-server",
      boatId: boatId,
      role: "boat-server",
    };

    console.log("[VPS-CONNECTOR] Payload for token:", payload);

    // Use TOKEN_EXPIRY from env or default to 90 days
    const expiresIn = process.env.TOKEN_EXPIRY
      ? `${process.env.TOKEN_EXPIRY}s`
      : "30d";
    return jwt.sign(payload, this.config.tokenSecret, {
      expiresIn: expiresIn,
      algorithm: "HS256",
    });
  }

  /**
   * Connect to the VPS Relay Proxy
   */
  connect() {
    if (this.connection && this.connection.readyState === WebSocket.OPEN) {
      console.log("[VPS-CONNECTOR] Already connected to VPS Relay Proxy");
      return;
    }

    const token = this._generateToken();
    const url = new URL(this.config.vpsUrl);
    url.searchParams.set("token", token);
    const fullUrl = url.toString();

    console.log(
      `[VPS-CONNECTOR] Connecting to VPS Relay Proxy at: ${this.config.vpsUrl}`
    );
    // console.log(`[VPS-CONNECTOR-DEBUG] Connection URL: ${fullUrl}`);

    return new Promise((resolve, reject) => {
      try {
        this.connection = new WebSocket(fullUrl);

        this.connection.on("open", () => {
          console.log("[VPS-CONNECTOR] Connected to VPS Relay Proxy");
          // console.log(`[VPS-CONNECTOR-DEBUG] WebSocket readyState: ${WebSocket.readyStateNames[this.connection.readyState]}`);
          this.connected = true;
          this.retryCount = 0;
          this.emit("connected");

          // Send required register message for proxy routing
          const registerMessage = JSON.stringify({
            type: "register",
            boatIds: [boatId],
            role: "boat-server",
          });
          this.connection.send(registerMessage);

          // Send initial message to identify as a relay server
          const identityMessage = JSON.stringify({
            type: "identity",
            boatId: boatId,
            role: "boat-server",
            time: new Date().toISOString(),
          });
          this.connection.send(identityMessage);
          resolve();
        });

        // Handle incoming messages from the VPS Relay Proxy
        this.connection.on("message", (data) => {
          try {
            const message = JSON.parse(data);

            // Handle connection status updates
            if (message.type === "connectionStatus") {
              const { boatId, clientCount } = message;
              console.log(
                `[VPS-CONNECTOR] Client count for boat ${boatId}: ${clientCount}`
              );
              
              // Update our internal client count
              this._clientCount = clientCount;

              // Emit a new event type for connection status
              this.emit("connectionStatus", { boatId, clientCount });
            } else {
              // Forward other messages as before
              this.emit("message", message);
            }
          } catch (error) {
            console.error("[VPS-CONNECTOR] Error parsing message:", error);
          }
        });

        this.connection.on("close", () => {
          console.log("[VPS-CONNECTOR] Disconnected from VPS Relay Proxy");
          this.connected = false;
          this.emit("disconnected");
          this._reconnect();
        });

        this.connection.on("error", (error) => {
          console.error("[VPS-CONNECTOR] Connection error:", error.message);
          this.emit("error", error);
          reject(error);
        });
      } catch (error) {
        console.error("[VPS-CONNECTOR] Failed to connect:", error);
        this.emit("error", error);
        this._reconnect();
        reject(error);
      }
    });
  }

  /**
   * Reconnect to the VPS Relay Proxy after a delay
   */
  _reconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    // Defensive: fallback to defaults if config is missing
    const interval = this.config?.reconnectInterval ?? 5000;
    const maxRetries = this.config?.maxRetries ?? 10;

    if (this.retryCount >= maxRetries) {
      console.error(
        `[VPS-CONNECTOR] Max retries (${maxRetries}) reached, giving up`
      );
      this.emit("max-retries");
      return;
    }

    this.retryCount++;
    console.log(
      `[VPS-CONNECTOR] Reconnecting in ${interval}ms (attempt ${this.retryCount}/${maxRetries})`
    );
    this.reconnectTimer = setTimeout(() => this.connect(), interval);
  }

  /**
   * Send data to the VPS relay proxy
   * @param {Object|Array} data - Data to send
   * @returns {boolean} - Success status
   */
  send(data) {
    if (!this.connection || this.connection.readyState !== WebSocket.OPEN) {
      console.warn("[VPS-CONNECTOR] Cannot send data - not connected");
      return false;
    }

    // Check if we have any remote clients connected
    if (this._clientCount <= 0 && this._shouldSkipMessage(data)) {
      console.log("[VPS-CONNECTOR] Suppressing message - no remote clients connected");
      return true; // Return true to indicate "success" even though we didn't send
    }

    try {
      // Handle array case (send sequentially)
      if (Array.isArray(data)) {
        if (data.length === 0) return true;

        let allSuccess = true;
        for (const item of data) {
          if (!this._sendSingle(item)) {
            allSuccess = false;
          }
        }
        return allSuccess;
      }

      // Single message case
      return this._sendSingle(data);
    } catch (error) {
      console.error("[VPS-CONNECTOR] Send failed:", error);
      return false;
    }
  }

  /**
   * Determine if a message should be skipped when no clients are connected
   * @private
   * @param {Object} data - Message data
   * @returns {boolean} - Whether to skip the message
   */
  _shouldSkipMessage(data) {
    // Always send identity, registration, and heartbeat messages
    if (data.type === "identity" || 
        data.type === "register" || 
        data.type === "subscribe" || 
        data.type === "heartbeat") {
      return false;
    }
    
    // Skip state updates and other messages when no clients
    return true;
  }

  // Private method for single message sending
  _sendSingle(data) {
    try {
      const payload = typeof data === "string" ? data : JSON.stringify(data);
      this.connection.send(payload);
      return true;
    } catch (error) {
      console.error("[VPS-CONNECTOR] Single message send failed:", error);
      return false;
    }
  }

  /**
   * Disconnect from the VPS Relay Proxy
   */
  disconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.connection) {
      this.connection.close();
      this.connection = null;
    }

    this.connected = false;
    console.log("[VPS-CONNECTOR] Disconnected from VPS Relay Proxy");
  }
}

// Add readyState names for better debugging
WebSocket.readyStateNames = {
  [WebSocket.CONNECTING]: "CONNECTING",
  [WebSocket.OPEN]: "OPEN",
  [WebSocket.CLOSING]: "CLOSING",
  [WebSocket.CLOSED]: "CLOSED",
};

// Top-level: prevent process crash on uncaught exceptions
if (typeof process !== "undefined" && process.on) {
  process.on("uncaughtException", (err) => {
    console.error("[VPS-CONNECTOR] Uncaught Exception:", err);
    // Optionally: implement clean shutdown or restart logic here
  });
}
