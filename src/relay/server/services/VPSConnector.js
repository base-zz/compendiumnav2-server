import WebSocket from "ws";
import EventEmitter from "events";
import jwt from "jsonwebtoken";
import debug from "debug";
import { getOrCreateAppUuid } from "../../../state/uniqueAppId.js";
import { getOrCreateKeyPair, signMessage, registerPublicKeyWithVPS } from "../../../state/keyPair.js";

const boatId = getOrCreateAppUuid();

const log = debug("compendium:vps-connector");
const logWarn = debug("compendium:vps-connector:warn");
const logError = debug("compendium:vps-connector:error");
const logTrace = debug("compendium:vps-connector:trace");

/**
 * VPSConnector
 *
 * Handles the connection from the Relay Server to the VPS Relay Proxy
 */
export class VPSConnector extends EventEmitter {
  constructor(config = {}) {
    super();

    // Initialize properties
    this.connection = null;
    this.connected = false;
    this.retryCount = 0;
    this.reconnectTimer = null;
    this.pingInterval = null;
    this._clientCount = 0;
    this._latencyValues = [];

    // Build final configuration, merging defaults, environment variables, and provided config
    const finalConfig = {};
    finalConfig.vpsUrl = this._buildVpsUrl();
    finalConfig.reconnectInterval = this._getNumericConfig(
      "VPS_RECONNECT_INTERVAL",
      config.reconnectInterval,
      5000
    );
    finalConfig.maxRetries = this._getNumericConfig(
      "VPS_MAX_RETRIES",
      config.maxRetries,
      10
    );
    finalConfig.pingInterval = this._getNumericConfig(
      "VPS_PING_INTERVAL",
      config.pingInterval,
      25000
    );
    finalConfig.connectionTimeout = this._getNumericConfig(
      "VPS_CONNECTION_TIMEOUT",
      config.connectionTimeout,
      30000
    );
    this.config = finalConfig;

    // Validate configuration
    if (!this.config.vpsUrl) {
      throw new Error("VPSConnector: vpsUrl could not be constructed. Check VPS_HOST environment variable.");
    }
  }

  _buildVpsUrl() {
    const host = process.env.VPS_HOST;
    const port = process.env.VPS_WS_PORT;
    const path = process.env.VPS_PATH || "/relay";
    
    if (!host)
      throw new Error("VPS_HOST must be set in the environment or config.");

    // Always use secure WebSockets (wss) in production
    if (process.env.NODE_ENV === "production") {
      // In production, we only allow secure connections
      const protocol = "wss";
      
      // In production, we should use port 443 or default port
      if (port && port !== "443") {
        throw new Error(
          "Production requires port 443 or omit VPS_WS_PORT to use the default port for wss."
        );
      }
      
      // Omit port for default (443)
      return port ? `${protocol}://${host}:${port}${path}` : `${protocol}://${host}${path}`;
    } else {
      // Development mode
      const protocol = "ws";
      if (!port) throw new Error("VPS_WS_PORT must be set in development.");
      logWarn("[SECURITY WARNING] Using insecure WebSocket connection for development");
      return `${protocol}://${host}:${port}${path}`;
    }
  }

  _getNumericConfig(envVar, configValue, defaultValue) {
    const value = process.env[envVar] || configValue;
    return value ? parseInt(value, 10) : defaultValue;
  }

  /**
   * Generate an empty token (key-based auth doesn't need tokens)
   * @private
   * @returns {string} Empty string as we use key-based authentication
   */
  _generateToken() {
    // Key-based authentication doesn't use tokens
    return "";
  }

  /**
   * Send identity message to the VPS
   * @private
   */
  _sendIdentity() {
    if (!this.connection || this.connection.readyState !== WebSocket.OPEN) {
      log("Cannot send identity, not connected");
      return;
    }

    const boatId = getOrCreateAppUuid();
    logTrace(`Creating identity message for boat ${boatId}`);
    logTrace(`This boatId must match the one clients are using to connect`);
    // Store the boatId for reference
    this.boatId = boatId;
    
    // Create the identity message
    const timestamp = Date.now();
    const identityMessage = {
      type: "identity",
      boatId,
      role: "boat-server",
      timestamp,
      time: new Date().toISOString()
    };
    
    // Always use key-based authentication
    {
      try {
        // Sign the message with our private key
        const signature = signMessage(`${boatId}:${timestamp}`);
        if (signature) {
          logTrace(`Found private key, generating signature`);
          identityMessage.signature = signature;
          logTrace(`Added signature to identity message (first 20 chars): ${signature.substring(0, 20)}...`);

          // After sending identity, register the public key via WebSocket
          // This is a new addition to register the key through WebSocket
          setTimeout(() => {
            this._registerPublicKeyViaWebSocket();
          }, 1000); // Wait 1 second to ensure identity is processed first
        } else {
          logWarn(`No private key available, sending unsigned message`);
        }
      } catch (error) {
        logError(`Error signing message: %s`, error);
      }
    }

    // Log and send the identity message
    logTrace(`Sending identity message: ${JSON.stringify(identityMessage)}`);
    this.connection.send(JSON.stringify(identityMessage));
  }
  
