import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import { v4 as uuidv4 } from 'uuid';

// Extended WebSocket type with custom properties
/**
 * @typedef {Object} ExtendedWebSocket
 * @property {string} [userId]
 * @property {string} [vesselId]
 * @property {boolean} [isAlive]
 * @property {string} [clientId]
 * @property {import('net').Socket} [_socket]
 */

// Extend the WebSocket type with our custom properties
/** @typedef {WebSocket & ExtendedWebSocket} ClientWebSocket */

/**
 * RelayWebSocketServer
 * 
 * Handles WebSocket connections for the relay server
 */
export class RelayWebSocketServer {
  constructor(relayServer, options = {}) {
    this.relayServer = relayServer;
    
    // Ensure we prioritize the PORT environment variable
    this.port = parseInt(process.env.VPS_WS_PORT, 10);
    if (isNaN(this.port)) throw new Error('Invalid VPS_WS_PORT in .env.server');
    
    this.options = {
      port: this.port,
      path: process.env.VPS_PATH,
      ...options
    };
    
    console.log(`[WS-INIT] Configuring WebSocket server on port ${this.options.port}`);
    
    this.server = null;
    this.clients = new Map();
  }
  
  /**
   * Initialize the WebSocket server
   */
  initialize() {
    // Create HTTP server first
    const httpServer = createServer();
    
    // Create WebSocket server using the HTTP server
    this.server = new WebSocketServer({
      server: httpServer,
      path: this.options.path,
      clientTracking: true,
      // ping/pong is handled manually in _setupPingInterval
    });
    
    // Set up ping interval after server is created
    this._setupPingInterval();
    
    // Start HTTP server
    return new Promise((resolve, reject) => {
      httpServer.listen(this.options.port, () => {
        console.log(`[WS] WebSocket server started on port ${this.options.port} with path ${this.options.path}`);
        this._setupEventHandlers();
        resolve(this);
      });
      
      httpServer.on('error', (error) => {
        console.error('[WS] Failed to start server:', error);
        reject(error);
      });
    });
  }
  
