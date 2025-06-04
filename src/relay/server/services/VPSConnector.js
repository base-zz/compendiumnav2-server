import WebSocket from "ws";
import EventEmitter from "events";
import jwt from "jsonwebtoken";
import { getOrCreateAppUuid } from "../../../state/uniqueAppId.js";
import { getOrCreateKeyPair, signMessage, registerPublicKeyWithVPS } from "../../../state/keyPair.js";

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
    this.pingInterval = null;
    this._clientCount = 0;
    // Ensure sensible defaults
    this.config.reconnectInterval = this.config.reconnectInterval || 5000;
    this.config.maxRetries = this.config.maxRetries || 10;
    this.config.pingInterval = this.config.pingInterval || 25000; // 25 second ping interval
    this.config.connectionTimeout = this.config.connectionTimeout || 30000; // 30 second connection timeout
    // tokenSecret is optional when using key-based authentication
    if (!this.config.vpsUrl)
      throw new Error("VPSConnector: vpsUrl is required in config");
  }

  initialize(config = {}) {
    // Setup config using env vars or provided config
    const mergedConfig = { ...config };
    mergedConfig.vpsUrl = this._buildVpsUrl(config);
    // We're using key-based authentication, so tokenSecret is not needed
    mergedConfig.tokenSecret = ""; // Empty string for key-based auth
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
    mergedConfig.pingInterval = this._getNumericConfig(
      "VPS_PING_INTERVAL",
      config.pingInterval,
      25000 // Default to 25 seconds for production use
    );
    mergedConfig.connectionTimeout = this._getNumericConfig(
      "VPS_CONNECTION_TIMEOUT",
      config.connectionTimeout,
      30000 // Default to 30 seconds for connection timeout
    );
    this.config = mergedConfig;
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
      console.warn(
        "[SECURITY WARNING] Using insecure WebSocket connection for development"
      );
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
      console.log("[VPS-CONNECTOR] Cannot send identity, not connected");
      return;
    }

    const boatId = getOrCreateAppUuid();
    console.log(`[VPS-CONNECTOR-DEBUG] Creating identity message for boat ${boatId}`);
    console.log(`[VPS-CONNECTOR-DEBUG] This boatId must match the one clients are using to connect`);
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
          console.log(`[VPS-DEBUG] Found private key, generating signature`);
          identityMessage.signature = signature;
          console.log(`[VPS-DEBUG] Added signature to identity message (first 20 chars): ${signature.substring(0, 20)}...`);
          
          // After sending identity, register the public key via WebSocket
          // This is a new addition to register the key through WebSocket
          setTimeout(() => {
            this._registerPublicKeyViaWebSocket();
          }, 1000); // Wait 1 second to ensure identity is processed first
        } else {
          console.log(`[VPS-DEBUG] No private key available, sending unsigned message`);
        }
      } catch (error) {
        console.error(`[VPS-DEBUG] Error signing message:`, error);
      }
    }
    
    // Log and send the identity message
    console.log(`[VPS-DEBUG] Sending identity message: ${JSON.stringify(identityMessage)}`);
    this.connection.send(JSON.stringify(identityMessage));
  }
  
  /**
   * Register the public key via WebSocket
   * @private
   */
  _registerPublicKeyViaWebSocket() {
    if (!this.connection || this.connection.readyState !== WebSocket.OPEN) {
      console.log("[VPS-CONNECTOR] Cannot register key, not connected");
      return;
    }
    
    const boatId = getOrCreateAppUuid();
    const keyPair = getOrCreateKeyPair();
    
    if (!keyPair) {
      console.log("[VPS-CONNECTOR] No key pair available for registration");
      return;
    }
    
    console.log(`[VPS-CONNECTOR] Registering public key via WebSocket`);
    
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
            console.log(`[VPS-CONNECTOR] Public key registered successfully via WebSocket`);
          } else {
            console.error(`[VPS-CONNECTOR] Failed to register public key via WebSocket: ${response.error || 'Unknown error'}`);
          }
        }
      } catch (error) {
        // Ignore parsing errors for other messages
      }
    };
    
    this.connection.addEventListener('message', responseHandler);
    
    // Send the registration message
    this.connection.send(JSON.stringify(message));
    console.log(`[VPS-CONNECTOR] Sent key registration message via WebSocket`);
  }

  /**
   * Connect to the VPS Relay Proxy
   */
  async connect() {
    if (this.connection && this.connection.readyState === WebSocket.OPEN) {
      console.log("[VPS-CONNECTOR] Already connected to VPS Relay Proxy");
      return;
    }

    // Always use key-based authentication
    console.log(`[VPS-CONNECTOR] Authentication method: key-based`);
    
    // Generate empty token (not used with key-based auth)
    const token = this._generateToken();
    console.log(`[VPS-CONNECTOR] Token generated: NO`); 
    
    // Register the public key for key-based auth
    let keyRegistrationSuccess = false;
    {
      const keyPair = getOrCreateKeyPair();
      console.log(`[VPS-CONNECTOR] Key pair available: ${!!keyPair}`);
      if (keyPair) {
        console.log(`[VPS-CONNECTOR] Public key (first 20 chars): ${keyPair.publicKey.substring(0, 20)}...`);
        
        // Try to register the public key with the VPS, but don't block connection if it fails
        try {
          console.log(`[VPS-CONNECTOR] Registering public key with VPS...`);
          keyRegistrationSuccess = await registerPublicKeyWithVPS(this.config.vpsUrl);
          console.log(`[VPS-CONNECTOR] Public key registration ${keyRegistrationSuccess ? 'successful' : 'failed'}`);
        } catch (error) {
          console.error(`[VPS-CONNECTOR] Error registering public key:`, error);
          console.log(`[VPS-CONNECTOR] Will continue with connection despite registration failure`);
        }
      }
    }
    
    const url = new URL(this.config.vpsUrl);
    url.searchParams.set("token", token);
    const fullUrl = url.toString();

    console.log(
      `[VPS-CONNECTOR] Connecting to VPS Relay Proxy at: ${this.config.vpsUrl}`
    );
    console.log(`[VPS-CONNECTOR-DEBUG] Connection URL: ${fullUrl}`);

    return new Promise((resolve, reject) => {
      // Set a connection timeout
      const connectionTimeout = setTimeout(() => {
        console.error(`[VPS-CONNECTOR] Connection timeout after ${this.config.connectionTimeout/1000} seconds to ${this.config.vpsUrl}`);
        if (this.connection) {
          this.connection.terminate();
        }
        reject(new Error('Connection timeout'));
      }, this.config.connectionTimeout);
      
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

          // Send initial message to identify as a relay server with signature
          const identityMessage = this._sendIdentity();
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
                `[VPS-CONNECTOR] Received connectionStatus message from VPS: boat ${boatId}, clients: ${clientCount}`
              );
              
              // Log the full message for debugging
              console.log(`[VPS-CONNECTOR] Full connectionStatus message:`, JSON.stringify(message));
              
              // Update our internal client count
              this._clientCount = clientCount;
              console.log(`[VPS-CONNECTOR] Updated internal client count to ${this._clientCount}`);

              // Emit a new event type for connection status
              console.log(`[VPS-CONNECTOR] Emitting connectionStatus event: boat ${boatId}, clients: ${clientCount}`);
              this.emit("connectionStatus", { boatId, clientCount });
            } else if (message.type === "pong") {
              // Calculate round-trip latency
              const now = Date.now();
              const sentTime = message.echo;
              const latencyMs = now - sentTime;
              
              // console.log(`[VPS-CONNECTOR] Received pong from server (latency: ${latencyMs}ms)`);
              
              // Store recent latency values for potential monitoring
              this._latencyValues = this._latencyValues || [];
              this._latencyValues.push(latencyMs);
              // Keep only the last 10 values
              if (this._latencyValues.length > 10) {
                this._latencyValues.shift();
              }
            } else {
              // Forward other messages
              this.emit("message", message);
            }
          } catch (error) {
            console.error("[VPS-CONNECTOR] Error parsing message:", error);
          }
        });
        
        // Setup ping interval to keep the connection alive
        if (this.pingInterval) {
          clearInterval(this.pingInterval);
        }
        
        this.pingInterval = setInterval(() => {
          if (this.connection && this.connection.readyState === WebSocket.OPEN) {
            // Send a ping message
            const pingMessage = JSON.stringify({
              type: "ping",
              timestamp: Date.now()
            });
            this.connection.send(pingMessage);
            
            // Only log at debug level if ping interval is longer than 10 seconds
            // This reduces log spam for frequent pings
            // if (this.config.pingInterval >= 10000) {
            //   console.log(`[VPS-CONNECTOR] Sent ping to keep connection alive (interval: ${this.config.pingInterval/1000}s)`);
            // }
          }
        }, this.config.pingInterval);
        
        // Clear the connection timeout since we're connected
        clearTimeout(connectionTimeout);
        
        this.connection.on("close", () => {
          console.log("[VPS-CONNECTOR] Disconnected from VPS Relay Proxy");
          this.connected = false;
          this.emit("disconnected");
          this._reconnect();
        });

      this.connection.on("error", (error) => {
        console.error("[VPS-CONNECTOR] Connection error:", error.message);
        console.error(`[VPS-CONNECTOR] Failed to connect to VPS at ${this.config.vpsUrl}`);
        console.error(`[VPS-CONNECTOR] Authentication method: key-based`); 
        console.log(`[VPS-CONNECTOR] Using key-based authentication with boat ID: ${boatId}`);
        const keyPair = getOrCreateKeyPair();
        console.log(`[VPS-CONNECTOR] Key pair available: ${!!keyPair}`);
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
  // Always send identity, registration, heartbeat, and ping messages
  if (data.type === "identity" || 
      data.type === "register" || 
      data.type === "subscribe" || 
      data.type === "heartbeat" || 
      data.type === "ping") {
    return false;
  }
  
  // Skip state updates and other messages when no clients
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
    
    // Extract message details for logging
    let messageDetails = {};
    if (typeof data === "object") {
      messageDetails = {
        type: data.type,
        messageId: data.id || 'unknown',
        timestamp: new Date().toISOString(),
        dataSize: payload.length
      };
      console.log(`[VPS-CONNECTOR] Sending message to VPS:`, messageDetails);
    } else {
      console.log(`[VPS-CONNECTOR] Sending raw message to VPS, size: ${payload.length} bytes`);
    }
    
    this.connection.send(payload);
    
    // Log successful send
    if (typeof data === "object" && data.type) {
      console.log(`[VPS-CONNECTOR] Successfully sent ${data.type} message to VPS`);
    } else {
      console.log(`[VPS-CONNECTOR] Successfully sent message to VPS`);
    }
    
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
  console.log("[VPS-CONNECTOR] Disconnected from VPS Relay Proxy");
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
    console.error("[VPS-CONNECTOR] Uncaught Exception:", err);
    // Optionally: implement clean shutdown or restart logic here
  });
}