  /**
   * Register the public key via WebSocket
   * @private
   */
  _registerPublicKeyViaWebSocket() {
    if (!this.connection || this.connection.readyState !== WebSocket.OPEN) {
      log("Cannot register key, not connected");
      return;
    }

    const boatId = getOrCreateAppUuid();
    const keyPair = getOrCreateKeyPair();

    if (!keyPair) {
      logWarn("No key pair available for registration");
      return;
    }

    log(`Registering public key via WebSocket`);
    
    const message = {
      type: "register-key",
      boatId,
      publicKey: keyPair.publicKey,
      timestamp: Date.now()
    };
    
    // Listen for the response
    const responseHandler = (event) => {
      try {
        const response = JSON.parse(event.data);

        if (response.type === "register-key-response" && response.boatId === boatId) {
          // Remove the event listener once we get the response
          this.connection.removeEventListener('message', responseHandler);

          if (response.success) {
            log(`Public key registered successfully via WebSocket`);
          } else {
            logError(`Failed to register public key via WebSocket: ${response.error || 'Unknown error'}`);
          }
        }
      } catch (error) {
        // Ignore parsing errors for other messages
      }
    };
    
    this.connection.addEventListener('message', responseHandler);

    // Send the registration message
    this.connection.send(JSON.stringify(message));
    log(`Sent key registration message via WebSocket`);
  }