  /**
   * Set up WebSocket event handlers
   */
  _setupEventHandlers() {
    // Listen for state events from the RelayServer's StateManager
    // This ensures that anchor updates and other state changes are broadcast to clients
    this.relayServer.stateManager.on('state:patch', (payload) => {
      console.log(`[WS] Received state patch event with ${payload.data?.length || 0} operations`);
      this._broadcastToSubscribers(payload);
    });
    
    this.relayServer.stateManager.on('state:full-update', (payload) => {
      console.log(`[WS] Received full state update event`);
      this._broadcastToSubscribers(payload);
    });
    
    this.server.on('connection', (/** @type {ClientWebSocket} */ ws, req) => {
      const clientId = uuidv4();
      
      // Extract token from URL parameters
      const url = new URL(`http://${req.headers.host}${req.url}`);
      const token = url.searchParams.get('token');
      
      // Validate token
      if (!token) {
        console.warn(`[WS] Client ${clientId} attempted to connect without token`);
        ws.close(4001, 'Authentication required');
        return;
      }
      
      // Validate the token
      const validation = this.relayServer.validateToken(token);
      if (!validation.valid) {
        console.warn(`[WS] Client ${clientId} provided invalid token: ${validation.reason}`);
        ws.close(4001, validation.reason);
        return;
      }
      
      // Set user context from token
      ws.userId = validation.userId;
      ws.vesselId = validation.vesselId;
      
      // Store client with user context
      this.clients.set(clientId, ws);
      
      // Set properties on the WebSocket object to track its state
      ws.isAlive = true;
      ws.clientId = clientId;
      
      // Handle pong messages to keep connection alive
      ws.on('pong', () => {
        ws.isAlive = true;
        console.log(`[WS] Received pong from client ${clientId}`);
      });
      
      // Register client with relay server
      this.relayServer.addClient(clientId);
      
      console.log(`[WS] Client ${clientId} connected from ${req.socket.remoteAddress}`);
      
      // Send welcome message
      ws.send(JSON.stringify({
        type: 'connection',
        status: 'connected',
        clientId,
        timestamp: Date.now()
      }));
      
      // Handle client messages
      ws.on('message', (message) => {
        console.log('========================================');
        console.log(`[RELAYSERVER/WS] ⚡ MESSAGE RECEIVED FROM CLIENT ${clientId} ⚡`);
        console.log('========================================');
        
        let parsedMessage;
        let rawMessage;
        
        try {
          // Log raw message details
          if (Buffer.isBuffer(message) || message instanceof ArrayBuffer) {
            rawMessage = message.toString();
            console.log(`[WS] Received buffer message from client ${clientId}:`, rawMessage);
            parsedMessage = JSON.parse(rawMessage);
          } else if (typeof message === 'string') {
            rawMessage = message;
            console.log(`[WS] Received string message from client ${clientId}:`, rawMessage);
            parsedMessage = JSON.parse(rawMessage);
          } else if (typeof message === 'object' && message !== null) {
            // Already parsed (can happen with some WebSocket libraries)
            parsedMessage = message;
            rawMessage = JSON.stringify(parsedMessage);
            console.log(`[WS] Received object message from client ${clientId}:`, parsedMessage);
          } else {
            console.warn(`[WS] Received unknown message type from client ${clientId}:`, typeof message, message);
            return;
          }
          
          // Log detailed message info
          console.log(`[WS] Message details:`, {
            clientId,
            type: parsedMessage.type || 'unknown',
            action: parsedMessage.action || 'none',
            hasData: !!parsedMessage.data,
            rawLength: rawMessage ? rawMessage.length : 0,
            messageId: parsedMessage.id || 'none',
            timestamp: new Date().toISOString()
          });
          
          // Log full message for specific types
          if (parsedMessage.type === 'anchor:update' || parsedMessage.type === 'command') {
            console.log(`[WS] Full ${parsedMessage.type} message:`, JSON.stringify(parsedMessage, null, 2));
          }
          
          this._handleClientMessage(clientId, parsedMessage);
        } catch (error) {
          console.error(`[WS] Error processing message from client ${clientId}:`, error);
          console.error(`[WS] Error message:`, error.message);
          console.error(`[WS] Error stack:`, error.stack);
          console.error(`[WS] Raw message that caused error:`, rawMessage || message);
          
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              type: 'error',
              error: 'Invalid message format',
              details: error.message,
              timestamp: Date.now()
            }));
          }
        }
      });
      
      // Handle client disconnection
      ws.on('close', () => {
        console.log(`[WS] Client ${clientId} disconnected`);
        this.relayServer.removeClient(clientId);
        this.clients.delete(clientId);
      });
      
      // Handle errors
      ws.on('error', (error) => {
        console.error(`[WS] Error with client ${clientId}:`, error);
      });
    });
    
    // Listen for data from the relay server to send to clients
    this.relayServer.on('dataToSend', (data) => {
      if (process.env.DEBUG === 'true') {
        console.log(`[WS] Received dataToSend event with type: ${data.type}`);
      }
      this._broadcastToSubscribers(data);
    });
  }
  
  /**
   * Handle messages from clients
   */
  async _handleClientMessage(clientId, message) {
    const { type, action, data } = message;
    
    // Always log message details in debug mode or for certain message types
    if (process.env.DEBUG === 'true' || type === 'anchor:update' || type === 'command') {
      console.log(`[WS-DEBUG] Processing ${type} message from client ${clientId}:`, {
        action,
        hasData: !!data,
        messageId: message.id || 'none',
        timestamp: new Date().toISOString()
      });
    }
    
    // Handle messages with serviceName format (e.g., { serviceName: "state", action: "bluetooth:select-device", data: {...} })
    if (message.serviceName === 'state' && message.action && message.data) {
      console.log('[STATE-MESSAGE] WebSocketServer: Received state service message:', JSON.stringify(message, null, 2));
      
      // Check if this is a bluetooth device selection message
      if (message.action === 'bluetooth:select-device' && message.data.deviceId) {
        console.log('[BLUETOOTH-SELECT] WebSocketServer: Detected bluetooth:select-device action');
        await this._handleBluetoothCommand(clientId, 'select-device', message.data);
        return;
      } else if (message.action === 'bluetooth:deselect-device' && message.data.deviceId) {
        console.log('[BLUETOOTH-DESELECT] WebSocketServer: Detected bluetooth:deselect-device action');
        await this._handleBluetoothCommand(clientId, 'deselect-device', message.data);
        return;
      }
    }
    
    switch (type) {
      case 'subscription':
        // Handle subscription changes
        if (action === 'update' && Array.isArray(data)) {
          console.log(`[WS] Client ${clientId} updated subscriptions to:`, data);
          this.relayServer.updateClientSubscriptions(clientId, data);
          this._sendToClient(clientId, {
            type: 'subscription',
            status: 'updated',
            subscriptions: data,
            timestamp: Date.now()
          });
        }
        break;
        
      case 'anchor:update':
        // Handle anchor state updates from clients
        if (data) {
          console.log(`[WS] Received anchor update from client ${clientId}`);
          
          // Forward the anchor data to the StateManager
          // The StateManager is the single source of truth for state changes
          const success = this.relayServer.stateManager.updateAnchorState(data);
          
          // Acknowledge receipt
          this._sendToClient(clientId, {
            type: 'anchor:update:ack',
            success,
            timestamp: Date.now()
          });
        }
        break;
        
      case 'bluetooth:select-device':
        // Handle Bluetooth device selection (direct format)
        console.log('[BLUETOOTH-SELECT] WebSocketServer: Received bluetooth:select-device message');
        console.log('[BLUETOOTH-SELECT] WebSocketServer: Full message:', JSON.stringify(message, null, 2));
        await this._handleBluetoothCommand(clientId, 'select-device', message);
        break;
        
      case 'bluetooth:deselect-device':
        // Handle Bluetooth device deselection (direct format)
        console.log('[BLUETOOTH-DESELECT] WebSocketServer: Received bluetooth:deselect-device message');
        await this._handleBluetoothCommand(clientId, 'deselect-device', message);
        break;
        
      case 'bluetooth:rename-device':
        // Handle Bluetooth device rename (direct format)
        console.log('[BLUETOOTH-RENAME] WebSocketServer: Received bluetooth:rename-device message');
        await this._handleBluetoothCommand(clientId, 'rename-device', message);
        break;
        
      case 'bluetooth:scan':
        // Handle Bluetooth scan (direct format)
        console.log('[BLUETOOTH-SCAN] WebSocketServer: Received bluetooth:scan message');
        await this._handleBluetoothCommand(clientId, 'scan', message);
        break;
        
      case 'command':
        // Handle commands (e.g., for anchor, navigation, alerts)
        console.log(`[WS] Received command from client ${clientId}:`, message);
        
        // Process command based on service and action
        if (message.service && message.action) {
          switch (message.service) {
            case 'alert':
              this._handleAlertCommand(clientId, message.action, message.data);
              break;
            case 'bluetooth':
              this._handleBluetoothCommand(clientId, message.action, message.data);
              break;
            // Other services would be handled here
            default:
              console.warn(`[WS] Unknown service in command from client ${clientId}:`, message.service);
          }
        }
        break;
        
      case 'ping':
        // Handle ping messages
        this._sendToClient(clientId, {
          type: 'pong',
          timestamp: Date.now()
        });
        break;
        
      case 'get-full-state':
        // Fetch the current state from the relay server's StateManager
        const fullState = this.relayServer.stateManager.getState();
        this._sendToClient(clientId, {
          type: 'state:full-update',
          data: fullState,
          timestamp: Date.now()
        });
        break;
      default:
        console.warn(`[WS] Unknown message type from client ${clientId}:`, message);
    }
  }

  
  /**
   * Send data to a specific client
   */
  _sendToClient(clientId, data) {
    const client = this.clients.get(clientId);
    if (client && client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    } else if (client) {
      console.warn(`[WS] Cannot send to client ${clientId} - readyState: ${client.readyState}`);
    }
  }
  
  /**
   * Send data to all clients
   */
  _sendToAllClients(message) {
    if (!this.server) {
      console.warn('[WS] Cannot send to all clients: WebSocket server not initialized');
      return;
    }
    
    const messageString = JSON.stringify(message);
    this.server.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(messageString);
      }
    });
  }
  
  /**
   * Handle Bluetooth commands from clients
   * @param {string} clientId - The client ID
   * @param {string} action - The Bluetooth action (e.g., 'toggle', 'scan')
   * @param {Object} data - The command data
   * @private
   */
  async _handleBluetoothCommand(clientId, action, data) {
    console.log(`[WS] Processing Bluetooth command: ${action} from client ${clientId}`, data);
    
    let success = false;
    let response = {
      type: 'bluetooth:response',
      action,
      success: false,
      timestamp: Date.now()
    };
    
    try {
      switch (action) {
        case 'toggle':
          // Toggle Bluetooth on/off
          if (typeof data?.enabled === 'boolean') {
            success = this.relayServer.stateManager.toggleBluetooth(data.enabled);
            response.message = `Bluetooth ${data.enabled ? 'enabled' : 'disabled'}`;
          } else {
            response.error = 'Invalid toggle parameter: enabled must be a boolean';
          }
          break;
          
        case 'scan':
          // Start/stop Bluetooth scanning
          if (typeof data?.scanning === 'boolean') {
            success = this.relayServer.stateManager.updateBluetoothScanningStatus(data.scanning);
            response.message = `Bluetooth scanning ${data.scanning ? 'started' : 'stopped'}`;
          } else {
            response.error = 'Invalid scan parameter: scanning must be a boolean';
          }
          break;
          
        case 'select-device':
          // Select a Bluetooth device
          console.log('[BLUETOOTH-SELECT] WebSocketServer: Entering select-device case');
          console.log('[BLUETOOTH-SELECT] WebSocketServer: data:', JSON.stringify(data, null, 2));
          if (data?.deviceId) {
            console.log('[BLUETOOTH-SELECT] WebSocketServer: Calling setBluetoothDeviceSelected with deviceId:', data.deviceId);
            success = await this.relayServer.stateManager.setBluetoothDeviceSelected(data.deviceId, true);
            console.log('[BLUETOOTH-SELECT] WebSocketServer: Result:', success);
            response.message = `Device ${data.deviceId} selected`;
            response.deviceId = data.deviceId;
          } else {
            console.log('[BLUETOOTH-SELECT] WebSocketServer: ERROR - No deviceId in data');
            response.error = 'Invalid parameter: deviceId is required';
          }
          break;
          
        case 'deselect-device':
          // Deselect a Bluetooth device
          console.log('[BLUETOOTH-DESELECT] WebSocketServer: Entering deselect-device case');
          if (data?.deviceId) {
            console.log('[BLUETOOTH-DESELECT] WebSocketServer: Calling setBluetoothDeviceSelected with deviceId:', data.deviceId);
            success = await this.relayServer.stateManager.setBluetoothDeviceSelected(data.deviceId, false);
            response.message = `Device ${data.deviceId} deselected`;
            response.deviceId = data.deviceId;
          } else {
            response.error = 'Invalid parameter: deviceId is required';
          }
          break;
          
        case 'rename-device':
          // Rename a Bluetooth device
          if (data?.deviceId && data?.name) {
            success = await this.relayServer.stateManager.updateBluetoothDeviceMetadata(data.deviceId, { name: data.name });
            response.message = `Device ${data.deviceId} renamed to ${data.name}`;
            response.deviceId = data.deviceId;
          } else {
            response.error = 'Invalid parameters: deviceId and name are required';
          }
          break;
          
        default:
          response.error = `Unknown Bluetooth action: ${action}`;
      }
    } catch (error) {
      console.error(`[WS] Error handling Bluetooth command ${action}:`, error);
      response.error = `Error processing command: ${error.message}`;
    }
    
    // Update the success flag in the response
    response.success = success;
    
    // Send response back to the client
    this._sendToClient(clientId, response);
  }
  
  /**
   * Handle alert commands from clients
   * @param {string} clientId - The client ID
   * @param {string} action - The alert action (e.g., 'update')
   * @param {Object} data - The alert data
   * @private
   */
  _handleAlertCommand(clientId, action, data) {
    console.log(`[WS] Handling alert command from client ${clientId}:`, action, data);
    
    if (!data) {
      console.warn(`[WS] Missing data in alert command from client ${clientId}`);
      return;
    }
    
    switch (action) {
      case 'update':
        // Process the alert update
        this._processAlertUpdate(clientId, data);
        break;
      default:
        console.warn(`[WS] Unknown alert action from client ${clientId}:`, action);
    }
  }
  
  /**
   * Process an alert update from a client
   * @param {string} clientId - The client ID
   * @param {Object} alertData - The alert data
   * @private
   */
  _processAlertUpdate(clientId, alertData) {
    // Validate required fields
    if (!alertData.type || !alertData.status) {
      console.warn(`[WS] Invalid alert data from client ${clientId}:`, alertData);
      return;
    }
    
    // Create alert object based on the status
    if (alertData.status === 'triggered') {
      // Create a new alert
      const alert = {
        id: crypto.randomUUID(),
        type: 'system',
        category: 'anchor',
        source: alertData.type.includes('ais') ? 'ais_monitor' : 'anchor_monitor',
        level: alertData.data?.level || 'warning',
        label: this._getAlertLabel(alertData.type),
        message: alertData.data?.message || `Alert triggered: ${alertData.type}`,
        timestamp: alertData.timestamp || new Date().toISOString(),
        acknowledged: false,
        status: 'active',
        trigger: alertData.type,
        data: alertData.data || {},
        actions: ['acknowledge', 'mute'],
        phoneNotification: true,
        sticky: true,
        autoResolvable: alertData.autoResolvable !== undefined ? alertData.autoResolvable : true
      };
      
      // Add the alert to the state
      this._addAlertToState(alert);
      
      // Acknowledge receipt
      this._sendToClient(clientId, {
        type: 'alert:update:ack',
        success: true,
        alertId: alert.id,
        timestamp: Date.now()
      });
    } else if (alertData.status === 'resolved') {
      // Find and resolve the alert
      // This is handled by the StateManager's rule engine
      console.log(`[WS] Client ${clientId} requested to resolve alert of type: ${alertData.type}`);
    }
  }
  
  /**
   * Get a human-readable label for an alert type
   * @param {string} alertType - The alert type
   * @returns {string} The alert label
   * @private
   */
  _getAlertLabel(alertType) {
    switch (alertType) {
      case 'anchor_dragging':
        return 'Anchor Dragging';
      case 'critical_range':
        return 'Critical Range Exceeded';
      case 'ais_proximity':
        return 'AIS Proximity Warning';
      default:
        return 'Alert';
    }
  }
  
  /**
   * Add an alert to the state
   * @param {Object} alert - The alert to add
   * @private
   */
  _addAlertToState(alert) {
    // Ensure the alerts structure exists in the state
    const state = this.relayServer.stateManager.appState;
    if (!state.alerts) {
      state.alerts = { active: [], resolved: [] };
    }
    
    if (!state.alerts.active) {
      state.alerts.active = [];
    }
    
    // Add the alert to the active alerts
    state.alerts.active.push(alert);
    
    // Broadcast the updated state
    this.relayServer.stateManager.broadcastStateUpdate();
    
    console.log(`[WS] Added alert to state: ${alert.label}`);
  }
  
  /**
   * Broadcast data to all subscribed clients
   */
  _broadcastToSubscribers(data) {
    const { type } = data;
    
    // Debug: Log the data being broadcast
    if (process.env.DEBUG === 'true') {
      console.log(`[WS-DEBUG] Broadcasting ${type} data:`, JSON.stringify(data));
    }
    
    // For testing purposes, broadcast to all clients regardless of subscriptions
    console.log(`[WS] Broadcasting ${type} data to all clients`);
    console.log(`[WS] Number of clients: ${this.clients.size}`);
    
    if (this.clients.size === 0) {
      if (process.env.DEBUG === 'true') {
        console.log(`[WS-DEBUG] No clients connected, skipping broadcast`);
      }
      return;
    }
    
    this.clients.forEach((client, clientId) => {
      // Check if the client is open and ready to receive data
      if (client && client.readyState === WebSocket.OPEN) {
        if (process.env.DEBUG === 'true') {
          console.log(`[WS-DEBUG] Sending ${type} data to client ${clientId}`);
        }
        
        try {
          const jsonData = JSON.stringify(data);
          client.send(jsonData);
          
          if (process.env.DEBUG === 'true') {
            console.log(`[WS-DEBUG] Successfully sent ${type} data to client ${clientId}`);
          }
        } catch (error) {
          console.error(`[WS] Error sending data to client ${clientId}:`, error);
          console.error(`[WS] Error message:`, error.message);
        }
      } else if (client) {
        console.log(`[WS] Client ${clientId} not ready, readyState: ${client.readyState}`);
      } else {
        console.log(`[WS] Client ${clientId} is null or undefined`);
      }
    });
  }
  
  /**
   * Shutdown the WebSocket server
   */
  /**
   * Set up ping interval to keep connections alive
   */
  _setupPingInterval() {
    // Clear any existing interval
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
    }
    
    // Set up ping interval to check for dead connections
    this.pingInterval = setInterval(() => {
      console.log(`[WS] Checking connection status for ${this.clients.size} clients`);
      
      this.clients.forEach((ws, clientId) => {
        if (ws.isAlive === false) {
          console.log(`[WS] Client ${clientId} is not responding, terminating connection`);
          this.relayServer.removeClient(clientId);
          this.clients.delete(clientId);
          return ws.terminate();
        }
        
        // Mark as not alive, will be marked alive when pong is received
        ws.isAlive = false;
        console.log(`[WS] Sending ping to client ${clientId}`);
        
        // Send ping
        ws.ping((err) => {
          if (err) {
            console.error(`[WS] Error sending ping to client ${clientId}:`, err);
          }
        });
      });
    }, 30000); // Check every 30 seconds
    
    console.log('[WS] Ping interval set up');
  }
  
  /**
   * Shutdown the WebSocket server
   */
  shutdown() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    
    if (this.server) {
      this.server.close();
      console.log('[WS] WebSocket server shut down');
    }
  }
}