  /**
   * Connect to the VPS Relay Proxy
   */
  async connect() {
    if (this.connection && this.connection.readyState === WebSocket.OPEN) {
      log("Already connected to VPS Relay Proxy");
      return;
    }

    // Always use key-based authentication
    log(`Authentication method: key-based`);

    // Generate empty token (not used with key-based auth)
    const token = this._generateToken();
    log(`Token generated: NO`);

    // Register the public key for key-based auth
    let keyRegistrationSuccess = false;
    {
      const keyPair = getOrCreateKeyPair();
      log(`Key pair available: ${!!keyPair}`);
      if (keyPair) {
        logTrace(`Public key (first 20 chars): ${keyPair.publicKey.substring(0, 20)}...`);

        // Try to register the public key with the VPS, but don't block connection if it fails
        try {
          log(`Registering public key with VPS...`);
          keyRegistrationSuccess = await registerPublicKeyWithVPS(this.config.vpsUrl);
          log(`Public key registration ${keyRegistrationSuccess ? 'successful' : 'failed'}`);
        } catch (error) {
          logError(`Error registering public key: %s`, error);
          logWarn(`Will continue with connection despite registration failure`);
        }
      }
    }
    
    const url = new URL(this.config.vpsUrl);
    url.searchParams.set("token", token);
    const fullUrl = url.toString();

    log(`Connecting to VPS Relay Proxy at: ${this.config.vpsUrl}`);
    logTrace(`Connection URL: ${fullUrl}`);

    return new Promise((resolve, reject) => {
      // Set a connection timeout
      const connectionTimeout = setTimeout(() => {
        logError(`Connection timeout after ${this.config.connectionTimeout/1000} seconds to ${this.config.vpsUrl}`);
        if (this.connection) {
          this.connection.terminate();
        }
        reject(new Error('Connection timeout'));
      }, this.config.connectionTimeout);
      
      try {
        this.connection = new WebSocket(fullUrl);

        this.connection.on("open", () => {
          log("Connected to VPS Relay Proxy");
          // logTrace(`WebSocket readyState: ${WebSocket.readyStateNames[this.connection.readyState]}`);
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

          // Send initial message to identify as a relay server with signature
          this._sendIdentity();

          resolve();
        });

        // Handle incoming messages from the VPS Relay Proxy
        this.connection.on("message", (data) => {
          try {
            const message = JSON.parse(data.toString());

            // Handle connection status updates
            if (message.type === "connectionStatus") {
              const { boatId, clientCount } = message;
              log(`Received connectionStatus message from VPS: boat ${boatId}, clients: ${clientCount}`);
              logTrace(`Full connectionStatus message: %s`, JSON.stringify(message));
              this._clientCount = clientCount;
              log(`Updated internal client count to ${this._clientCount}`);
              this.emit("connectionStatus", { boatId, clientCount });
            } else if (message.type === "pong") {
              const now = Date.now();
              const sentTime = message.echo;
              const latencyMs = now - sentTime;
              logTrace(`Received pong from server (latency: ${latencyMs}ms)`);
              this._latencyValues = this._latencyValues || [];
              this._latencyValues.push(latencyMs);
              if (this._latencyValues.length > 10) {
                this._latencyValues.shift();
              }
            } else {
              this.emit("message", message);
            }
          } catch (error) {
            logError("Error parsing message: %s", error);
          }
        });

        // Setup ping interval to keep the connection alive
        if (this.pingInterval) {
          clearInterval(this.pingInterval);
        }

        this.pingInterval = setInterval(() => {
          if (this.connection && this.connection.readyState === WebSocket.OPEN) {
            const pingMessage = JSON.stringify({
              type: "ping",
              timestamp: Date.now(),
            });
            this.connection.send(pingMessage);
          }
        }, this.config.pingInterval);

        // Clear the connection timeout since we're connected
        clearTimeout(connectionTimeout);

        this.connection.on("close", () => {
          log("Disconnected from VPS Relay Proxy");
          this.connected = false;
          this.emit("disconnected");
          this._reconnect();
        });

        this.connection.on("error", (error) => {
          logError("Connection error: %s", error.message);
          logError(`Failed to connect to VPS at ${this.config.vpsUrl}`);
          this.emit("error", error);
          clearTimeout(connectionTimeout);
          this._reconnect();
          reject(error);
        });
      } catch (error) {
        logError("Failed to connect: %s", error);
        this.emit("error", error);
        clearTimeout(connectionTimeout);
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
    const interval = this.config?.reconnectInterval ?? 5000;
    const maxRetries = this.config?.maxRetries ?? 10;

    if (this.retryCount >= maxRetries) {
      logError(`Max retries (${maxRetries}) reached, giving up`);
      this.emit("max-retries");
      return;
    }

    this.retryCount++;
    log(`Reconnecting in ${interval}ms (attempt ${this.retryCount}/${maxRetries})`);
    this.reconnectTimer = setTimeout(() => this.connect(), interval);
  }

  /**
   * Gracefully shut down the connection and clean up resources
   */
  shutdown() {
    log("Shutting down VPS connection...");
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    if (this.connection) {
      // Remove all listeners to prevent reconnection attempts
      this.connection.removeAllListeners();
      this.connection.close();
      this.connection = null;
    }
    this.connected = false;
    log("VPS connection shut down.");
  }

  /**
   * Send data to the VPS relay proxy
   * @param {Object|Array} data - Data to send
   * @returns {boolean} - Success status
   */
  send(data) {
    if (!this.connection || this.connection.readyState !== WebSocket.OPEN) {
      logWarn("Cannot send data - not connected");
      return false;
    }

    if (this._clientCount <= 0 && this._shouldSkipMessage(data)) {
      logTrace("Suppressing message - no remote clients connected");
      return true;
    }

    try {
      if (Array.isArray(data)) {
        data.forEach((msg) => this._sendSingle(msg));
        return true;
      }
      return this._sendSingle(data);
    } catch (error) {
      logError("Send failed: %s", error);
      return false;
    }
  }

  /**
   * Check if a message should be skipped when no clients are connected
   * @private
   * @param {Object} data - Message data
   * @returns {boolean} - Whether to skip the message
   */
  _shouldSkipMessage(data) {
    if (
      !data ||
      data.type === "identity" ||
      data.type === "register" ||
      data.type === "subscribe" ||
      data.type === "heartbeat" ||
      data.type === "ping" ||
      data.type === "anchor:update"
    ) {
      return false;
    }
    return true;
  }

  /**
   * Private method for single message sending
   * @private
   * @param {Object|string} data - Data to send
   * @returns {boolean} - Success status
   */
  _sendSingle(data) {
    try {
      const payload = typeof data === "string" ? data : JSON.stringify(data);

      let messageDetails = {};
      if (typeof data === "object" && data !== null && data.type) {
        messageDetails = {
          type: data.type,
          messageId: data.id || "unknown",
          timestamp: new Date().toISOString(),
          dataSize: payload.length,
        };
        logTrace(`Sending message to VPS: %o`, messageDetails);
      } else {
        logTrace(`Sending raw message to VPS, size: ${payload.length} bytes`);
      }

      this.connection.send(payload);

      if (typeof data === "object" && data !== null && data.type) {
        logTrace(`Successfully sent ${data.type} message to VPS`);
      } else {
        logTrace(`Successfully sent message to VPS`);
      }

      return true;
    } catch (error) {
      logError("Single message send failed: %s", error);
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

  if (this.pingInterval) {
    clearInterval(this.pingInterval);
    this.pingInterval = null;
  }

  if (this.connection) {
    this.connection.close();
    this.connection = null;
  }

  this.connected = false;
  this.connecting = false;
  this.emit("disconnected");
  log("Disconnected from VPS Relay Proxy");
}

  // Get readable name for WebSocket readyState
  _getReadyStateName(readyState) {
    const names = {
      [WebSocket.CONNECTING]: "CONNECTING",
      [WebSocket.OPEN]: "OPEN",
      [WebSocket.CLOSING]: "CLOSING",
      [WebSocket.CLOSED]: "CLOSED"
    };
    return names[readyState] || `UNKNOWN(${readyState})`;
  }
}

// Top-level: prevent process crash on uncaught exceptions
if (typeof process !== "undefined" && process.on) {
  process.on("uncaughtException", (err) => {
    logError("Uncaught Exception: %s", err);
    // Optionally: implement clean shutdown or restart logic here
  });
}
